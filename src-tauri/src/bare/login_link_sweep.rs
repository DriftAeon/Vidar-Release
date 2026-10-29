//! Periodic login reconciliation and byproduct expiry.
use super::*;
use std::time::{Duration, SystemTime};
#[cfg(not(test))] use std::sync::OnceLock;

#[cfg(not(test))]
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const SWEEP_LOCK_WAIT: Duration = Duration::from_millis(200);
const SHELF_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Start once at setup, including when all agent tabs were restored without a new spawn.
#[cfg(not(test))]
pub(crate) fn start_login_sweep() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| { std::thread::spawn(|| loop {
        std::thread::sleep(SWEEP_INTERVAL);
        if let Ok(home) = home::resolve() { sweep(&home); }
    }); });
}
/// Sweep every home beside this install's home twice: the first pass adopts renewed files,
/// and the second brings homes visited earlier onto the resulting store file.
fn sweep(home: &Path) {
    let Some(shared) = super::super::home_path::shared_for(home) else { return };
    let Some(homes) = home.parent() else { return };
    let Some(top) = homes.parent() else { return };
    for _ in 0..2 {
        let Ok(rd) = std::fs::read_dir(homes) else { return };
        let mut dirs: Vec<_> = rd.flatten().filter(|d| d.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()))
            .map(|d| d.path()).filter(|p| p != &shared).collect();
        dirs.sort();
        for dir in dirs {
            if !has_record(top, &dir) { continue }
            // A busy or vanished home gets another chance on the next tick.
            let Ok(lock) = home::lock(&dir, SWEEP_LOCK_WAIT) else { continue };
            let entries = recorded_entries(top, &dir);
            if entries.is_empty() { continue }
            let _ = sync_inner(&dir, &shared, &entries, &lock, true);
            let mut expired = Vec::new();
            for e in &entries { expired.extend(age_out_beside(top, &super::super::under(&dir, &e.file))); }
            if let Ok(_store_lock) = home::lock(&shared, SWEEP_LOCK_WAIT) {
                for e in &entries {
                    expired.extend(age_out_beside(top, &shared.join(&e.agent).join(Path::new(&e.file).file_name().unwrap_or_default())));
                }
            }
            let _ = append_log(&dir.join("logs").join(LOG), &expired);
        }
    }
}

fn has_record(top: &Path, home: &Path) -> bool {
    let logs = home.join("logs");
    if refuse_reparse_down(top, &logs).is_err() { return false }
    std::fs::read_dir(logs).is_ok_and(|items| items.flatten().any(|item| {
        let name = item.file_name().to_string_lossy().to_ascii_lowercase();
        (name == STATE || name.starts_with("login-link-") && name.ends_with(".json"))
            && item.file_type().is_ok_and(|kind| kind.is_file() && !kind.is_symlink())
    }))
}

/// Only record keys choose login names; no login contents are inspected here.
fn recorded_entries(top: &Path, home: &Path) -> Vec<SharedLogin> {
    let logs = home.join("logs");
    if refuse_reparse_down(top, &logs).is_err() { return Vec::new() }
    let Ok(rd) = std::fs::read_dir(logs) else { return Vec::new() };
    let mut out = Vec::new();
    for item in rd.flatten() {
        if !item.file_type().is_ok_and(|t| t.is_file() && !t.is_symlink()) { continue }
        let name = item.file_name().to_string_lossy().to_ascii_lowercase();
        let agent = if name == STATE { CLAUDE_AGENT }
            else if let Some(agent) = name.strip_prefix("login-link-").and_then(|s| s.strip_suffix(".json")) { agent }
            else { continue };
        if agent.is_empty() || !agent.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { continue }
        let Ok(record) = crate::fsx::read_json::<BTreeMap<String, FileId>>(&item.path()) else { continue };
        for key in record.keys() {
            if key.ends_with("#keep-home") || key.ends_with("#keep-store") { continue }
            let Some((key_agent, file)) = key.split_once('/') else { continue };
            if !key_agent.eq_ignore_ascii_case(agent) { continue }
            let entry = SharedLogin { agent: agent.to_string(), file: file.to_string() };
            let parent = Path::new(file).parent().unwrap_or(Path::new(""));
            let dirs = [parent.to_string_lossy().into_owned()];
            if validate(std::slice::from_ref(&entry), &dirs).is_ok() && !out.contains(&entry) { out.push(entry); }
        }
    }
    out
}

