//! src-tauri\src\settings\store.rs — the generic-tree read-modify-write side
//! of vidar.json. Every `save_*` command edits
//! the file as an untyped JSON tree, not through `VidarConfig`, so a key this
//! build doesn't model still survives a save — `with_config_root` is the one
//! place that pattern lives now, instead of five copies of it.

use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;

/// One process-wide lock around every vidar.json read-modify-write
/// (`with_config_root_at`), migration included.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// Strips a leading UTF-8 BOM (`\u{FEFF}`, three bytes on disk) — some editors on Windows
/// write one, and `serde_json::from_str` treats it as invalid JSON rather than whitespace,
/// so a config saved by such an editor would fail to parse.
pub(crate) fn strip_bom(text: &str) -> &str {
    crate::fsx::strip_bom(text)
}

/// Shared read side for every `save_*` command's generic-tree edit. An absent file
/// is the only case that defaults to an empty object — any other read error (a
/// locked file, denied permissions, ...) or an unparsable file returns `Err` so the
/// caller's write never fires and vidar.json is never wiped down to the one key
/// that command was writing.
fn read_root_at(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(strip_bom(&text))
            .map_err(|e| format!("vidar.json parse error, not overwriting: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(format!("vidar.json read error, not overwriting: {e}")),
    }
}

// Write-then-rename via crate::fsx: a crash mid-save must not truncate the
// config, and a unique tmp name means two overlapping saves can't clobber
// each other's tmp file.
fn write_config_at(path: &Path, root: &Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(path, json.as_bytes())
}

/// Read-modify-write over vidar.json's generic JSON tree: read (NotFound-only
/// default, everything else refused per `read_root`), let `patch` mutate the
/// root object, write atomically. Every `save_*` command in config.rs is one
/// call to this.
pub fn with_config_root<F>(patch: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_json::Map<String, Value>) -> Result<(), String>,
{
    with_config_root_at(&crate::paths::config_path(), patch)
}

/// Same as `with_config_root`, over an explicit path — the seam `config.rs`'s
/// migration-version persist uses so it stays testable against a temp file
/// instead of the real vidar.json (also usable by tests here).
///
/// Serialized: every call holds `CONFIG_LOCK` from read to rename, so two
/// in-process writers (a `save_*`, `patch_settings`, the load-time migration)
/// can never interleave and have the later rename publish a stale snapshot.
/// `patch` must not call back into this function (the lock is not reentrant).
pub(crate) fn with_config_root_at<F>(path: &Path, patch: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_json::Map<String, Value>) -> Result<(), String>,
{
    with_config_root_then_at(path, patch, || Ok(()))
}

/// `with_config_root_at` plus `after`, run under the same lock once the config write has succeeded (a failed
/// patch or write never runs it): a second file that must follow vidar.json, never lead it.
pub(crate) fn with_config_root_then_at<F, G>(path: &Path, patch: F, after: G) -> Result<(), String>
where
    F: FnOnce(&mut serde_json::Map<String, Value>) -> Result<(), String>,
    G: FnOnce() -> Result<(), String>,
{
    // A poisoned lock only means an earlier patch panicked; the file on disk
    // is still whole (atomic rename), so carry on rather than refuse forever.
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut root = read_root_at(path)?;
    let obj = root.as_object_mut().ok_or("vidar.json root is not an object")?;
    patch(obj)?;
    write_config_at(path, &root)?;
    after()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_defaults_to_an_empty_object() {
        let path = std::env::temp_dir().join("vidar-settings-store-test-missing.json");
        let _ = std::fs::remove_file(&path);
        let root = read_root_at(&path).expect("missing file is not an error");
        assert_eq!(root, Value::Object(Default::default()));
    }

    #[test]
    fn unparsable_file_is_an_error_not_a_wipe() {
        let path = std::env::temp_dir().join("vidar-settings-store-test-unparsable.json");
        std::fs::write(&path, b"not json").unwrap();
        let result = read_root_at(&path);
        let _ = std::fs::remove_file(&path);
        assert!(result.is_err(), "unparsable file must not be treated as absent");
    }

    #[test]
    fn a_locked_file_is_an_error_not_a_wipe() {
        use std::os::windows::fs::OpenOptionsExt;
        let path = std::env::temp_dir().join("vidar-settings-store-test-locked.json");
        std::fs::write(&path, b"{\"fontSize\":14}").unwrap();
        // No FILE_SHARE_READ/WRITE: the handle stays open through this call, so the
        // read below hits a sharing violation — the same shape as another process
        // (or Vidar itself, mid-write) holding the file open.
        let _held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .expect("open exclusively");
        let result = read_root_at(&path);
        drop(_held);
        let _ = std::fs::remove_file(&path);
        assert!(result.is_err(), "a locked file must not be treated as absent");
    }

    #[test]
    fn strip_bom_drops_only_a_leading_bom() {
        assert_eq!(strip_bom("\u{FEFF}{}"), "{}");
        assert_eq!(strip_bom("{}"), "{}");
    }

    #[test]
    fn a_leading_bom_does_not_break_parsing() {
        let path = std::env::temp_dir().join("vidar-settings-store-test-bom.json");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"{\"fontSize\":14}");
        std::fs::write(&path, &bytes).unwrap();
        let result = read_root_at(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(result.unwrap(), serde_json::json!({ "fontSize": 14 }));
    }
}
