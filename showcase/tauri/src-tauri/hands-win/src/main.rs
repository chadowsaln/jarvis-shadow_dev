// Hands helper for Little Boy on Windows, the twin of hands/main.swift: lets the agent see one window or app, read its
// controls and work them. Same commands, same JSON: one command per run, one JSON object on stdout, live progress as
// "@"-prefixed JSON lines on stderr.
//
//   littleboy-hands windows                      visible windows, front to back
//   littleboy-hands front                        the app, window title and (for a browser) address in front
//   littleboy-hands capture <out.jpg> front|app:<name>|window:<id>|screen [max] [thumb thumbMax]
//   littleboy-hands locate front|app:<name>|window:<id>|screen
//   littleboy-hands select <out.png>             drag to choose an area (Esc cancels)
//   littleboy-hands ui front|app:<name>|window:<id> [controls]
//   littleboy-hands locate-control <target> <id>
//   littleboy-hands find-text <target> <text> [scroll]
//   littleboy-hands ocr-find <target> <text> [all]
//   littleboy-hands refine '[[x,y,w,h],…]' [window:<id>]
//   littleboy-hands act <json>                   {"app":"Notepad","steps":[{"do":"fill","field":"Text editor","text":"hi"}]}
//   littleboy-hands --self-test                  the logic checks (no windows needed)
//   littleboy-hands --smoke                      a real run against Notepad (CI)
//
// Coordinates are screen points: physical pixels ÷ the scale of the monitor they're on, which is how the overlays
// place things (each overlay's origin is its monitor's position ÷ its scale; see safe_js in src/main.rs). Window ids
// are HWNDs. trusted, guide and screencheck are macOS permissions and answer "unsupported" here.
#![cfg_attr(not(windows), allow(dead_code))]

mod logic;

#[cfg(windows)]
mod act;
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod ocr;
#[cfg(windows)]
mod select;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
mod win;

use serde_json::{json, Value};
use std::io::Write;

pub fn out(v: Value) -> ! {
    #[cfg(windows)]
    act::give_back();
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
    std::process::exit(0)
}

pub fn fail(msg: &str) -> ! {
    out(json!({ "ok": false, "error": msg }))
}

/// Live progress for the overlay while acting: one JSON line per event on stderr, prefixed with "@".
pub fn progress(v: Value) {
    let mut e = std::io::stderr().lock();
    let _ = writeln!(e, "@{v}");
    let _ = e.flush();
}

fn self_test() -> ! {
    let mut bad = 0;
    for (name, ok) in logic::self_test() {
        println!("{} {name}", if ok { "ok" } else { "FAIL" });
        bad += usize::from(!ok);
    }
    std::process::exit(i32::from(bad > 0))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().cloned() else { fail("no command") };
    if cmd == "--self-test" {
        self_test();
    }
    #[cfg(windows)]
    windows_main(&cmd, &args);
    #[cfg(not(windows))]
    fail(&format!("{cmd}: this helper only runs on Windows"));
}

