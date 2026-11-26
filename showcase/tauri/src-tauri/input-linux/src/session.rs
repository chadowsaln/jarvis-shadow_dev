//! The desktop side of the input helper: an EIS connection through the XDG desktop portal
//! (`RemoteDesktop` + `ConnectToEIS`, the modern Wayland path) with the portal's own
//! `Notify*` calls as the fallback for desktops whose portal has no `ConnectToEIS`.
//!
//! Nothing here decides *whether* input is allowed: the sidecar's safety rules and the
//! user's approval already ran. This module only turns one validated action into input.

#![cfg(target_os = "linux")]

use std::collections::HashMap;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use reis::{ei, PendingRequestResult};
use reis::Interface;

use crate::logic::{self, Action};

const HELPER_NAME: &str = "roamies-input";
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// The interfaces this client offers to speak. `ei_text` is what lets text be typed without
/// a keymap; asking for it costs nothing where the desktop does not have it.
const INTERFACES: [(&str, u32); 11] = [
    ("ei_callback", 1),
    ("ei_connection", 1),
    ("ei_pingpong", 1),
    ("ei_seat", 1),
    ("ei_device", 1),
    ("ei_pointer", 1),
    ("ei_pointer_absolute", 1),
    ("ei_button", 1),
    ("ei_scroll", 1),
    ("ei_keyboard", 1),
    ("ei_text", 1),
];

pub struct Capabilities {
    pub backend: &'static str,
    pub text: bool,
    pub pointer: bool,
    pub keyboard: bool,
}

#[derive(Debug)]
pub struct Failure {
    pub reason: String,
    pub remediation: Option<String>,
    /// The user said no: another attempt would only ask again.
    pub denied: bool,
}

impl Failure {
    fn plain(reason: impl Into<String>) -> Self {
        Failure { reason: reason.into(), remediation: None, denied: false }
    }
    fn with(reason: impl Into<String>, remediation: impl Into<String>) -> Self {
        Failure { reason: reason.into(), remediation: Some(remediation.into()), denied: false }
    }
    fn denied(reason: impl Into<String>, remediation: impl Into<String>) -> Self {
        Failure { reason: reason.into(), remediation: Some(remediation.into()), denied: true }
    }
}

pub struct Session {
    backend: Backend,
}

enum Backend {
    Eis(Eis),
    Notify(Notify),
}

impl Session {
    /// Open a session. On a desktop with a modern portal this shows the remote-control
    /// consent dialog once; the answer is remembered through the restore token where the
    /// portal supports it.
    pub fn start() -> Result<Session, Failure> {
        // The fast path: a compositor or a test exported $LIBEI_SOCKET. No portal, no prompt.
        if let Some(context) = ei::Context::connect_to_env()
            .map_err(|e| Failure::plain(format!("LIBEI_SOCKET could not be opened: {e}")))?
        {
            return Ok(Session { backend: Backend::Eis(Eis::open(context, None)?) });
        }
        let portal = Portal::open()?;
        match portal.connect_to_eis() {
            Ok(context) => Ok(Session { backend: Backend::Eis(Eis::open(context, Some(portal))?) }),
            Err(failure) => {
                // No ConnectToEIS (portal 1): its own Notify* calls still inject input, without
                // text. A refusal is final; asking again would only show the dialog twice.
                if failure.denied || portal.version < 2 {
                    return Err(failure);
                }
                let remediation = failure.remediation.clone();
                let notify = portal.into_notify().map_err(|second| Failure {
                    reason: format!("{}; the portal's own input calls failed too: {}", failure.reason, second.reason),
                    remediation: second.remediation.or(remediation),
                    denied: second.denied,
                })?;
                Ok(Session { backend: Backend::Notify(notify) })
            }
        }
    }

    pub fn capabilities(&self) -> Capabilities {
        match &self.backend {
            Backend::Eis(eis) => Capabilities {
                backend: "libei",
                text: eis.has("ei_text"),
                pointer: eis.has("ei_pointer_absolute") || eis.has("ei_pointer"),
                keyboard: eis.has("ei_keyboard"),
            },
            Backend::Notify(_) => Capabilities { backend: "portal-notify", text: false, pointer: true, keyboard: true },
        }
    }

