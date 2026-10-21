// Display lifecycle: one classifier, the scan that uses it, and the startup sweep that moves aged files out
// of the top of bridge\display and out of the archive root. Nothing else moves files out of that top:
// `sweep.rs` only sweeps `display\reviews\` (a separate folder).
//
// Classes (top-level files of the display folder only):
//   Live          a gate file (`<slug>-<8 hex>.<svg|html|png>`) without a validated CURRENT decision:
//                 no sidecar, stale, malformed, unreadable, or naming a different file. Any read error
//                 lands here. Never moved, never capped out of the scan.
//   DecidedFresh / DecidedOld   a gate file with a current decision, aged by the decision's `at_ms`
//   LookOnlyFresh / LookOnlyOld a plain `<slug>.<svg|html|png>`, aged by mtime
//   DocFresh / DocOld           `.md/.txt/.diff`, aged by mtime
// A `.decision.json` is never classified: it moves only with its media file.
// The decision is read through `display::read_decision_in`, the reader behind `read_display_decision`
// (canonical-parent check included), and the path is gated by `validate_drop_path`. The Display scan
// caches the decision part keyed by path + size + mtime of media and sidecar; moves never use the cache.
//
// Destinations: decided and look-only files go to `archive\shown\<yyyy-mm>\` (UTC month of the decision's
// `at_ms`, else mtime); a name clash goes to `archive\shown\<yyyy-mm>\~<ms>\<original name>` (pair together);
// old documents go to `archive\reviews\`. Every archive path read, walked or created passes `confine`
// (canonical containment, no reparse point from the archive root down).
//
// A pair moves media first, then sidecar; a sidecar failure moves the media back. A rollback that also
// fails is logged and left: nothing repairs it by name. Every moved file appends one JSONL line
// `{at_ms, from, to}` to the move log (`displaySweepJournal`); W3 link edits read destinations from it.
//
// One in-process lock serializes Save, Clear, Delete and each sweep move. Under it a move re-classifies
// the file (which re-reads the decision and re-hashes the media), so a revised file stays.
//
// Startup, per move under that lock: top-level aged items, then loose archive-root files (not `legacy\`,
// `reviews\`, `shown\`) into `archive\shown\<yyyy-mm>\` by sidecar `at_ms`, else mtime.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use super::display::{decision_sidecar, read_decision_in, request_id_of, sidecar_is_plain_file};
use super::drop::validate_drop_path;
use super::sweep::MAX_AGE;
use super::{kind_of, open_drop_file, DisplayEntry, FILE_ATTRIBUTE_REPARSE_POINT};

/// Entries the scan returns beyond the live gate files.
const NON_LIVE_CAP: usize = 20;
const SIDECAR_CAP: usize = 16 * 1024;
const CACHE_CAP: usize = 4096;

static LOCK: Mutex<()> = Mutex::new(());

/// The one in-process lock over display writes (Save, Clear, Delete, each sweep move).
pub(super) fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub(super) type Rename<'a> = &'a dyn Fn(&Path, &Path) -> io::Result<()>;

/// The folders one sweep works over.
pub(super) struct Ctx {
    pub root: PathBuf,
    pub archive: PathBuf,
    pub shown: PathBuf,
    pub reviews: PathBuf,
    /// the append-only JSONL move log
    pub log: PathBuf,
}

