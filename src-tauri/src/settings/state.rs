//! src-tauri\src\settings\state.rs — `vidar-state.json`: the
//! file-backed tier for churny UI state (theme, rightbar, split widths, ...)
//! that section 7's decision moved out of `localStorage` (WebView2's copy
//! sits under `%LOCALAPPDATA%`, not the Vidar folder) without putting it in
//! the hand-edited vidar.json. Same read-modify-write shape as
//! `settings::store`, but over the whole untyped object — there is no typed
//! schema here, `prefs.ts` (batch B) owns the key registry on the TS side.
//!
//! `NotFound` reads as `{}` (a fresh install, or every key cleared); any
//! other read or parse error refuses instead of overwriting, same rule as
//! vidar.json — a stale-but-parseable file is worth more than the silent
//! wipe a "just start from empty" fallback would have caused (settings-2 in
//! the audit, the bug this module structure exists to not repeat).

use std::path::Path;

use serde_json::Value;

fn read_root_at(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(crate::settings::store::strip_bom(&text)).map_err(|e| {
            format!("{} parse error, not overwriting (fix or delete the file): {e}", path.display())
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(format!("{} read error, not overwriting: {e}", path.display())),
    }
}

fn write_root_at(path: &Path, root: &Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(path, json.as_bytes())
}

/// The plain (non-command) read, so `main.rs`'s pre-paint theme injection can
/// call it during `setup()` before any webview exists to receive a command.
pub fn load() -> Result<Value, String> {
    read_root_at(&crate::paths::ui_state_path())
}

/// A patch whose merged result, serialized compactly, is longer than this is
/// refused before any write (exactly this long is accepted; the pretty-printed
/// file on disk runs somewhat larger) — `prefs-core.ts` checks the same bound
/// the same way. Its key registry is small, churny UI state, so a caller
/// sending megabytes is a bug upstream, not a file vidar-state.json should
/// grow to.
const MAX_STATE_FILE_BYTES: usize = 1024 * 1024;

/// A value whose compact JSON is longer than this is logged as `{"bytes":N}`.
const HISTORY_VALUE_CAP: usize = 512;

/// One changed key: (key, from, to); `None` = absent.
type Change = (String, Option<Value>, Option<Value>);

fn history_value(v: &Option<Value>) -> Value {
    match v {
        None => Value::Null,
        Some(v) => {
            let n = serde_json::to_string(v).map(|s| s.len()).unwrap_or(0);
            if n > HISTORY_VALUE_CAP {
                serde_json::json!({ "bytes": n })
            } else {
                v.clone()
            }
        }
    }
}

/// Appends one JSON line per change to `state-history.jsonl` beside the state
/// file: `{"at":"<UTC RFC3339>","key":..,"from":..,"to":..}`. Append-only, never
/// truncated. Best effort: a failure is logged once and never fails the patch.
fn append_history(state_path: &Path, changes: &[Change]) {
    use std::io::Write;
    static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if changes.is_empty() {
        return;
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let at = crate::driver_mode::utc_stamp(secs);
    let mut text = String::new();
    for (key, from, to) in changes {
        let line = serde_json::json!({
            "at": at,
            "key": key,
            "from": history_value(from),
            "to": history_value(to),
        });
        text.push_str(&line.to_string());
        text.push('\n');
    }
    let file = state_path.with_file_name("state-history.jsonl");
    let result = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .and_then(|mut f| f.write_all(text.as_bytes()));
    if let Err(e) = result {
        if !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            eprintln!("state history append failed ({}): {e}", file.display());
        }
    }
}

fn merge_and_write_at(path: &Path, entries: serde_json::Map<String, Value>) -> Result<(), String> {
    let mut root = read_root_at(path)?;
    let obj = root.as_object_mut().ok_or("vidar-state.json root is not an object")?;
    let mut changes: Vec<Change> = Vec::new();
    for (k, v) in entries {
        let before = obj.get(&k).cloned();
        // A null value clears the key rather than persisting a literal null —
        // the only way `prefs.ts` can ask for a key to go away through this
        // generic-tree merge.
        let after = if v.is_null() { None } else { Some(v) };
        if before != after {
            changes.push((k.clone(), before, after.clone()));
        }
        match after {
            None => {
                obj.remove(&k);
            }
            Some(v) => {
                obj.insert(k, v);
            }
        }
    }
    let json = serde_json::to_string(&root).map_err(|e| e.to_string())?;
    if json.len() > MAX_STATE_FILE_BYTES {
        return Err(format!(
            "vidar-state.json would exceed {MAX_STATE_FILE_BYTES} bytes ({} bytes); patch refused",
            json.len()
        ));
    }
    write_root_at(path, &root)?;
    // Still under `patch_state`'s lock, so history lines stay in merge order.
    append_history(path, &changes);
    Ok(())
}

// Async so Tauri runs them on its async runtime, not the main thread: a
// debounced prefs flush does file I/O (read, merge, atomic write) that should
// never stall the UI event loop.
#[tauri::command]
pub async fn read_state() -> Result<Value, String> {
    load()
}

#[tauri::command]
pub async fn patch_state(entries: serde_json::Map<String, Value>) -> Result<(), String> {
    // Off the main thread two patches can now overlap; the lock keeps each
    // read-merge-write whole, as the main thread's serial dispatch did before.
    static PATCH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = PATCH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    merge_and_write_at(&crate::paths::ui_state_path(), entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn missing_file_reads_as_empty_object() {
        let path = temp_path("vidar-state-test-missing.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_root_at(&path).unwrap(), Value::Object(Default::default()));
    }

    #[test]
    fn unparsable_file_refuses_and_is_left_untouched() {
        let path = temp_path("vidar-state-test-unparsable.json");
        let original = b"not json".to_vec();
        std::fs::write(&path, &original).unwrap();

        let read_err = read_root_at(&path).unwrap_err();
        assert!(read_err.contains("vidar-state-test-unparsable.json"), "names the path: {read_err}");
        assert!(read_err.contains("expected"), "carries the parse error: {read_err}");

        let mut entries = serde_json::Map::new();
        entries.insert("theme".to_string(), Value::from("jager"));
        let patch_err = merge_and_write_at(&path, entries);
        assert!(patch_err.is_err(), "an unparsable file must refuse the patch, not overwrite it");

        let on_disk = std::fs::read(&path).unwrap();
        assert_eq!(on_disk, original, "an unparsable file must not be rewritten");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn patch_state_merges_into_a_missing_file() {
        let path = temp_path("vidar-state-test-merge-missing.json");
        let _ = std::fs::remove_file(&path);

        let mut entries = serde_json::Map::new();
        entries.insert("theme".to_string(), Value::from("jager"));
        merge_and_write_at(&path, entries).expect("patch");

        let root = read_root_at(&path).unwrap();
        assert_eq!(root["theme"], Value::from("jager"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn patch_state_merges_without_dropping_other_keys() {
        let path = temp_path("vidar-state-test-merge-existing.json");
        std::fs::write(&path, br#"{"theme":"zero","rightbarWidth":240}"#).unwrap();

        let mut entries = serde_json::Map::new();
        entries.insert("theme".to_string(), Value::from("panzer"));
        merge_and_write_at(&path, entries).expect("patch");

        let root = read_root_at(&path).unwrap();
        assert_eq!(root["theme"], Value::from("panzer"));
        assert_eq!(root["rightbarWidth"], Value::from(240));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_null_value_deletes_the_key() {
        let path = temp_path("vidar-state-test-null-deletes.json");
        std::fs::write(&path, br#"{"theme":"zero","rightbarWidth":240}"#).unwrap();

        let mut entries = serde_json::Map::new();
        entries.insert("theme".to_string(), Value::Null);
        merge_and_write_at(&path, entries).expect("patch");

        let root = read_root_at(&path).unwrap();
        assert!(root.get("theme").is_none(), "null must delete the key: {root}");
        assert_eq!(root["rightbarWidth"], Value::from(240));
        let _ = std::fs::remove_file(&path);
    }

    fn history_dir(name: &str) -> std::path::PathBuf {
        let dir = temp_path(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn history_lines(dir: &Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("state-history.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn one(k: &str, v: Value) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        m.insert(k.to_string(), v);
        m
    }

    #[test]
    fn history_logs_changed_new_and_unchanged_keys() {
        let dir = history_dir("vidar-state-test-hist-change");
        let path = dir.join("vidar-state.json");
        std::fs::write(&path, br#"{"rightbar.width":268}"#).unwrap();

        merge_and_write_at(&path, one("rightbar.width", Value::from(220))).unwrap();
        merge_and_write_at(&path, one("rightbar.width", Value::from(220))).unwrap();
        merge_and_write_at(&path, one("theme", Value::from("jager"))).unwrap();

        let lines = history_lines(&dir);
        assert_eq!(lines.len(), 2, "unchanged value writes nothing: {lines:?}");
        assert_eq!(lines[0]["key"], "rightbar.width");
        assert_eq!(lines[0]["from"], 268);
        assert_eq!(lines[0]["to"], 220);
        assert!(lines[0]["at"].as_str().unwrap().ends_with('Z'));
        assert_eq!(lines[1]["key"], "theme");
        assert_eq!(lines[1]["from"], Value::Null);
        assert_eq!(lines[1]["to"], "jager");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_logs_a_delete_with_null_to() {
        let dir = history_dir("vidar-state-test-hist-delete");
        let path = dir.join("vidar-state.json");
        std::fs::write(&path, br#"{"theme":"zero"}"#).unwrap();

        merge_and_write_at(&path, one("theme", Value::Null)).unwrap();
        merge_and_write_at(&path, one("theme", Value::Null)).unwrap();

        let lines = history_lines(&dir);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert_eq!(lines[0]["from"], "zero");
        assert!(lines[0].get("to").is_some() && lines[0]["to"].is_null());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_logs_an_oversize_value_as_bytes() {
        let dir = history_dir("vidar-state-test-hist-big");
        let path = dir.join("vidar-state.json");
        let big = "x".repeat(600);

        merge_and_write_at(&path, one("blob", Value::from(big))).unwrap();

        let lines = history_lines(&dir);
        assert_eq!(lines[0]["to"], serde_json::json!({ "bytes": 602 }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_history_append_does_not_fail_the_patch() {
        let dir = history_dir("vidar-state-test-hist-fail");
        let path = dir.join("vidar-state.json");
        // A directory squatting on the history file name makes the open fail.
        std::fs::create_dir_all(dir.join("state-history.jsonl")).unwrap();

        merge_and_write_at(&path, one("theme", Value::from("jager"))).expect("patch still succeeds");
        assert_eq!(read_root_at(&path).unwrap()["theme"], "jager");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_patch_that_would_exceed_the_cap_is_refused_and_leaves_the_file_untouched() {
        let path = temp_path("vidar-state-test-cap.json");
        let original = br#"{"theme":"zero"}"#.to_vec();
        std::fs::write(&path, &original).unwrap();

        let mut entries = serde_json::Map::new();
        entries.insert("huge".to_string(), Value::from("x".repeat(MAX_STATE_FILE_BYTES + 1)));
        let err = merge_and_write_at(&path, entries).unwrap_err();
        assert!(err.contains("exceed"), "{err}");

        let on_disk = std::fs::read(&path).unwrap();
        assert_eq!(on_disk, original, "a refused patch must not touch the file");
        let _ = std::fs::remove_file(&path);
    }
}
