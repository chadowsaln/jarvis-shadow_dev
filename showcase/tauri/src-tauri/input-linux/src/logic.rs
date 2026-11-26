//! The parts of the input helper that never touch a desktop: what a JSON line means, which
//! evdev button a name is, how a long text is split for `ei_text`, and which screen a point
//! belongs to. No D-Bus and no EIS here, so `cargo test` runs these on any platform.

use serde_json::Value;

/// `ei_text.utf8` takes at most 254 bytes per request (255 with the terminating NUL).
pub const MAX_TEXT_BYTES: usize = 254;

/// Linux input-event-codes.h button numbers (`BTN_LEFT`, `BTN_RIGHT`, `BTN_MIDDLE`).
pub const BTN_LEFT: u32 = 0x110;
pub const BTN_RIGHT: u32 = 0x111;
pub const BTN_MIDDLE: u32 = 0x112;

/// A rectangle a pointer device may visit: x, y, width, height in logical pixels.
pub type Region = (f64, f64, f64, f64);

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Move { x: f64, y: f64 },
    MoveRelative { dx: f64, dy: f64 },
    Click { x: Option<f64>, y: Option<f64>, button: u32, count: u8 },
    Down { button: u32 },
    Up { button: u32 },
    Drag { from_x: f64, from_y: f64, to_x: f64, to_y: f64, button: u32 },
    Scroll { dx: f64, dy: f64 },
    Type { text: String },
    /// evdev key codes, pressed in order and released in reverse.
    Key { codes: Vec<u32> },
    Ping,
    Stop,
}

fn number(value: &Value, key: &str) -> Result<f64, String> {
    let n = value
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("missing number \"{key}\""))?;
    if !n.is_finite() || n.abs() > 100_000.0 {
        return Err(format!("\"{key}\" is not a usable coordinate or amount: {n}"));
    }
    Ok(n)
}

fn optional_number(value: &Value, key: &str) -> Result<Option<f64>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => number(value, key).map(Some),
    }
}

/// A button by name ("left", "right", "middle") or by its evdev number.
pub fn button_code(value: &Value) -> Result<u32, String> {
    match value.get("button") {
        None | Some(Value::Null) => Ok(BTN_LEFT),
        Some(Value::String(name)) => match name.to_ascii_lowercase().as_str() {
            "left" | "1" | "primary" => Ok(BTN_LEFT),
            "right" | "3" | "secondary" => Ok(BTN_RIGHT),
            "middle" | "2" | "auxiliary" => Ok(BTN_MIDDLE),
            other => Err(format!("unknown mouse button \"{other}\": use left, right or middle")),
        },
        Some(other) => other
            .as_u64()
            .filter(|n| (1..=0x2ff).contains(n))
            .map(|n| n as u32)
            .ok_or_else(|| "button must be left, right, middle or an evdev number".to_string()),
    }
}

fn key_codes(value: &Value) -> Result<Vec<u32>, String> {
    let codes = value
        .get("codes")
        .and_then(Value::as_array)
        .ok_or_else(|| "missing \"codes\": a list of evdev key codes".to_string())?;
    if codes.is_empty() || codes.len() > 8 {
        return Err("codes must hold 1 to 8 keys".to_string());
    }
    codes
        .iter()
        .map(|c| {
            c.as_u64()
                .filter(|n| (1..=0x2ff).contains(n))
                .map(|n| n as u32)
                .ok_or_else(|| format!("{c} is not an evdev key code (1 to 767)"))
        })
        .collect()
}

