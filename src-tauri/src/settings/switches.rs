//! src-tauri\src\settings\switches.rs — one named registry for the three
//! bottom-bar switches (close-lock, auto-speak, auto-send), replacing the
//! three copy-pasted structs + six `#[tauri::command]`s that used to live in
//! `bridge.rs`. Each switch is a `{ <field>: bool, atMs: u64 }` file
//! at its own path (`crate::paths`), field name `locked` for close-lock and
//! `on` for the other two — that split predates this file and stays, so the
//! bytes on disk are unchanged (`tools\release\swap-release.ps1` parses
//! close-lock.json directly; see `bytes_are_unchanged_*` below).
//!
//! `bridge.rs`'s six old per-switch commands (`read_close_lock`,
//! `set_close_lock`, ...) are gone; every TS caller
//! goes through `read_switch`/`set_switch` by name.

use std::path::{Path, PathBuf};

use serde_json::Value;

struct SwitchDef {
    name: &'static str,
    path: fn() -> PathBuf,
    /// "locked" (close-lock) or "on" (auto-speak, auto-send)
    field: &'static str,
}

const SWITCHES: &[SwitchDef] = &[
    SwitchDef { name: "close-lock", path: crate::paths::close_lock_path, field: "locked" },
    SwitchDef { name: "auto-speak", path: crate::paths::auto_speak_path, field: "on" },
    SwitchDef { name: "auto-send", path: crate::paths::auto_send_path, field: "on" },
];

fn find(name: &str) -> Option<&'static SwitchDef> {
    SWITCHES.iter().find(|s| s.name == name)
}

