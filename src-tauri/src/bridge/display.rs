// Display: the bridge\display readers, the Approve/Deny gate and its decision sidecars,
// clear/delete, and the 2 s poller that emits `display-update`.

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::clips::PNG_SIG;
use super::documents::{scan_docs_tree, scan_run_docs};
use super::{display_dir, is_doc, kind_of, open_drop_file, scan_kind, sha256_hex, DisplayEntry, FILE_ATTRIBUTE_REPARSE_POINT};

const MAX_DISPLAY_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct DisplayUpdate {
    files: Vec<DisplayEntry>,
    /// .md/.txt under the same folder — the workbench Document tab's catalog
    docs: Vec<DisplayEntry>,
    newest: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct DisplayFile {
    kind: String,
    content: String,
    /// sha256 of the bytes as read — what a gate decision binds to
    sha256: String,
}

/// A file directly inside bridge\display (no subfolders), by canonical path:
/// the parent must BE the display root, and the name is taken from the
/// canonical path, never from the caller's string. Every display reader and
/// the gate go through this.
pub(crate) fn display_child(path: &str) -> Result<(PathBuf, String), String> {
    display_child_in(&display_dir(), path)
}

/// `display_child` against an explicit display root (the sweep and its tests pass theirs).
pub(super) fn display_child_in(display_root: &Path, path: &str) -> Result<(PathBuf, String), String> {
    let requested = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let root = fs::canonicalize(display_root).map_err(|e| e.to_string())?;
    if requested.parent() != Some(root.as_path()) {
        return Err("not a file directly in the display dir".into());
    }
    let name = requested
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("file name is not valid text")?
        .to_string();
    if name.starts_with('.') || name.contains(['/', '\\', ':']) {
        return Err("file name not allowed".into());
    }
    Ok((requested, name))
}

/// Bytes of a display child, read from one opened handle (no reparse points,
/// regular file only, bounded), plus the sha256 of exactly those bytes.
fn read_display_bytes(path: &str) -> Result<(PathBuf, String, Vec<u8>, String), String> {
    read_display_bytes_in(&display_dir(), path)
}

fn read_display_bytes_in(display_root: &Path, path: &str) -> Result<(PathBuf, String, Vec<u8>, String), String> {
    let (p, name) = display_child_in(display_root, path)?;
    let (_, buf, more) = open_drop_file(&p, MAX_DISPLAY_BYTES as usize)?;
    if more {
        return Err(format!("File Over {}MB", MAX_DISPLAY_BYTES / 1024 / 1024));
    }
    let sha = sha256_hex(&buf);
    Ok((p, name, buf, sha))
}

#[tauri::command]
pub fn read_display_file(path: String) -> Result<DisplayFile, String> {
    let (p, _, buf, sha256) = read_display_bytes(&path)?;
    let kind = kind_of(&p.to_string_lossy());
    if kind == "png" {
        return Err("binary: use read_display_png".into());
    }
    Ok(DisplayFile { kind, content: String::from_utf8_lossy(&buf).into_owned(), sha256 })
}

#[derive(Clone, Serialize)]
pub struct DisplayPng {
    sha256: String,
    base64: String,
}

/// A .png in the display dir as base64 (cap MAX_DISPLAY_BYTES) with its hash;
/// the frontend shows it as an <img> from a blob, outside the preview frame.
#[tauri::command]
pub fn read_display_png(path: String) -> Result<DisplayPng, String> {
    use base64::Engine as _;
    let (_, _, buf, sha256) = read_display_bytes(&path)?;
    if buf.len() < PNG_SIG.len() || buf[..PNG_SIG.len()] != PNG_SIG {
        return Err("not a PNG".into());
    }
    Ok(DisplayPng { sha256, base64: base64::engine::general_purpose::STANDARD.encode(&buf) })
}

/// Snapshot for a listener mounted after the poller's last emission.
#[tauri::command]
pub fn list_display() -> Result<DisplayUpdate, String> {
    scan().ok_or_else(|| "display dir unreadable".into())
}

// ---- display gate ----
//
// Approve / Deny on the file that is on screen, written as
// <name>.decision.json beside it. The decision carries the sha256 of the bytes
// the verdict was given on; the save re-reads the file and refuses if the
// bytes changed or the file is gone, so a preview swapped after the click
// cannot inherit the verdict. The sidecar name derives from the canonical
// file name, never from anything the webview sends. Atomic write: exclusive
// temp in the same dir, then rename (the reader sees whole files only).

const MAX_DECISION_BYTES: usize = 16 * 1024;
const MAX_DECISION_COMMENT: usize = 4000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub file: String,
    pub sha256: String,
    pub verdict: String,
    pub comment: String,
    pub at_ms: u64,
    /// `<slug>-<8 hex>` file names carry a request id for the waiting body
    pub request: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionView {
    pub decision: Decision,
    /// the decision's sha256 matches the file as it is now
    pub current: bool,
}

pub(super) fn request_id_of(name: &str) -> Option<String> {
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    let (_, tail) = stem.rsplit_once('-')?;
    (tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())).then(|| tail.to_string())
}