    pub fn run(&mut self, action: &Action) -> Result<(), String> {
        match &mut self.backend {
            Backend::Eis(eis) => eis.run(action),
            Backend::Notify(notify) => notify.run(action),
        }
    }
}

// ------------------------------------------------------------------ probe

/// What this desktop offers, without asking the user for anything: no session is created and
/// no consent dialog appears.
pub fn probe() -> Value {
    use ashpd::desktop::remote_desktop::RemoteDesktop;
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return failure_json(Failure::plain(format!("could not start the portal runtime: {e}"))),
    };
    let proxy = match rt.block_on(RemoteDesktop::new()) {
        Ok(proxy) => proxy,
        Err(e) => return failure_json(portal_failure("open the desktop portal's remote-control interface", e)),
    };
    let version = proxy.version();
    let devices = rt
        .block_on(proxy.available_device_types())
        .map(device_names)
        .unwrap_or_default();
    let eis = version >= 2;
    json!({
        "ok": true,
        "backend": if eis { "libei" } else { "portal-notify" },
        "portalVersion": version,
        "eis": eis,
        // What a device actually offers (text included) is only known once a session is open: the
        // portal's version says it has ConnectToEIS, not that this compositor implements ei_text.
        "text": Value::Null,
        "deviceTypes": devices,
        "socket": std::env::var_os("LIBEI_SOCKET").is_some(),
        "token": token_path().exists(),
    })
}

pub fn failure_json(failure: Failure) -> Value {
    json!({ "ok": false, "reason": failure.reason, "remediation": failure.remediation })
}

// ------------------------------------------------------------------ portal

fn device_names(types: ashpd::desktop::remote_desktop::DeviceType) -> String {
    use ashpd::desktop::remote_desktop::DeviceType;
    let mut names = Vec::new();
    if types.contains(DeviceType::KEYBOARD) {
        names.push("keyboard");
    }
    if types.contains(DeviceType::POINTER) {
        names.push("pointer");
    }
    if types.contains(DeviceType::TOUCHSCREEN) {
        names.push("touchscreen");
    }
    names.join(",")
}

struct Portal {
    rt: tokio::runtime::Runtime,
    proxy: ashpd::desktop::remote_desktop::RemoteDesktop,
    session: ashpd::desktop::Session<ashpd::desktop::remote_desktop::RemoteDesktop>,
    version: u32,
}

impl Portal {
    fn open() -> Result<Portal, Failure> {
        use ashpd::desktop::remote_desktop::RemoteDesktop;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|e| Failure::plain(format!("could not start the portal runtime: {e}")))?;
        let proxy = rt
            .block_on(RemoteDesktop::new())
            .map_err(|e| portal_failure("open the desktop portal's remote-control interface", e))?;
        let version = proxy.version();
        let session = rt
            .block_on(proxy.create_session(Default::default()))
            .map_err(|e| portal_failure("create a remote-control session", e))?;
        Ok(Portal { rt, proxy, session, version })
    }

    fn choose_devices(&self) -> Result<(), Failure> {
        use ashpd::desktop::remote_desktop::{DeviceType, SelectDevicesOptions};
        use ashpd::desktop::PersistMode;
        let (proxy, session, rt) = (&self.proxy, &self.session, &self.rt);
        rt.block_on(async {
            let mut options = SelectDevicesOptions::default()
                .set_devices(DeviceType::KEYBOARD | DeviceType::POINTER)
                .set_persist_mode(PersistMode::ExplicitlyRevoked);
            if let Some(token) = read_token() {
                options = options.set_restore_token(Some(token.as_str()));
            }
            proxy
                .select_devices(session, options)
                .await
                .map_err(|e| portal_failure("choose the pointer and keyboard", e))?
                .response()
                .map_err(|e| portal_failure("choose the pointer and keyboard", e))?;
            let started = proxy
                .start(session, None, Default::default())
                .await
                .map_err(|e| portal_failure("start remote control", e))?
                .response()
                .map_err(|e| portal_failure("start remote control", e))?;
            if let Some(token) = started.restore_token() {
                write_token(token);
            }
            Ok(())
        })
    }

    /// Start the session (the consent dialog) and take the EIS file descriptor. Everything
    /// after this point is input without any further prompts.
    fn connect_to_eis(&self) -> Result<ei::Context, Failure> {
        use ashpd::desktop::remote_desktop::ConnectToEISOptions;
        self.choose_devices()?;
        let fd = self
            .rt
            .block_on(self.proxy.connect_to_eis(&self.session, ConnectToEISOptions::default()))
            .map_err(|e| portal_failure("connect to the desktop's input protocol", e))?;
        ei::Context::new(UnixStream::from(fd))
            .map_err(|e| Failure::plain(format!("the desktop's input socket could not be opened: {e}")))
    }

    /// Portal without ConnectToEIS: its own Notify* calls.
    fn into_notify(self) -> Result<Notify, Failure> {
        self.choose_devices()?;
        let Portal { rt, proxy, session, .. } = self;
        Ok(Notify { rt, proxy, session })
    }
}

