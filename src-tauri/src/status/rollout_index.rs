/* ---- Codex rollout index ----
   Codex writes one rollout per session under `<home>\sessions\YYYY\MM\DD\*.jsonl`. Finding the
   newest one for a cwd used to open every rollout and read its first line (a few MB per query on
   a long history). The index keeps each file's (cwd, session id) from that first line, which
   never changes, and relists only day folders whose mtime moved.

   Inferred, not verified against Codex: new rollouts appear only in the current day folder;
   NTFS bumps a folder's mtime when a file is added; a resumed session appends to its original
   rollout. If one is wrong the result is a stale "newest" until the next day-folder change,
   never a path or model served without a stat in the same call (AGENTS.md: no stale
   filesystem answers). Files whose first line does not parse yet go to `retry`. */

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use serde_json::Value;

const RETRY_CAP: usize = 64;
const MODELS_CAP: usize = 64;

#[derive(Default)]
struct HomeIndex {
    /// rollout → (cwd, session id) from its first line
    files: HashMap<PathBuf, (String, Option<String>)>,
    /// day folder → mtime when last listed
    days: HashMap<PathBuf, SystemTime>,
    /// files whose first line did not parse (empty, half-written): re-read every call
    retry: HashSet<PathBuf>,
}

static INDEX: LazyLock<Mutex<HashMap<PathBuf, HomeIndex>>> = LazyLock::new(Default::default);

/// First line of a rollout as (cwd, id); None when the line is missing or not yet valid JSON.
fn first_line_meta(path: &Path) -> Option<(String, Option<String>)> {
    let file = fs::File::open(path).ok()?;
    let line = BufReader::new(file).lines().next()?.ok()?;
    let value: Value = serde_json::from_str(&line).ok()?;
    let cwd = value.pointer("/payload/cwd").and_then(Value::as_str).unwrap_or("").to_owned();
    let id = value.pointer("/payload/id").and_then(Value::as_str).map(str::to_owned);
    Some((cwd, id))
}

impl HomeIndex {
    fn add_file(&mut self, path: PathBuf) {
        if self.files.contains_key(&path) { return; }
        match first_line_meta(&path) {
            Some(meta) => {
                self.retry.remove(&path);
                self.files.insert(path, meta);
            }
            None if self.retry.len() < RETRY_CAP => { self.retry.insert(path); }
            None => {}
        }
    }

    fn list_day(&mut self, day: &Path) {
        let Ok(rd) = fs::read_dir(day) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("jsonl") { self.add_file(p); }
        }
    }

    /// Bring the index up to date: list the sessions and year/month folders, stat every day
    /// folder, relist the new or changed ones plus the newest by name, retry unparsed files.
    fn collect_rollouts(&mut self, sessions: &Path) {
        let mut day_dirs: Vec<(PathBuf, Option<SystemTime>)> = Vec::new();
        let mut stack = vec![(sessions.to_path_buf(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    if depth < 2 {
                        stack.push((p, depth + 1));
                    } else {
                        let m = fs::metadata(&p).and_then(|m| m.modified()).ok();
                        day_dirs.push((p, m));
                    }
                } else if depth < 3 && p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    self.add_file(p); // a rollout outside the day layout still counts
                }
            }
        }
        let newest = day_dirs.iter().map(|(p, _)| p).max().cloned();
        for (day, m) in day_dirs {
            let changed = match (self.days.get(&day), m) {
                (Some(old), Some(new)) => *old != new,
                _ => true,
            };
            if changed || newest.as_ref() == Some(&day) {
                self.list_day(&day);
                match m {
                    Some(m) => { self.days.insert(day, m); }
                    None => { self.days.remove(&day); }
                }
            }
        }
        let pending: Vec<PathBuf> = self.retry.iter().cloned().collect();
        for p in pending {
            if !p.exists() { self.retry.remove(&p); } else { self.add_file(p); }
        }
    }
}

/// The newest rollout for `cwd` under `home` and its session id. Every candidate is stat'ed in
/// this call (a resumed session appends to an older-day rollout, so mtime decides, not folder).
pub(super) fn newest_entry(home: &Path, cwd: &str) -> Option<(PathBuf, Option<String>)> {
    entries_newest_first(home, cwd).into_iter().next().map(|(p, id, _)| (p, id))
}

