// Audio in: the default microphone (cpal: WASAPI on Windows, ALSA on Linux, which PipeWire and PulseAudio
// both answer) or a WAV file played in real time (dev tests), both mixed down to mono 16 kHz for Parakeet and
// metered for the listening animation.

use crate::{Ev, RATE};
#[cfg(any(windows, target_os = "linux"))]
use crate::log;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// Mono, any rate in, 16 kHz out. Each output sample averages the input it covers (a box filter),
/// which is enough anti-aliasing for speech.
pub struct Resampler {
    step: f64,
    next: f64,
    base: usize,
    hist: Vec<f32>,
}

impl Resampler {
    pub fn new(rate: u32) -> Self {
        Resampler { step: rate as f64 / RATE as f64, next: 0.0, base: 0, hist: Vec::new() }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.step == 1.0 {
            return out.extend_from_slice(input);
        }
        self.hist.extend_from_slice(input);
        let half = (self.step / 2.0).max(0.5);
        loop {
            let lo = (self.next - half).floor().max(0.0) as usize;
            let hi = (self.next + half).ceil() as usize;
            if hi > self.base + self.hist.len() {
                break;
            }
            let s = &self.hist[lo - self.base..hi - self.base];
            out.push(s.iter().sum::<f32>() / s.len() as f32);
            self.next += self.step;
        }
        let keep = ((self.next - half).floor().max(0.0) as usize).max(self.base);
        self.hist.drain(..keep - self.base);
        self.base = keep;
    }
}

/// Where captured audio goes: the take buffer (16 kHz mono) and level events.
pub struct Sink {
    buf: Arc<Mutex<Vec<f32>>>,
    tx: Sender<Ev>,
    resampler: Option<Resampler>,
    channels: usize,
    mono: Vec<f32>,
    out: Vec<f32>,
}

impl Sink {
    pub fn new(buf: Arc<Mutex<Vec<f32>>>, tx: Sender<Ev>) -> Self {
        Sink { buf, tx, resampler: None, channels: 1, mono: Vec::new(), out: Vec::new() }
    }

    fn start(&mut self, rate: u32, channels: usize) {
        self.resampler = Some(Resampler::new(rate));
        self.channels = channels.max(1);
    }

    /// Interleaved samples at the rate and channel count given to start().
    pub fn feed(&mut self, data: &[f32]) {
        let ch = self.channels;
        self.mono.clear();
        self.mono.extend(data.chunks(ch).map(|f| f.iter().sum::<f32>() / f.len() as f32));
        if self.mono.is_empty() {
            return;
        }
        let rms = (self.mono.iter().map(|s| s * s).sum::<f32>() / self.mono.len() as f32).sqrt();
        // Same scale as the Mac helper: about -55 dB is silence, -15 dB is loud speech.
        let level = ((20.0 * rms.max(1e-7).log10() as f64 + 55.0) / 40.0).clamp(0.0, 1.0);
        self.out.clear();
        if let Some(r) = self.resampler.as_mut() {
            r.push(&self.mono, &mut self.out);
        }
        self.buf.lock().unwrap().extend_from_slice(&self.out);
        let _ = self.tx.send(Ev::Level(level));
    }
}

/// Why the microphone didn't open or stopped: "missing", "busy", "blocked", "lost" or "failed", with the
/// system's own words. The app turns the reason into what the Roamie says.
#[derive(Debug, Clone, PartialEq)]
pub struct MicError {
    pub reason: &'static str,
    pub detail: String,
}

impl MicError {
    pub fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        MicError { reason, detail: detail.into() }
    }
}

// E_ACCESSDENIED, which cpal passes on as an unclassified backend error: what a Windows desktop app gets when a
// privacy switch, a policy or security software keeps it off the microphone.
#[cfg(any(windows, target_os = "linux"))]
const ACCESS_DENIED: &str = "(os error -2147024891)";