impl Ctx {
    pub fn live() -> Ctx {
        Ctx {
            root: crate::paths::display_dir(),
            archive: crate::paths::display_archive_dir(),
            shown: crate::paths::display_archive_shown_dir(),
            reviews: crate::paths::display_archive_reviews_dir(),
            log: crate::paths::display_sweep_journal_path(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Class {
    Live,
    DecidedFresh,
    DecidedOld,
    LookOnlyFresh,
    LookOnlyOld,
    DocFresh,
    DocOld,
}

impl Class {
    fn movable(self) -> bool {
        matches!(self, Class::DecidedOld | Class::LookOnlyOld | Class::DocOld)
    }
}

#[derive(Clone, Debug)]
pub(super) struct Item {
    pub name: String,
    pub class: Class,
    /// the age basis: the decision's `at_ms` for a decided file, else the mtime
    pub stamp_ms: u64,
    pub mtime_ms: u64,
    /// sha256 of the bytes, when the classifier read them (gate files)
    pub sha: Option<String>,
    /// a regular file, not a link
    pub regular: bool,
}

fn mtime_ms_of(md: &fs::Metadata) -> u64 {
    md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn is_old(stamp_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(stamp_ms) > MAX_AGE.as_millis() as u64
}

fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The shared classifier, uncached (every move-time check). None for anything that is not a display item
/// (folders, sidecars, other types).
pub(super) fn classify(root: &Path, path: &Path, now_ms: u64) -> Option<Item> {
    classify_with(root, path, now_ms, false)
}

fn classify_with(root: &Path, path: &Path, now_ms: u64, cached: bool) -> Option<Item> {
    use std::os::windows::fs::MetadataExt;
    let name = path.file_name()?.to_str()?.to_string();
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".decision.json") {
        return None;
    }
    let ext = lower.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
    let media = matches!(ext.as_str(), "html" | "svg" | "png");
    let doc = matches!(ext.as_str(), "md" | "txt" | "diff");
    if !media && !doc {
        return None;
    }
    let md = fs::symlink_metadata(path).ok()?;
    if md.is_dir() {
        return None;
    }
    let mtime_ms = mtime_ms_of(&md);
    let gate = media && request_id_of(&name).is_some();
    let item = |class: Class, stamp_ms: u64, sha: Option<String>, regular: bool| {
        Some(Item { name: name.clone(), class, stamp_ms, mtime_ms, sha, regular })
    };
    let reparse = md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    let path_str = path.to_string_lossy();
    let regular = md.is_file() && !reparse && validate_drop_path(&path_str, &["html", "svg", "png", "md", "txt", "diff"]).is_ok();
    if !regular {
        // never moved: a gate file stays live, anything else stays fresh
        let class = if gate { Class::Live } else if doc { Class::DocFresh } else { Class::LookOnlyFresh };
        return item(class, mtime_ms, None, false);
    }
    if doc {
        return item(if is_old(mtime_ms, now_ms) { Class::DocOld } else { Class::DocFresh }, mtime_ms, None, true);
    }
    if !gate {
        return item(if is_old(mtime_ms, now_ms) { Class::LookOnlyOld } else { Class::LookOnlyFresh }, mtime_ms, None, true);
    }
    let decided = if cached { cached_decision(root, path, &path_str, &name, &md) } else { decision_now(root, &path_str) };
    match decided {
        Some((at, sha)) => item(if is_old(at, now_ms) { Class::DecidedOld } else { Class::DecidedFresh }, at, Some(sha), true),
        None => item(Class::Live, mtime_ms, None, true),
    }
}

/// `(at_ms, sha256 of the media)` when the file has a current decision.
fn decision_now(root: &Path, path_str: &str) -> Option<(u64, String)> {
    match read_decision_in(root, path_str) {
        Ok((Some(v), sha)) if v.current => Some((v.decision.at_ms, sha)),
        _ => None,
    }
}

// ---- scan cache (the Display scan only) ----

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Stamp {
    len: u64,
    mtime_ns: u128,
    attrs: u32,
}

fn stamp_of(md: &fs::Metadata) -> Stamp {
    use std::os::windows::fs::MetadataExt;
    let mtime_ns = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    Stamp { len: md.len(), mtime_ns, attrs: md.file_attributes() }
}

struct Cached {
    media: Stamp,
    side: Option<Stamp>,
    decided: Option<(u64, String)>,
}

static CACHE: Mutex<BTreeMap<PathBuf, Cached>> = Mutex::new(BTreeMap::new());

/// `decision_now` through the cache: a hit needs the same size, mtime and attributes of the media and of the
/// sidecar (or both sidecars absent). The stamps are taken before the read, so a change during the read
/// leaves a stale key that the next scan misses.
fn cached_decision(root: &Path, path: &Path, path_str: &str, name: &str, md: &fs::Metadata) -> Option<(u64, String)> {
    let media = stamp_of(md);
    let side = fs::symlink_metadata(decision_sidecar(path, name)).ok().map(|m| stamp_of(&m));
    {
        let c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = c.get(path) {
            if hit.media == media && hit.side == side {
                return hit.decided.clone();
            }
        }
    }
    let decided = decision_now(root, path_str);
    let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if c.len() >= CACHE_CAP {
        c.clear();
    }
    c.insert(path.to_path_buf(), Cached { media, side, decided: decided.clone() });
    decided
}

fn top_level(root: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(root) else { return Vec::new() };
    let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    v.sort();
    v
}

/// The Display file list: every live gate file (uncapped) plus the newest `NON_LIVE_CAP` other display
/// files, newest first. Files under 2 s old are left for the next tick (mid-write).
pub(super) fn scan_display_files(root: &Path, now_ms: u64) -> Option<Vec<DisplayEntry>> {
    let rd = fs::read_dir(root).ok()?;
    let mut live: Vec<DisplayEntry> = Vec::new();
    let mut rest: Vec<DisplayEntry> = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        let lower = p.to_string_lossy().to_ascii_lowercase();
        if !(lower.ends_with(".svg") || lower.ends_with(".html") || lower.ends_with(".png")) {
            continue;
        }
        let Some(item) = classify_with(root, &p, now_ms, true) else { continue };
        if !item.regular || now_ms.saturating_sub(item.mtime_ms) < 2000 {
            continue;
        }
        let entry = DisplayEntry { path: p.to_string_lossy().into_owned(), kind: kind_of(&lower), mtime_ms: item.mtime_ms, group: None };
        if item.class == Class::Live {
            live.push(entry);
        } else {
            rest.push(entry);
        }
    }
    rest.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    rest.truncate(NON_LIVE_CAP);
    live.extend(rest);
    live.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Some(live)
}

// ---- archive confinement ----

/// Ok(true) present and not a reparse point, Ok(false) absent, Err a link/junction or unreadable.
fn plain_or_absent(p: &Path) -> Result<bool, String> {
    use std::os::windows::fs::MetadataExt;
    match fs::symlink_metadata(p) {
        Ok(md) if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => Err(format!("{} is a link or junction", p.display())),
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{}: {e}", p.display())),
    }
}

/// The one archive confinement check, for every archive path the sweep reads, walks or creates: `p` sits
/// under the archive root by plain components (no `..`), neither the archive root nor anything existing
/// below it on the way to `p` is a reparse point, and the canonical form of the deepest existing part is
/// inside the canonical archive root.
pub(super) fn confine(archive: &Path, p: &Path) -> Result<(), String> {
    let rel = p.strip_prefix(archive).map_err(|_| format!("{} is outside the archive", p.display()))?;
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("{} is not a plain path under the archive", p.display()));
    }
    if !plain_or_absent(archive)? {
        return Ok(()); // no archive yet: nothing below it exists to redirect anything
    }
    let canon_root = fs::canonicalize(archive).map_err(|e| format!("{}: {e}", archive.display()))?;
    let mut cur = archive.to_path_buf();
    let mut deepest = archive.to_path_buf();
    for c in rel.components() {
        cur.push(c);
        if !plain_or_absent(&cur)? {
            break;
        }
        deepest = cur.clone();
    }
    let canon = fs::canonicalize(&deepest).map_err(|e| format!("{}: {e}", deepest.display()))?;
    if !canon.starts_with(&canon_root) {
        return Err(format!("{} resolves outside the archive", p.display()));
    }
    Ok(())
}

/// `p` confined to the archive and inside `within` (`shown` or `reviews`).
fn confine_to(ctx: &Ctx, within: &Path, p: &Path) -> Result<(), String> {
    if !p.starts_with(within) {
        return Err(format!("{} is outside {}", p.display(), within.display()));
    }
    confine(&ctx.archive, p)
}

/// Creates a destination folder only after it passes `confine_to`, and checks it again once it exists.
fn make_dir_in(ctx: &Ctx, within: &Path, dir: &Path) -> Result<(), String> {
    confine_to(ctx, within, dir)?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    confine_to(ctx, within, dir)
}

// ---- move log ----

fn log_line(ctx: &Ctx, v: serde_json::Value) {
    use std::io::Write;
    if let Some(parent) = ctx.log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let line = format!("{v}\n");
    if let Err(e) = fs::OpenOptions::new().append(true).create(true).open(&ctx.log).and_then(|mut f| f.write_all(line.as_bytes())) {
        eprintln!("[sweep] could not append to the move log {}: {e}", ctx.log.display());
    }
}

/// One path form in the log whoever moved the file: Clear passes canonical `\\?\C:\...` paths, the sweep
/// plain `C:\...` ones, and W3 matches links against `from`.
fn plain_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
    }
}