pub(super) fn decision_sidecar(root_child: &Path, name: &str) -> PathBuf {
    root_child.with_file_name(format!("{name}.decision.json"))
}

// ---- clear / delete ----
//
// Clear keeps the file but takes it off the bar: it moves into
// bridge\display\archive\shown\<yyyy-mm of the Clear>\, a subfolder the scanners never list
// (they take regular files directly in the root). Delete removes it for good. Both act
// on a display child by canonical path and carry the decision sidecar along. Clear uses the
// sweep's pair routine (media first, then sidecar, rolled back on failure; a name clash goes
// to `~<ms>\`). Save, Clear, Delete and the sweep share one in-process lock
// (`display_sweep::lock`).

pub(super) fn sidecar_is_plain_file(side: &Path) -> bool {
    // symlink_metadata does not follow: a link where the sidecar goes is left alone
    fs::symlink_metadata(side).map(|m| m.is_file()).unwrap_or(false)
}

#[tauri::command]
pub fn archive_display_file(path: String) -> Result<String, String> {
    let _guard = super::display_sweep::lock();
    let (p, name) = display_child(&path)?;
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let dest = super::display_sweep::clear_core(&super::display_sweep::Ctx::live(), &|a, b| fs::rename(a, b), &p, &name, now_ms)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_display_file(path: String) -> Result<(), String> {
    let _guard = super::display_sweep::lock();
    let (p, name) = display_child(&path)?;
    fs::remove_file(&p).map_err(|e| format!("could not delete {name}: {e}"))?;
    let side = decision_sidecar(&p, &name);
    if sidecar_is_plain_file(&side) {
        let _ = fs::remove_file(&side);
    }
    Ok(())
}

/// `dismiss` clears the file from Relay without ruling on it: a waiter must not read it as approve or deny.
fn valid_verdict(v: &str) -> bool {
    matches!(v, "approve" | "deny" | "dismiss")
}

#[tauri::command]
pub fn save_display_decision(path: String, sha256: String, verdict: String, comment: String) -> Result<u64, String> {
    use std::io::Write;
    if !valid_verdict(&verdict) {
        return Err("verdict must be approve, deny or dismiss".into());
    }
    if comment.chars().count() > MAX_DECISION_COMMENT {
        return Err(format!("comment over {MAX_DECISION_COMMENT} characters"));
    }
    let _guard = super::display_sweep::lock();
    // the file as it is NOW, from an opened handle, must be what was shown
    let (p, name, _, now_sha) = read_display_bytes(&path)?;
    if now_sha != sha256 {
        return Err("file changed since it was shown — reopen it and decide again".into());
    }
    let at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let d = Decision { file: name.clone(), sha256: now_sha, verdict, comment, at_ms, request: request_id_of(&name) };
    let out = serde_json::to_string_pretty(&d).map_err(|e| e.to_string())?;
    if out.len() > MAX_DECISION_BYTES {
        return Err("decision too large".into());
    }
    let side = decision_sidecar(&p, &name);
    if let Ok(md) = fs::symlink_metadata(&side) {
        use std::os::windows::fs::MetadataExt;
        if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !md.is_file() {
            return Err("a link sits where the decision file goes — remove it first".into());
        }
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = side.with_file_name(format!("{name}.decision.{}-{nanos}.tmp", std::process::id()));
    {
        let mut t = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
        if let Err(e) = t.write_all(out.as_bytes()).and_then(|_| t.sync_all()) {
            drop(t);
            let _ = fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    }
    if let Err(e) = fs::rename(&tmp, &side) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("could not place the decision file: {e}"));
    }
    Ok(at_ms)
}

/// The decision beside a display file, if any. A malformed sidecar is an
/// error, never "no decision" (fail closed). `current` says whether it was
/// given on the bytes that are there now.
#[tauri::command]
pub fn read_display_decision(path: String) -> Result<Option<DecisionView>, String> {
    read_decision_in(&display_dir(), &path).map(|(d, _)| d)
}

/// The reader behind `read_display_decision` against an explicit display root; also returns the
/// sha256 of the file's bytes. The sweep classifier calls this, so a decision counts as current
/// exactly when the Relay would show it as current.
pub(super) fn read_decision_in(display_root: &Path, path: &str) -> Result<(Option<DecisionView>, String), String> {
    let (p, name, _, now_sha) = read_display_bytes_in(display_root, path)?;
    let side = decision_sidecar(&p, &name);
    let Ok(md) = fs::symlink_metadata(&side) else { return Ok((None, now_sha)) };
    {
        use std::os::windows::fs::MetadataExt;
        if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !md.is_file() {
            return Err("decision path is not a regular file".into());
        }
    }
    let (_, buf, more) = open_drop_file(&side, MAX_DECISION_BYTES)?;
    if more {
        return Err("decision file too large".into());
    }
    let d: Decision = serde_json::from_slice(&buf).map_err(|e| format!("decision invalid: {e}"))?;
    if d.file != name {
        return Err("decision names a different file".into());
    }
    let current = d.sha256 == now_sha;
    Ok((Some(DecisionView { decision: d, current }), now_sha))
}

#[cfg(test)]
mod gate_tests {
    use super::*;

    #[test]
    fn request_ids() {
        assert_eq!(request_id_of("gemini-434c758e.png"), Some("434c758e".into()));
        assert_eq!(request_id_of("gemini-2.png"), None);
        assert_eq!(request_id_of("gemini-434C758E.png"), None);
        assert_eq!(request_id_of("plain.svg"), None);
    }

    #[test]
    fn sidecar_from_canonical_name_only() {
        let side = decision_sidecar(Path::new(r"C:\x\display\a.png"), "a.png");
        assert_eq!(side, PathBuf::from(r"C:\x\display\a.png.decision.json"));
    }

    #[test]
    fn verdicts_include_dismiss() {
        for v in ["approve", "deny", "dismiss"] {
            assert!(valid_verdict(v), "{v}");
        }
        assert!(!valid_verdict("approved"));
        assert!(!valid_verdict(""));
    }

    #[test]
    fn hash_is_stable_hex() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}

/// Consecutive ticks the poller may hold an emit while a file settles.
const SETTLE_HOLD_CAP: u32 = 3;

/// Emit decision for one tick: hold while a file is mid-write (scan_kind would
/// drop it for a tick, which flashes the panel), but never more than the cap so
/// a writer that never stops cannot starve updates.
fn should_emit(settling: bool, held: u32) -> bool {
    !settling || held >= SETTLE_HOLD_CAP
}

/// True when an accepted display or doc file in bridge\display is under 2 s old.
fn settling(now_ms: u64) -> bool {
    let Ok(rd) = fs::read_dir(display_dir()) else { return false };
    rd.filter_map(|e| e.ok()).any(|e| {
        let name = e.path().to_string_lossy().to_ascii_lowercase();
        if !(is_display(&name) || is_doc(&name)) {
            return false;
        }
        e.metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| now_ms.saturating_sub(d.as_millis() as u64) < 2000)
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod poller_tests {
    use super::*;

    #[test]
    fn should_emit_holds_while_settling_up_to_cap() {
        assert!(should_emit(false, 0));
        assert!(!should_emit(true, 0));
        assert!(!should_emit(true, SETTLE_HOLD_CAP - 1));
        assert!(should_emit(true, SETTLE_HOLD_CAP));
    }
}

pub fn start_display_poller(app: AppHandle) {
    thread::spawn(move || {
        // Signature over the WHOLE scanned list, not just the newest entry: a
        // change to an older file must emit too.
        let mut last_sig: Option<Vec<(String, u64)>> = None;
        let mut held: u32 = 0;
        loop {
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if !should_emit(settling(now_ms), held) {
                // Leave last_sig alone so the settled list emits next tick.
                held += 1;
                thread::sleep(Duration::from_secs(2));
                continue;
            }
            held = 0;
            if let Some(update) = scan() {
                let sig: Vec<(String, u64)> = update
                    .files
                    .iter()
                    .chain(update.docs.iter())
                    .map(|f| (f.path.clone(), f.mtime_ms))
                    .collect();
                if Some(&sig) != last_sig.as_ref() {
                    last_sig = Some(sig);
                    let _ = app.emit("display-update", update);
                }
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
}

fn is_display(name: &str) -> bool {
    name.ends_with(".svg") || name.ends_with(".html") || name.ends_with(".png")
}

fn scan() -> Option<DisplayUpdate> {
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    // every live gate file, uncapped, plus the newest 20 others (display_sweep::scan_display_files)
    let files = super::display_sweep::scan_display_files(&display_dir(), now_ms)?;
    let mut docs = scan_run_docs(now_ms);
    docs.extend(scan_docs_tree(now_ms));
    docs.extend(scan_kind(now_ms, &is_doc, 20)?);
    let newest = files.first().map(|f| f.path.clone());
    Some(DisplayUpdate { files, docs, newest })
}