/// Expire only this module's named byproducts beside a recorded login path.
fn age_out_beside(top: &Path, login: &Path) -> Vec<String> {
    let mut lines = Vec::new();
    if refuse_reparse_down(top, login).is_err() { return lines }
    let Some(parent) = login.parent() else { return lines };
    let Some(base) = login.file_name().map(|n| n.to_string_lossy().into_owned()) else { return lines };
    let Ok(rd) = std::fs::read_dir(parent) else { return lines };
    let now = SystemTime::now();
    for item in rd.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        let suffix = name.strip_prefix(&base).unwrap_or("");
        if !matches!(suffix, ".split" | ".vidar-old" | ".vidar-adopt") { continue }
        let path = item.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { continue }
        if meta.modified().ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > SHELF_AGE)
            && std::fs::remove_file(&path).is_ok() { lines.push(format!("expired {}", path.display())); }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Kind { agent: &'static str, dir: &'static str, file: &'static str }
    const CLAUDE: Kind = Kind { agent: "claude", dir: "claude-homes/0123456789ab", file: ".credentials.json" };
    const CODEX: Kind = Kind { agent: "codex", dir: "codex-home", file: "auth.json" };

    impl Kind {
        fn cred(&self, h: &Path) -> PathBuf { h.join(self.dir).join(self.file) }
        fn run(&self, h: &Path, lock: &HomeLock) -> Result<Vec<String>, String> {
            let dirs = vec![self.dir.to_string()];
            if self.agent == CLAUDE_AGENT { sync_claude(h, &h.join(self.dir), &dirs, lock) }
            else { sync_codex(h, &h.join(self.dir), &dirs, lock) }
        }
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("vidar-login-sweep-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn homes(&self) -> PathBuf { self.0.join("lad/Vidar/homes") }
        fn store(&self, k: &Kind) -> PathBuf { self.homes().join("_shared").join(k.agent).join(k.file) }
        fn home(&self, key: &str, k: &Kind) -> (PathBuf, HomeLock) {
            let h = self.homes().join(key);
            home::prepare_dirs(&h, &[k.dir.to_string(), "logs".into()]).unwrap();
            let lock = home::lock(&h, home::LOCK_WAIT).unwrap();
            (h, lock)
        }
    }
    impl Drop for TempDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn id(p: &Path) -> FileId { seen(p).unwrap().unwrap().0 }
    fn stamp(p: &Path, age: Duration) {
        let f = std::fs::OpenOptions::new().write(true).open(p).unwrap();
        f.set_modified(SystemTime::now() - age).unwrap();
    }
    fn rewrite_by_rename(p: &Path, text: &str, age: Duration) {
        let tmp = p.with_extension("tmp");
        std::fs::write(&tmp, text).unwrap();
        std::fs::rename(&tmp, p).unwrap();
        stamp(p, age);
    }

    fn refreshed_home_reaches_sibling(k: &Kind) {
        let t = TempDir::new();
        let (a, la) = t.home("aaaaaaaaaaaaaaaa", k);
        std::fs::write(k.cred(&a), "OLD").unwrap();
        k.run(&a, &la).unwrap();
        let (b, lb) = t.home("bbbbbbbbbbbbbbbb", k);
        k.run(&b, &lb).unwrap();
        drop((la, lb));
        rewrite_by_rename(&k.cred(&a), "NEW", Duration::ZERO);
        let renewed = id(&k.cred(&a));
        assert_ne!(renewed, id(&t.store(k)));
        sweep(&a);
        assert_eq!(id(&t.store(k)), renewed);
        assert_eq!(id(&k.cred(&b)), renewed);
        assert_eq!(seen(&t.store(k)).unwrap().unwrap().1, 3);
    }

    #[test]
    fn claude_refresh_reaches_every_home_on_sweep() { refreshed_home_reaches_sibling(&CLAUDE); }
    #[test]
    fn codex_refresh_reaches_every_home_on_sweep() { refreshed_home_reaches_sibling(&CODEX); }

    #[test]
    fn later_home_refresh_reaches_earlier_home_on_second_pass() {
        let t = TempDir::new();
        let (a, la) = t.home("aaaaaaaaaaaaaaaa", &CODEX);
        std::fs::write(CODEX.cred(&a), "OLD").unwrap();
        CODEX.run(&a, &la).unwrap();
        let (b, lb) = t.home("bbbbbbbbbbbbbbbb", &CODEX);
        CODEX.run(&b, &lb).unwrap();
        drop((la, lb));
        rewrite_by_rename(&CODEX.cred(&b), "NEW", Duration::ZERO);
        let renewed = id(&CODEX.cred(&b));
        sweep(&a);
        assert_eq!(id(&t.store(&CODEX)), renewed);
        assert_eq!(id(&CODEX.cred(&a)), renewed);
        assert_eq!(seen(&t.store(&CODEX)).unwrap().unwrap().1, 3);
    }

    #[test]
    fn fresh_split_of_old_login_survives_age_out() {
        let t = TempDir::new();
        let (a, la) = t.home("aaaaaaaaaaaaaaaa", &CODEX);
        std::fs::write(CODEX.cred(&a), "OLD").unwrap();
        CODEX.run(&a, &la).unwrap();
        drop(la);
        stamp(&CODEX.cred(&a), Duration::from_secs(10 * 24 * 60 * 60));
        rewrite_by_rename(&t.store(&CODEX), "NEW", Duration::ZERO);
        sweep(&a);
        assert!(beside(&CODEX.cred(&a), ".split").exists());
    }

    #[test]
    fn adopted_refresh_preserves_old_store_split_for_seven_days() {
        let t = TempDir::new();
        let (a, la) = t.home("aaaaaaaaaaaaaaaa", &CODEX);
        std::fs::write(CODEX.cred(&a), "OLD").unwrap();
        CODEX.run(&a, &la).unwrap();
        drop(la);
        stamp(&t.store(&CODEX), Duration::from_secs(10 * 24 * 60 * 60));
        rewrite_by_rename(&CODEX.cred(&a), "NEW", Duration::ZERO);
        sweep(&a);
        assert!(beside(&t.store(&CODEX), ".split").exists());
    }

    #[test]
    fn empty_profile_removes_its_record_before_sweep() {
        let t = TempDir::new();
        let (a, la) = t.home("aaaaaaaaaaaaaaaa", &CLAUDE);
        std::fs::write(CLAUDE.cred(&a), "FAKE").unwrap();
        CLAUDE.run(&a, &la).unwrap();
        let record = a.join("logs").join(STATE);
        assert!(record.exists());
        sync_profile(&a, &[], &[], &la).unwrap();
        drop(la);
        assert!(!record.exists());
        assert!(!has_record(t.homes().parent().unwrap(), &a));
        sweep(&a);
        assert!(!record.exists());
    }

    #[test]
    fn stable_keep_both_pair_keeps_its_record_unchanged() {
        let t = TempDir::new();
        let (a, la) = t.home("aaaaaaaaaaaaaaaa", &CLAUDE);
        std::fs::write(CLAUDE.cred(&a), "initial").unwrap();
        CLAUDE.run(&a, &la).unwrap();
        rewrite_by_rename(&CLAUDE.cred(&a), "unreadable home", Duration::ZERO);
        rewrite_by_rename(&t.store(&CLAUDE), "unreadable store", Duration::ZERO);
        assert_eq!(CLAUDE.run(&a, &la).unwrap().len(), 1);
        let record = a.join("logs").join(STATE);
        let before = std::fs::read(&record).unwrap();
        assert!(String::from_utf8_lossy(&before).contains("#keep-home"));
        assert_eq!(CLAUDE.run(&a, &la).unwrap().len(), 1);
        assert_eq!(std::fs::read(&record).unwrap(), before);
    }

    #[test]
    fn sweep_expires_only_old_split() {
        let t = TempDir::new();
        let (a, la) = t.home("aaaaaaaaaaaaaaaa", &CODEX);
        std::fs::write(CODEX.cred(&a), "FAKE").unwrap();
        CODEX.run(&a, &la).unwrap();
        drop(la);
        let old = beside(&CODEX.cred(&a), ".split");
        let recent = beside(&t.store(&CODEX), ".split");
        std::fs::write(&old, "OLD").unwrap();
        std::fs::write(&recent, "RECENT").unwrap();
        stamp(&old, Duration::from_secs(8 * 24 * 60 * 60));
        stamp(&recent, Duration::from_secs(24 * 60 * 60));
        sweep(&a);
        assert!(!old.exists());
        assert!(recent.exists());
    }
}