fn portal_failure(doing: &str, error: ashpd::Error) -> Failure {
    use ashpd::desktop::ResponseError;
    if matches!(error, ashpd::Error::Response(ResponseError::Cancelled)) {
        return Failure::denied(
            "the remote-control request was denied",
            "Allow the prompt when JARVIS V2 asks to control the pointer and keyboard (GNOME: Settings > Apps > JARVIS V2, or the shield icon in the top bar).",
        );
    }
    let text = error.to_string();
    if matches!(error, ashpd::Error::PortalNotFound(_)) || text.contains("ServiceUnknown") || text.contains("not found") {
        return Failure::with(
            format!("this desktop has no remote-control portal ({doing})"),
            "Install the portal for your desktop: xdg-desktop-portal-gnome (GNOME), xdg-desktop-portal-kde (Plasma) or xdg-desktop-portal-wlr (sway/wlroots), plus xdg-desktop-portal.",
        );
    }
    Failure::with(
        format!("could not {doing}: {text}"),
        "Check that xdg-desktop-portal and the backend for your desktop are running: systemctl --user status xdg-desktop-portal.",
    )
}

// ------------------------------------------------------------------ EIS

struct Entry {
    device: ei::Device,
    interfaces: HashMap<String, reis::Object>,
    regions: Vec<logic::Region>,
    resumed: bool,
}

impl Entry {
    fn interface<T: Interface>(&self) -> Option<T> {
        self.interfaces.get(T::NAME)?.clone().downcast()
    }
}

struct Eis {
    context: ei::Context,
    connection: Option<ei::Connection>,
    serial: u32,
    sequence: u32,
    seats: HashMap<ei::Seat, HashMap<String, u64>>,
    entries: Vec<Entry>,
    dead: Option<String>,
    last_time: u64,
    /// Keeps the portal session (and its D-Bus connection) alive for as long as the EIS
    /// connection is used: dropping it tears the session down under us.
    _keepalive: Option<Portal>,
}

impl Eis {
    fn open(context: ei::Context, keepalive: Option<Portal>) -> Result<Eis, Failure> {
        let handshake = context.handshake();
        handshake.handshake_version(1);
        handshake.name(HELPER_NAME);
        handshake.context_type(ei::handshake::ContextType::Sender);
        for (interface, version) in INTERFACES {
            handshake.interface_version(interface, version);
        }
        handshake.finish();
        let _ = context.flush();

        let mut eis = Eis {
            context,
            connection: None,
            serial: 0,
            sequence: 0,
            seats: HashMap::new(),
            entries: Vec::new(),
            dead: None,
            last_time: 0,
            _keepalive: keepalive,
        };
        eis.wait_ready()?;
        Ok(eis)
    }