#[cfg(windows)]
fn windows_main(cmd: &str, args: &[String]) -> ! {
    use logic::{app_matches, whole_match};
    use win::{no_window, resolve, win_info, windows};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, ShowWindow, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER};
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let arg = |i: usize| args.get(i).map(String::as_str);
    fn point_arg(s: &str) -> Option<(f64, f64)> {
        let p: Vec<f64> = s.split(',').filter_map(|v| v.trim().parse::<f64>().ok()).collect();
        (p.len() == 2).then(|| (p[0], p[1]))
    }
    fn click_point(args: &[String]) -> Option<(f64, f64)> {
        if let Some(i) = args.iter().position(|a| a == "--at") {
            return args.get(i + 1).and_then(|s| point_arg(s));
        }
        match (args.get(1).and_then(|s| s.parse::<f64>().ok()), args.get(2).and_then(|s| s.parse::<f64>().ok())) {
            (Some(x), Some(y)) => Some((x, y)),
            _ => None,
        }
    }
    fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
    }
    match cmd {
        "--smoke" => smoke::run(),
        "trusted" | "guide" | "screencheck" => out(json!({ "ok": false, "unsupported": true, "error": "Not needed on Windows." })),
        "windows" => {
            let front = win::front_pid();
            let list: Vec<Value> = windows().iter().take(30).map(|w| {
                let mut i = win_info(w);
                if Some(w.pid) == front {
                    i["frontApp"] = true.into();
                }
                i
            }).collect();
            out(json!({ "ok": true, "windows": list }))
        }
        // Where the user is right now: the app in front (never Little Boy), its window's title, and a browser's address.
        "front" => {
            let mut o = json!({ "ok": true });
            let Some(w) = resolve("front") else { out(o) };
            o["app"] = w.app.clone().into();
            o["exe"] = w.exe.clone().into();
            let title = if win::front_pid() == Some(w.pid) { win::front_title() } else { w.title.clone() };
            if !title.is_empty() {
                o["title"] = title.into();
            }
            if logic::is_browser(&w.exe) {
                if let Some(u) = uia::browser_address(&w) {
                    o["url"] = u.into();
                }
            }
            out(o)
        }
        "locate" => {
            let Some(t) = arg(1) else { fail("usage: locate <target>") };
            if t == "screen" {
                out(json!({ "ok": true, "what": "screen" }));
            }
            let Some(w) = resolve(t) else { fail(&no_window(t)) };
            out(json!({ "ok": true, "window": win_info(&w) }))
        }
        "capture" => {
            let (Some(file), Some(target)) = (arg(1), arg(2)) else { fail("usage: capture <out> <target> [max] [thumb thumbMax]") };
            let max = arg(3).and_then(|m| m.parse().ok());
            let thumb = arg(4);
            let thumb_max = arg(5).and_then(|m| m.parse().ok()).unwrap_or(900);
            let (shot, mut o) = if target == "screen" {
                let m = win::primary();
                let Some(s) = capture::grab_screen(m.px) else { fail("Screen capture failed.") };
                (s, json!({ "ok": true, "file": file, "what": "screen", "bounds": m.pt().ints() }))
            } else {
                let Some(w) = resolve(target) else { fail(&no_window(target)) };
                let Some((s, _)) = capture::grab_window(win::hwnd(w.id)) else { fail("Window capture failed.") };
                (s, json!({ "ok": true, "file": file, "window": win_info(&w) }))
            };
            match capture::save(&shot, file, max, 85) {
                Ok(px) => o["pixels"] = json!(px),
                Err(e) => fail(&format!("Couldn't save the screenshot: {e}")),
            }
            if let Some(t) = thumb {
                let _ = capture::save(&shot, t, Some(thumb_max), 72);
            }
            out(o)
        }
        "select" => {
            let Some(file) = arg(1) else { fail("usage: select <out>") };
            match select::select(file) {
                Ok(Some(_)) => out(json!({ "ok": true, "file": file })),
                Ok(None) => out(json!({ "ok": false, "cancelled": true })),
                Err(e) => fail(&e),
            }
        }
        "ui" => {
            let Some(w) = arg(1).and_then(resolve) else { fail("No matching window is open.") };
            let tree = uia::Tree::of_window(&w);
            let items: Vec<Value> = tree.walk(w.r, 260).into_iter().map(|c| c.1).collect();
            // ui <target> controls: just the controls (to re-find ids before acting), without the page's text.
            if arg(2) == Some("controls") {
                out(json!({ "ok": true, "window": win_info(&w), "controls": items }));
            }
            let (on, off) = tree.scan_text(w.r);
            let note = if items.is_empty() { "This app shares no controls. Use a screenshot plus click at coordinates instead." } else { "" };
            out(json!({ "ok": true, "window": win_info(&w), "controls": items, "texts": logic::page_text(on, 5000), "elsewhere": logic::offscreen_text(off, 4000), "note": note }))
        }
        "locate-control" => {
            let (Some(w), Some(id)) = (arg(1).and_then(resolve), arg(2).and_then(|s| s.parse::<usize>().ok())) else { fail("usage: locate-control <target> <id>") };
            let items = uia::Tree::of_window(&w).walk(w.r, 260);
            if id < 1 || id > items.len() {
                fail(&format!("No control {id} in {}. Read the window again.", w.app));
            }
            out(json!({ "ok": true, "window": win_info(&w), "control": items[id - 1].1 }))
        }
        "refine" => {
            let Some(list) = arg(1).and_then(|s| serde_json::from_str::<Vec<Vec<f64>>>(s).ok()) else { fail("usage: refine '[[x,y,w,h],...]' [window:<id>]") };
            let w = arg(2).and_then(resolve);
            let boxes: Vec<Value> = capture::refine(&list, w.as_ref()).into_iter().map(|r| r.map_or(Value::Null, |r| json!(r.tenths()))).collect();
            out(json!({ "ok": true, "boxes": boxes }))
        }
        "ocr-find" => {
            let (Some(t), Some(text)) = (arg(1), arg(2)) else { fail("usage: ocr-find <target> <text> [all]") };
            let w = if t == "screen" { None } else { Some(resolve(t).unwrap_or_else(|| fail("No matching window is open."))) };
            match ocr::ocr_find(w.as_ref(), text, arg(3) == Some("all")) {
                Ok(m) => out(json!({ "ok": true, "matches": m })),
                Err(e) => fail(&e),
            }
        }
        // Looks through every window of the app ("app:X"), or every window on screen ("screen"), front to back.
        "find-text" => {
            let (Some(t), Some(q)) = (arg(1), arg(2)) else { fail("usage: find-text <target> <text>") };
            let wins: Vec<logic::Win> = if t == "screen" {
                windows()
            } else if t == "front" {
                resolve("front").map(|f| windows().into_iter().filter(|w| w.pid == f.pid).collect()).unwrap_or_default()
            } else if let Some(name) = t.strip_prefix("app:") {
                windows().into_iter().filter(|w| app_matches(&w.app, &w.exe, name)).collect()
            } else {
                resolve(t).into_iter().collect()
            };
            if wins.is_empty() {
                fail("No matching window is open.");
            }
            let search = || {
                let mut all: Vec<Value> = vec![];
                for (z, w) in wins.iter().take(12).enumerate() {
                    for (i, (_, mut m)) in uia::Tree::of_window(w).find_text(w.r, q, false, 8).into_iter().enumerate() {
                        m["window"] = win_info(w);
                        m["rank"] = (z * 100 + i).into();
                        all.push(m);
                    }
                }
                all
            };
            let mut all = search();
            let whole = |m: &Value| whole_match(m["match"].as_str().unwrap_or(""), m["text"].as_str().unwrap_or(""), q);
            // "scroll": nothing whole on screen, so bring it into view in the frontmost window that has it, then look again.
            if arg(3) == Some("scroll") && !all.iter().any(whole) && wins.iter().take(12).any(|w| scroll_to_text(w, q)) {
                all = search();
            }
            // Exact text in any window beats a partial match in the front one.
            let ql = q.trim().to_lowercase();
            let (exact, rest): (Vec<Value>, Vec<Value>) = all.into_iter().partition(|m| m["text"].as_str().unwrap_or("").trim().to_lowercase() == ql);
            out(json!({ "ok": true, "matches": exact.into_iter().chain(rest).take(8).collect::<Vec<_>>() }))
        }
        "act" => {
            let Some(plan) = arg(1) else { fail("bad plan") };
            act::act(plan)
        }
        // ---------- Batch 2: raw input verbs (the sidecar's desktop adapter) ----------
        "move" => {
            let (Some(x), Some(y)) = (arg(1).and_then(|s| s.parse::<f64>().ok()), arg(2).and_then(|s| s.parse::<f64>().ok())) else { fail("usage: move <x> <y> [--relative]") };
            if args.iter().any(|a| a == "--relative") {
                let mut p = windows::Win32::Foundation::POINT::default();
                let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) };
                let s = win::scale_at_px(p.x, p.y);
                act::move_to(p.x as f64 / s + x, p.y as f64 / s + y);
            } else {
                act::move_to(x, y);
            }
            out(json!({ "ok": true }))
        }
        "click" => {
            let p = click_point(args);
            let button = flag(args, "--button").unwrap_or("left");
            let Some((x, y)) = p else { fail("usage: click --at x,y [--button left|right|middle]") };
            act::click_button(x, y, button);
            out(json!({ "ok": true, "at": [x, y] }))
        }
        "double" => {
            let Some((x, y)) = click_point(args) else { fail("usage: double --at x,y") };
            act::double_click(x, y);
            out(json!({ "ok": true, "at": [x, y] }))
        }
        "drag" => {
            let (Some(from), Some(to)) = (arg(1).and_then(point_arg), arg(2).and_then(point_arg)) else { fail("usage: drag x,y x,y") };
            act::drag(from.0, from.1, to.0, to.1);
            out(json!({ "ok": true, "from": [from.0, from.1], "to": [to.0, to.1] }))
        }
        "scroll" => {
            let Some((x, y)) = click_point(args) else { fail("usage: scroll --at x,y [--dx n] [--dy n]") };
            let dx = flag(args, "--dx").and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
            let dy = flag(args, "--dy").and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
            act::wheel(x, y, dy, dx);
            out(json!({ "ok": true, "at": [x, y], "dx": dx, "dy": dy }))
        }
        "type" => {
            let Some(text) = arg(1) else { fail("usage: type <text>") };
            act::type_text(text);
            out(json!({ "ok": true, "chars": text.chars().count() }))
        }
        "key" => {
            let Some(combo) = arg(1) else { fail("usage: key <combo>") };
            if !act::press_key(combo) { fail(&format!("unknown key: {combo}")) }
            out(json!({ "ok": true, "key": combo }))
        }
        "focus" => {
            let Some(w) = arg(1).and_then(resolve) else { fail("No matching window is open.") };
            let ok = win::bring_to_front(&w);
            out(json!({ "ok": ok, "window": win_info(&w) }))
        }
        // ---------- Batch 2: window management, apps, clipboard, displays ----------
        "window" => {
            let (Some(sub), Some(w)) = (arg(1), arg(2).and_then(resolve)) else { fail("usage: window <minimize|maximize|restore|move|resize> <target> [x y|w h]") };
            let h = win::hwnd(w.id);
            match sub {
                "minimize" => { let _ = unsafe { ShowWindow(h, SW_MINIMIZE) }; }
                "maximize" => { let _ = unsafe { ShowWindow(h, SW_MAXIMIZE) }; }
                "restore" => { let _ = unsafe { ShowWindow(h, SW_RESTORE) }; }
                "move" => {
                    let (Some(x), Some(y)) = (arg(3).and_then(|s| s.parse::<i32>().ok()), arg(4).and_then(|s| s.parse::<i32>().ok())) else { fail("usage: window move <target> <x> <y>") };
                    let _ = unsafe { SetWindowPos(h, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) };
                }
                "resize" => {
                    let (Some(wd), Some(ht)) = (arg(3).and_then(|s| s.parse::<i32>().ok()), arg(4).and_then(|s| s.parse::<i32>().ok())) else { fail("usage: window resize <target> <w> <h>") };
                    let _ = unsafe { SetWindowPos(h, None, 0, 0, wd, ht, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE) };
                }
                other => fail(&format!("unknown window action: {other}")),
            }
            out(json!({ "ok": true, "window": win_info(&w) }))
        }
        "quit" => {
            let Some(name) = arg(1) else { fail("usage: quit <app>") };
            match std::process::Command::new("taskkill").args(["/IM", name]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status() {
                Ok(s) if s.success() => out(json!({ "ok": true, "quit": name })),
                _ => fail(&format!("No running app matches {name}.")),
            }
        }
        "apps" => {
            let list: Vec<Value> = win::windows().iter().map(|w| json!({ "name": &w.app, "title": &w.title, "id": w.id, "pid": w.pid })).collect();
            out(json!({ "ok": true, "apps": list }))
        }
        "clipboard" => {
            let Some(sub) = arg(1) else { fail("usage: clipboard get|set [text]") };
            match sub {
                "get" => {
                    let o = std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]).output();
                    match o { Ok(r) => out(json!({ "ok": true, "text": String::from_utf8_lossy(&r.stdout) })), Err(e) => fail(&format!("clipboard read failed: {e}")) }
                }
                "set" => {
                    let Some(text) = arg(2) else { fail("usage: clipboard set <text>") };
                    let o = std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value $env:JARVIS_CLIP"]).env("JARVIS_CLIP", text).output();
                    match o { Ok(r) if r.status.success() => out(json!({ "ok": true })), _ => fail("clipboard write failed") }
                }
                other => fail(&format!("usage: clipboard get|set [text] (not {other})")),
            }
        }
        "monitors" => {
            let list: Vec<Value> = win::monitors().iter().map(|m| {
                let r = m.pt();
                json!({ "x": r.x, "y": r.y, "width": r.w, "height": r.h, "scale": m.scale, "primary": m.primary })
            }).collect();
            out(json!({ "ok": true, "monitors": list }))
        }
        // secret-* is handled by the sidecar on Windows (secrets.mjs).
        other => fail(&format!("unknown command {other}")),
    }
}

