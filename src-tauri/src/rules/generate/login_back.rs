//! src-tauri\src\rules\generate\login_back.rs — the login a generator run starts from and the refreshed login a
//! call hands back (Create Runes failing `exit code 1` on an OAuth refresh, 2026-10-25).
//! - `source`: the newer, by last-write time, of the shared store's login (`<homes>\_shared\<agent>\<file>`, the
//!   file every Bare tab home links, `bare/login_link.rs`) and the Bare home's own (`claude-config\.credentials.json`,
//!   `codex-home\auth.json`); a tie is the store. The home's own file splits off the store when a CLI refreshes it by
//!   rename, and a split copy keeps a refresh token a later refresh rotated dead.
//! - `write_back`: after a call, its config dir's login goes back over the run's source when it is no longer the
//!   same file (the CLI refreshed by rename, or the call got a copy) and it was written later than the source. It
//!   runs under the Bare home's lock and, for a store target, the store's lock too (`login_link`'s order), and
//!   re-checks under them. An existing target is overwritten in place (truncate, write, `sync_all`): its file ID,
//!   links and DACL stay, so every tab home linked to the store sees the new login at once. A rename would orphan
//!   those links and leave each running tab a refresh token the call may have rotated dead, logging the tabs out
//!   at their next refresh. The torn-read window is one small write, and a tab CLI reads the file only at start and
//!   at refresh; chosen over orphaning the links (user's lead, 2026-10-25). A missing target is created by a copy
//!   to a temp name beside it, a private DACL, then a rename.
//! Trust boundary as in `login_link`: names, file IDs, last-write times; contents are copied, never read or logged.

use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};

use crate::bare::home as bare;

/// The store folder beside the install homes (`bare/home_path.rs` `SHARED`).
const SHARED: &str = "_shared";
/// The temp name's suffix beside the target.
const TEMP_SUFFIX: &str = ".vidar-gen";
const FILE_READ_ATTRIBUTES: u32 = 0x80;
const FILE_SHARE_ALL: u32 = 0x7;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

/// What `write_back` found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Back {
    /// The call's login is still the target file: the CLI wrote it in place, nothing to do.
    Linked,
    /// The call left no login file.
    Missing,
    /// The call's login is a different file but not written later than the target.
    NotNewer,
    /// The call's login replaced the target.
    Written,
}

/// `<homes>\_shared` when `bare_home` sits in a `homes` folder (`home_path::shared_for`).
fn store_root(bare_home: &Path) -> Option<PathBuf> {
    let parent = bare_home.parent()?;
    let homes = parent.file_name()?.to_string_lossy().eq_ignore_ascii_case("homes");
    let own = bare_home.file_name()?.to_string_lossy().eq_ignore_ascii_case(SHARED);
    (homes && !own).then(|| parent.join(SHARED))
}

fn written(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).ok().filter(|m| m.is_file()).and_then(|m| m.modified().ok())
}

/// The login file a run links from: the store's `<agent>\<file>` or the Bare home's `<folder>\<file>`, whichever
/// was written later (the store on a tie); `None` when neither exists.
pub fn source(bare_home: &Path, agent: &str, folder: &str, file: &str) -> Option<PathBuf> {
    let own = bare_home.join(folder).join(file);
    let store = store_root(bare_home).map(|s| s.join(agent).join(file));
    let pick = |p: PathBuf| written(&p).map(|t| (p, t));
    match (store.and_then(pick), pick(own)) {
        (Some((s, ts)), Some((o, to))) => Some(if to > ts { o } else { s }),
        (Some((s, _)), None) => Some(s),
        (None, Some((o, _))) => Some(o),
        (None, None) => None,
    }
}

/// Volume serial plus file index; `None` when the file is missing.
fn file_id(p: &Path) -> Result<Option<(u32, u64)>, String> {
    Ok(identity(p)?.map(|(id, _)| id))
}

/// The file ID and the link count; `None` when the file is missing.
fn identity(p: &Path) -> Result<Option<((u32, u64), u32)>, String> {
    if !p.is_file() {
        return Ok(None);
    }
    let f = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(p)
        .map_err(|e| format!("{}: {e}", p.display()))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(f.as_raw_handle()), &mut info) }.map_err(|e| format!("{}: file ID: {e}", p.display()))?;
    let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    Ok(Some(((info.dwVolumeSerialNumber, index), info.nNumberOfLinks)))
}

/// `Some` when nothing is to be written, `None` when `call` should replace `target`.
fn judge(target: &Path, call: &Path) -> Result<Option<Back>, String> {
    let Some(call_id) = file_id(call)? else { return Ok(Some(Back::Missing)) };
    if file_id(target)? == Some(call_id) {
        return Ok(Some(Back::Linked));
    }
    match (written(call), written(target)) {
        (Some(c), Some(t)) if c <= t => Ok(Some(Back::NotNewer)),
        (None, _) => Ok(Some(Back::Missing)),
        _ => Ok(None),
    }
}

/// Hands `call`'s login back over `target` (the run's `source`) when it is a different, later-written file. The
/// check is repeated under the locks, so a Bare tab that refreshed the target meanwhile keeps its newer login.
pub fn write_back(bare_home: &Path, target: &Path, call: &Path) -> Result<Back, String> {
    let fail = |e: String| format!("login: the refreshed login was not written back to {} ({e})", target.display());
    if let Some(done) = judge(target, call).map_err(fail)? {
        return Ok(done);
    }
    let _home = bare::lock(bare_home, bare::LOCK_WAIT).map_err(fail)?;
    let _store = match store_root(bare_home).filter(|s| target.starts_with(s)) {
        Some(s) => Some(bare::lock(&s, bare::LOCK_WAIT).map_err(fail)?),
        None => None,
    };
    if let Some(done) = judge(target, call).map_err(fail)? {
        return Ok(done);
    }
    if target.is_file() {
        overwrite(call, target).map_err(fail)?;
        return Ok(Back::Written);
    }
    let name = target.file_name().ok_or_else(|| fail("no file name".into()))?.to_string_lossy().into_owned();
    let tmp = target.with_file_name(format!("{name}{TEMP_SUFFIX}"));
    let _ = std::fs::remove_file(&tmp);
    let placed = std::fs::copy(call, &tmp)
        .map_err(|e| format!("copy: {e}"))
        .and_then(|_| bare::acl::set_private_file(&tmp))
        .and_then(|_| std::fs::rename(&tmp, target).map_err(|e| format!("rename: {e}")));
    if let Err(e) = placed {
        let _ = std::fs::remove_file(&tmp);
        return Err(fail(e));
    }
    Ok(Back::Written)
}

/// Rewrites the existing `target` with `call`'s bytes in place: same file ID, same links, same DACL.
fn overwrite(call: &Path, target: &Path) -> Result<(), String> {
    use std::io::Write;
    let mut from = std::fs::File::open(call).map_err(|e| format!("open the call's login: {e}"))?;
    let mut to = std::fs::OpenOptions::new().write(true).truncate(true).open(target).map_err(|e| format!("open: {e}"))?;
    std::io::copy(&mut from, &mut to).map_err(|e| format!("write: {e}"))?;
    to.flush().and_then(|_| to.sync_all()).map_err(|e| format!("flush: {e}"))
}

#[cfg(test)]
#[path = "login_back_tests.rs"]
mod tests;