    /// Wait until the desktop has handed over the pointer and the keyboard. The pointer usually
    /// arrives first: a device is reported the moment it resumes, so stopping at the first
    /// one claimed no keyboard on a desktop that was about to offer it (and then refused every
    /// key). Both are waited for, with a short grace once one is there so a desktop that grants
    /// only one of them is reported quickly instead of blocking.
    fn wait_ready(&mut self) -> Result<(), Failure> {
        const GRACE: Duration = Duration::from_millis(2000);
        let start = Instant::now();
        let mut first: Option<Instant> = None;
        loop {
            self.pump(Duration::from_millis(10));
            if let Some(reason) = &self.dead {
                return Err(Failure::with(
                    format!("the desktop closed the input connection: {reason}"),
                    "Try again; if it keeps closing, check the portal for your desktop (xdg-desktop-portal-gnome / -kde).",
                ));
            }
            let pointer = self.has("ei_pointer_absolute") || self.has("ei_pointer");
            let keyboard = self.has("ei_keyboard");
            if pointer && keyboard {
                return Ok(());
            }
            if pointer || keyboard {
                let since = *first.get_or_insert_with(Instant::now);
                if since.elapsed() >= GRACE {
                    return Ok(());
                }
            }
            if start.elapsed() >= READY_TIMEOUT {
                break;
            }
        }
        Err(Failure::with(
            "the desktop did not offer a pointer or keyboard for remote control",
            "Make sure the session was allowed (GNOME: the shield icon in the top bar), then try again.",
        ))
    }

    fn has(&self, interface: &str) -> bool {
        self.entries.iter().any(|e| e.resumed && e.interfaces.contains_key(interface))
    }

    fn frame(&mut self, index: usize) -> Result<(), String> {
        let time = self.next_time();
        let serial = self.serial;
        self.entries[index].device.frame(serial, time);
        self.context
            .flush()
            .map_err(|e| format!("the desktop would not take the input: {e}"))
    }

    fn next_time(&mut self) -> u64 {
        self.last_time = now_micros().max(self.last_time + 1);
        self.last_time
    }

    fn run(&mut self, action: &Action) -> Result<(), String> {
        // Read anything the desktop sent since the last action (a pause, a serial change).
        self.pump(Duration::ZERO);
        if let Some(reason) = self.dead.clone() {
            return Err(format!("the desktop closed the input connection: {reason}"));
        }
        match action {
            Action::Move { x, y } => self.move_abs(*x, *y),
            Action::MoveRelative { dx, dy } => {
                let index = self.index("ei_pointer")?;
                let pointer: ei::Pointer = self.entries[index].interface().ok_or_else(|| missing("ei_pointer"))?;
                pointer.motion_relative(*dx as f32, *dy as f32);
                self.frame(index)
            }
            Action::Click { x, y, button, count } => {
                if let (Some(x), Some(y)) = (x, y) {
                    self.move_abs(*x, *y)?;
                }
                for i in 0..*count {
                    self.button(*button, true)?;
                    self.button(*button, false)?;
                    if i + 1 < *count {
                        std::thread::sleep(Duration::from_millis(60));
                    }
                }
                Ok(())
            }
            Action::Down { button } => self.button(*button, true),
            Action::Up { button } => self.button(*button, false),
            Action::Drag { from_x, from_y, to_x, to_y, button } => {
                self.drag(*from_x, *from_y, *to_x, *to_y, *button)
            }
            Action::Scroll { dx, dy } => {
                let index = self.index("ei_scroll")?;
                let scroll: ei::Scroll = self.entries[index].interface().ok_or_else(|| missing("ei_scroll"))?;
                scroll.scroll(*dx as f32, *dy as f32);
                self.frame(index)
            }
            Action::Type { text } => self.type_text(text),
            Action::Key { codes } => self.keys(codes),
            Action::Ping | Action::Stop => Ok(()),
        }
    }

    fn index(&self, interface: &str) -> Result<usize, String> {
        self.entries
            .iter()
            .position(|e| e.resumed && e.interfaces.contains_key(interface))
            .ok_or_else(|| missing(interface))
    }