/// Scrolls the best whole match for `q` that's out of view into view. True if something was scrolled.
#[cfg(windows)]
fn scroll_to_text(w: &logic::Win, q: &str) -> bool {
    let tree = uia::Tree::of_window(w);
    let Some((e, _)) = tree.find_text(w.r, q, true, 8).into_iter().find(|m| {
        logic::whole_match(m.1["match"].as_str().unwrap_or(""), m.1["text"].as_str().unwrap_or(""), q) && !m.0.r.is_some_and(|f| w.r.intersects(&f))
    }) else {
        return false;
    };
    let mut cur = tree.index_of(&e.el);
    for _ in 0..4 {
        let Some(c) = cur else { break };
        if uia::scroll_into_view(&tree.nodes[c].el) {
            std::thread::sleep(std::time::Duration::from_millis(350));
            return true;
        }
        cur = tree.nodes[c].parent;
    }
    false
}

/// `--smoke`: the real helper against a real app, the way the sidecar calls it (each command its own run).
#[cfg(windows)]
mod smoke {
    use crate::logic::{app_matches, hands_off};
    use serde_json::{json, Value};
    use std::process::{Command, Stdio};
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    fn hands(args: &[&str]) -> Value {
        let exe = std::env::current_exe().expect("own path");
        let o = Command::new(exe).args(args).stderr(Stdio::null()).output().expect("run helper");
        let text = String::from_utf8_lossy(&o.stdout);
        serde_json::from_str(text.trim().lines().last().unwrap_or("{}")).unwrap_or(json!({}))
    }