/// Absent file or an unknown switch name = off/unlocked. A UTF-8 BOM is stripped. For the
/// close-lock (`locked` field) an existing file that cannot be read or parsed counts as LOCKED,
/// mirroring `swap-release.ps1` (`catch { $locked = $true }`); a parsed file's `locked` follows
/// PowerShell `[bool]` (absent/null/false/0/"" = unlocked, anything else locked). The other two
/// switches keep off on any error.
fn read_switch_at(path: &Path, field: &str) -> bool {
    let fail_locked = field == "locked";
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return fail_locked,
    };
    let Ok(v) = serde_json::from_str::<Value>(crate::settings::store::strip_bom(&text)) else {
        return fail_locked;
    };
    if !fail_locked {
        return v.get(field).and_then(Value::as_bool).unwrap_or(false);
    }
    match v.get(field) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(true, |f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Same two-key shape every switch file already used: `{ <field>: on, atMs }`,
/// field first — `serde_json::Map` preserves insertion order (`preserve_order`,
/// Cargo.toml), so this is byte-for-byte what the old per-switch structs wrote.
fn write_switch_at(path: &Path, field: &str, on: bool) -> Result<(), String> {
    let mut obj = serde_json::Map::new();
    obj.insert(field.to_string(), Value::Bool(on));
    obj.insert("atMs".to_string(), Value::from(crate::fsx::now_ms()));
    let text = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(path, text.as_bytes())
}

#[tauri::command]
pub fn read_switch(name: String) -> bool {
    match find(&name) {
        Some(def) => read_switch_at(&(def.path)(), def.field),
        None => false,
    }
}

#[tauri::command]
pub fn set_switch(name: String, on: bool) -> Result<bool, String> {
    let def = find(&name).ok_or_else(|| format!("unknown switch \"{name}\""))?;
    write_switch_at(&(def.path)(), def.field, on)
        .map_err(|e| format!("could not write {name}: {e}"))?;
    Ok(on)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn unknown_switch_name_reads_false_and_set_fails() {
        assert!(!read_switch("not-a-switch".to_string()));
        assert!(set_switch("not-a-switch".to_string(), true).is_err());
    }

    #[test]
    fn round_trips_a_bool_switch_true_and_false() {
        let path = temp_path("vidar-switches-test-roundtrip.json");
        let _ = std::fs::remove_file(&path);
        write_switch_at(&path, "on", true).expect("write on");
        assert!(read_switch_at(&path, "on"));
        write_switch_at(&path, "on", false).expect("write off");
        assert!(!read_switch_at(&path, "on"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn auto_send_is_registered_with_the_on_field_and_its_own_file() {
        let def = find("auto-send").expect("auto-send registered");
        assert_eq!(def.field, "on");
        assert!((def.path)().ends_with("auto-send.json"));
        assert!(find("auto-speak").is_some() && find("close-lock").is_some());
    }

    #[test]
    fn missing_file_reads_false() {
        let path = temp_path("vidar-switches-test-missing.json");
        let _ = std::fs::remove_file(&path);
        assert!(!read_switch_at(&path, "locked"));
    }

    #[test]
    fn malformed_file_reads_false_for_on_switches_not_a_panic() {
        let path = temp_path("vidar-switches-test-malformed.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(!read_switch_at(&path, "on"));
        let _ = std::fs::remove_file(&path);
    }

    // swap-release.ps1 treats an unparsable close-lock.json as locked.
    #[test]
    fn malformed_close_lock_reads_locked() {
        let path = temp_path("vidar-switches-test-malformed-lock.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(read_switch_at(&path, "locked"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn unreadable_close_lock_reads_locked() {
        // A directory at the path: exists, read_to_string fails with a non-NotFound error.
        let path = temp_path("vidar-switches-test-dir-lock");
        std::fs::create_dir_all(&path).unwrap();
        assert!(read_switch_at(&path, "locked"));
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn bom_prefixed_close_lock_is_read() {
        let path = temp_path("vidar-switches-test-bom-lock.json");
        std::fs::write(&path, b"\xEF\xBB\xBF{\"locked\":true,\"atMs\":1}").unwrap();
        assert!(read_switch_at(&path, "locked"));
        std::fs::write(&path, b"\xEF\xBB\xBF{\"locked\":false,\"atMs\":1}").unwrap();
        assert!(!read_switch_at(&path, "locked"));
        let _ = std::fs::remove_file(&path);
    }

    /// Pins the on-disk shape: exactly two keys, the switch's own field
    /// spelled correctly and first, `atMs` second and numeric. Both field
    /// names in use (`locked`, `on`) are checked — `swap-release.ps1` parses
    /// close-lock.json's `locked` field directly, so a rename here is a
    /// silent break for that script, not a compile error.
    #[test]
    fn bytes_are_unchanged_for_locked_field() {
        let path = temp_path("vidar-switches-test-shape-locked.json");
        write_switch_at(&path, "locked", true).expect("write");
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let v: Value = serde_json::from_str(&text).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 2, "exactly {{locked, atMs}}: {text}");
        assert_eq!(obj.get("locked"), Some(&Value::Bool(true)));
        assert!(obj.get("atMs").and_then(Value::as_u64).is_some());
        let locked_idx = text.find("\"locked\"").expect("locked key present");
        let at_ms_idx = text.find("\"atMs\"").expect("atMs key present");
        assert!(locked_idx < at_ms_idx, "locked must be written before atMs: {text}");
    }

    #[test]
    fn bytes_are_unchanged_for_on_field() {
        let path = temp_path("vidar-switches-test-shape-on.json");
        write_switch_at(&path, "on", true).expect("write");
        let text = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let v: Value = serde_json::from_str(&text).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 2, "exactly {{on, atMs}}: {text}");
        assert_eq!(obj.get("on"), Some(&Value::Bool(true)));
        assert!(obj.get("atMs").and_then(Value::as_u64).is_some());
        let on_idx = text.find("\"on\"").expect("on key present");
        let at_ms_idx = text.find("\"atMs\"").expect("atMs key present");
        assert!(on_idx < at_ms_idx, "on must be written before atMs: {text}");
    }
}