/// Every rollout for `cwd` under `home` with its session id and mtime, newest first, each stat'ed
/// in this call (same rule as `newest_entry`). A Raw Codex tab's thread is resolved from these
/// (`codex_rollout_threads`, src/panels/sessions/codex-thread.ts).
pub(super) fn entries_newest_first(home: &Path, cwd: &str) -> Vec<(PathBuf, Option<String>, SystemTime)> {
    if cwd.is_empty() {
        return Vec::new();
    }
    let mut all = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let idx = all.entry(home.to_path_buf()).or_default();
    idx.collect_rollouts(&home.join("sessions"));
    let mut out: Vec<(PathBuf, Option<String>, SystemTime)> = Vec::new();
    let mut gone = Vec::new();
    for (p, (c, id)) in &idx.files {
        if c != cwd { continue; }
        match fs::metadata(p).and_then(|m| m.modified()) {
            Ok(m) => out.push((p.clone(), id.clone(), m)),
            Err(_) => gone.push(p.clone()),
        }
    }
    for p in gone { idx.files.remove(&p); }
    out.sort_by(|a, b| b.2.cmp(&a.2));
    out
}

pub(super) fn newest_rollout(home: &Path, cwd: &str) -> Option<PathBuf> {
    newest_entry(home, cwd).map(|(p, _)| p)
}

struct CachedModel {
    len: u64,
    mtime: SystemTime,
    model: Option<String>,
}

static MODELS: LazyLock<Mutex<HashMap<PathBuf, CachedModel>>> = LazyLock::new(Default::default);

/// The newest top-level `turn_context` model in a rollout. Served from memory only when this
/// call's stat shows the same length and mtime as the read that produced it; any other stat
/// rereads the whole file. The stat precedes the read, so a write in between leaves a stale
/// stamp that the next call rereads.
pub(super) fn cached_model(path: &Path) -> Option<String> {
    let md = fs::metadata(path).ok()?;
    let (len, mtime) = (md.len(), md.modified().ok()?);
    {
        let cache = MODELS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = cache.get(path) {
            if c.len == len && c.mtime == mtime { return c.model.clone(); }
        }
    }
    let model = rollout_model(path);
    let mut cache = MODELS.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= MODELS_CAP && !cache.contains_key(path) { cache.clear(); }
    cache.insert(path.to_path_buf(), CachedModel { len, mtime, model: model.clone() });
    model
}

fn rollout_model(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut model = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        // Cheap filter first: prompts and tool output dwarf the turn records.
        if !line.contains("\"turn_context\"") { continue; }
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        // Top-level record only: a rollout nests copies under collaboration_mode settings.
        if value.get("type").and_then(Value::as_str) == Some("turn_context") {
            if let Some(m) = value.pointer("/payload/model").and_then(Value::as_str) {
                model = Some(m.to_owned());
            }
        }
    }
    model
}

/// One rate-limit window as the status flyout reads it (`rate_limits.five_hour|seven_day`).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct LimitWindow {
    pub used_percentage: f64,
    /// epoch seconds
    pub resets_at: u64,
}

/// What one pass over a rollout yields: the newest top-level `turn_context` model and the
/// 5H/7D windows of the last top-level `token_count` that carried `rate_limits`.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct RolloutLimits {
    pub model: Option<String>,
    pub five_hour: Option<LimitWindow>,
    pub seven_day: Option<LimitWindow>,
    /// the token_count record's own timestamp (epoch ms); the file's mtime when it has none
    pub observed_ms: u64,
}

struct CachedLimits {
    len: u64,
    mtime: SystemTime,
    limits: RolloutLimits,
}

static LIMITS: LazyLock<Mutex<HashMap<PathBuf, CachedLimits>>> = LazyLock::new(Default::default);