fn log_move(ctx: &Ctx, from: &Path, to: &Path) {
    log_line(ctx, serde_json::json!({ "at_ms": wall_ms(), "from": plain_path(from), "to": plain_path(to) }));
}

// ---- destinations and pair moves ----

/// `yyyy-mm` of an epoch-ms instant (UTC).
pub(super) fn month_of(ms: u64) -> String {
    crate::driver_mode::utc_stamp(ms / 1000)[..7].to_string()
}

fn taken(dir: &Path, names: &[String]) -> bool {
    names.iter().any(|n| fs::symlink_metadata(dir.join(n)).is_ok())
}

/// `base` when none of `names` is there; else `base\~<ms>` (the first free ms from `now_ms`).
fn free_dest(base: &Path, names: &[String], now_ms: u64) -> PathBuf {
    let mut dir = base.to_path_buf();
    let mut ms = now_ms;
    while taken(&dir, names) {
        dir = base.join(format!("~{ms}"));
        ms += 1;
    }
    dir
}

/// Media first, then sidecar. A sidecar failure moves the media back; a rollback that fails too is logged
/// and left (media at the destination, sidecar at its source).
fn move_pair(ctx: &Ctx, rename: Rename, within: &Path, media: &Path, side: Option<&Path>, dest_dir: &Path, name: &str) -> Result<PathBuf, String> {
    make_dir_in(ctx, within, dest_dir)?;
    let dest_media = dest_dir.join(name);
    rename(media, &dest_media).map_err(|e| format!("could not move {name}: {e}"))?;
    if let Some(s) = side {
        let dest_side = dest_dir.join(format!("{name}.decision.json"));
        if let Err(e) = rename(s, &dest_side) {
            return Err(match rename(&dest_media, media) {
                Ok(()) => format!("could not move the decision for {name}: {e}; {name} stays"),
                Err(e2) => {
                    let msg = format!("could not move the decision for {name}: {e}; could not put it back either: {e2}; left as is");
                    log_move(ctx, media, &dest_media);
                    log_line(ctx, serde_json::json!({ "at_ms": wall_ms(), "from": s.to_string_lossy(), "to": null, "error": msg }));
                    msg
                }
            });
        }
        log_move(ctx, media, &dest_media);
        log_move(ctx, s, &dest_side);
    } else {
        log_move(ctx, media, &dest_media);
    }
    Ok(dest_media)
}

/// Clear: the pair into `shown\<month of the Clear>\`. The caller holds the lock.
pub(super) fn clear_core(ctx: &Ctx, rename: Rename, media: &Path, name: &str, now_ms: u64) -> Result<PathBuf, String> {
    let side = decision_sidecar(media, name);
    let side = sidecar_is_plain_file(&side).then_some(side);
    pair_to_shown(ctx, rename, media, name, side.as_deref(), now_ms, now_ms)
}

fn pair_to_shown(ctx: &Ctx, rename: Rename, media: &Path, name: &str, side: Option<&Path>, month_ms: u64, now_ms: u64) -> Result<PathBuf, String> {
    let mut names = vec![name.to_string()];
    if side.is_some() {
        names.push(format!("{name}.decision.json"));
    }
    let dir = free_dest(&ctx.shown.join(month_of(month_ms)), &names, now_ms);
    move_pair(ctx, rename, &ctx.shown, media, side, &dir, name)
}