/// A cpal error as a MicError, or None for a glitch the stream carries on through (a dropped buffer, a refused
/// priority boost, a rerouted default), which must not end the take. `opening`: while starting, not mid-take.
#[cfg(any(windows, target_os = "linux"))]
pub fn mic_problem(e: &cpal::Error, opening: bool) -> Option<MicError> {
    use cpal::ErrorKind::*;
    let detail = e.to_string();
    let reason = match e.kind() {
        Xrun | RealtimeDenied | DeviceChanged => return None,
        PermissionDenied => "blocked",
        _ if detail.contains(ACCESS_DENIED) => "blocked",
        DeviceBusy => "busy",
        DeviceNotAvailable if opening => "missing",
        DeviceNotAvailable | StreamInvalidated => "lost",
        _ => "failed",
    };
    Some(MicError { reason, detail })
}

#[cfg(any(windows, target_os = "linux"))]
fn open_failed(e: cpal::Error) -> MicError {
    mic_problem(&e, true).unwrap_or_else(|| MicError::new("failed", e.to_string()))
}

/// What a take's microphone is: the system default, the one picked, or the default because the picked one isn't
/// there any more (unplugged, or its Bluetooth profile is off). The app shows this, so it never claims a device it
/// isn't recording from.
#[derive(Debug, Clone, PartialEq)]
pub struct MicInfo {
    pub wanted: Option<String>,
    pub used: String,
    pub fallback: bool,
}