/// Read one command line. Unknown commands and bad numbers are refused here, before any
/// desktop call, so a typo can never turn into input somewhere unexpected.
pub fn parse_action(value: &Value) -> Result<Action, String> {
    let command = value
        .get("cmd")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing \"cmd\"".to_string())?;
    match command {
        "move" => Ok(Action::Move { x: number(value, "x")?, y: number(value, "y")? }),
        "move_relative" | "relative" => {
            Ok(Action::MoveRelative { dx: number(value, "dx")?, dy: number(value, "dy")? })
        }
        "click" => {
            let count = match value.get("count").and_then(Value::as_u64) {
                None => 1,
                Some(n) if (1..=3).contains(&n) => n as u8,
                Some(n) => return Err(format!("count must be 1, 2 or 3 (got {n})")),
            };
            Ok(Action::Click {
                x: optional_number(value, "x")?,
                y: optional_number(value, "y")?,
                button: button_code(value)?,
                count,
            })
        }
        "down" => Ok(Action::Down { button: button_code(value)? }),
        "up" => Ok(Action::Up { button: button_code(value)? }),
        "drag" => Ok(Action::Drag {
            from_x: number(value, "fromX")?,
            from_y: number(value, "fromY")?,
            to_x: number(value, "toX")?,
            to_y: number(value, "toY")?,
            button: button_code(value)?,
        }),
        "scroll" => Ok(Action::Scroll { dx: optional_number(value, "dx")?.unwrap_or(0.0), dy: optional_number(value, "dy")?.unwrap_or(0.0) }),
        "type" => {
            let text = value
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "missing \"text\"".to_string())?;
            if text.is_empty() {
                return Err("text is empty".to_string());
            }
            if text.len() > 20_000 {
                return Err("text is longer than 20,000 bytes; send it in parts".to_string());
            }
            Ok(Action::Type { text: text.to_string() })
        }
        "key" => Ok(Action::Key { codes: key_codes(value)? }),
        "ping" => Ok(Action::Ping),
        "stop" => Ok(Action::Stop),
        other => Err(format!(
            "unknown command \"{other}\": use move, move_relative, click, down, up, drag, scroll, type, key, ping or stop"
        )),
    }
}

/// Split text so every piece is at most `MAX_TEXT_BYTES` bytes and whole characters: `ei_text`
/// refuses anything longer, and cutting inside a character would corrupt Arabic or an emoji.
pub fn text_chunks(text: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut last_fit = 0;
    for (at, ch) in text.char_indices() {
        let end = at + ch.len_utf8();
        if end - start > MAX_TEXT_BYTES {
            chunks.push(&text[start..last_fit]);
            start = at;
        }
        last_fit = end;
    }
    if start < text.len() {
        chunks.push(&text[start..]);
    }
    chunks
}