/// Re-classifies (re-reading the decision and re-hashing a gate file) under the lock and moves one
/// top-level item when it is still the same movable thing. Ok(false): left in place.
fn move_top_item(ctx: &Ctx, rename: Rename, path: &Path, first: &Item, now_ms: u64) -> Result<bool, String> {
    let _guard = lock();
    let Some(cur) = classify(&ctx.root, path, now_ms) else { return Ok(false) };
    if !cur.regular || !cur.class.movable() || cur.class != first.class || cur.stamp_ms != first.stamp_ms || cur.sha != first.sha {
        return Ok(false);
    }
    if cur.class == Class::DocOld {
        // documents keep the old rule: an existing name in the destination is skipped
        if fs::symlink_metadata(ctx.reviews.join(&cur.name)).is_ok() {
            return Ok(false);
        }
        move_pair(ctx, rename, &ctx.reviews, path, None, &ctx.reviews, &cur.name)?;
        return Ok(true);
    }
    let side = decision_sidecar(path, &cur.name);
    let side = sidecar_is_plain_file(&side).then_some(side);
    pair_to_shown(ctx, rename, path, &cur.name, side.as_deref(), cur.stamp_ms, now_ms)?;
    Ok(true)
}

/// Every movable top-level item is re-checked under the lock and moved.
/// `between` runs after the first classification and before the locked re-check (tests revise files there).
fn sweep_top(ctx: &Ctx, rename: Rename, now_ms: u64, between: &dyn Fn(&Path)) -> usize {
    let mut moved = 0;
    for p in top_level(&ctx.root) {
        let Some(first) = classify(&ctx.root, &p, now_ms) else { continue };
        if !first.class.movable() {
            continue;
        }
        between(&p);
        match move_top_item(ctx, rename, &p, &first, now_ms) {
            Ok(true) => moved += 1,
            Ok(false) => {}
            Err(e) => eprintln!("[sweep] {e}"),
        }
    }
    moved
}

fn sidecar_at_ms(side: &Path) -> Option<u64> {
    let (_, buf, more) = open_drop_file(side, SIDECAR_CAP).ok()?;
    if more {
        return None;
    }
    serde_json::from_slice::<serde_json::Value>(&buf).ok()?.get("atMs")?.as_u64()
}

/// One loose archive-root file (with its sidecar) into `shown\<month>\`, by sidecar `at_ms`, else mtime.
fn move_root_file(ctx: &Ctx, rename: Rename, p: &Path, name: &str, now_ms: u64) -> Result<bool, String> {
    let _guard = lock();
    confine(&ctx.archive, p)?;
    if !fs::symlink_metadata(p).map_or(false, |m| m.is_file()) {
        return Ok(false); // gone since the listing
    }
    let is_side = name.ends_with(".decision.json");
    let side = (!is_side).then(|| decision_sidecar(p, name)).filter(|s| sidecar_is_plain_file(s));
    let stamp = if is_side { sidecar_at_ms(p) } else { side.as_deref().and_then(sidecar_at_ms) }
        .or_else(|| fs::symlink_metadata(p).ok().map(|m| mtime_ms_of(&m)))
        .unwrap_or(now_ms);
    pair_to_shown(ctx, rename, p, name, side.as_deref(), stamp, now_ms).map(|_| true)
}

/// Loose files in the archive root (folders -- legacy, reviews, shown -- stay) go to `shown` by month.
fn sweep_archive_root(ctx: &Ctx, rename: Rename, now_ms: u64) -> usize {
    if let Err(e) = confine(&ctx.archive, &ctx.archive) {
        eprintln!("[sweep] archive root skipped: {e}");
        return 0;
    }
    let files: Vec<PathBuf> = top_level(&ctx.archive).into_iter().filter(|p| fs::symlink_metadata(p).map_or(false, |m| m.is_file())).collect();
    let mut moved = 0;
    for p in &files {
        let Some(name) = p.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        if name.strip_suffix(".decision.json").is_some_and(|media| files.iter().any(|q| q.file_name().and_then(|n| n.to_str()) == Some(media))) {
            continue; // travels with its media
        }
        match move_root_file(ctx, rename, p, &name, now_ms) {
            Ok(true) => moved += 1,
            Ok(false) => {}
            Err(e) => eprintln!("[sweep] {name}: {e}"),
        }
    }
    moved
}

/// Startup entry: aged top-level items, then loose archive-root files. Returns the files-or-pairs moved.
pub(super) fn run_startup(ctx: &Ctx, now_ms: u64, rename: Rename) -> usize {
    sweep_top(ctx, rename, now_ms, &|_| {}) + sweep_archive_root(ctx, rename, now_ms)
}