/// Which of `names` a pick means: the same name (any case), else the only one that contains it. None when nothing
/// matches, or when more than one does (never a guess: the caller falls back to the default).
#[cfg(any(windows, target_os = "linux"))]
pub fn pick_input(names: &[String], wanted: Option<&str>) -> Option<usize> {
    let w = wanted?.trim().to_lowercase();
    if w.is_empty() {
        return None;
    }
    if let Some(i) = names.iter().position(|n| n.to_lowercase() == w) {
        return Some(i);
    }
    let mut hits = names.iter().enumerate().filter(|(_, n)| n.to_lowercase().contains(&w));
    let (i, _) = hits.next()?;
    hits.next().is_none().then_some(i)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn pick_input(_names: &[String], _wanted: Option<&str>) -> Option<usize> {
    None
}

/// Recording stops when this is dropped.
pub struct Source {
    #[cfg(any(windows, target_os = "linux"))]
    _stream: Option<cpal::Stream>,
    // Linux: pw-record reads a PipeWire source (a Bluetooth headset, a USB mic) that raw ALSA can't open by name.
    #[cfg(target_os = "linux")]
    child: Option<std::process::Child>,
    stop: Arc<AtomicBool>,
}

impl Drop for Source {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        #[cfg(target_os = "linux")]
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Linux: the sources PipeWire/PulseAudio lists (the ones the desktop's sound settings show: the built-in mic, a
/// Bluetooth headset, a USB mic) and recording one by name with pw-record. cpal's ALSA list is a different, smaller
/// set: it can't open a Bluetooth source at all, and its raw hw devices can return a stuck signal while the
/// PipeWire node of the same mic records fine (measured on Fedora 44 / PipeWire 1.6).
#[cfg(target_os = "linux")]
pub mod pulse {
    use super::*;
    use std::io::Read;
    use std::process::{Command, Stdio};

    #[derive(Debug, Clone, PartialEq)]
    pub struct SourceInfo {
        /// The node name (what `pw-record --target` takes); stable per device.
        pub name: String,
        pub description: String,
        pub default: bool,
        /// A monitor of an output, not something anyone talks into.
        pub monitor: bool,
    }

    /// Is pw-record here (it comes with PipeWire on every desktop that has PipeWire)?
    pub fn available() -> bool {
        std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|d| d.join("pw-record").is_file()))
    }

    fn run(args: &[&str]) -> Option<String> {
        let out = Command::new(args[0]).args(&args[1..]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Every source, the default one first marked. Empty when pactl isn't there (a PipeWire install without its
    /// PulseAudio tools) or doesn't answer.
    pub fn sources() -> Vec<SourceInfo> {
        let default = run(&["pactl", "get-default-source"]).map(|s| s.trim().to_owned()).unwrap_or_default();
        let Some(json) = run(&["pactl", "-f", "json", "list", "sources"]) else { return Vec::new() };
        let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(&json) else { return Vec::new() };
        list.iter().filter_map(|s| {
            let name = s.get("name")?.as_str()?.to_owned();
            let description = s.get("description").and_then(|d| d.as_str()).unwrap_or(&name).to_owned();
            // A monitor of an output names the sink it follows ("monitor_source"); nobody talks into one.
            let monitor = s.get("monitor_source").and_then(|m| m.as_str()).is_some_and(|m| !m.is_empty())
                || name.ends_with(".monitor")
                || s.pointer("/properties/device.class").and_then(|c| c.as_str()) == Some("monitor");
            Some(SourceInfo { default: name == default, name, description, monitor })
        }).collect()
    }

    /// Records the source `name` as 16 kHz mono 16-bit PCM from pw-record's stdout. A vanished device (Bluetooth
    /// out of range, unplugged) ends the stream and is reported as `lost`.
    pub fn open(name: &str, mut sink: Sink) -> Result<(Source, MicInfo), MicError> {
        let err_tx = sink.tx.clone();
        let mut child = Command::new("pw-record")
            // raw: bare samples on stdout (without it pw-record puts a container header there and the bytes are
            // no longer 16-bit samples).
            .args(["--target", name, "--rate", &RATE.to_string(), "--channels", "1", "--format", "s16", "--container", "raw", "-"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn()
            .map_err(|e| MicError::new("failed", format!("pw-record: {e}")))?;
        let mut out = child.stdout.take().expect("piped stdout");
        let mut err = child.stderr.take();
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        sink.start(RATE, 1);
        let label = sources().into_iter().find(|s| s.name == name).map(|s| s.description).unwrap_or_else(|| name.to_owned());
        let said = label.clone();
        std::thread::spawn(move || {
            let mut bytes = vec![0u8; 3200]; // 100 ms of 16-bit mono
            let mut odd: Option<u8> = None;
            loop {
                let n = match out.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut samples = Vec::with_capacity(n / 2 + 1);
                let mut i = 0;
                if let Some(b) = odd.take() {
                    samples.push(i16::from_le_bytes([b, bytes[0]]) as f32 / 32768.0);
                    i = 1;
                }
                while i + 1 < n {
                    samples.push(i16::from_le_bytes([bytes[i], bytes[i + 1]]) as f32 / 32768.0);
                    i += 2;
                }
                if i < n {
                    odd = Some(bytes[i]);
                }
                if !samples.is_empty() {
                    sink.feed(&samples);
                }
            }
            // Ended on its own (the device went away, or pw-record was refused): the take can't go on.
            if stop2.load(Ordering::Relaxed) {
                return;
            }
            let detail = err.as_mut().and_then(|e| {
                let mut s = String::new();
                e.read_to_string(&mut s).ok()?;
                Some(s.trim().to_owned())
            }).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("{said} stopped"));
            let _ = err_tx.send(Ev::AudioFailed(MicError::new("lost", detail)));
        });
        log(&format!("microphone on: {label} ({name})"));
        Ok((Source { _stream: None, child: Some(child), stop }, MicInfo { wanted: Some(name.to_owned()), used: name.to_owned(), fallback: false }))
    }

    /// The source a pick means: its node name (any case), else the only one whose name or description contains it.
    pub fn pick(sources: &[SourceInfo], wanted: Option<&str>) -> Option<usize> {
        let w = wanted?.trim().to_lowercase();
        if w.is_empty() {
            return None;
        }
        if let Some(i) = sources.iter().position(|s| !s.monitor && s.name.to_lowercase() == w) {
            return Some(i);
        }
        let mut hits = sources.iter().enumerate().filter(|(_, s)| {
            !s.monitor && (s.name.to_lowercase().contains(&w) || s.description.to_lowercase().contains(&w))
        });
        let (i, _) = hits.next()?;
        hits.next().is_none().then_some(i)
    }
}

pub fn read_wav(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut r = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = r.spec();
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.unwrap_or(0) as f32 / scale).collect()
        }
    };
    let ch = spec.channels.max(1) as usize;
    let mono: Vec<f32> = raw.chunks(ch).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect();
    let mut out = Vec::new();
    Resampler::new(spec.sample_rate).push(&mono, &mut out);
    Ok((out, RATE))
}

/// Dev stand-in for the mic: plays a WAV into the sink at real speed, then silence until stopped.
pub fn play_file(path: &Path, mut sink: Sink) -> Result<(Source, MicInfo), String> {
    let (samples, _) = read_wav(path)?;
    sink.start(RATE, 1);
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        let chunk = RATE as usize / 50;
        let silence = vec![0.0f32; chunk];
        let mut i = 0;
        while !stop2.load(Ordering::Relaxed) {
            let piece = if i < samples.len() { &samples[i..(i + chunk).min(samples.len())] } else { &silence[..] };
            sink.feed(piece);
            i += chunk;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    });
    Ok((Source {
        #[cfg(any(windows, target_os = "linux"))]
        _stream: None,
        #[cfg(target_os = "linux")]
        child: None,
        stop,
    }, MicInfo { wanted: None, used: "test audio".into(), fallback: false }))
}