    fn check_screens(&self, index: usize, x: f64, y: f64) -> Result<(), String> {
        let screens = &self.entries[index].regions;
        if logic::region_allows(screens, x, y) {
            return Ok(());
        }
        Err(format!(
            "{x},{y} is outside the screens the desktop offered ({screens:?}); take the coordinates from a screenshot"
        ))
    }

    fn move_abs(&mut self, x: f64, y: f64) -> Result<(), String> {
        let index = self.index("ei_pointer_absolute")?;
        self.check_screens(index, x, y)?;
        let pointer: ei::PointerAbsolute = self.entries[index]
            .interface()
            .ok_or_else(|| missing("ei_pointer_absolute"))?;
        pointer.motion_absolute(x as f32, y as f32);
        self.frame(index)
    }

    fn button(&mut self, button: u32, pressed: bool) -> Result<(), String> {
        let index = self.index("ei_button")?;
        let buttons: ei::Button = self.entries[index].interface().ok_or_else(|| missing("ei_button"))?;
        buttons.button(
            button,
            if pressed { ei::button::ButtonState::Press } else { ei::button::ButtonState::Released },
        );
        self.frame(index)
    }

    fn drag(&mut self, from_x: f64, from_y: f64, to_x: f64, to_y: f64, button: u32) -> Result<(), String> {
        let index = self.index("ei_pointer_absolute")?;
        self.check_screens(index, from_x, from_y)?;
        self.check_screens(index, to_x, to_y)?;
        let pointer: ei::PointerAbsolute = self.entries[index]
            .interface()
            .ok_or_else(|| missing("ei_pointer_absolute"))?;
        let buttons: ei::Button = self.entries[index].interface().ok_or_else(|| missing("ei_button"))?;
        pointer.motion_absolute(from_x as f32, from_y as f32);
        buttons.button(button, ei::button::ButtonState::Press);
        self.frame(index)?;
        let steps = 12;
        for step in 1..=steps {
            let t = step as f64 / steps as f64;
            pointer.motion_absolute((from_x + (to_x - from_x) * t) as f32, (from_y + (to_y - from_y) * t) as f32);
            self.frame(index)?;
            std::thread::sleep(Duration::from_millis(12));
        }
        buttons.button(button, ei::button::ButtonState::Released);
        self.frame(index)
    }

    fn keys(&mut self, codes: &[u32]) -> Result<(), String> {
        let index = self.index("ei_keyboard")?;
        let keyboard: ei::Keyboard = self.entries[index].interface().ok_or_else(|| missing("ei_keyboard"))?;
        for code in codes {
            keyboard.key(*code, ei::keyboard::KeyState::Press);
            self.frame(index)?;
        }
        for code in codes.iter().rev() {
            keyboard.key(*code, ei::keyboard::KeyState::Released);
            self.frame(index)?;
        }
        Ok(())
    }

    fn type_text(&mut self, text: &str) -> Result<(), String> {
        let index = self.index("ei_text").map_err(|_| {
            "this desktop cannot type text through the input protocol (it has no ei_text); install ydotool for typing, or use linux_set_text on a text field".to_string()
        })?;
        let target: ei::Text = self.entries[index].interface().ok_or_else(|| missing("ei_text"))?;
        for chunk in logic::text_chunks(text) {
            target.utf8(chunk);
            self.frame(index)?;
            std::thread::sleep(Duration::from_millis(4));
        }
        Ok(())
    }