#[cfg(test)]
mod tests {
    use super::super::sha256_hex;
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const DAY_MS: u64 = 24 * 60 * 60 * 1000;
    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn real_now() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
    }

    /// A fresh display folder, archive and move log under a temp root.
    fn ctx(tag: &str) -> Ctx {
        let base = std::env::temp_dir().join(format!("vidar-dsweep-{}-{}-{tag}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&base);
        let archive = base.join("display").join("archive");
        fs::create_dir_all(base.join("display")).unwrap();
        fs::create_dir_all(&archive).unwrap();
        Ctx { root: base.join("display"), shown: archive.join("shown"), reviews: archive.join("reviews"), archive, log: base.join("display-sweep.jsonl") }
    }

    fn cleanup(c: &Ctx) {
        let _ = fs::remove_dir_all(c.root.parent().unwrap());
    }

    fn put(c: &Ctx, name: &str, body: &str) -> PathBuf {
        let p = c.root.join(name);
        fs::write(&p, body).unwrap();
        p
    }

    fn set_mtime(p: &Path, secs_since_epoch: u64) {
        let f = fs::File::options().write(true).open(p).unwrap();
        f.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(secs_since_epoch)).unwrap();
    }

    fn age(p: &Path, days: u64) {
        set_mtime(p, real_now() / 1000 - days * 86_400);
    }

    fn sidecar_json(name: &str, sha: &str, verdict: &str, at_ms: u64) -> String {
        serde_json::json!({ "file": name, "sha256": sha, "verdict": verdict, "comment": "", "atMs": at_ms, "request": null }).to_string()
    }

    fn decide(c: &Ctx, name: &str, verdict: &str, at_ms: u64) {
        let sha = sha256_hex(&fs::read(c.root.join(name)).unwrap());
        fs::write(c.root.join(format!("{name}.decision.json")), sidecar_json(name, &sha, verdict, at_ms)).unwrap();
    }

    fn cls(c: &Ctx, name: &str, now: u64) -> Class {
        classify(&c.root, &c.root.join(name), now).unwrap().class
    }

    fn real() -> Rename<'static> {
        &|a, b| fs::rename(a, b)
    }

    fn tops(c: &Ctx) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(&c.root).unwrap().flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn log_lines(c: &Ctx) -> Vec<serde_json::Value> {
        fs::read_to_string(&c.log).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    /// A pair whose sidecar move and rollback both failed: media in shown\<month>\, sidecar at the top.
    fn half_moved_pair(c: &Ctx, now: u64) -> PathBuf {
        let at = now - 10 * DAY_MS;
        put(c, "pair-aaaaaaaa.html", "x");
        decide(c, "pair-aaaaaaaa.html", "approve", at);
        let root = c.root.clone();
        let rename = |a: &Path, b: &Path| {
            if a.to_string_lossy().ends_with(".decision.json") || b.parent() == Some(root.as_path()) {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked"))
            } else {
                fs::rename(a, b)
            }
        };
        assert_eq!(sweep_top(c, &rename, now, &|_| {}), 0);
        c.shown.join(month_of(at))
    }

    #[test]
    fn display_gate_classes() {
        let c = ctx("gate");
        let now = real_now();
        put(&c, "missing-aaaaaaaa.html", "x");
        put(&c, "fresh-bbbbbbbb.html", "x");
        decide(&c, "fresh-bbbbbbbb.html", "approve", now - DAY_MS);
        put(&c, "old-cccccccc.html", "x");
        decide(&c, "old-cccccccc.html", "deny", now - 10 * DAY_MS);
        put(&c, "stale-dddddddd.html", "x");
        decide(&c, "stale-dddddddd.html", "approve", now - 10 * DAY_MS);
        fs::write(c.root.join("stale-dddddddd.html"), "revised").unwrap();
        put(&c, "bad-eeeeeeee.html", "x");
        fs::write(c.root.join("bad-eeeeeeee.html.decision.json"), "{nope").unwrap();
        put(&c, "dir-ffffffff.html", "x");
        fs::create_dir(c.root.join("dir-ffffffff.html.decision.json")).unwrap();
        put(&c, "wrong-11111111.html", "x");
        let sha = sha256_hex(b"x");
        fs::write(c.root.join("wrong-11111111.html.decision.json"), sidecar_json("other-11111111.html", &sha, "approve", now - 10 * DAY_MS)).unwrap();

        assert_eq!(cls(&c, "missing-aaaaaaaa.html", now), Class::Live);
        assert_eq!(cls(&c, "fresh-bbbbbbbb.html", now), Class::DecidedFresh);
        // aged by at_ms: the file itself is brand new
        let old = classify(&c.root, &c.root.join("old-cccccccc.html"), now).unwrap();
        assert_eq!((old.class, old.stamp_ms), (Class::DecidedOld, now - 10 * DAY_MS));
        assert_eq!(cls(&c, "stale-dddddddd.html", now), Class::Live);
        assert_eq!(cls(&c, "bad-eeeeeeee.html", now), Class::Live);
        assert_eq!(cls(&c, "dir-ffffffff.html", now), Class::Live);
        assert_eq!(cls(&c, "wrong-11111111.html", now), Class::Live);
        cleanup(&c);
    }

    #[test]
    fn display_look_only_and_doc_classes() {
        let c = ctx("look");
        let now = real_now();
        let a = put(&c, "look-fresh.html", "x");
        age(&a, 1);
        let b = put(&c, "look-old.svg", "x");
        age(&b, 10);
        let d = put(&c, "note-old.md", "x");
        age(&d, 10);
        put(&c, "note-new.md", "x");
        let e = put(&c, "change-old.diff", "x");
        age(&e, 10);
        put(&c, "side-aaaaaaaa.html.decision.json", "{}");
        put(&c, "other.json", "{}");
        assert_eq!(cls(&c, "look-fresh.html", now), Class::LookOnlyFresh);
        assert_eq!(cls(&c, "look-old.svg", now), Class::LookOnlyOld);
        assert_eq!(cls(&c, "note-old.md", now), Class::DocOld);
        assert_eq!(cls(&c, "note-new.md", now), Class::DocFresh);
        assert_eq!(cls(&c, "change-old.diff", now), Class::DocOld);
        assert!(classify(&c.root, &c.root.join("side-aaaaaaaa.html.decision.json"), now).is_none());
        assert!(classify(&c.root, &c.root.join("other.json"), now).is_none());
        cleanup(&c);
    }

    #[test]
    fn display_month_is_utc_yyyy_mm() {
        assert_eq!(month_of(1_760_000_000_000), "2025-10");
        assert_eq!(month_of(0), "1970-01");
    }

    #[test]
    fn display_scan_returns_every_live_gate_file() {
        let c = ctx("live60");
        for i in 0..60 {
            put(&c, &format!("pending-{i:08x}.html"), "x");
        }
        let got = scan_display_files(&c.root, real_now() + 10_000).unwrap();
        assert_eq!(got.len(), 60);
        cleanup(&c);
    }

    #[test]
    fn display_scan_keeps_twenty_non_live_beside_sixty_live() {
        let c = ctx("cap");
        let now = real_now();
        for i in 0..60 {
            put(&c, &format!("pending-{i:08x}.html"), "x");
        }
        for i in 0..25 {
            let name = format!("decided-{:08x}.html", 0x1000 + i);
            put(&c, &name, "x");
            decide(&c, &name, "approve", now - DAY_MS);
        }
        let got = scan_display_files(&c.root, now + 10_000).unwrap();
        let decided = got.iter().filter(|e| e.path.contains("decided-")).count();
        assert_eq!((got.len(), decided), (80, 20));
        cleanup(&c);
    }

    #[test]
    fn display_scan_cache_invalidates_on_a_sidecar_change() {
        let c = ctx("cache");
        let now = real_now();
        let p = put(&c, "cached-aaaaaaaa.html", "abc");
        set_mtime(&p, 1_760_000_000);
        decide(&c, "cached-aaaaaaaa.html", "approve", now - DAY_MS);
        let cached = |c: &Ctx| classify_with(&c.root, &p, now, true).unwrap().class;
        assert_eq!(cached(&c), Class::DecidedFresh);

        // same size, same mtime, different bytes: the cache still answers (it is keyed by size + mtime)
        fs::write(&p, "xyz").unwrap();
        set_mtime(&p, 1_760_000_000);
        assert_eq!(cached(&c), Class::DecidedFresh, "a hit");
        assert_eq!(cls(&c, "cached-aaaaaaaa.html", now), Class::Live, "the uncached move-time check sees the change");

        // any sidecar change invalidates: a rewritten (malformed) decision is read afresh
        fs::write(c.root.join("cached-aaaaaaaa.html.decision.json"), "{nope").unwrap();
        assert_eq!(cached(&c), Class::Live);
        // and a valid decision for the new bytes is picked up again
        decide(&c, "cached-aaaaaaaa.html", "deny", now - 10 * DAY_MS);
        assert_eq!(cached(&c), Class::DecidedOld);
        cleanup(&c);
    }

    #[test]
    fn sweep_moves_old_by_month_and_leaves_the_rest() {
        let c = ctx("moves");
        let now = real_now();
        let at = now - 10 * DAY_MS;
        put(&c, "old-aaaaaaaa.html", "old");
        decide(&c, "old-aaaaaaaa.html", "approve", at);
        put(&c, "new-bbbbbbbb.html", "new");
        decide(&c, "new-bbbbbbbb.html", "approve", now - DAY_MS);
        let pend = put(&c, "pend-cccccccc.html", "pending");
        age(&pend, 30);
        let look = put(&c, "look.html", "look");
        age(&look, 10);
        let doc = put(&c, "tidy.md", "doc");
        age(&doc, 10);
        let month = c.shown.join(month_of(at));

        let moved = sweep_top(&c, real(), now, &|_| {});
        assert_eq!(moved, 3);
        assert!(month.join("old-aaaaaaaa.html").is_file() && month.join("old-aaaaaaaa.html.decision.json").is_file());
        assert!(c.reviews.join("tidy.md").is_file());
        let look_month = c.shown.join(month_of(real_now() - 10 * DAY_MS));
        assert!(look_month.join("look.html").is_file());
        assert_eq!(tops(&c), vec!["new-bbbbbbbb.html", "new-bbbbbbbb.html.decision.json", "pend-cccccccc.html"]);
        cleanup(&c);
    }

    #[test]
    fn sweep_old_review_file_with_a_fresh_decision_stays() {
        let c = ctx("legacy");
        let now = real_now();
        let p = put(&c, "review-aaaaaaaa.html", "x");
        decide(&c, "review-aaaaaaaa.html", "approve", now - DAY_MS);
        age(&p, 30);
        age(&c.root.join("review-aaaaaaaa.html.decision.json"), 30);
        assert_eq!(cls(&c, "review-aaaaaaaa.html", now), Class::DecidedFresh, "aged by the decision, not the mtime");
        assert_eq!(run_startup(&c, now, real()), 0);
        assert!(c.root.join("review-aaaaaaaa.html").is_file() && c.root.join("review-aaaaaaaa.html.decision.json").is_file());
        assert!(!c.shown.exists() && !c.reviews.join("review-aaaaaaaa.html").exists());
        cleanup(&c);
    }

    #[test]
    fn sweep_collision_goes_to_tilde_subfolder_with_name_intact() {
        let c = ctx("clash");
        let now = real_now();
        let at = now - 10 * DAY_MS;
        let month = c.shown.join(month_of(at));
        fs::create_dir_all(&month).unwrap();
        fs::write(month.join("dup-aaaaaaaa.html"), "earlier").unwrap();
        for round in 0..2 {
            put(&c, "dup-aaaaaaaa.html", &format!("round {round}"));
            decide(&c, "dup-aaaaaaaa.html", "approve", at);
            assert_eq!(sweep_top(&c, real(), now, &|_| {}), 1);
        }
        let mut subs: Vec<PathBuf> = fs::read_dir(&month).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        subs.sort();
        assert_eq!(subs.len(), 2, "repeated clash gets its own folder");
        for s in &subs {
            assert!(s.file_name().unwrap().to_string_lossy().starts_with('~'));
            let side: serde_json::Value = serde_json::from_slice(&fs::read(s.join("dup-aaaaaaaa.html.decision.json")).unwrap()).unwrap();
            assert_eq!(side["file"], "dup-aaaaaaaa.html");
            assert!(s.join("dup-aaaaaaaa.html").is_file());
        }
        assert_eq!(fs::read_to_string(month.join("dup-aaaaaaaa.html")).unwrap(), "earlier");
        cleanup(&c);
    }

    #[test]
    fn sweep_scan_between_the_two_renames_shows_nothing_new() {
        let c = ctx("between");
        let now = real_now();
        put(&c, "pair-aaaaaaaa.html", "x");
        decide(&c, "pair-aaaaaaaa.html", "approve", now - 10 * DAY_MS);
        let seen = std::cell::RefCell::new(Vec::<usize>::new());
        let rename = |a: &Path, b: &Path| {
            if a.to_string_lossy().ends_with(".decision.json") {
                // media already moved, sidecar still at the top
                seen.borrow_mut().push(scan_display_files(&c.root, now + 10_000).unwrap().len());
            }
            fs::rename(a, b)
        };
        assert_eq!(sweep_top(&c, &rename, now, &|_| {}), 1);
        assert_eq!(*seen.borrow(), vec![0]);
        cleanup(&c);
    }

    #[test]
    fn sweep_sidecar_failure_rolls_the_media_back() {
        let c = ctx("rollback");
        let now = real_now();
        put(&c, "pair-aaaaaaaa.html", "x");
        decide(&c, "pair-aaaaaaaa.html", "approve", now - 10 * DAY_MS);
        let rename = |a: &Path, b: &Path| {
            if a.to_string_lossy().ends_with(".decision.json") {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "locked"))
            } else {
                fs::rename(a, b)
            }
        };
        assert_eq!(sweep_top(&c, &rename, now, &|_| {}), 0);
        assert_eq!(tops(&c), vec!["pair-aaaaaaaa.html", "pair-aaaaaaaa.html.decision.json"]);
        assert!(!c.shown.join(month_of(now - 10 * DAY_MS)).join("pair-aaaaaaaa.html").exists());
        assert!(log_lines(&c).is_empty(), "a clean rollback logs no move");
        cleanup(&c);
    }

    #[test]
    fn sweep_rollback_failure_is_logged_and_left() {
        let c = ctx("repair");
        let now = real_now();
        let month = half_moved_pair(&c, now);
        assert!(month.join("pair-aaaaaaaa.html").is_file());
        assert_eq!(tops(&c), vec!["pair-aaaaaaaa.html.decision.json"]);
        assert!(scan_display_files(&c.root, now + 10_000).unwrap().is_empty(), "no phantom pending");
        let log = log_lines(&c);
        assert!(log.iter().any(|l| l["error"].as_str().is_some_and(|e| e.contains("could not put it back"))), "{log:?}");
        // no repair: the next startup leaves the orphan sidecar where it is
        assert_eq!(run_startup(&c, now, real()), 0);
        assert_eq!(tops(&c), vec!["pair-aaaaaaaa.html.decision.json"]);
        assert!(!month.join("pair-aaaaaaaa.html.decision.json").exists());
        cleanup(&c);
    }

    #[test]
    fn sweep_appends_each_move_to_the_log() {
        let c = ctx("log");
        let now = real_now();
        let at = now - 10 * DAY_MS;
        put(&c, "pair-aaaaaaaa.html", "x");
        decide(&c, "pair-aaaaaaaa.html", "approve", at);
        let doc = put(&c, "tidy.md", "doc");
        age(&doc, 10);
        assert_eq!(sweep_top(&c, real(), now, &|_| {}), 2);
        let log = log_lines(&c);
        assert_eq!(log.len(), 3, "{log:?}");
        let month = c.shown.join(month_of(at));
        let pair = |n: &str| (c.root.join(n).to_string_lossy().into_owned(), month.join(n).to_string_lossy().into_owned());
        for n in ["pair-aaaaaaaa.html", "pair-aaaaaaaa.html.decision.json"] {
            let (from, to) = pair(n);
            assert!(log.iter().any(|l| l["from"] == from.as_str() && l["to"] == to.as_str() && l["at_ms"].as_u64().is_some()), "{n}: {log:?}");
        }
        let (from, to) = (c.root.join("tidy.md").to_string_lossy().into_owned(), c.reviews.join("tidy.md").to_string_lossy().into_owned());
        assert!(log.iter().any(|l| l["from"] == from.as_str() && l["to"] == to.as_str()), "{log:?}");
        cleanup(&c);
    }

    #[test]
    fn sweep_revision_between_classify_and_move_is_not_moved() {
        let c = ctx("revise");
        let now = real_now();
        put(&c, "pair-aaaaaaaa.html", "x");
        decide(&c, "pair-aaaaaaaa.html", "approve", now - 10 * DAY_MS);
        let look = put(&c, "look.html", "x");
        age(&look, 10);
        let revise = |p: &Path| {
            // a writer revises the file after the first classification
            fs::write(p, "revised").unwrap();
        };
        assert_eq!(sweep_top(&c, real(), now, &revise), 0);
        assert!(c.root.join("pair-aaaaaaaa.html").is_file() && c.root.join("look.html").is_file());
        assert!(!c.shown.exists() || fs::read_dir(&c.shown).unwrap().next().is_none());
        cleanup(&c);
    }

    #[test]
    fn sweep_reappearing_file_classifies_live() {
        let c = ctx("reappear");
        let now = real_now();
        put(&c, "pair-aaaaaaaa.html", "x");
        decide(&c, "pair-aaaaaaaa.html", "approve", now - 10 * DAY_MS);
        assert_eq!(sweep_top(&c, real(), now, &|_| {}), 1);
        assert!(tops(&c).is_empty());
        put(&c, "pair-aaaaaaaa.html", "x again");
        assert_eq!(cls(&c, "pair-aaaaaaaa.html", now), Class::Live);
        assert_eq!(sweep_top(&c, real(), now, &|_| {}), 0);
        cleanup(&c);
    }

    #[test]
    fn sweep_clear_uses_the_pair_routine_into_the_month_of_the_clear() {
        let c = ctx("clear");
        let now = real_now();
        let p = put(&c, "mock-aaaaaaaa.html", "x");
        decide(&c, "mock-aaaaaaaa.html", "approve", now);
        // the real caller passes display_child's canonical (`\\?\`) path
        let canon = fs::canonicalize(&p).unwrap();
        let dest = clear_core(&c, real(), &canon, "mock-aaaaaaaa.html", now).unwrap();
        assert_eq!(dest.file_name(), Some(std::ffi::OsStr::new("mock-aaaaaaaa.html")));
        assert!(dest.parent().unwrap().ends_with(month_of(now)));
        assert!(dest.with_file_name("mock-aaaaaaaa.html.decision.json").is_file());
        assert!(tops(&c).is_empty());
        let log = log_lines(&c);
        assert_eq!(log.len(), 2, "{log:?}");
        for l in &log {
            let (from, to) = (l["from"].as_str().unwrap(), l["to"].as_str().unwrap());
            assert!(!from.starts_with(r"\\?\") && !to.starts_with(r"\\?\"), "{l}");
            assert_eq!(plain_path(Path::new(from)), from);
        }
        assert!(log.iter().any(|l| l["from"].as_str().unwrap().ends_with(r"\mock-aaaaaaaa.html")));
        cleanup(&c);
    }

    #[test]
    fn sweep_destination_outside_shown_or_reviews_is_refused() {
        let c = ctx("contain");
        let outside = c.root.parent().unwrap().join("elsewhere");
        let dotdot = c.shown.join("..").join("..").join("..").join("elsewhere");
        assert!(confine_to(&c, &c.shown, &c.shown.join("2025-10")).is_ok());
        assert!(confine_to(&c, &c.reviews, &c.reviews).is_ok());
        for (tag, dest) in [("outside", &outside), ("dotdot", &dotdot), ("archive-root", &c.archive), ("reviews-as-shown", &c.reviews)] {
            assert!(confine_to(&c, &c.shown, dest).is_err(), "{tag}");
        }
        assert!(confine_to(&c, &c.reviews, &c.shown.join("2025-10")).is_err());
        assert!(make_dir_in(&c, &c.shown, &outside).is_err());
        assert!(!outside.exists());
        cleanup(&c);
    }

    #[test]
    fn sweep_archive_root_loose_files_are_moved_by_month() {
        let c = ctx("archroot");
        let now = real_now();
        // sidecar at_ms wins over mtime; no sidecar falls back to mtime; folders stay
        fs::write(c.archive.join("paired.png"), "p").unwrap();
        set_mtime(&c.archive.join("paired.png"), 1_760_000_000); // 2025-10
        let sha = sha256_hex(b"p");
        fs::write(c.archive.join("paired.png.decision.json"), sidecar_json("paired.png", &sha, "approve", 1_741_000_000_000)).unwrap(); // 2025-03
        fs::write(c.archive.join("bare.html"), "b").unwrap();
        set_mtime(&c.archive.join("bare.html"), 1_760_000_000);
        fs::create_dir_all(c.archive.join("legacy")).unwrap();
        fs::write(c.archive.join("legacy").join("keep.html"), "k").unwrap();
        fs::create_dir_all(&c.reviews).unwrap();
        fs::write(c.reviews.join("r.md"), "r").unwrap();

        assert_eq!(run_startup(&c, now, real()), 2);
        let paired = c.shown.join("2025-03");
        assert!(paired.join("paired.png").is_file() && paired.join("paired.png.decision.json").is_file());
        assert!(c.shown.join("2025-10").join("bare.html").is_file());
        assert!(c.archive.join("legacy").join("keep.html").is_file() && c.reviews.join("r.md").is_file());
        let left: Vec<String> = fs::read_dir(&c.archive).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left.iter().filter(|n| n.contains('.')).count(), 0, "{left:?}");
        cleanup(&c);
    }
}