#[cfg(any(windows, target_os = "linux"))]
pub fn has_input() -> bool {
    use cpal::traits::HostTrait;
    cpal::default_host().default_input_device().is_some()
}

/// cpal's own list: Windows' microphones, and on Linux the raw ALSA PCMs (a smaller, different set from PipeWire's:
/// it has no Bluetooth source at all).
#[cfg(any(windows, target_os = "linux"))]
fn cpal_devices() -> serde_json::Value {
    use cpal::traits::{DeviceTrait, HostTrait};
    use serde_json::json;
    let host = cpal::default_host();
    let name = |d: &cpal::Device| d.description().map(|x| x.name().to_owned()).unwrap_or_else(|e| format!("(no name: {e})"));
    let about = |d: &cpal::Device| {
        let n = name(d);
        match d.default_input_config() {
            Ok(c) => json!({ "name": n, "format": format!("{:?} {} Hz {} ch", c.sample_format(), c.sample_rate(), c.channels()) }),
            Err(e) => {
                let p = open_failed(e);
                json!({ "name": n, "error": p.detail, "reason": p.reason })
            }
        }
    };
    let def = host.default_input_device();
    let def_name = def.as_ref().map(name);
    let inputs = match host.input_devices() {
        Ok(list) => json!(list.map(|d| {
            let mut v = about(&d);
            // The one a bare "default" means, so the picker can say which device that is with a name.
            v["default"] = json!(def_name.as_deref() == Some(name(&d).as_str()));
            v
        }).collect::<Vec<_>>()),
        Err(e) => json!({ "error": e.to_string() }),
    };
    json!({ "type": "devices", "host": host.id().name(), "default": def.map(|d| about(&d)), "inputs": inputs })
}

/// Every microphone the app offers: PipeWire's sources on Linux (the ones the desktop's sound settings show), cpal's
/// devices on Windows. `--devices` prints it for the panel's picker and for diagnostics reports.
#[cfg(windows)]
pub fn devices() -> serde_json::Value {
    cpal_devices()
}

