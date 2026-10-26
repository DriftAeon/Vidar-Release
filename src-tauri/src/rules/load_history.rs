//! src-tauri\src\rules\load_history.rs — `runes_load_history`: when each instruction file, read,
//! rune read, skill and Bare set was last used, swept from a profile's Claude transcripts and the
//! Bare launch manifests into the `runeLoadHistory` file, `paths::rune_load_history` (nothing in the app reads it, it is there for a user's own cleanup).
//! Paths and ids only: transcript content never reaches the file (`loaded.rs` returns none).
//! Each transcript keeps a watermark (len, mtime, sha256 of its first 4 KB): a grown file with the
//! same head resumes at `len`, a changed head or a shrunk file rescans, a deleted file's mark goes.
//! `len` is the end of the last complete line read (or the file length once the scan went partial).
//! Dates are the transcript's (or manifest's) mtime as a local `YYYY-MM-DD`, kept as a max per key.
//! The file is shared by every profile: one sweep keeps the marks of other profiles' live transcripts.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::catalog::clean;

/// Bytes of a transcript's head the watermark hashes.
const HEAD: u64 = 4096;
/// A gap between sweeps longer than this resets `since`.
const RETENTION_DAYS: i64 = 30;
/// A Bare launch manifest is read to at most this many bytes.
const MANIFEST_CAP: u64 = 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Mark {
    pub len: u64,
    /// Unix milliseconds.
    pub mtime: u64,
    pub head: String,
    pub partial: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub version: u32,
    pub since: String,
    pub last_sweep: String,
    #[serde(default)]
    pub transcripts: BTreeMap<String, Mark>,
    #[serde(default)]
    pub paths: BTreeMap<String, String>,
    #[serde(default)]
    pub reads: BTreeMap<String, String>,
    #[serde(default)]
    pub rune_reads: BTreeMap<String, String>,
    #[serde(default)]
    pub skills: BTreeMap<String, String>,
    #[serde(default)]
    pub bare_sets: BTreeMap<String, String>,
}

/// One sweep at a time across the process: two would race the read-modify-write of the file.
static SWEEP: Mutex<()> = Mutex::new(());

fn note(map: &mut BTreeMap<String, String>, key: String, date: &str) {
    let e = map.entry(key).or_default();
    if e.as_str() < date {
        *e = date.to_string();
    }
}

