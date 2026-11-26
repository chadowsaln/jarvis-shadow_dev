//! `roamies-input` — Linux input injection for JARVIS V2.
//!
//! The sidecar starts it with `serve` and talks JSON lines on stdin/stdout: one command
//! (`{"id":1,"cmd":"click","x":40,"y":50}`) and one reply (`{"id":1,"ok":true}`) per line.
//! The desktop is asked once, through the XDG desktop portal's remote-control prompt, and
//! the session is then held open for as long as this process runs.
//!
//! Other modes:
//!   probe        what this desktop offers, without any prompt (JSON)
//!   clear-token  forget the remembered portal consent
//!
//! The same binary builds on macOS and Windows (the Linux half is compiled out), so its
//! command parsing is tested anywhere with `cargo test`.

mod logic;

#[cfg(target_os = "linux")]
mod session;

use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str).unwrap_or("serve") {
        "serve" => serve(),
        "probe" => {
            let value = probe();
            println!("{value}");
        }
        "clear-token" => clear_token(),
        "help" | "--help" | "-h" => {
            println!(
                "roamies-input — Linux input injection for JARVIS V2\n\n  serve         read JSON commands on stdin, answer on stdout (the sidecar's mode)\n  probe         print what this desktop offers, without asking for consent\n  clear-token   forget the remembered portal consent\n"
            );
        }
        other => {
            eprintln!("roamies-input: unknown command \"{other}\" (use serve, probe or clear-token)");
            std::process::exit(2);
        }
    }
}

/// One JSON line per reply, one writer at a time.
fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

#[cfg(target_os = "linux")]
fn probe() -> Value {
    session::probe()
}

#[cfg(not(target_os = "linux"))]
fn probe() -> Value {
    json!({ "ok": false, "reason": "roamies-input injects input on Linux only", "remediation": null })
}

#[cfg(target_os = "linux")]
fn clear_token() {
    let removed = session::clear_token();
    emit(json!({ "ok": true, "removed": removed }));
}

#[cfg(not(target_os = "linux"))]
fn clear_token() {
    emit(json!({ "ok": false, "reason": "roamies-input injects input on Linux only" }));
}

#[cfg(not(target_os = "linux"))]
fn serve() {
    emit(json!({
        "event": "error",
        "reason": "roamies-input injects input on Linux only",
        "remediation": null,
    }));
    std::process::exit(2);
}

#[cfg(target_os = "linux")]
fn serve() {
    let mut session = match session::Session::start() {
        Ok(session) => session,
        Err(failure) => {
            emit(json!({
                "event": "error",
                "reason": failure.reason,
                "remediation": failure.remediation,
                "denied": failure.denied,
            }));
            std::process::exit(2);
        }
    };
    let caps = session.capabilities();
    emit(json!({
        "event": "ready",
        "backend": caps.backend,
        "text": caps.text,
        "pointer": caps.pointer,
        "keyboard": caps.keyboard,
    }));

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                emit(json!({ "ok": false, "reason": format!("not JSON: {error}") }));
                continue;
            }
        };
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        match logic::parse_action(&value) {
            Ok(logic::Action::Stop) => {
                emit(json!({ "id": id, "ok": true }));
                break;
            }
            Ok(logic::Action::Ping) => emit(json!({ "id": id, "ok": true })),
            Ok(action) => match session.run(&action) {
                Ok(()) => emit(json!({ "id": id, "ok": true })),
                Err(reason) => emit(json!({ "id": id, "ok": false, "reason": reason })),
            },
            Err(reason) => emit(json!({ "id": id, "ok": false, "reason": reason })),
        }
    }
    // Dropping the session closes the portal's remote-control session with it.
}