#[cfg(target_os = "linux")]
pub fn devices() -> serde_json::Value {
    use serde_json::json;
    let sources = pulse::sources();
    if sources.is_empty() || !pulse::available() {
        // No PipeWire tools: the raw ALSA list is all there is, and the picker has to say so.
        let mut v = cpal_devices();
        v["capture"] = json!("alsa");
        v["why"] = json!("pactl and pw-record aren't here, so only raw ALSA devices can be used");
        return v;
    }
    json!({
        "type": "devices", "host": "PipeWire", "capture": "pipewire",
        "default": sources.iter().find(|s| s.default).map(|s| json!({ "name": s.name, "description": s.description })),
        "inputs": sources.iter().map(|s| json!({ "name": s.name, "description": s.description, "default": s.default, "monitor": s.monitor })).collect::<Vec<_>>(),
        "alsa": cpal_devices()["inputs"].clone(),
    })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn devices() -> serde_json::Value {
    serde_json::json!({ "type": "devices", "unsupported": true })
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn has_input() -> bool {
    false
}

#[cfg(windows)]
pub fn open_mic(sink: Sink, wanted: Option<&str>) -> Result<(Source, MicInfo), MicError> {
    open_cpal(sink, wanted)
}

/// Linux: the picked PipeWire source when there is one and pw-record can read it, else cpal (the default, or raw
/// ALSA when named); a pick that isn't there falls back to the default rather than failing the take.
#[cfg(target_os = "linux")]
pub fn open_mic(sink: Sink, wanted: Option<&str>) -> Result<(Source, MicInfo), MicError> {
    let wanted_name = wanted.map(str::trim).filter(|w| !w.is_empty());
    let sources = pulse::sources();
    if pulse::available() {
        if let Some(i) = pulse::pick(&sources, wanted_name) {
            let mut res = pulse::open(&sources[i].name, sink)?;
            res.1.wanted = wanted_name.map(str::to_owned);
            return Ok(res);
        } else if let Some(def) = sources.iter().find(|s| s.default && !s.monitor).or_else(|| sources.iter().find(|s| !s.monitor)) {
            let mut res = pulse::open(&def.name, sink)?;
            res.1.wanted = wanted_name.map(str::to_owned);
            if wanted_name.is_some() {
                res.1.fallback = true;
                log(&format!("mic {:?} is not connected; using default PipeWire source ({})", wanted_name, def.description));
            }
            return Ok(res);
        }
    }
    let mut out = open_cpal(sink, wanted_name)?;
    if wanted_name.is_some() && !sources.is_empty() {
        // Named a PipeWire source, and it isn't there: cpal's default is a different device, so say so.
        out.1.fallback = true;
    }
    Ok(out)
}

#[cfg(any(windows, target_os = "linux"))]
fn open_cpal(mut sink: Sink, wanted: Option<&str>) -> Result<(Source, MicInfo), MicError> {
    use cpal::traits::{DeviceTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample, I24, U24};

    fn build<T>(dev: &cpal::Device, cfg: cpal::StreamConfig, mut sink: Sink, err_tx: Sender<Ev>) -> Result<cpal::Stream, cpal::Error>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let mut tmp = Vec::new();
        dev.build_input_stream::<T, _, _>(
            cfg,
            move |data: &[T], _| {
                tmp.clear();
                tmp.extend(data.iter().map(|&s| s.to_sample::<f32>()));
                sink.feed(&tmp);
            },
            move |e| {
                if let Some(p) = mic_problem(&e, false) {
                    let _ = err_tx.send(Ev::AudioFailed(p));
                }
            },
            None,
        )
    }

    let (dev, info) = pick_cpal_device(wanted)?;
    let supported = dev.default_input_config().map_err(open_failed)?;
    sink.start(supported.sample_rate(), supported.channels() as usize);
    let err_tx = sink.tx.clone();
    let format = supported.sample_format();
    let cfg: cpal::StreamConfig = supported.into();
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&dev, cfg, sink, err_tx),
        SampleFormat::F64 => build::<f64>(&dev, cfg, sink, err_tx),
        SampleFormat::I8 => build::<i8>(&dev, cfg, sink, err_tx),
        SampleFormat::I16 => build::<i16>(&dev, cfg, sink, err_tx),
        // 24-bit mics (some USB and studio interfaces) come through as I24.
        SampleFormat::I24 => build::<I24>(&dev, cfg, sink, err_tx),
        SampleFormat::I32 => build::<i32>(&dev, cfg, sink, err_tx),
        SampleFormat::I64 => build::<i64>(&dev, cfg, sink, err_tx),
        SampleFormat::U8 => build::<u8>(&dev, cfg, sink, err_tx),
        SampleFormat::U16 => build::<u16>(&dev, cfg, sink, err_tx),
        SampleFormat::U24 => build::<U24>(&dev, cfg, sink, err_tx),
        SampleFormat::U32 => build::<u32>(&dev, cfg, sink, err_tx),
        other => return Err(MicError::new("failed", format!("unsupported sample format {other:?}"))),
    }
    .map_err(open_failed)?;
    stream.play().map_err(open_failed)?;
    log(&format!("microphone on: {}", info.used));
    Ok((Source {
        _stream: Some(stream),
        #[cfg(target_os = "linux")]
        child: None,
        stop: Arc::new(AtomicBool::new(false)),
    }, info))
}