/// The key form `paths` and `reads` use: forward slashes, lowercase.
fn path_key(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

fn ms(t: Option<SystemTime>) -> u64 {
    t.and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

/// sha256 hex of the first `min(n, HEAD)` bytes of `path`.
fn head_hash(path: &Path, n: u64) -> std::io::Result<String> {
    let mut buf = Vec::new();
    std::fs::File::open(path)?.take(n.min(HEAD)).read_to_end(&mut buf)?;
    Ok(Sha256::digest(&buf).iter().map(|b| format!("{b:02x}")).collect())
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant), for the retention gap.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn day_number(date: &str) -> Option<i64> {
    let mut it = date.splitn(3, '-').map(|s| s.parse::<i64>().ok());
    Some(days_from_civil(it.next()??, it.next()??, it.next()??))
}

/// UTC civil date of unix milliseconds; the fallback where no local zone is known.
fn utc_date(ms: u64) -> String {
    let days = (ms / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Local `YYYY-MM-DD` of unix milliseconds, with the zone rules in force at that instant
/// (kernel32 `SystemTimeToTzSpecificLocalTime`; no time crate in this tree, as `speak.rs`).
#[cfg(windows)]
fn local_date(ms: u64) -> String {
    #[repr(C)]
    #[derive(Default)]
    struct FileTime { low: u32, high: u32 }
    #[repr(C)]
    #[derive(Default)]
    struct SysTime { year: u16, month: u16, dow: u16, day: u16, hour: u16, minute: u16, second: u16, millis: u16 }
    extern "system" {
        fn FileTimeToSystemTime(ft: *const FileTime, st: *mut SysTime) -> i32;
        fn SystemTimeToTzSpecificLocalTime(tz: *const core::ffi::c_void, utc: *const SysTime, local: *mut SysTime) -> i32;
    }
    let ticks = (ms + 11_644_473_600_000) * 10_000;
    let ft = FileTime { low: ticks as u32, high: (ticks >> 32) as u32 };
    let (mut utc, mut local) = (SysTime::default(), SysTime::default());
    // SAFETY: both calls get valid, correctly-sized in and out pointers; a null zone means the current one.
    let ok = unsafe { FileTimeToSystemTime(&ft, &mut utc) != 0 && SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) != 0 };
    if !ok {
        return utc_date(ms);
    }
    format!("{:04}-{:02}-{:02}", local.year, local.month, local.day)
}

#[cfg(not(windows))]
fn local_date(ms: u64) -> String {
    utc_date(ms)
}

/// `<home>\projects\<slug>\*.jsonl` across `homes` (subagent transcripts are sidechains and record no loads).
fn transcripts_in(homes: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for slug in homes.iter().filter_map(|h| std::fs::read_dir(h.join("projects")).ok()).flatten().flatten() {
        let Ok(files) = std::fs::read_dir(slug.path()) else { continue };
        out.extend(files.flatten().map(|f| f.path()).filter(|p| p.extension().is_some_and(|e| e == "jsonl") && p.is_file()));
    }
    out.sort();
    out
}

/// The Bare launch manifests in `dir` whose `profile` is `profile`, as (mtime ms, payload set ids).
fn manifest_sets(dir: &Path, profile: &str) -> Vec<(u64, Vec<String>)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "json") { continue }
        let Ok(text) = crate::fsx::read_text_capped(&p, MANIFEST_CAP) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(crate::fsx::strip_bom(&text)) else { continue };
        if v["profile"].as_str() != Some(profile) { continue }
        let sets: Vec<String> = v["payload"]["sets"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect();
        if sets.is_empty() { continue }
        out.push((ms(e.metadata().ok().and_then(|m| m.modified().ok())), sets));
    }
    out
}

/// One transcript into `h`: the watermark decides the start, every use found takes the mtime's date.
fn sweep_one(h: &mut History, prev: Option<&Mark>, path: &Path, firsts: &mut Option<u64>) -> std::io::Result<Mark> {
    let meta = std::fs::metadata(path)?;
    let (len, mtime) = (meta.len(), ms(meta.modified().ok()));
    *firsts = Some(firsts.map_or(mtime, |m| m.min(mtime)));
    let (from, was_partial) = match prev {
        Some(m) if m.len == len && m.mtime == mtime => return Ok(m.clone()),
        Some(m) if len >= m.len && head_hash(path, m.len)? == m.head => (m.len, m.partial),
        _ => (0, false),
    };
    let (found, offset) = super::loaded::scan_uncached(path, from)?;
    let date = local_date(mtime);
    for f in &found.files { note(&mut h.paths, path_key(&f.path), &date) }
    for r in &found.reads { note(&mut h.reads, path_key(r), &date) }
    for id in &found.rune_reads { note(&mut h.rune_reads, id.clone(), &date) }
    for s in &found.skills { note(&mut h.skills, s.clone(), &date) }
    let partial = was_partial || found.truncated;
    // a partial scan stopped at the cap (or past READS_MAX): resume from the file's end, not inside the cut
    let end = if found.truncated { offset.max(len) } else { offset };
    Ok(Mark { len: end, mtime, head: head_hash(path, end)?, partial })
}

/// The pure sweep: `prev` (the file as it stood) plus `transcripts` and `bare` (manifest mtime, sets), on `today`.
fn sweep(prev: Option<History>, transcripts: &[PathBuf], bare: &[(u64, Vec<String>)], today: &str) -> History {
    let first = prev.is_none();
    let mut h = prev.unwrap_or_else(|| History {
        version: 1,
        since: String::new(),
        last_sweep: String::new(),
        transcripts: BTreeMap::new(),
        paths: BTreeMap::new(),
        reads: BTreeMap::new(),
        rune_reads: BTreeMap::new(),
        skills: BTreeMap::new(),
        bare_sets: BTreeMap::new(),
    });
    let old = std::mem::take(&mut h.transcripts);
    let mut oldest = None;
    let mut marks = BTreeMap::new();
    for p in transcripts {
        let key = clean(p);
        if let Ok(m) = sweep_one(&mut h, old.get(&key), p, &mut oldest) {
            marks.insert(key, m);
        }
    }
    // marks this sweep did not reach (another profile's transcripts) stay while their file does
    for (k, m) in old {
        if !marks.contains_key(&k) && Path::new(&k).is_file() {
            marks.insert(k, m);
        }
    }
    h.transcripts = marks;
    for (mtime, sets) in bare {
        let date = local_date(*mtime);
        for s in sets { note(&mut h.bare_sets, s.clone(), &date) }
    }
    let gap = match (day_number(&h.last_sweep), day_number(today)) {
        (Some(a), Some(b)) => b - a > RETENTION_DAYS,
        _ => false,
    };
    if first || h.since.is_empty() {
        h.since = oldest.map_or_else(|| today.to_string(), local_date).min(today.to_string());
    } else if gap {
        h.since = today.to_string();
    }
    h.version = 1;
    h.last_sweep = today.to_string();
    h
}

/// Sweeps into `file` and writes it atomically (tmp then rename); an unreadable file starts over.
fn run_at(file: &Path, transcripts: &[PathBuf], bare: &[(u64, Vec<String>)], today: &str) -> Result<History, String> {
    let prev = crate::fsx::read_json::<History>(file).ok().filter(|h| h.version == 1);
    let h = sweep(prev, transcripts, bare, today);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Load history {}: {e}", clean(dir)))?;
    }
    let bytes = serde_json::to_vec_pretty(&h).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(file, &bytes)?;
    Ok(h)
}

fn plain_profile(p: &str) -> bool {
    !p.is_empty() && p.len() <= 128 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Sweeps `profile`'s Claude transcripts (every config dir it has; none = the user's own) and, for a
/// Bare profile, its launch manifests; returns the history as written.
#[tauri::command]
pub async fn runes_load_history(profile: Option<String>) -> Result<History, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = profile.as_deref() {
            if !plain_profile(p) {
                return Err(format!("invalid profile `{p}`"));
            }
        }
        let _one = SWEEP.lock().unwrap_or_else(|e| e.into_inner());
        let transcripts = transcripts_in(&crate::bare::claude_dir::homes_for(profile.as_deref()));
        let bare = match (profile.as_deref(), crate::bare::home::resolve()) {
            (Some(p), Ok(home)) => manifest_sets(&home.join("manifests"), p),
            _ => Vec::new(),
        };
        run_at(&crate::paths::rune_load_history(), &transcripts, &bare, &local_date(crate::fsx::now_ms()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "load_history_tests.rs"]
mod tests;
