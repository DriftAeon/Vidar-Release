//! Hand-editable window behaviour. Empty summon chord reserves no global key.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowTrayCfg {
    pub close_to_tray: bool,
    pub summon_hotkey: String,
}

/// RegisterHotKey modifiers and virtual key; the supported grammar is deliberately small.
pub(crate) fn parse_chord(chord: &str) -> Result<Option<(u32, u32)>, String> {
    if chord.trim().is_empty() {
        return Ok(None);
    }
    let mut mods = 0;
    let mut key = None;
    for part in chord.split('+') {
        let part = part.trim().to_ascii_uppercase();
        let modifier = match part.as_str() {
            "CTRL" | "CONTROL" => Some(2),
            "ALT" => Some(1),
            "SHIFT" => Some(4),
            "SUPER" | "WIN" | "META" => Some(8),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if mods & modifier != 0 {
                return Err("summon hotkey repeats a modifier".into());
            }
            mods |= modifier;
            continue;
        }
        let vk = match part.as_str() {
            "SPACE" => 0x20,
            "TAB" => 0x09,
            "ENTER" | "RETURN" => 0x0d,
            "ESC" | "ESCAPE" => 0x1b,
            s if s.len() == 1 && s.as_bytes()[0].is_ascii_alphanumeric() => s.as_bytes()[0] as u32,
            s if s.starts_with('F') => s[1..].parse::<u32>().ok()
                .filter(|n| (1..=24).contains(n)).map(|n| 0x6f + n)
                .ok_or("summon hotkey needs F1-F24")?,
            _ => return Err("summon hotkey needs a letter, digit, F1-F24, Space, Tab, Enter or Escape".into()),
        };
        if key.replace(vk).is_some() {
            return Err("summon hotkey needs exactly one key".into());
        }
    }
    if mods == 0 {
        return Err("summon hotkey needs at least one modifier".into());
    }
    Ok(Some((mods | 0x4000, key.ok_or("summon hotkey is missing its key")?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_settings_preserve_old_config_defaults_and_round_trip() {
        let cfg: WindowTrayCfg = serde_json::from_str("{}").unwrap();
        assert!(!cfg.close_to_tray);
        assert_eq!(parse_chord(&cfg.summon_hotkey).unwrap(), None);
        let raw = serde_json::json!({"closeToTray": true, "summonHotkey": "Ctrl+Alt+V"});
        let cfg: WindowTrayCfg = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(serde_json::to_value(cfg).unwrap(), raw);
        assert!(serde_json::from_str::<WindowTrayCfg>(r#"{"closeToTray":"yes"}"#).is_err());
    }

    #[test]
    fn tray_chord_rejects_ambiguous_or_unmodified_bindings() {
        for chord in ["V", "Ctrl", "Ctrl+Ctrl+V", "Alt+V+X", "Ctrl++V", "Ctrl+F25", "Ctrl+Mouse1"] {
            assert!(parse_chord(chord).is_err(), "{chord}");
        }
        assert_eq!(parse_chord("  ").unwrap(), None);
        assert_eq!(parse_chord("Ctrl+Alt+V").unwrap(), Some((0x4003, b'V' as u32)));
        assert_eq!(parse_chord("Win+Shift+F24").unwrap(), Some((0x400c, 0x87)));
    }
}