    /// Poll the desktop's socket and handle everything it sent, at most `timeout` long.
    fn pump(&mut self, timeout: Duration) {
        let mut fds = libc::pollfd { fd: self.context.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        let millis = timeout.as_millis().min(i32::MAX as u128) as i32;
        // SAFETY: one valid pollfd, and poll only writes to it.
        let ready = unsafe { libc::poll(&mut fds, 1, millis) };
        if ready < 0 {
            return;
        }
        if ready > 0 && fds.revents & (libc::POLLIN | libc::POLLHUP) != 0 {
            match self.context.read() {
                Ok(0) => self.die("the desktop closed the input connection".to_string()),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => self.die(format!("the desktop's input connection failed: {e}")),
            }
        }
        while let Some(result) = self.context.pending_event() {
            match result {
                PendingRequestResult::Request(event) => self.handle(event),
                PendingRequestResult::ParseError(error) => {
                    self.die(format!("the desktop sent something this build does not understand: {error}"));
                    break;
                }
                PendingRequestResult::InvalidObject(_) => {}
            }
        }
        let _ = self.context.flush();
    }

    fn die(&mut self, reason: String) {
        if self.dead.is_none() {
            self.dead = Some(reason);
        }
    }

    fn handle(&mut self, event: ei::Event) {
        use ei::{connection, device, seat};
        match event {
            ei::Event::Handshake(_, ei::handshake::Event::Connection { connection, serial }) => {
                self.connection = Some(connection);
                self.serial = serial;
            }
            ei::Event::Connection(_, connection::Event::Seat { seat }) => {
                self.seats.insert(seat, HashMap::new());
            }
            ei::Event::Connection(_, connection::Event::Ping { ping }) => {
                ping.done(0);
            }
            ei::Event::Connection(_, connection::Event::Disconnected { reason, explanation, .. }) => {
                self.die(format!("{reason:?}: {}", explanation.unwrap_or_default()));
            }
            ei::Event::Seat(seat, seat::Event::Capability { mask, interface }) => {
                if let Some(capabilities) = self.seats.get_mut(&seat) {
                    capabilities.insert(interface, mask);
                }
            }
            ei::Event::Seat(seat, seat::Event::Done) => {
                let mask = self
                    .seats
                    .get(&seat)
                    .map(|capabilities| capabilities.values().copied().fold(0u64, |all, m| all | m))
                    .unwrap_or(0);
                if mask != 0 {
                    seat.bind(mask);
                    let _ = self.context.flush();
                }
            }
            ei::Event::Seat(_, seat::Event::Device { device }) => {
                self.entries.push(Entry { device, interfaces: HashMap::new(), regions: Vec::new(), resumed: false });
            }
            ei::Event::Seat(_, seat::Event::Destroyed { .. }) => {}
            ei::Event::Device(device, event) => match event {
                device::Event::Interface { object } => {
                    if let Some(entry) = self.entries.iter_mut().find(|e| e.device == device) {
                        entry.interfaces.insert(object.interface().to_string(), object);
                    }
                }
                device::Event::Region { offset_x, offset_y, width, hight, .. } => {
                    if let Some(entry) = self.entries.iter_mut().find(|e| e.device == device) {
                        entry.regions.push((offset_x as f64, offset_y as f64, width as f64, hight as f64));
                    }
                }
                device::Event::Resumed { serial } => {
                    self.serial = serial;
                    self.sequence = self.sequence.wrapping_add(1);
                    let sequence = self.sequence;
                    if let Some(entry) = self.entries.iter_mut().find(|e| e.device == device) {
                        entry.resumed = true;
                        // One emulation transaction per session, not per click (libei's own client
                        // does the same): a device stopped in the same batch as its frame is
                        // neutralised by Mutter.
                        entry.device.start_emulating(serial, sequence);
                    }
                    let _ = self.context.flush();
                }
                device::Event::Paused { serial } => {
                    self.serial = serial;
                    if let Some(entry) = self.entries.iter_mut().find(|e| e.device == device) {
                        entry.resumed = false;
                    }
                }
                device::Event::Destroyed { serial } => {
                    self.serial = serial;
                    self.entries.retain(|e| e.device != device);
                }
                _ => {}
            },
            _ => {}
        }
    }
}

fn missing(interface: &str) -> String {
    let what = match interface {
        "ei_pointer" => "pointer motion",
        "ei_pointer_absolute" => "absolute pointer motion",
        "ei_button" => "mouse buttons",
        "ei_scroll" => "scrolling",
        "ei_keyboard" => "the keyboard",
        "ei_text" => "text input",
        _ => interface,
    };
    format!("the desktop did not offer {what} for remote control")
}

// ------------------------------------------------------------------ portal Notify*

struct Notify {
    rt: tokio::runtime::Runtime,
    proxy: ashpd::desktop::remote_desktop::RemoteDesktop,
    session: ashpd::desktop::Session<ashpd::desktop::remote_desktop::RemoteDesktop>,
}

impl Notify {
    fn run(&self, action: &Action) -> Result<(), String> {
        use ashpd::desktop::remote_desktop::{KeyState, NotifyPointerAxisOptions};
        let proxy = &self.proxy;
        let session = &self.session;
        let io = |e: ashpd::Error| format!("the desktop would not take the input: {e}");
        match action {
            Action::Move { x, y } => self.rt.block_on(async {
                proxy.notify_pointer_motion_absolute(session, 0, *x, *y, Default::default()).await.map_err(io)
            }),
            Action::MoveRelative { dx, dy } => self.rt.block_on(async {
                proxy.notify_pointer_motion(session, *dx, *dy, Default::default()).await.map_err(io)
            }),
            Action::Click { x, y, button, count } => {
                if let (Some(x), Some(y)) = (x, y) {
                    self.run(&Action::Move { x: *x, y: *y })?;
                }
                for i in 0..*count {
                    self.run(&Action::Down { button: *button })?;
                    self.run(&Action::Up { button: *button })?;
                    if i + 1 < *count {
                        std::thread::sleep(Duration::from_millis(60));
                    }
                }
                Ok(())
            }
            Action::Down { button } => self.rt.block_on(async {
                proxy.notify_pointer_button(session, *button as i32, KeyState::Pressed, Default::default()).await.map_err(io)
            }),
            Action::Up { button } => self.rt.block_on(async {
                proxy.notify_pointer_button(session, *button as i32, KeyState::Released, Default::default()).await.map_err(io)
            }),
            Action::Drag { from_x, from_y, to_x, to_y, button } => {
                self.run(&Action::Move { x: *from_x, y: *from_y })?;
                self.run(&Action::Down { button: *button })?;
                let steps = 12;
                for step in 1..=steps {
                    let t = step as f64 / steps as f64;
                    self.run(&Action::Move { x: from_x + (to_x - from_x) * t, y: from_y + (to_y - from_y) * t })?;
                    std::thread::sleep(Duration::from_millis(12));
                }
                self.run(&Action::Up { button: *button })
            }
            Action::Scroll { dx, dy } => self.rt.block_on(async {
                let options = NotifyPointerAxisOptions::default().set_finish(true);
                proxy.notify_pointer_axis(session, *dx, *dy, options).await.map_err(io)
            }),
            Action::Key { codes } => {
                for code in codes {
                    self.key(*code, true)?;
                }
                for code in codes.iter().rev() {
                    self.key(*code, false)?;
                }
                Ok(())
            }
            Action::Type { .. } => Err(
                "this desktop's portal has no text input through remote control; install ydotool for typing, or use linux_set_text on a text field".to_string(),
            ),
            Action::Ping | Action::Stop => Ok(()),
        }
    }

    /// The portal takes XKB keycodes; evdev's are 8 lower.
    fn key(&self, code: u32, pressed: bool) -> Result<(), String> {
        use ashpd::desktop::remote_desktop::KeyState;
        let state = if pressed { KeyState::Pressed } else { KeyState::Released };
        self.rt
            .block_on(async { self.proxy.notify_keyboard_keycode(&self.session, code as i32 + 8, state, Default::default()).await })
            .map_err(|e| format!("the desktop would not take the key: {e}"))
    }
}

// ------------------------------------------------------------------ shared

fn now_micros() -> u64 {
    let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: a valid pointer to a timespec; clock_gettime only writes to it.
    let ok = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } == 0;
    if ok {
        (time.tv_sec as u64).saturating_mul(1_000_000).saturating_add((time.tv_nsec as u64) / 1_000)
    } else {
        0
    }
}

fn token_path() -> PathBuf {
    let base = std::env::var_os("ROAMIES_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".gg")))
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    base.join("input-restore-token")
}

fn read_token() -> Option<String> {
    std::fs::read_to_string(token_path()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn write_token(token: &str) {
    let path = token_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
}

pub fn clear_token() -> bool {
    std::fs::remove_file(token_path()).is_ok()
}