/// cpal's device: the picked one, or the default when it isn't there (with `fallback` set, so the app can say so).
#[cfg(any(windows, target_os = "linux"))]
fn pick_cpal_device(wanted: Option<&str>) -> Result<(cpal::Device, MicInfo), MicError> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let name = |d: &cpal::Device| d.description().map(|x| x.name().to_owned()).unwrap_or_else(|e| format!("(no name: {e})"));
    let wanted = wanted.map(str::trim).filter(|w| !w.is_empty());
    let inputs: Vec<_> = host.input_devices().map(|l| l.collect()).unwrap_or_default();
    let names: Vec<String> = inputs.iter().map(&name).collect();
    if let Some(i) = pick_input(&names, wanted) {
        return Ok((inputs.into_iter().nth(i).expect("index from the same list"), MicInfo { wanted: wanted.map(str::to_owned), used: names[i].clone(), fallback: false }));
    }
    let def = host.default_input_device().ok_or_else(|| MicError::new("missing", "no default input device"))?;
    let used = name(&def);
    if let Some(w) = wanted {
        log(&format!("mic {w:?} is not connected; using the default ({used})"));
    }
    Ok((def, MicInfo { wanted: wanted.map(str::to_owned), used, fallback: wanted.is_some() }))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn open_mic(_sink: Sink, _wanted: Option<&str>) -> Result<(Source, MicInfo), MicError> {
    Err(MicError::new("failed", "the microphone is only wired up on Windows and Linux (use --test-audio)"))
}

/// Records `secs` seconds from a microphone (the picked one, else the default) to a 16 kHz mono WAV and reports which
/// device actually captured and how loud it was (`roamies-voice --record 2 --out mic.wav [--mic NAME]`). It proves
/// the whole input path on a real machine, with no speech model and no window: a peak near silence explains every
/// "it didn't hear me" without guessing.
pub fn record(secs: f64, wanted: Option<&str>, out: &Path) -> Result<serde_json::Value, MicError> {
    use serde_json::json;
    let secs = secs.clamp(0.2, 30.0);
    let buf = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = std::sync::mpsc::channel();
    let (source, info) = open_mic(Sink::new(buf.clone(), tx), wanted)?;
    // The level events only drive the listening animation; dropping them keeps this a plain recording.
    drop(rx);
    std::thread::sleep(std::time::Duration::from_secs_f64(secs));
    drop(source);
    let samples = std::mem::take(&mut *buf.lock().unwrap());
    let n = samples.len().max(1) as f32;
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / n).sqrt();
    let mean = samples.iter().sum::<f32>() / n;
    let clipped = samples.iter().filter(|s| s.abs() > 0.999).count() as f32 / n;
    let verdict = mic_verdict(peak, mean, clipped);
    let db = |v: f32| ((20.0 * v.max(1e-7).log10() as f64) * 10.0).round() / 10.0; // one decimal place
    let spec = hound::WavSpec { channels: 1, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(out, spec).map_err(|e| MicError::new("failed", format!("{}: {e}", out.display())))?;
    for s in &samples {
        w.write_sample((s.clamp(-1.0, 1.0) * 32767.0) as i16).map_err(|e| MicError::new("failed", e.to_string()))?;
    }
    w.finalize().map_err(|e| MicError::new("failed", e.to_string()))?;
    Ok(json!({
        "type": "record", "file": out.display().to_string(), "seconds": secs, "samples": samples.len(),
        "peak_db": db(peak), "rms_db": db(rms), "mean_db": db(mean.abs()), "clipped": (clipped * 1000.0).round() / 1000.0,
        "silent": verdict == "silent", "verdict": verdict,
        "device": { "used": info.used, "wanted": info.wanted, "fallback": info.fallback },
    }))
}

