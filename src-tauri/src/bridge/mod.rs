// Bridge: the fixed bridge\ and docs\ roots, helpers shared by the readers, and the
// re-exports of the child modules' commands (globs, so generate_handler! finds them).

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

mod clips;
mod display;
mod display_sweep;
mod documents;
mod drop;
mod sweep;
mod workbench;

pub use clips::*;
pub use display::*;
pub use documents::*;
pub use drop::*;
pub use sweep::sweep_review_artefacts;
pub use workbench::*;

// The literals below live in crate::paths; these stay as thin
// wrappers so the many local call sites in this file don't all need to spell
// out the crate path.
fn clips_dir() -> PathBuf {
    crate::paths::clips_dir()
}
pub(crate) fn display_dir() -> PathBuf {
    crate::paths::display_dir()
}

/// The changes inbox and the run folders (gitignored working state):
/// the newest `docs\runs\<yyyy-mm-dd>-<slug>` and `docs\inbox\` lead the Document tab's
/// catalog so the human gate between stages is one click. Read-only here: the agents and the
/// orchestrator write them; the Document tab edits them like any other document.
pub(crate) fn runs_dir() -> PathBuf {
    crate::paths::runs_dir()
}

pub fn ensure_dirs() {
    let _ = fs::create_dir_all(clips_dir());
    let _ = fs::create_dir_all(display_dir());
    let _ = fs::create_dir_all(crate::paths::display_reviews_dir());
    let _ = fs::create_dir_all(runs_dir());
}

const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// Opens WITHOUT following a leaf link, then inspects that handle: a plain open
/// would follow the symlink and describe the target, defeating the check.
/// Ancestor junctions/symlinks are allowed on purpose (OneDrive, junctioned
/// repos). Reads at most `cap` bytes from the same handle; `took_more` says
/// whether the file had more.
fn open_drop_file(p: &std::path::Path, cap: usize) -> Result<(std::fs::Metadata, Vec<u8>, bool), String> {
    use std::io::Read;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(p)
        .map_err(|e| e.to_string())?;
    let md = f.metadata().map_err(|e| e.to_string())?;
    if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("links are not followed — drop the target file".into());
    }
    if !md.is_file() {
        return Err("not a regular file".into());
    }
    let mut buf = Vec::with_capacity(cap.min(md.len() as usize + 1));
    f.take(cap as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let more = buf.len() > cap;
    buf.truncate(cap);
    Ok((md, buf, more))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn kind_of(p: &str) -> String {
    let l = p.to_ascii_lowercase();
    if l.ends_with(".svg") {
        "svg".into()
    } else if l.ends_with(".png") {
        "png".into()
    } else if l.ends_with(".md") {
        "md".into()
    } else if l.ends_with(".txt") {
        "txt".into()
    } else {
        "html".into()
    }
}

#[derive(Clone, Serialize)]
pub struct DisplayEntry {
    path: String,
    kind: String,
    mtime_ms: u64,
    /// Catalog group label ("Inbox", "Run · <slug>", one per newest run); absent for bridge\display entries
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
}

fn scan_kind(now_ms: u64, accept: &dyn Fn(&str) -> bool, cap: usize) -> Option<Vec<DisplayEntry>> {
    let mut files: Vec<DisplayEntry> = fs::read_dir(display_dir())
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            let name = p.to_string_lossy().to_ascii_lowercase();
            if !accept(&name) {
                return None;
            }
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let mtime_ms = meta
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            // Files modified <2s ago may still be mid-write; pick them up next tick.
            if now_ms.saturating_sub(mtime_ms) < 2000 {
                return None;
            }
            Some(DisplayEntry {
                path: p.to_string_lossy().into_owned(),
                kind: kind_of(&name),
                mtime_ms,
                group: None,
            })
        })
        .collect();
    files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    files.truncate(cap);
    Some(files)
}

fn is_doc(name: &str) -> bool {
    name.ends_with(".md") || name.ends_with(".txt")
}
