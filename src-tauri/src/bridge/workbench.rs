// Workbench bridge: one JSON entry (and optional png) per Tray/Document item under
// bridge\workbench, so a tab can address what the user has open.

use std::fs;
use std::path::PathBuf;

use super::clips::{MAX_CLIP_IMAGE_BYTES, PNG_SIG};

/* ---- workbench bridge ----
   What is in the Tray and what the Document tab has open, published so a TAB can
   address it: "read Tray Alpha" instead of the user reading a path aloud.

   One file per entry, not one manifest. `bridge\sessions\<tab>.json` is the
   existing precedent for frequently-rewritten JSON that agents read, and the
   shape matters here: a single manifest would be rewritten on every tray change
   and every consumer would race the whole file. Per entry, an add writes one
   small file and a remove deletes one.

   Persists across restarts: entries and their pngs survive a
   relaunch: × and Clear are the only removal, and a skipped/failed restore
   deletes its own entry the same way, so nothing here goes stale silently.

   Read-only for consumers. Writing INTO the tray from a tab is not this; Display
   already covers "show the user something". */
// Lives in crate::paths::workbench_dir().
fn workbench_dir() -> PathBuf {
    crate::paths::workbench_dir()
}

/// Entry names come from the frontend (block names, "document"), so they are
/// allowlisted rather than trusted: letters, digits and `-`, no separators, no
/// dots, so nothing can escape the folder or name a stream.
fn valid_entry_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn workbench_path(name: &str) -> Result<PathBuf, String> {
    if !valid_entry_name(name) {
        return Err("entry name must be 1-32 chars of letters, digits or -".into());
    }
    Ok(workbench_dir().join(format!("{name}.json")))
}

fn workbench_png_path(name: &str) -> Result<PathBuf, String> {
    if !valid_entry_name(name) {
        return Err("entry name must be 1-32 chars of letters, digits or -".into());
    }
    Ok(workbench_dir().join(format!("{name}.png")))
}

/// Every published entry's raw JSON body, name order — a boot-time restore
/// reads these and rebuilds the tray from them.
#[tauri::command]
pub fn list_workbench_entries() -> Vec<String> {
    let mut out: Vec<(String, String)> = Vec::new();
    if let Ok(rd) = fs::read_dir(workbench_dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
            if let Ok(body) = crate::fsx::read_text(&p) {
                out.push((stem.to_string(), body));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, body)| body).collect()
}

/// A tray image block with no path (marquee/OCR crop, pasted image): the bytes
/// alongside the entry JSON so a restore has something to read back. Mirrors
/// `save_clip_image` (raw body, PNG-only) but overwrites `<name>.png` in place
/// rather than minting a new clip name — the name is the entry's identity.
#[tauri::command]
pub fn write_workbench_png(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    let name = request
        .headers()
        .get("name")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing name header")?;
    let p = workbench_png_path(name)?;
    if bytes.len() > MAX_CLIP_IMAGE_BYTES {
        return Err(format!("image over {} MiB", MAX_CLIP_IMAGE_BYTES / 1024 / 1024));
    }
    if bytes.len() < PNG_SIG.len() || bytes[..PNG_SIG.len()] != PNG_SIG {
        return Err("not a PNG".into());
    }
    fs::create_dir_all(workbench_dir()).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(&p, bytes)
}

/// The bytes back for a restore. No signature re-check: this file was only
/// ever written by `write_workbench_png`.
#[tauri::command]
pub fn read_workbench_png(name: String) -> Result<tauri::ipc::Response, String> {
    let p = workbench_png_path(&name)?;
    let buf = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
}

/// Publish one entry. `json` is composed by the frontend; this side owns the
/// name, the location and the atomic write, never the shape.
#[tauri::command]
pub fn write_workbench_entry(name: String, json: String) -> Result<(), String> {
    let p = workbench_path(&name)?;
    fs::create_dir_all(workbench_dir()).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(&p, json.as_bytes())
}

