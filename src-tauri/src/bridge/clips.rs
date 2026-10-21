// Clips: atomic, collision-safe writes of text and PNG clips into bridge\clips.

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{clips_dir, ensure_dirs};

// Shared by the workbench tray and the toolbench's log crop — the prefix is
// the only thing that differs, and it keeps every bridge write in one place.
pub fn write_clip(prefix: &str, content: &str) -> Result<String, String> {
    write_clip_bytes(prefix, "txt", content.as_bytes())
}

// Exclusive creation with a suffix retry: epoch millis are not unique, and two
// same-tick saves through fs::write silently overwrote each other (review
// finding). Bounded — 16 collisions in one millisecond is not a real case.
fn write_clip_bytes(prefix: &str, ext: &str, bytes: &[u8]) -> Result<String, String> {
    use std::io::Write;
    ensure_dirs();
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    for n in 0..16 {
        let name = if n == 0 {
            format!("{prefix}-{millis}.{ext}")
        } else {
            format!("{prefix}-{millis}-{n}.{ext}")
        };
        let path = clips_dir().join(name);
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                f.write_all(bytes).map_err(|e| e.to_string())?;
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("clip name collision".into())
}

#[tauri::command]
pub fn save_clip(content: String) -> Result<String, String> {
    write_clip("clip", &content)
}

pub(super) const MAX_CLIP_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub(super) const PNG_SIG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// Workbench image block → `bridge\clips\clip-<ms>.png`. Raw request body
/// (the frontend passes the blob's ArrayBuffer straight to invoke), PNG only:
/// the one clipboard image type browsers must support, and the full 8-byte
/// signature rather than a prefix. No path arguments, so nothing to contain.
#[tauri::command]
pub fn save_clip_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    if bytes.len() > MAX_CLIP_IMAGE_BYTES {
        return Err(format!("image over {} MiB", MAX_CLIP_IMAGE_BYTES / 1024 / 1024));
    }
    if bytes.len() < PNG_SIG.len() || bytes[..PNG_SIG.len()] != PNG_SIG {
        return Err("not a PNG".into());
    }
    write_clip_bytes("clip", "png", bytes)
}
