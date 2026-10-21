// Dropped files: the path guard and bounded readers behind workbench file blocks, and the
// pin-checked character model read (the pin lives in the character pack, crate::characters).

use std::path::PathBuf;

use serde::Serialize;

use super::clips::PNG_SIG;
use super::open_drop_file;

/* ---- dropped files (workbench file blocks) ----
   Trusted-local-frontend readers of eligible files: the path is a string from
   the webview and nothing here can prove it came from a drop. The guards decide
   what we're willing to RENDER, not where the path came from. */

const TEXT_EXT: &[&str] = &["md", "txt", "log", "json", "ps1", "ts", "rs", "toml", "yaml", "yml", "css", "html"];
const MAX_DROP_TEXT_PREVIEW: usize = 256 * 1024;
const MAX_DROP_PNG: usize = 8 * 1024 * 1024;
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropText {
    name: String,
    /// file size observed at metadata time — not a snapshot; the file may grow
    bytes: u64,
    text: String,
    lossy: bool,
    truncated: bool,
}

/// Drive-rooted, parsed by component: no ADS colons, no reserved DOS device
/// basenames (any extension), no trailing dots/spaces. `\\?\`, `\\.\` and UNC
/// are rejected — the drop event supplies plain drive paths. A mapped drive is
/// still not guaranteed local; the README says so.
pub(super) fn validate_drop_path(path: &str, allowed_ext: &[&str]) -> Result<PathBuf, String> {
    let b = path.as_bytes();
    let rooted = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    if !rooted {
        return Err("path must be drive-rooted (X:\\...)".into());
    }
    let p = PathBuf::from(path);
    for comp in p.components() {
        let std::path::Component::Normal(os) = comp else { continue };
        let s = os.to_string_lossy();
        if s.contains(':') {
            return Err("alternate data streams are not allowed".into());
        }
        if s.ends_with('.') || s.ends_with(' ') {
            return Err("component ends with a dot or space".into());
        }
        let stem = s.split('.').next().unwrap_or("").to_uppercase();
        if RESERVED.contains(&stem.as_str()) {
            return Err(format!("reserved device name: {s}"));
        }
    }
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !allowed_ext.contains(&ext.as_str()) {
        return Err(format!(".{ext} is not a supported type"));
    }
    Ok(p)
}

#[tauri::command]
pub fn read_drop_text(path: String) -> Result<DropText, String> {
    let p = validate_drop_path(&path, TEXT_EXT)?;
    let (md, mut buf, truncated) = open_drop_file(&p, MAX_DROP_TEXT_PREVIEW)?;
    // a multibyte char split by the preview boundary is not corruption: back
    // up to the last complete sequence before deciding `lossy`
    if truncated {
        if let Err(e) = std::str::from_utf8(&buf) {
            if e.error_len().is_none() {
                buf.truncate(e.valid_up_to());
            }
        }
    }
    let lossy = std::str::from_utf8(&buf).is_err();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(DropText { name, bytes: md.len(), text, lossy, truncated })
}

/// Raw bytes back (`tauri::ipc::Response` → ArrayBuffer in JS); the frontend
/// takes name and size from the path and the buffer.
#[tauri::command]
pub fn read_drop_png(path: String) -> Result<tauri::ipc::Response, String> {
    let p = validate_drop_path(&path, &["png"])?;
    let (_, buf, more) = open_drop_file(&p, MAX_DROP_PNG)?;
    if more {
        return Err(format!("image over {} MiB", MAX_DROP_PNG / 1024 / 1024));
    }
    if buf.len() < PNG_SIG.len() || buf[..PNG_SIG.len()] != PNG_SIG {
        return Err("not a PNG".into());
    }
    Ok(tauri::ipc::Response::new(buf))
}

/* ---- character models ----
   The pin (path, size, sha256) lives in the user's pack (`crate::characters`), written only
   by Rust from a native pick. The cap below is independent of the pin: a pack cannot raise
   what this reader will buffer or send across IPC. */

pub(crate) const MAX_CHARACTER_GLB: usize = 64 * 1024 * 1024;

/// Bounded read of a `.glb` through the same path guard and no-leaf-link open as every
/// other drop reader. Shared by the load below and by pinning (add / re-pin).
pub(crate) fn read_character_glb(path: &str) -> Result<Vec<u8>, String> {
    let p = validate_drop_path(path, &["glb"])?;
    let (_, bytes, more) = open_drop_file(&p, MAX_CHARACTER_GLB)?;
    if more {
        return Err(format!("the model is over {} MiB", MAX_CHARACTER_GLB / 1024 / 1024));
    }
    Ok(bytes)
}

pub(crate) fn character_digest(bytes: &[u8]) -> String {
    super::sha256_hex(bytes)
}

fn verify_character_model(bytes: &[u8], pinned_bytes: u64, pinned_sha256: &str) -> Result<(), String> {
    if bytes.len() as u64 != pinned_bytes || character_digest(bytes) != pinned_sha256 {
        return Err("the model file changed since it was pinned; pin it again in Settings › Characters".into());
    }
    Ok(())
}

/// Id only: no caller-controlled path or digest. The pack names the file; size and sha256
/// are re-checked on every load, which also stops an ancestor junction exposing another file.
#[tauri::command]
pub fn read_character_model(id: Option<String>) -> Result<tauri::ipc::Response, String> {
    let id = id.filter(|s| !s.trim().is_empty()).ok_or("a character id is required")?;
    let pin = crate::characters::model_pin(&id)?;
    let bytes = read_character_glb(&pin.path).map_err(|e| format!("could not read {}: {e}", pin.path))?;
    verify_character_model(&bytes, pin.bytes, &pin.sha256)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod character_tests {
    use super::*;

    #[test]
    fn a_pin_mismatch_refuses_the_load() {
        let model = b"glTF\x02\x00\x00\x00model-bytes".to_vec();
        let sha = character_digest(&model);
        assert!(verify_character_model(&model, model.len() as u64, &sha).is_ok());
        // truncated, same-size replacement, and a size-only match all refuse
        assert!(verify_character_model(b"glTF", model.len() as u64, &sha).is_err());
        assert!(verify_character_model(&vec![0; model.len()], model.len() as u64, &sha).is_err());
        assert!(verify_character_model(&model, model.len() as u64 + 1, &sha).is_err());
    }
}