fn epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// `YYYY-MM-DDTHH:MM:SS[.f]Z` (UTC) as epoch milliseconds; anything else is None.
pub(super) fn rfc3339_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || *b.last()? != b'Z' { return None; }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) { return None; }
        part.parse().ok()
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' { return None; }
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 { return None; }
    let mut millis = 0i64;
    match &s[19..s.len() - 1] {
        "" => {}
        frac if frac.starts_with('.') && frac.len() > 1 => {
            let digits = &frac[1..];
            if !digits.bytes().all(|c| c.is_ascii_digit()) { return None; }
            let padded: String = digits.chars().chain("000".chars()).take(3).collect();
            millis = padded.parse().ok()?;
        }
        _ => return None,
    }
    // days from civil (Howard Hinnant), proleptic Gregorian
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec;
    u64::try_from(secs * 1000 + millis).ok()
}

/// A `rate_limits` window object → (kind, used %, resets_at secs). `kind` is 0 for five_hour,
/// 1 for seven_day; `window_minutes` decides (300 / 10080), else `position` (primary 0, secondary 1).
fn read_window(v: &Value, position: u8, observed_ms: u64) -> Option<(u8, LimitWindow)> {
    let used = v.get("used_percent").and_then(Value::as_f64)?;
    let kind = match v.get("window_minutes").and_then(Value::as_u64) {
        Some(300) => 0,
        Some(10080) => 1,
        Some(_) => return None,
        None => position,
    };
    let resets_at = match v.get("resets_at").and_then(Value::as_f64) {
        Some(r) if r >= 0.0 => r as u64,
        _ => {
            let secs = v.get("resets_in_seconds").and_then(Value::as_f64).filter(|s| *s >= 0.0)?;
            observed_ms / 1000 + secs as u64
        }
    };
    Some((kind, LimitWindow { used_percentage: used, resets_at }))
}

/// One pass over a rollout's lines. Top-level records only: a rollout nests copies of both
/// shapes inside other payloads.
fn scan_limits<I: Iterator<Item = String>>(lines: I, mtime_ms: u64) -> RolloutLimits {
    let mut out = RolloutLimits { observed_ms: mtime_ms, ..Default::default() };
    for line in lines {
        let turn = line.contains("\"turn_context\"");
        let token = line.contains("\"token_count\"");
        if !turn && !token { continue; }
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        match value.get("type").and_then(Value::as_str) {
            Some("turn_context") => {
                if let Some(m) = value.pointer("/payload/model").and_then(Value::as_str) {
                    out.model = Some(m.to_owned());
                }
            }
            Some("event_msg") if value.pointer("/payload/type").and_then(Value::as_str) == Some("token_count") => {
                let Some(rl) = value.pointer("/payload/rate_limits").filter(|r| r.is_object()) else { continue };
                let observed = value.get("timestamp").and_then(Value::as_str)
                    .and_then(rfc3339_ms).unwrap_or(mtime_ms);
                out.five_hour = None;
                out.seven_day = None;
                out.observed_ms = observed;
                for (name, position) in [("primary", 0u8), ("secondary", 1u8)] {
                    let Some((kind, w)) = rl.get(name).and_then(|v| read_window(v, position, observed)) else { continue };
                    if kind == 0 { out.five_hour = Some(w); } else { out.seven_day = Some(w); }
                }
            }
            _ => {}
        }
    }
    out
}

/// Windows whose reset is at or before `now_secs` no longer describe the account.
pub(super) fn drop_expired(l: &mut RolloutLimits, now_secs: u64) {
    if l.five_hour.as_ref().is_some_and(|w| w.resets_at <= now_secs) { l.five_hour = None; }
    if l.seven_day.as_ref().is_some_and(|w| w.resets_at <= now_secs) { l.seven_day = None; }
}