/// Whether a point lies in one of the screens the desktop offered. With no regions the
/// desktop said nothing to check against, and the point is allowed through.
pub fn region_allows(regions: &[Region], x: f64, y: f64) -> bool {
    regions.is_empty()
        || regions
            .iter()
            .any(|(rx, ry, w, h)| x >= *rx && y >= *ry && x < rx + w && y < ry + h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_every_command_the_sidecar_sends() {
        assert_eq!(
            parse_action(&json!({"cmd":"move","x":10,"y":20})).unwrap(),
            Action::Move { x: 10.0, y: 20.0 }
        );
        assert_eq!(
            parse_action(&json!({"cmd":"move_relative","dx":-3,"dy":4})).unwrap(),
            Action::MoveRelative { dx: -3.0, dy: 4.0 }
        );
        assert_eq!(
            parse_action(&json!({"cmd":"click","x":1,"y":2,"button":"right","count":2})).unwrap(),
            Action::Click { x: Some(1.0), y: Some(2.0), button: BTN_RIGHT, count: 2 }
        );
        assert_eq!(parse_action(&json!({"cmd":"down"})).unwrap(), Action::Down { button: BTN_LEFT });
        assert_eq!(parse_action(&json!({"cmd":"up","button":"middle"})).unwrap(), Action::Up { button: BTN_MIDDLE });
        assert_eq!(
            parse_action(&json!({"cmd":"drag","fromX":1,"fromY":2,"toX":3,"toY":4})).unwrap(),
            Action::Drag { from_x: 1.0, from_y: 2.0, to_x: 3.0, to_y: 4.0, button: BTN_LEFT }
        );
        assert_eq!(
            parse_action(&json!({"cmd":"scroll","dy":-3})).unwrap(),
            Action::Scroll { dx: 0.0, dy: -3.0 }
        );
        assert_eq!(parse_action(&json!({"cmd":"type","text":"مرحبا"})).unwrap(), Action::Type { text: "مرحبا".into() });
        assert_eq!(parse_action(&json!({"cmd":"key","codes":[29,46]})).unwrap(), Action::Key { codes: vec![29, 46] });
        assert_eq!(parse_action(&json!({"cmd":"ping"})).unwrap(), Action::Ping);
    }

    #[test]
    fn refuses_bad_commands_before_they_reach_the_desktop() {
        assert!(parse_action(&json!({"cmd":"nope"})).unwrap_err().contains("unknown command"));
        assert!(parse_action(&json!({"cmd":"move","x":1})).is_err(), "a missing y is refused");
        assert!(parse_action(&json!({"cmd":"move","x":1e9,"y":0})).is_err(), "absurd coordinates are refused");
        assert!(parse_action(&json!({"cmd":"move","x":"left","y":0})).is_err());
        assert!(parse_action(&json!({"cmd":"click","button":"thumb"})).unwrap_err().contains("unknown mouse button"));
        assert!(parse_action(&json!({"cmd":"click","count":9})).is_err());
        assert!(parse_action(&json!({"cmd":"key","codes":[]})).is_err());
        assert!(parse_action(&json!({"cmd":"key","codes":[0]})).is_err());
        assert!(parse_action(&json!({"cmd":"type","text":""})).is_err());
        assert!(parse_action(&json!({})).is_err(), "no command at all");
    }

    #[test]
    fn buttons_keep_their_evdev_numbers() {
        assert_eq!(button_code(&json!({"button":"left"})).unwrap(), 0x110);
        assert_eq!(button_code(&json!({"button":"RIGHT"})).unwrap(), 0x111);
        assert_eq!(button_code(&json!({"button":"3"})).unwrap(), 0x111);
        assert_eq!(button_code(&json!({"button":274})).unwrap(), 274);
        assert!(button_code(&json!({"button":9999})).is_err());
        assert_eq!(button_code(&json!({})).unwrap(), BTN_LEFT, "no button means left");
    }

    #[test]
    fn text_is_split_on_characters_and_under_the_limit() {
        assert_eq!(text_chunks("short"), vec!["short"]);
        assert!(text_chunks("").is_empty());
        // Arabic is two bytes a letter: 200 letters are 400 bytes, so two pieces.
        let arabic = "م".repeat(200);
        let pieces = text_chunks(&arabic);
        assert_eq!(pieces.len(), 2);
        assert!(pieces.iter().all(|p| p.len() <= MAX_TEXT_BYTES));
        assert_eq!(pieces.concat(), arabic, "nothing is lost or split mid-character");
        // An emoji is four bytes and must stay whole.
        for piece in text_chunks(&"😀".repeat(100)) {
            assert!(piece.len() <= MAX_TEXT_BYTES);
            assert!(piece.chars().all(|c| c == '😀'));
        }
    }

    #[test]
    fn a_point_must_be_on_a_screen_the_desktop_offered() {
        let screens = [(0.0, 0.0, 1920.0, 1080.0), (1920.0, 0.0, 1280.0, 1024.0)];
        assert!(region_allows(&screens, 0.0, 0.0));
        assert!(region_allows(&screens, 1919.0, 1079.0));
        assert!(region_allows(&screens, 2000.0, 10.0), "the second screen");
        assert!(!region_allows(&screens, 1920.0, 1080.0), "the gap under the second screen");
        assert!(!region_allows(&screens, 5000.0, 10.0));
        assert!(region_allows(&[], 5000.0, 10.0), "no regions: nothing to refuse against");
    }
}