/// Remove one entry, and its png if it has one. Absent is success: a block
/// removed twice, or one with no image, is not an error.
#[tauri::command]
pub fn delete_workbench_entry(name: String) -> Result<(), String> {
    let p = workbench_path(&name)?;
    let png = workbench_png_path(&name)?;
    let _ = fs::remove_file(&png);
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

const ARCHIVE_DIR: &str = "archive";
pub const DEFAULT_ARCHIVE_DAYS: i64 = 7;

/// Move `src` into `archive`, appending a timestamp suffix when the name is taken.
/// Absent source is success (a block removed twice, or one with no image).
fn archive_file(src: &std::path::Path, archive: &std::path::Path, stamp: u128) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(archive).map_err(|e| e.to_string())?;
    let file = src.file_name().ok_or("no file name")?;
    let mut dest = archive.join(file);
    if dest.exists() {
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("entry");
        let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
        let mut n = 0u32;
        loop {
            let tail = if n == 0 { format!("{stamp}") } else { format!("{stamp}-{n}") };
            dest = archive.join(format!("{stem}-{tail}.{ext}"));
            if !dest.exists() {
                break;
            }
            n += 1;
        }
    }
    fs::rename(src, &dest).map_err(|e| e.to_string())?;
    // purge ages by mtime; a rename keeps the old one, so stamp archive time
    fs::File::options()
        .write(true)
        .open(&dest)
        .and_then(|f| f.set_modified(std::time::SystemTime::now()))
        .map_err(|e| e.to_string())
}

/// Archive one entry, and its png if it has one, into `archive\` beside the entries.
/// Listing is non-recursive and keyed on `.json`, so `archive\` is never listed.
#[tauri::command]
pub fn archive_workbench_entry(name: String) -> Result<(), String> {
    let p = workbench_path(&name)?;
    let png = workbench_png_path(&name)?;
    let archive = workbench_dir().join(ARCHIVE_DIR);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let png_res = archive_file(&png, &archive, stamp);
    archive_file(&p, &archive, stamp)?;
    png_res
}

/// Delete files in `archive` last modified more than `days` ago. `days <= 0` = never.
fn purge_archive_in(archive: &std::path::Path, days: i64, now: std::time::SystemTime) -> usize {
    if days <= 0 {
        return 0;
    }
    let max_age = std::time::Duration::from_secs(days as u64 * 86_400);
    let mut n = 0;
    if let Ok(rd) = fs::read_dir(archive) {
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if !md.is_file() {
                continue;
            }
            let Ok(mtime) = md.modified() else { continue };
            if now.duration_since(mtime).map(|a| a > max_age).unwrap_or(false)
                && fs::remove_file(e.path()).is_ok()
            {
                n += 1;
            }
        }
    }
    n
}

/// App-start purge of the Tray archive; N from vidar.json `workbenchArchiveDays` (default 7).
pub fn purge_workbench_archive() {
    let days = crate::config::load()
        .config
        .workbench_archive_days
        .unwrap_or(DEFAULT_ARCHIVE_DAYS);
    purge_archive_in(&workbench_dir().join(ARCHIVE_DIR), days, std::time::SystemTime::now());
}

#[cfg(test)]
mod workbench_tests {
    use super::*;

    #[test]
    fn archive_names_collisions_and_purge_cuts_by_age() {
        let root = std::env::temp_dir().join(format!("vidar-wb-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let archive = root.join("archive");
        fs::create_dir_all(&root).unwrap();
        let src = root.join("Alpha.json");
        fs::write(&src, "1").unwrap();
        archive_file(&src, &archive, 111).unwrap();
        assert!(archive.join("Alpha.json").exists() && !src.exists());
        fs::write(&src, "2").unwrap();
        archive_file(&src, &archive, 111).unwrap();
        assert!(archive.join("Alpha-111.json").exists());
        assert_eq!(fs::read_to_string(archive.join("Alpha.json")).unwrap(), "1");
        // purge: "now" 10 days ahead removes both at N=7; N=0 keeps; N=30 keeps
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(10 * 86_400);
        assert_eq!(purge_archive_in(&archive, 0, later), 0);
        assert_eq!(purge_archive_in(&archive, -1, later), 0);
        assert_eq!(purge_archive_in(&archive, 30, later), 0);
        assert_eq!(purge_archive_in(&archive, 7, std::time::SystemTime::now()), 0);
        assert_eq!(purge_archive_in(&archive, 7, later), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn entry_name_validation_gates_both_paths() {
        assert!(workbench_path("Alpha-1").is_ok());
        assert!(workbench_png_path("Alpha-1").is_ok());
        for bad in ["", "has space", "dots.no", "../escape", &"x".repeat(33)] {
            assert!(workbench_path(bad).is_err());
            assert!(workbench_png_path(bad).is_err());
        }
    }

    #[test]
    fn png_path_sits_beside_the_json_entry() {
        let json = workbench_path("Bravo").unwrap();
        let png = workbench_png_path("Bravo").unwrap();
        assert_eq!(json.parent(), png.parent());
        assert_eq!(json.file_stem(), png.file_stem());
        assert_eq!(png.extension().and_then(|e| e.to_str()), Some("png"));
    }
}