/// The model and 5H/7D windows of a rollout in one read, served from memory only while this
/// call's stat equals the stat of the read that produced them (same rule as `cached_model`).
/// Expiry is applied per call, after the cache.
pub(super) fn cached_limits(path: &Path) -> Option<RolloutLimits> {
    let md = fs::metadata(path).ok()?;
    let (len, mtime) = (md.len(), md.modified().ok()?);
    let hit = {
        let cache = LIMITS.lock().unwrap_or_else(|e| e.into_inner());
        cache.get(path).filter(|c| c.len == len && c.mtime == mtime).map(|c| c.limits.clone())
    };
    let mut limits = match hit {
        Some(l) => l,
        None => {
            let file = fs::File::open(path).ok()?;
            let l = scan_limits(BufReader::new(file).lines().map_while(Result::ok), epoch_ms(mtime));
            let mut cache = LIMITS.lock().unwrap_or_else(|e| e.into_inner());
            if cache.len() >= MODELS_CAP && !cache.contains_key(path) { cache.clear(); }
            cache.insert(path.to_path_buf(), CachedLimits { len, mtime, limits: l.clone() });
            l
        }
    };
    drop_expired(&mut limits, epoch_ms(SystemTime::now()) / 1000);
    Some(limits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use std::time::Duration;

    fn temp_home(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("vidar-rollouts-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        home
    }

    fn meta(cwd: &str, id: &str) -> String {
        format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":{cwd:?}}}}}\n")
    }

    fn rollout(home: &Path, day: &str, name: &str, cwd: &str, id: &str, age_secs: u64) -> PathBuf {
        let dir = home.join("sessions").join(day);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, meta(cwd, id)).unwrap();
        touch(&p, age_secs);
        p
    }

    fn touch(p: &Path, age_secs: u64) {
        let f = File::options().write(true).open(p).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(age_secs)).unwrap();
    }

    #[test]
    fn a_rollout_added_to_the_newest_day_folder_becomes_newest() {
        let home = temp_home("add");
        let old = rollout(&home, "2026/10/16", "a.jsonl", "C:\\p", "id-old", 500);
        assert_eq!(newest_entry(&home, "C:\\p").unwrap().0, old);
        let new = rollout(&home, "2026/10/17", "b.jsonl", "C:\\p", "id-new", 5);
        let (p, id) = newest_entry(&home, "C:\\p").unwrap();
        assert_eq!((p, id.as_deref()), (new.clone(), Some("id-new")));
        // a file in an already-indexed newest folder is picked up with no mtime change to rely on
        let newer = rollout(&home, "2026/10/17", "c.jsonl", "C:\\p", "id-newer", 1);
        assert_eq!(newest_entry(&home, "C:\\p").unwrap().0, newer);
        // another cwd never matches
        assert!(newest_entry(&home, "C:\\other").is_none());
        // an empty cwd matches nothing
        assert!(newest_entry(&home, "").is_none());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn entries_list_every_rollout_for_the_cwd_newest_first() {
        let home = temp_home("list");
        rollout(&home, "2026/10/15", "a.jsonl", "C:\\p", "id-a", 900);
        rollout(&home, "2026/10/16", "b.jsonl", "C:\\p", "id-b", 5);
        rollout(&home, "2026/10/16", "c.jsonl", "C:\\p", "id-c", 400);
        rollout(&home, "2026/10/16", "d.jsonl", "C:\\other", "id-d", 1);
        let ids: Vec<_> = entries_newest_first(&home, "C:\\p").into_iter().map(|(_, id, _)| id.unwrap()).collect();
        assert_eq!(ids, ["id-b", "id-c", "id-a"]);
        assert_eq!(newest_entry(&home, "C:\\p").unwrap().1.as_deref(), Some("id-b"));
        assert!(entries_newest_first(&home, "").is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn an_older_folder_rollout_that_grows_beats_a_newer_one() {
        let home = temp_home("grow");
        let older = rollout(&home, "2026/10/15", "a.jsonl", "C:\\p", "id-a", 900);
        let newer = rollout(&home, "2026/10/16", "b.jsonl", "C:\\p", "id-b", 400);
        assert_eq!(newest_entry(&home, "C:\\p").unwrap().0, newer);
        let mut f = File::options().append(true).open(&older).unwrap();
        f.write_all(b"{\"type\":\"event_msg\"}\n").unwrap();
        drop(f);
        touch(&older, 1);
        let (p, id) = newest_entry(&home, "C:\\p").unwrap();
        assert_eq!((p, id.as_deref()), (older, Some("id-a")));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_half_written_first_line_is_retried_until_it_parses() {
        let home = temp_home("retry");
        let dir = home.join("sessions").join("2026/10/17");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.jsonl");
        fs::write(&p, "{\"type\":\"session_meta\",\"pay").unwrap();
        // a later day folder, so the half-written file's folder is neither newest nor re-stat'ed as changed
        rollout(&home, "2026/10/18", "z.jsonl", "C:\\other", "id-z", 1);
        assert!(newest_entry(&home, "C:\\p").is_none());
        fs::write(&p, meta("C:\\p", "id-late")).unwrap();
        // the folder mtime is not relied on: the retry set re-reads the file
        let (got, id) = newest_entry(&home, "C:\\p").unwrap();
        assert_eq!((got, id.as_deref()), (p, Some("id-late")));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_model_follows_the_file_and_rereads_on_any_stat_change() {
        let home = temp_home("model");
        let p = rollout(&home, "2026/10/17", "a.jsonl", "C:\\p", "id", 100);
        assert_eq!(cached_model(&p), None);
        let turn = |m: &str| format!("{{\"type\":\"turn_context\",\"payload\":{{\"model\":\"{m}\"}}}}\n");
        let mut f = File::options().append(true).open(&p).unwrap();
        f.write_all(turn("gpt-a").as_bytes()).unwrap();
        drop(f);
        touch(&p, 50);
        assert_eq!(cached_model(&p).as_deref(), Some("gpt-a"));
        // same length, different bytes, newer mtime: a reread, not the cached answer
        let mut body = meta("C:\\p", "id");
        body.push_str(&turn("gpt-b"));
        assert_eq!(body.len() as u64, fs::metadata(&p).unwrap().len());
        fs::write(&p, body).unwrap();
        touch(&p, 20);
        assert_eq!(cached_model(&p).as_deref(), Some("gpt-b"));
        // truncated to the meta line: the model vanishes with its bytes
        fs::write(&p, meta("C:\\p", "id")).unwrap();
        touch(&p, 5);
        assert_eq!(cached_model(&p), None);
        let _ = fs::remove_dir_all(&home);
    }

    fn scan(lines: &[&str]) -> RolloutLimits {
        scan_limits(lines.iter().map(|s| s.to_string()), 42_000)
    }

    fn tc(ts: &str, rl: &str) -> String {
        format!("{{\"timestamp\":\"{ts}\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"rate_limits\":{rl}}}}}")
    }

    #[test]
    fn rfc3339_ms_parses_utc_and_rejects_the_rest() {
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(rfc3339_ms("2026-10-19T12:34:56.789123Z"), Some(1_792_413_296_789));
        assert_eq!(rfc3339_ms("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(rfc3339_ms("2026-10-19T12:34:56+02:00"), None);
        assert_eq!(rfc3339_ms("2026-10-19 12:34:56Z"), None);
        assert_eq!(rfc3339_ms("2026-13-19T12:34:56Z"), None);
        assert_eq!(rfc3339_ms("2026-10-19T12:34:56.Z"), None);
        assert_eq!(rfc3339_ms(""), None);
    }

    #[test]
    fn windows_map_by_minutes_then_by_position() {
        let ts = "2026-10-19T12:00:00Z";
        let by_minutes = tc(ts, r#"{"primary":{"used_percent":70.0,"window_minutes":10080,"resets_at":4000000000},"secondary":{"used_percent":20.0,"window_minutes":300,"resets_at":4000000100}}"#);
        let l = scan(&[&by_minutes]);
        assert_eq!(l.seven_day, Some(LimitWindow { used_percentage: 70.0, resets_at: 4_000_000_000 }));
        assert_eq!(l.five_hour, Some(LimitWindow { used_percentage: 20.0, resets_at: 4_000_000_100 }));
        assert_eq!(l.observed_ms, rfc3339_ms(ts).unwrap());
        let positional = tc(ts, r#"{"primary":{"used_percent":5,"resets_at":4000000000},"secondary":{"used_percent":9,"resets_at":4000000001}}"#);
        let l = scan(&[&positional]);
        assert_eq!(l.five_hour.map(|w| w.used_percentage), Some(5.0));
        assert_eq!(l.seven_day.map(|w| w.used_percentage), Some(9.0));
        // an unknown window length maps to neither
        let odd = tc(ts, r#"{"primary":{"used_percent":5,"window_minutes":60,"resets_at":4000000000}}"#);
        let l = scan(&[&odd]);
        assert!(l.five_hour.is_none() && l.seven_day.is_none());
    }

    #[test]
    fn legacy_resets_in_seconds_counts_from_the_observed_time() {
        let ts = "1970-01-01T00:01:40Z"; // 100 s
        let l = scan(&[&tc(ts, r#"{"primary":{"used_percent":1,"window_minutes":300,"resets_in_seconds":50}}"#)]);
        assert_eq!(l.five_hour.map(|w| w.resets_at), Some(150));
    }

    #[test]
    fn a_nested_rate_limits_copy_is_ignored_and_the_last_top_level_record_wins() {
        let nested = r#"{"timestamp":"2026-10-19T12:00:00Z","type":"response_item","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":99,"window_minutes":300,"resets_at":4000000000}}}}"#;
        let nested_event = r#"{"timestamp":"2026-10-19T12:00:00Z","type":"event_msg","payload":{"type":"other","wrapped":{"type":"token_count","rate_limits":{"primary":{"used_percent":98,"window_minutes":300,"resets_at":4000000000}}}}}"#;
        assert!(scan(&[nested, nested_event]).five_hour.is_none());
        let first = tc("2026-10-19T12:00:00Z", r#"{"primary":{"used_percent":10,"window_minutes":300,"resets_at":4000000000}}"#);
        let second = tc("2026-10-19T12:05:00Z", r#"{"primary":{"used_percent":11,"window_minutes":300,"resets_at":4000000000}}"#);
        let l = scan(&[&first, nested, &second]);
        assert_eq!(l.five_hour.map(|w| w.used_percentage), Some(11.0));
        assert_eq!(l.observed_ms, rfc3339_ms("2026-10-19T12:05:00Z").unwrap());
    }

    #[test]
    fn an_unparsable_timestamp_falls_back_to_the_mtime_and_the_model_rides_along() {
        let rec = tc("not a time", r#"{"primary":{"used_percent":3,"window_minutes":300,"resets_at":4000000000}}"#);
        let turn = r#"{"type":"turn_context","payload":{"model":"gpt-x"}}"#;
        let l = scan(&[turn, &rec]);
        assert_eq!((l.observed_ms, l.model.as_deref()), (42_000, Some("gpt-x")));
    }

    #[test]
    fn an_expired_window_is_dropped() {
        let rec = tc("2026-10-19T12:00:00Z", r#"{"primary":{"used_percent":3,"window_minutes":300,"resets_at":1000},"secondary":{"used_percent":4,"window_minutes":10080,"resets_at":5000}}"#);
        let mut l = scan(&[&rec]);
        drop_expired(&mut l, 1000);
        assert!(l.five_hour.is_none());
        assert_eq!(l.seven_day.map(|w| w.resets_at), Some(5000));
    }

    #[test]
    fn cached_limits_reads_the_file_and_rereads_on_a_stat_change() {
        let home = temp_home("limits");
        let p = rollout(&home, "2026/10/17", "a.jsonl", "C:\\p", "id", 100);
        let rec = |pct: u32| tc("2026-10-19T12:00:00Z", &format!("{{\"primary\":{{\"used_percent\":{pct},\"window_minutes\":300,\"resets_at\":4000000000}}}}"));
        let mut f = File::options().append(true).open(&p).unwrap();
        f.write_all(format!("{}\n", rec(10)).as_bytes()).unwrap();
        drop(f);
        touch(&p, 50);
        assert_eq!(cached_limits(&p).unwrap().five_hour.map(|w| w.used_percentage), Some(10.0));
        let mut f = File::options().append(true).open(&p).unwrap();
        f.write_all(format!("{}\n", rec(20)).as_bytes()).unwrap();
        drop(f);
        touch(&p, 20);
        assert_eq!(cached_limits(&p).unwrap().five_hour.map(|w| w.used_percentage), Some(20.0));
        let _ = fs::remove_dir_all(&home);
    }
}