/// What a recording of a microphone means: real room sound, silence, a stuck DC signal or constant clipping. A stuck
/// device (a muted internal mic whose driver hands back a constant) records loud junk that no speech model can read,
/// which is why the diagnostics report names it instead of letting it look like a working mic.
pub fn mic_verdict(peak: f32, mean: f32, clipped: f32) -> &'static str {
    if peak < 0.01 {
        "silent"
    } else if clipped > 0.5 || mean.abs() > 0.2 {
        "stuck"
    } else {
        "ok"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A working mic, a muted one, and one whose driver returns a constant: the three the diagnostics report names.
    #[test]
    fn a_recording_is_judged_by_its_level_and_its_center() {
        assert_eq!(mic_verdict(0.3, 0.0, 0.0), "ok");
        assert_eq!(mic_verdict(0.3, -0.02, 0.0), "ok");
        assert_eq!(mic_verdict(0.004, 0.0, 0.0), "silent");
        assert_eq!(mic_verdict(1.0, 0.66, 0.02), "stuck", "a DC offset is not speech");
        assert_eq!(mic_verdict(1.0, 0.0, 0.9), "stuck", "clipping the whole time");
    }

    #[test]
    fn resamples_48k_to_16k_in_any_chunking() {
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.001).sin()).collect();
        let mut whole = Vec::new();
        Resampler::new(48_000).push(&input, &mut whole);
        let mut pieces = Vec::new();
        let mut r = Resampler::new(48_000);
        for c in input.chunks(441) {
            r.push(c, &mut pieces);
        }
        assert!((15_990..=16_000).contains(&whole.len()), "{}", whole.len());
        assert_eq!(whole, pieces);
        // A slow sine survives the box filter almost unchanged.
        assert!((whole[8000] - input[24_000]).abs() < 0.01);
    }

    // A pick is the same name (any case) or the only one that contains it; never a guess between two.
    #[test]
    fn a_pick_needs_an_exact_or_unique_name() {
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let list = names(&["Pro 10s (USB)", "Pro 10s", "HDA Intel PCH, ALC255 Analog", "Default Audio Device"]);
        assert_eq!(pick_input(&list, Some("Pro 10s")), Some(1), "the exact name wins over the one that contains it");
        assert_eq!(pick_input(&list, Some("pro 10s")), Some(1), "case doesn't matter");
        assert_eq!(pick_input(&list, Some("  ALC255 ")), Some(2), "a unique part of the name is enough");
        assert_eq!(pick_input(&list, Some("Pro")), None, "two match: the default, not a guess");
        assert_eq!(pick_input(&list, Some("Jabra")), None, "unplugged");
        assert_eq!(pick_input(&list, Some("")), None);
        assert_eq!(pick_input(&list, None), None);
    }

    #[test]
    fn resamples_44k1_and_passes_16k_through() {
        let mut out = Vec::new();
        Resampler::new(44_100).push(&vec![0.5; 44_100], &mut out);
        assert!((15_990..=16_000).contains(&out.len()), "{}", out.len());
        assert!(out.iter().all(|s| (s - 0.5).abs() < 1e-6));
        let mut same = Vec::new();
        Resampler::new(16_000).push(&[0.1, 0.2, 0.3], &mut same);
        assert_eq!(same, vec![0.1, 0.2, 0.3]);
    }

    // Each failure gets the reason the user is told; glitches must not end a take ("I can't find a microphone").
    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn mic_errors_get_a_reason_and_glitches_are_ignored() {
        use cpal::{Error, ErrorKind};
        for kind in [ErrorKind::Xrun, ErrorKind::RealtimeDenied, ErrorKind::DeviceChanged] {
            assert_eq!(mic_problem(&kind.into(), false), None, "{kind:?} mid-take is a glitch");
        }
        let reason = |e: Error, opening| mic_problem(&e, opening).map(|p| p.reason);
        assert_eq!(reason(ErrorKind::DeviceBusy.into(), true), Some("busy"));
        assert_eq!(reason(ErrorKind::PermissionDenied.into(), true), Some("blocked"));
        // How cpal words E_ACCESSDENIED from WASAPI (an io::Error from the HRESULT).
        let denied = std::io::Error::from_raw_os_error(0x8007_0005_u32 as i32).to_string();
        assert_eq!(reason(Error::with_message(ErrorKind::BackendError, denied), true), Some("blocked"));
        assert_eq!(reason(ErrorKind::DeviceNotAvailable.into(), true), Some("missing"));
        assert_eq!(reason(ErrorKind::DeviceNotAvailable.into(), false), Some("lost"), "unplugged mid-take");
        assert_eq!(reason(ErrorKind::StreamInvalidated.into(), false), Some("lost"), "the chosen mic went away mid-take");
        let other = mic_problem(&Error::with_message(ErrorKind::BackendError, "boom"), true).expect("a failure");
        assert_eq!((other.reason, other.detail.as_str()), ("failed", "boom"));
        assert_eq!(open_failed(ErrorKind::Xrun.into()).reason, "failed", "nothing that stops opening is ignored");
    }
}