    fn wait_window(pred: impl Fn(&Value) -> bool) -> Option<Value> {
        let until = Instant::now() + Duration::from_secs(20);
        while Instant::now() < until {
            if let Some(w) = hands(&["windows"])["windows"].as_array().and_then(|l| l.iter().find(|w| pred(w)).cloned()) {
                return Some(w);
            }
            sleep(Duration::from_millis(300));
        }
        None
    }

    fn kill(pid: u64) {
        let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }

    pub fn run() -> ! {
        let mut bad = 0;
        let mut check = |name: &str, ok: bool, detail: String| {
            println!("{} {name}{}", if ok { "ok" } else { "FAIL" }, if ok || detail.is_empty() { String::new() } else { format!(" ({detail})") });
            bad += usize::from(!ok);
        };
        let phrase = "Roamies smoke 4711 Grüße \u{1F600}";
        let _ = Command::new("notepad.exe").spawn();
        let is_notepad = |w: &Value| app_matches(w["app"].as_str().unwrap_or(""), "", "notepad") || w["title"].as_str().unwrap_or("").contains("Notepad");
        let Some(win) = wait_window(is_notepad) else {
            println!("FAIL windows lists Notepad ({})", hands(&["windows"]));
            std::process::exit(1)
        };
        check("windows lists Notepad", true, String::new());
        let id = win["id"].as_i64().unwrap_or(0);
        let target = format!("window:{id}");

        let loc = hands(&["locate", "app:Notepad"]);
        check("locate app:Notepad finds it", loc["window"]["id"].as_i64() == Some(id), loc.to_string());

        let file = std::env::temp_dir().join(format!("roamies-smoke-{}.jpg", std::process::id()));
        let file_s = file.to_string_lossy().to_string();
        let cap = hands(&["capture", &file_s, &target, "1568"]);
        let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        check("capture writes a JPEG", cap["ok"] == json!(true) && size > 1000, cap.to_string());
        let (px, b) = (&cap["pixels"], &cap["window"]["bounds"]);
        let ratio = |a: &Value, i: usize, j: usize| a[i].as_f64().unwrap_or(0.0) / a[j].as_f64().unwrap_or(1.0).max(1.0);
        check("its picture has the window's shape", (ratio(px, 0, 1) / ratio(b, 2, 3).max(0.01) - 1.0).abs() <= 0.02, format!("pixels {px}, bounds {b}"));
        let _ = std::fs::remove_file(&file);

        let ui = hands(&["ui", &target]);
        let field = ui["controls"].as_array().and_then(|c| c.iter().find(|c| ["text field", "text area"].contains(&c["role"].as_str().unwrap_or(""))).cloned());
        check("ui finds the text box", field.is_some(), ui.to_string());
        if let Some(f) = field {
            let plan = json!({ "window": id, "steps": [{ "do": "fill", "id": f["id"], "text": phrase }] }).to_string();
            let r = hands(&["act", &plan]);
            check("act fills it", r["ok"] == json!(true), r.to_string());
            let ui = hands(&["ui", &target, "controls"]);
            let shows = ui["controls"].as_array().is_some_and(|c| c.iter().any(|c| c["value"].as_str().unwrap_or("").contains(phrase)));
            check("ui shows what was typed", shows, ui.to_string());
            sleep(Duration::from_millis(400));
            let o = hands(&["ocr-find", &target, "4711"]);
            if o["error"].as_str().is_some_and(|e| e.contains("no OCR language")) {
                println!("skip ocr-find: {}", o["error"].as_str().unwrap_or(""));
            } else {
                check("ocr-find reads it off the window", o["matches"].as_array().is_some_and(|m| !m.is_empty()), o.to_string());
            }
        }

        // A terminal is never typed in.
        let mut term = Command::new("cmd.exe").args(["/k", "title RoamiesSmoke"]).spawn().ok();
        match wait_window(|w| w["title"].as_str().unwrap_or("").contains("RoamiesSmoke")) {
            Some(t) => {
                let plan = json!({ "window": t["id"], "steps": [{ "do": "type", "text": "echo hi" }] }).to_string();
                let r = hands(&["act", &plan]);
                check("act refuses a terminal", r["error"].as_str().unwrap_or("").starts_with("Blocked for safety"), r.to_string());
            }
            None => check("act refuses a terminal", hands_off("cmd").is_some(), "no console window showed up".into()),
        }
        if let Some(t) = term.as_mut() {
            let _ = t.kill();
        }
        if let Some(pid) = notepad_pid(id) {
            kill(pid);
        }
        std::process::exit(i32::from(bad > 0))
    }

    fn notepad_pid(id: i64) -> Option<u64> {
        Some(crate::win::pid_of(crate::win::hwnd(id)) as u64).filter(|&p| p != 0)
    }
}
