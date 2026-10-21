// Changes bench tab backend: working-tree status, stage / unstage / revert,
// commit, pull / push and branch rename, all through `gitrun`.
//
// Trust boundary (every command): cwd must be an existing directory; git runs
// from `rev-parse --show-toplevel`, never the raw cwd; every path an action
// names must appear verbatim in a status list built fresh in the same call
// (else the whole call is refused before git runs) and always follows `--`;
// one process-wide mutex serialises the mutating commands (status takes none).
// The 5 s status poll alone keeps a per-folder cache (root for 60 s, line counts
// while the tracked records and file stamps hold); actions resolve fresh.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::gitrun::{GitOpts, GitOut};

/// Every git subprocess of this file goes through here, so the tests can count them.
mod gitrun {
    use std::path::Path;
    pub(super) use crate::gitrun::{GitOpts, GitOut};

    #[cfg(test)]
    thread_local! { pub(super) static RUNS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) }; }

    pub(super) fn git(cwd: &Path, args: &[&str], opts: &GitOpts) -> Result<GitOut, String> {
        #[cfg(test)]
        RUNS.with(|c| c.set(c.get() + 1));
        crate::gitrun::git(cwd, args, opts)
    }

    pub(super) fn run(cwd: &Path, args: &[&str], opts: &GitOpts) -> Result<(Option<i32>, GitOut), String> {
        #[cfg(test)]
        RUNS.with(|c| c.set(c.get() + 1));
        crate::gitrun::run(cwd, args, opts)
    }
}

const READ_TIMEOUT: Duration = Duration::from_secs(15);
const SLOW_TIMEOUT: Duration = Duration::from_secs(120); // commit (pre-commit hook), pull, push
const STATUS_CAP: usize = 16 * 1024 * 1024;
const SMALL_CAP: usize = 1024 * 1024;

static MUTATE: Mutex<()> = Mutex::new(());

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    orig_path: Option<String>,
    x: String,
    y: String,
    untracked: bool,
    // null = binary; a side with no change is 0
    staged_adds: Option<u64>,
    staged_dels: Option<u64>,
    work_adds: Option<u64>,
    work_dels: Option<u64>,
    /// a `u` record (merge conflict); revert refuses it
    #[serde(skip)]
    unmerged: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    repo: bool,
    root: String,
    branch: Option<String>,
    detached: bool,
    head: Option<String>,
    upstream: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
    files: Vec<ChangedFile>,
}

#[derive(Serialize, Debug)]
#[serde(untagged)]
pub enum ChangesStatus {
    NoRepo { repo: bool },
    Repo(RepoStatus),
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ActVerb { Stage, Unstage, Revert }

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SyncMode { Sync, Pull, Push }

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pulled: bool,
    pushed: bool,
    /// git's own stdout + stderr of each step, trimmed
    output: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    sha: String,
    /// commit's stderr (hook output), trimmed
    stderr: String,
    sync: Option<SyncResult>,
    /// the commit landed but the requested sync failed
    sync_error: Option<String>,
    /// the commit landed but git then failed (a post-commit hook, `gc --auto`)
    warning: Option<String>,
}

// ---------- parsing ----------

#[derive(Debug, Default)]
struct Parsed {
    /// `branch.oid (initial)`: no commit yet, so there is no HEAD to restore from
    initial: bool,
    /// first 7 characters of `branch.oid`; None before the first commit
    oid: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
    files: Vec<ChangedFile>,
}

fn file(path: &str, orig: Option<&str>, xy: &str, untracked: bool) -> ChangedFile {
    let mut c = xy.chars();
    ChangedFile {
        path: path.to_string(),
        orig_path: orig.map(str::to_string),
        x: c.next().map(String::from).unwrap_or_default(),
        y: c.next().map(String::from).unwrap_or_default(),
        untracked,
        staged_adds: Some(0),
        staged_dels: Some(0),
        work_adds: Some(0),
        work_dels: Some(0),
        unmerged: false,
    }
}

/// `status --porcelain=v2 --branch -z` → branch headers and one entry per path.
fn parse_status(z: &str) -> Parsed {
    let mut p = Parsed::default();
    let mut it = z.split('\0');
    while let Some(rec) = it.next() {
        if rec.is_empty() { continue; }
        if let Some(h) = rec.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" => {
                    p.initial = v == "(initial)";
                    p.oid = if v == "(initial)" { None } else { Some(v.chars().take(7).collect()) };
                }
                "branch.head" => p.head = Some(v.to_string()),
                "branch.upstream" => p.upstream = Some(v.to_string()),
                "branch.ab" => {
                    for part in v.split(' ') {
                        if let Some(n) = part.strip_prefix('+') { p.ahead = n.parse().ok(); }
                        if let Some(n) = part.strip_prefix('-') { p.behind = n.parse().ok(); }
                    }
                }
                _ => {}
            }
            continue;
        }
        match rec.as_bytes()[0] {
            b'1' => {
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if f.len() == 9 { p.files.push(file(f[8], None, f[1], false)); }
            }
            b'2' => {
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                let orig = it.next();
                if f.len() == 10 { p.files.push(file(f[9], orig, f[1], false)); }
            }
            b'u' => {
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if f.len() == 11 {
                    let mut e = file(f[10], None, f[1], false);
                    e.unmerged = true;
                    p.files.push(e);
                }
            }
            b'?' if rec.len() > 2 => p.files.push(file(&rec[2..], None, "??", true)),
            _ => {} // `!` ignored entries are never requested
        }
    }
    p
}

type Counts = (Option<u64>, Option<u64>);

/// `diff --numstat -z` → path (rename destination) → (adds, dels); `-` is binary (None).
fn parse_numstat(z: &str) -> HashMap<String, Counts> {
    let mut out = HashMap::new();
    let mut it = z.split('\0');
    while let Some(rec) = it.next() {
        if rec.is_empty() { continue; }
        let mut f = rec.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (f.next(), f.next(), f.next()) else { continue };
        let path = if path.is_empty() {
            // rename / copy: "A\tD\t\0old\0new\0"
            let _old = it.next();
            match it.next() { Some(new) => new, None => continue }
        } else {
            path
        };
        out.insert(path.to_string(), (a.parse().ok(), d.parse().ok()));
    }
    out
}

// ---------- shared steps ----------

fn read_opts() -> GitOpts<'static> { GitOpts::read(READ_TIMEOUT, SMALL_CAP) }

/// Literal pathspecs stay off for verbs that run hooks: git exports the
/// setting to them, and a hook's own globs must keep working.
fn hook_opts(timeout: Duration) -> GitOpts<'static> {
    GitOpts { timeout, cap: SMALL_CAP, stdin: None, literal_pathspecs: false, ceiling: None, global_config: None }
}

/// None when cwd is a directory outside any work tree.
fn repo_root(cwd: &str) -> Result<Option<PathBuf>, String> {
    let cwd_path = PathBuf::from(cwd);
    if !cwd_path.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    // a non-zero exit from an existing directory means no work tree here
    let (code, o) = gitrun::run(&cwd_path, &["rev-parse", "--show-toplevel"], &read_opts())?;
    if code != Some(0) { return Ok(None); }
    let root = o.text.trim().replace('/', "\\");
    if root.is_empty() { return Err("not a git work tree (bare?)".into()); }
    Ok(Some(PathBuf::from(root)))
}

fn require_root(cwd: &str) -> Result<PathBuf, String> {
    repo_root(cwd)?.ok_or_else(|| "not a git repository".to_string())
}

/// One `git status` process, no counts: all an action or a sync needs.
fn status_list(root: &Path) -> Result<(Parsed, String), String> {
    let opts = GitOpts::read(READ_TIMEOUT, STATUS_CAP);
    let status = gitrun::git(root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], &opts)?;
    if status.truncated { return Err("git status output is over 16 MiB".into()); }
    Ok((parse_status(&status.text), tracked_records(&status.text)))
}

/// The status text of tracked records only (types 1, 2, u; a rename keeps its
/// source record): no branch headers, no untracked entries. Staged counts depend
/// on this text (it holds the object names); equal text means equal staged counts.
fn tracked_records(z: &str) -> String {
    let mut out = String::new();
    let mut it = z.split('\0');
    while let Some(rec) = it.next() {
        let Some(&k) = rec.as_bytes().first() else { continue };
        if rec.starts_with("# ") { continue; }
        let orig = if k == b'2' { it.next() } else { None };
        if matches!(k, b'1' | b'2' | b'u') {
            out.push_str(rec);
            out.push('\0');
            if let Some(o) = orig { out.push_str(o); out.push('\0'); }
        }
    }
    out
}

/// (path, size and mtime of the file on disk; None = missing)
type Stamp = (String, Option<(u64, Option<SystemTime>)>);

/// What the last poll of one folder learned; the counts are valid while `recs` (and for
/// the work side `stamps`) still match.
#[derive(Clone, Default)]
struct Counted {
    recs: String,
    staged: HashMap<String, Counts>,
    stamps: Vec<Stamp>,
    work: HashMap<String, Counts>,
}

fn stamps_of(root: &Path, files: &[ChangedFile]) -> Vec<Stamp> {
    files.iter()
        .filter(|f| !f.untracked && f.y != ".")
        .map(|f| {
            let st = std::fs::metadata(root.join(&f.path)).ok().map(|m| (m.len(), m.modified().ok()));
            (f.path.clone(), st)
        })
        .collect()
}

/// Status plus line counts. With `prev` (same folder, last poll) a side whose inputs did
/// not move reuses its counts: staged when the tracked records are equal, work when they
/// and the stamps of the files with a work change are. A side with no tracked change
/// runs no numstat.
fn status_counted(root: &Path, prev: Option<&Counted>) -> Result<(Parsed, Counted), String> {
    let (mut parsed, recs) = status_list(root)?;
    let opts = GitOpts::read(READ_TIMEOUT, STATUS_CAP);
    let numstat = |cached: bool| -> Result<HashMap<String, Counts>, String> {
        let mut args = vec!["diff"];
        if cached { args.push("--cached"); }
        args.extend(["--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv"]);
        let o = gitrun::git(root, &args, &opts)?;
        if o.truncated { return Err("git diff --numstat output is over 16 MiB".into()); }
        Ok(parse_numstat(&o.text))
    };
    let same = prev.filter(|p| p.recs == recs);
    let any_staged = parsed.files.iter().any(|f| !f.untracked && f.x != ".");
    let staged = match same {
        _ if !any_staged => HashMap::new(),
        Some(p) => p.staged.clone(),
        None => numstat(true)?,
    };
    let stamps = stamps_of(root, &parsed.files);
    let work = match same {
        _ if stamps.is_empty() => HashMap::new(),
        Some(p) if p.stamps == stamps => p.work.clone(),
        _ => numstat(false)?,
    };
    for f in parsed.files.iter_mut() {
        if let Some((a, d)) = staged.get(&f.path) { f.staged_adds = *a; f.staged_dels = *d; }
        if let Some((a, d)) = work.get(&f.path) { f.work_adds = *a; f.work_dels = *d; }
    }
    Ok((parsed, Counted { recs, staged, stamps, work }))
}

/// Uncached: the reference the poll cache must agree with.
#[cfg(test)]
fn status_with_counts(root: &Path) -> Result<Parsed, String> {
    Ok(status_counted(root, None)?.0)
}

const ROOT_TTL: Duration = Duration::from_secs(60);
const POLL_CAP: usize = 8;

struct Entry {
    root: PathBuf,
    root_at: Instant,
    touched: Instant,
    counted: Counted,
}

/// Per working folder, for the 5 s poll only. The lock is never held across a git call.
static POLL: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

fn poll_get(cwd: &str) -> Option<(PathBuf, Instant, Counted)> {
    let g = POLL.lock().unwrap_or_else(|p| p.into_inner());
    g.as_ref()?.get(cwd).map(|e| (e.root.clone(), e.root_at, e.counted.clone()))
}

fn poll_drop(cwd: &str) {
    let mut g = POLL.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(m) = g.as_mut() { m.remove(cwd); }
}

fn poll_put(cwd: &str, e: Entry) {
    let mut g = POLL.lock().unwrap_or_else(|p| p.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    if !m.contains_key(cwd) && m.len() >= POLL_CAP {
        let oldest = m.iter().min_by_key(|(_, v)| v.touched).map(|(k, _)| k.clone());
        if let Some(k) = oldest { m.remove(&k); }
    }
    m.insert(cwd.to_string(), e);
}

/// Every requested path must be a path (or a rename source) in the fresh list.
/// Revert checks every record for the path (after `rm --cached` one path has a
/// tracked and an untracked record) and refuses when `restore --worktree`
/// would lose data: untracked, staged-new or intent-to-add (`A` in either
/// column), a rename/copy destination, unmerged (drops the other side), or a
/// deleted file whose path is now a directory on disk (removes the subtree).
fn check_paths(root: &Path, files: &[ChangedFile], verb: ActVerb, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() { return Err("no paths given".into()); }
    for p in paths {
        let mut hits = files.iter().filter(|f| &f.path == p || f.orig_path.as_deref() == Some(p.as_str())).peekable();
        if hits.peek().is_none() { return Err(format!("not in the current change list: {p}")); }
        if verb != ActVerb::Revert { continue; }
        for f in hits.filter(|f| &f.path == p) {
            if f.untracked {
                return Err(format!("untracked files are kept, not reverted: {p}"));
            }
            if f.unmerged {
                return Err(format!("unmerged, so revert would drop the other side: {p} (resolve it in a terminal)"));
            }
            if f.x == "A" || f.y == "A" || ((f.x == "R" || f.x == "C") && f.orig_path.is_some()) {
                return Err(format!("not in HEAD, so revert would delete it: {p} (unstage it first)"));
            }
            if (f.x == "D" || f.y == "D") && root.join(p).is_dir() {
                return Err(format!("deleted file is now a folder, so revert would remove it: {p}"));
            }
        }
    }
    Ok(())
}

/// NUL-terminated pathspecs for `--pathspec-from-file=- --pathspec-file-nul`:
/// stdin has no CreateProcess length limit.
fn nul_paths(paths: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    for p in paths { out.extend_from_slice(p.as_bytes()); out.push(0); }
    out
}

/// Full HEAD sha; None before the first commit.
fn head_sha(root: &Path) -> Result<Option<String>, String> {
    let (code, o) = gitrun::run(root, &["rev-parse", "--verify", "--quiet", "HEAD"], &read_opts())?;
    Ok(if code == Some(0) { Some(o.text.trim().to_string()) } else { None })
}

/// `git config --get`, with "" for an unset key.
fn config_get(root: &Path, key: &str) -> Result<String, String> {
    Ok(gitrun::git(root, &["config", "--default", "", "--get", key], &read_opts())?.text.trim().to_string())
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    MUTATE.lock().unwrap_or_else(|p| p.into_inner())
}

fn joined(o: &GitOut) -> String {
    [o.text.trim(), o.stderr.trim()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n")
}

/// The caller holds the lock.
fn sync_locked(root: &Path, mode: SyncMode) -> Result<SyncResult, String> {
    let (parsed, _) = status_list(root)?;
    let branch = match parsed.head.as_deref() {
        None | Some("(detached)") => return Err("detached HEAD: no branch to sync".into()),
        Some(b) => b.to_string(),
    };
    if parsed.upstream.is_none() {
        return Err(format!("branch {branch} has no upstream; set one in a terminal (git branch -u <remote>/<branch>)"));
    }
    let pushing = matches!(mode, SyncMode::Sync | SyncMode::Push);
    // the push target is checked before anything runs, so a refused sync pulls nothing
    let target = if pushing { Some(push_target(root, &branch)?) } else { None };
    let mut out = SyncResult { pulled: false, pushed: false, output: String::new() };
    let log = |o: &GitOut, out: &mut SyncResult| {
        let t = joined(o);
        if !t.is_empty() { if !out.output.is_empty() { out.output.push('\n'); } out.output.push_str(&t); }
    };
    if matches!(mode, SyncMode::Sync | SyncMode::Pull) {
        let o = gitrun::git(root, &["pull", "--no-rebase", "--ff-only"], &hook_opts(SLOW_TIMEOUT))?;
        log(&o, &mut out);
        out.pulled = true;
    }
    if let Some((remote, merge)) = target {
        // the one branch to its upstream: no tags, no submodules, whatever config says
        let refspec = format!("HEAD:{merge}");
        let pushed = gitrun::git(root, &["push", "--no-follow-tags", "--recurse-submodules=no", &remote, &refspec], &hook_opts(SLOW_TIMEOUT));
        let o = match pushed {
            Ok(o) => o,
            Err(e) if out.pulled => return Err(format!("pulled, then the push failed: {e}")),
            Err(e) => return Err(e),
        };
        log(&o, &mut out);
        out.pushed = true;
    }
    Ok(out)
}

/// (remote, merge ref) of the upstream, when the push would go there. The push
/// remote is `branch.<b>.pushRemote`, else `remote.pushDefault`, else
/// `branch.<b>.remote`; a fork setup (it differs) and a local upstream (`.`)
/// are refused.
fn push_target(root: &Path, branch: &str) -> Result<(String, String), String> {
    let remote = config_get(root, &format!("branch.{branch}.remote"))?;
    let merge = config_get(root, &format!("branch.{branch}.merge"))?;
    if remote == "." {
        return Err(format!("branch {branch} tracks a local branch (remote .); push it from a terminal"));
    }
    let mut push_remote = config_get(root, &format!("branch.{branch}.pushRemote"))?;
    if push_remote.is_empty() { push_remote = config_get(root, "remote.pushDefault")?; }
    if push_remote.is_empty() { push_remote = remote.clone(); }
    if push_remote != remote {
        return Err(format!("branch {branch} pushes to remote {push_remote}, not its upstream remote {remote}; push it from a terminal"));
    }
    Ok((remote, merge))
}

// ---------- blocking bodies ----------

fn status_blocking(cwd: &str) -> Result<ChangesStatus, String> {
    if !Path::new(cwd).is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    let prev = poll_get(cwd);
    // a resolved root is reused for 60 s while its `.git` is still there; actions never reuse it
    let cached = prev.as_ref().filter(|(root, at, _)| at.elapsed() < ROOT_TTL && root.join(".git").exists());
    let from_cache = cached.is_some();
    let (mut root, mut root_at) = match cached {
        Some((root, at, _)) => (root.clone(), *at),
        None => match repo_root(cwd)? {
            Some(root) => (root, Instant::now()),
            None => { poll_drop(cwd); return Ok(ChangesStatus::NoRepo { repo: false }); }
        },
    };
    let mut before = prev.as_ref().filter(|(r, _, _)| *r == root).map(|(_, _, c)| c);
    let (p, counted) = match status_counted(&root, before) {
        Ok(r) => r,
        // a cached root that now fails: forget it and ask git once more
        Err(_) if from_cache => {
            poll_drop(cwd);
            let Some(fresh) = repo_root(cwd)? else { return Ok(ChangesStatus::NoRepo { repo: false }) };
            (root, root_at, before) = (fresh, Instant::now(), None);
            status_counted(&root, before)?
        }
        Err(e) => return Err(e),
    };
    poll_put(cwd, Entry { root: root.clone(), root_at, touched: Instant::now(), counted });
    let detached = p.head.as_deref() == Some("(detached)");
    Ok(ChangesStatus::Repo(RepoStatus {
        repo: true,
        root: root.to_string_lossy().into_owned(),
        branch: if detached { None } else { p.head },
        detached,
        head: p.oid,
        upstream: p.upstream,
        ahead: p.ahead,
        behind: p.behind,
        files: p.files,
    }))
}

fn act_blocking(cwd: &str, verb: ActVerb, paths: &[String]) -> Result<(), String> {
    let root = require_root(cwd)?;
    let _g = lock();
    let (parsed, _) = status_list(&root)?;
    check_paths(&root, &parsed.files, verb, paths)?;
    let mut args: Vec<&str> = match verb {
        ActVerb::Stage => vec!["add"],
        // no HEAD yet: restore has nothing to restore the index from
        ActVerb::Unstage if parsed.initial => vec!["rm", "--cached", "-q"],
        ActVerb::Unstage => vec!["restore", "--staged"],
        // worktree only, from the index: staged edits of a file in both groups survive (F1)
        ActVerb::Revert => vec!["restore", "--worktree"],
    };
    // paths ride stdin (a long Stage All overflows CreateProcess's ~32 K limit);
    // GIT_LITERAL_PATHSPECS applies to them all the same
    args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    let list = nul_paths(paths);
    // add and restore hold index.lock: the write timeout, so a kill never strands it
    let opts = GitOpts { timeout: SLOW_TIMEOUT, cap: SMALL_CAP, stdin: Some(&list), literal_pathspecs: true, ceiling: None, global_config: None };
    gitrun::git(&root, &args, &opts)?;
    Ok(())
}

fn commit_blocking(cwd: &str, message: &str, sync: bool) -> Result<CommitResult, String> {
    if message.trim().is_empty() { return Err("commit message is empty".into()); }
    let root = require_root(cwd)?;
    let _g = lock();
    let opts = GitOpts { timeout: SLOW_TIMEOUT, cap: SMALL_CAP, stdin: Some(message.as_bytes()), literal_pathspecs: false, ceiling: None, global_config: None };
    let before = head_sha(&root)?;
    let (stderr, warning) = match gitrun::git(&root, &["commit", "-F", "-"], &opts) {
        Ok(o) => (o.stderr, None),
        Err(e) => {
            // a timeout in post-commit or `gc --auto` comes after the commit landed
            let after = head_sha(&root)?;
            if after.is_none() || after == before { return Err(e); }
            (String::new(), Some(format!("the commit landed, but git then failed: {e}")))
        }
    };
    let sha = gitrun::git(&root, &["rev-parse", "--short", "HEAD"], &read_opts())?.text.trim().to_string();
    let mut res = CommitResult { sha, stderr, sync: None, sync_error: None, warning };
    if sync {
        match sync_locked(&root, SyncMode::Sync) {
            Ok(s) => res.sync = Some(s),
            Err(e) => res.sync_error = Some(e),
        }
    }
    Ok(res)
}

fn sync_blocking(cwd: &str, mode: SyncMode) -> Result<SyncResult, String> {
    let root = require_root(cwd)?;
    let _g = lock();
    sync_locked(&root, mode)
}

fn rename_blocking(cwd: &str, name: &str) -> Result<(), String> {
    if name.trim().is_empty() { return Err("branch name is empty".into()); }
    if name.starts_with('-') { return Err(format!("branch name may not start with '-': {name}")); }
    let root = require_root(cwd)?;
    let _g = lock();
    let checked = gitrun::git(&root, &["check-ref-format", "--branch", name], &read_opts())
        .map_err(|_| format!("not a valid branch name: {name}"))?;
    // `--branch` expands @{-N} shorthands; only a name that is itself is taken
    if checked.text.trim() != name { return Err(format!("not a plain branch name: {name}")); }
    gitrun::git(&root, &["branch", "-m", name], &hook_opts(READ_TIMEOUT))?;
    Ok(())
}

// ---------- commands ----------

async fn blocking<T: Send + 'static>(what: &str, f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("{what} task failed: {e}"))?
}

#[tauri::command]
pub async fn changes_status(cwd: String) -> Result<ChangesStatus, String> {
    blocking("changes_status", move || status_blocking(&cwd)).await
}

#[tauri::command]
pub async fn changes_act(cwd: String, verb: ActVerb, paths: Vec<String>) -> Result<(), String> {
    blocking("changes_act", move || act_blocking(&cwd, verb, &paths)).await
}

#[tauri::command]
pub async fn changes_commit(cwd: String, message: String, sync: bool) -> Result<CommitResult, String> {
    blocking("changes_commit", move || commit_blocking(&cwd, &message, sync)).await
}

#[tauri::command]
pub async fn changes_sync(cwd: String, mode: SyncMode) -> Result<SyncResult, String> {
    blocking("changes_sync", move || sync_blocking(&cwd, mode)).await
}

#[tauri::command]
pub async fn changes_rename_branch(cwd: String, name: String) -> Result<(), String> {
    blocking("changes_rename_branch", move || rename_blocking(&cwd, &name)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn changes_parse_porcelain_v2_rename_untracked_binary() {
        let z = "# branch.oid 0123abcd\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaaa bbbb src/a b.rs\0\
2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.txt\0old name.txt\0\
1 M. N... 100644 100644 100644 aaaa bbbb img.png\0\
? docs/new file.md\0";
        let mut p = parse_status(z);
        assert_eq!(p.head.as_deref(), Some("main"));
        assert_eq!(p.oid.as_deref(), Some("0123abc"));
        assert_eq!(parse_status("# branch.oid (initial)\0# branch.head main\0").oid, None);
        assert_eq!(p.upstream.as_deref(), Some("origin/main"));
        assert_eq!((p.ahead, p.behind), (Some(2), Some(1)));
        assert_eq!(p.files.len(), 4);
        assert_eq!(p.files[0].path, "src/a b.rs");
        assert_eq!((p.files[0].x.as_str(), p.files[0].y.as_str()), (".", "M"));
        assert_eq!(p.files[1].path, "new name.txt");
        assert_eq!(p.files[1].orig_path.as_deref(), Some("old name.txt"));
        assert!(p.files[3].untracked && p.files[3].path == "docs/new file.md" && p.files[3].x == "?");

        let staged = parse_numstat("0\t0\t\0old name.txt\0new name.txt\0-\t-\timg.png\0");
        let work = parse_numstat("3\t1\tsrc/a b.rs\0");
        assert_eq!(staged.get("new name.txt"), Some(&(Some(0), Some(0))));
        assert_eq!(staged.get("img.png"), Some(&(None, None)));
        assert_eq!(work.get("src/a b.rs"), Some(&(Some(3), Some(1))));
        for f in p.files.iter_mut() {
            if let Some((a, d)) = staged.get(&f.path) { f.staged_adds = *a; f.staged_dels = *d; }
        }
        let json = serde_json::to_value(&p.files[2]).unwrap();
        assert!(json["stagedAdds"].is_null() && json["stagedDels"].is_null());
        assert!(serde_json::to_value(&p.files[0]).unwrap().get("origPath").is_none());
        assert_eq!(serde_json::to_value(&p.files[1]).unwrap()["origPath"], "old name.txt");
    }

    #[test]
    fn changes_detached_head_parses() {
        let p = parse_status("# branch.oid abc\0# branch.head (detached)\0");
        assert_eq!(p.head.as_deref(), Some("(detached)"));
        assert!(p.upstream.is_none() && p.ahead.is_none());
    }

    #[test]
    fn changes_path_not_in_status_is_refused() {
        let files = parse_status("1 .M N... 100644 100644 100644 a b src/a.rs\0? new.txt\0");
        let root = Path::new("Z:\\vidar-no-such-root");
        assert!(check_paths(root, &files.files, ActVerb::Stage, &["src/a.rs".into(), "new.txt".into()]).is_ok());
        let e = check_paths(root, &files.files, ActVerb::Stage, &["src/a.rs".into(), "src/*.rs".into()]).unwrap_err();
        assert!(e.contains("src/*.rs"), "{e}");
        assert!(check_paths(root, &files.files, ActVerb::Stage, &[]).is_err());
        assert!(check_paths(root, &files.files, ActVerb::Revert, &["new.txt".into()]).unwrap_err().contains("untracked"));
    }

    /// Commits `f.txt` ("base\n") so the repo has a HEAD.
    fn committed_repo(tag: &str) -> (TempRepo, String) {
        let repo = temp_repo(tag);
        let cwd = repo.0.to_string_lossy().into_owned();
        fs::write(repo.0.join("f.txt"), "base\n").unwrap();
        act_blocking(&cwd, ActVerb::Stage, &["f.txt".into()]).unwrap();
        commit_blocking(&cwd, "Base", false).unwrap();
        (repo, cwd)
    }

    fn g(repo: &TempRepo, args: &[&str]) -> Result<GitOut, String> { gitrun::git(&repo.0, args, &read_opts()) }

    #[test]
    fn changes_revert_refuses_intent_to_add() {
        let (repo, cwd) = committed_repo("ita");
        let n = repo.0.join("n.txt");
        fs::write(&n, "unsaved\n").unwrap();
        g(&repo, &["add", "-N", "n.txt"]).unwrap();
        let f = files_of(&cwd);
        assert!(f.iter().any(|f| f.path == "n.txt" && f.y == "A"), "{f:?}");
        assert!(act_blocking(&cwd, ActVerb::Revert, &["n.txt".into()]).unwrap_err().contains("not in HEAD"));
        assert_eq!(fs::read_to_string(&n).unwrap(), "unsaved\n");
    }

    #[test]
    fn changes_revert_refuses_tracked_plus_untracked_record() {
        let (repo, cwd) = committed_repo("dup");
        let f_path = repo.0.join("f.txt");
        fs::write(&f_path, "kept local\n").unwrap();
        g(&repo, &["rm", "--cached", "-q", "f.txt"]).unwrap();
        let f = files_of(&cwd);
        assert_eq!(f.iter().filter(|r| r.path == "f.txt").count(), 2, "{f:?}");
        assert!(act_blocking(&cwd, ActVerb::Revert, &["f.txt".into()]).unwrap_err().contains("untracked"));
        assert_eq!(fs::read_to_string(&f_path).unwrap(), "kept local\n");
    }

    #[test]
    fn changes_revert_refuses_unmerged() {
        let (repo, cwd) = committed_repo("um");
        let f_path = repo.0.join("f.txt");
        g(&repo, &["checkout", "-q", "-b", "side"]).unwrap();
        fs::write(&f_path, "side\n").unwrap();
        g(&repo, &["commit", "-q", "-am", "Side"]).unwrap();
        g(&repo, &["checkout", "-q", "main"]).unwrap();
        fs::write(&f_path, "main\n").unwrap();
        g(&repo, &["commit", "-q", "-am", "Main"]).unwrap();
        assert!(g(&repo, &["merge", "side"]).is_err(), "merge should conflict");
        assert!(files_of(&cwd).iter().any(|f| f.path == "f.txt" && f.unmerged));
        let before = fs::read_to_string(&f_path).unwrap();
        assert!(act_blocking(&cwd, ActVerb::Revert, &["f.txt".into()]).unwrap_err().contains("unmerged"));
        assert_eq!(fs::read_to_string(&f_path).unwrap(), before);
    }

    #[test]
    fn changes_revert_refuses_deleted_file_now_a_folder() {
        let (repo, cwd) = committed_repo("dir");
        let f_path = repo.0.join("f.txt");
        fs::remove_file(&f_path).unwrap();
        fs::create_dir_all(&f_path).unwrap();
        fs::write(f_path.join("inner.txt"), "inside\n").unwrap();
        let f = files_of(&cwd);
        assert!(f.iter().any(|r| r.path == "f.txt" && r.y == "D"), "{f:?}");
        assert!(act_blocking(&cwd, ActVerb::Revert, &["f.txt".into()]).unwrap_err().contains("now a folder"));
        assert_eq!(fs::read_to_string(f_path.join("inner.txt")).unwrap(), "inside\n");
    }

    #[test]
    fn changes_unstage_before_first_commit() {
        let repo = temp_repo("init");
        let cwd = repo.0.to_string_lossy().into_owned();
        fs::write(repo.0.join("a.txt"), "one\n").unwrap();
        act_blocking(&cwd, ActVerb::Stage, &["a.txt".into()]).unwrap();
        assert_eq!(files_of(&cwd)[0].x, "A");
        act_blocking(&cwd, ActVerb::Unstage, &["a.txt".into()]).unwrap();
        let f = files_of(&cwd);
        assert!(f.len() == 1 && f[0].untracked, "{f:?}");
        assert!(repo.0.join("a.txt").exists());
    }

    #[test]
    fn changes_long_path_list_goes_through_stdin() {
        let (repo, cwd) = committed_repo("long");
        let pad = "p".repeat(90);
        let paths: Vec<String> = (0..400).map(|i| format!("f{i:04}-{pad}.txt")).collect();
        assert!(paths.iter().map(|p| p.len() + 1).sum::<usize>() > 32 * 1024);
        for p in &paths { fs::write(repo.0.join(p), "new\n").unwrap(); }
        act_blocking(&cwd, ActVerb::Stage, &paths).unwrap();
        let f = files_of(&cwd);
        assert_eq!(f.iter().filter(|r| r.x == "A").count(), 400);
        commit_blocking(&cwd, "Many", false).unwrap();
        for p in &paths { fs::write(repo.0.join(p), "changed\n").unwrap(); }
        act_blocking(&cwd, ActVerb::Stage, &paths).unwrap();
        act_blocking(&cwd, ActVerb::Unstage, &paths).unwrap();
        act_blocking(&cwd, ActVerb::Revert, &paths).unwrap();
        assert!(files_of(&cwd).is_empty());
        assert_eq!(fs::read_to_string(repo.0.join(&paths[399])).unwrap(), "new\n");
    }

    #[test]
    fn changes_push_refuses_a_fork_push_remote() {
        let (repo, cwd) = committed_repo("fork");
        // two fake remotes on paths that do not exist: nothing ever reaches a network
        g(&repo, &["remote", "add", "origin", "Z:/vidar-no-such-remote-a"]).unwrap();
        g(&repo, &["remote", "add", "fork", "Z:/vidar-no-such-remote-b"]).unwrap();
        g(&repo, &["config", "branch.main.remote", "origin"]).unwrap();
        g(&repo, &["config", "branch.main.merge", "refs/heads/main"]).unwrap();
        g(&repo, &["config", "branch.main.pushRemote", "fork"]).unwrap();
        for mode in [SyncMode::Push, SyncMode::Sync] {
            let e = sync_blocking(&cwd, mode).unwrap_err();
            assert!(e.contains("remote fork") && e.contains("upstream remote origin"), "{e}");
        }
        g(&repo, &["config", "--unset", "branch.main.pushRemote"]).unwrap();
        g(&repo, &["config", "remote.pushDefault", "fork"]).unwrap();
        assert!(sync_blocking(&cwd, SyncMode::Push).unwrap_err().contains("remote fork"));
        g(&repo, &["config", "--unset", "remote.pushDefault"]).unwrap();
        g(&repo, &["config", "branch.main.remote", "."]).unwrap();
        assert!(sync_blocking(&cwd, SyncMode::Push).unwrap_err().contains("local branch"));
    }

    struct TempRepo(PathBuf);
    impl Drop for TempRepo {
        fn drop(&mut self) {
            if fs::remove_dir_all(&self.0).is_err() {
                // git marks object files read-only
                fn clear(p: &Path) {
                    if let Ok(rd) = fs::read_dir(p) {
                        for e in rd.flatten() {
                            let path = e.path();
                            if path.is_dir() { clear(&path); } else if let Ok(m) = fs::metadata(&path) {
                                let mut perm = m.permissions();
                                #[allow(clippy::permissions_set_readonly_false)]
                                perm.set_readonly(false);
                                let _ = fs::set_permissions(&path, perm);
                            }
                        }
                    }
                }
                clear(&self.0);
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn temp_repo(tag: &str) -> TempRepo {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("vidar-changes-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let repo = TempRepo(dir);
        let g = |args: &[&str]| { gitrun::git(&repo.0, args, &read_opts()).unwrap(); };
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.name", "Vidar Test"]);
        g(&["config", "user.email", "test@vidar.invalid"]);
        g(&["config", "commit.gpgsign", "false"]);
        g(&["config", "core.autocrlf", "false"]);
        g(&["config", "core.hooksPath", ".git/no-hooks"]);
        repo
    }

    fn files_of(cwd: &str) -> Vec<ChangedFile> {
        match status_blocking(cwd).unwrap() {
            ChangesStatus::Repo(r) => r.files,
            ChangesStatus::NoRepo { .. } => panic!("not a repo"),
        }
    }

    /// Result and the number of git subprocesses `f` started on this thread.
    fn counted<T>(f: impl FnOnce() -> T) -> (T, u32) {
        gitrun::RUNS.with(|c| c.set(0));
        let out = f();
        (out, gitrun::RUNS.with(|c| c.get()))
    }

    /// The uncached list for the same repo: what a poll must always agree with.
    fn fresh_files(repo: &TempRepo) -> Vec<ChangedFile> {
        status_with_counts(&repo.0).unwrap().files
    }

    #[test]
    fn changes_status_poll_cache() {
        let (repo, cwd) = committed_repo("poll");
        let f = repo.0.join("f.txt");

        // a tracked edit: first poll resolves the root and counts, the second runs status alone
        fs::write(&f, "base\nmore\n").unwrap();
        let (first, _) = counted(|| files_of(&cwd));
        assert_eq!(first[0].work_adds, Some(1), "{first:?}");
        let (second, n2) = counted(|| files_of(&cwd));
        assert_eq!(second, first);
        assert_eq!(n2, 1, "second poll ran {n2} git processes");

        // the file grows: the counts move
        fs::write(&f, "base\nmore\nthree\n").unwrap();
        assert_eq!(files_of(&cwd)[0].work_adds, Some(2));
        assert_eq!(files_of(&cwd), fresh_files(&repo));

        // staged: counted once, then reused
        act_blocking(&cwd, ActVerb::Stage, &["f.txt".into()]).unwrap();
        assert_eq!(files_of(&cwd)[0].staged_adds, Some(2));
        let (staged, n3) = counted(|| files_of(&cwd));
        assert_eq!((staged[0].staged_adds, n3), (Some(2), 1));

        // a clean tree never runs a numstat
        commit_blocking(&cwd, "Two", false).unwrap();
        let (clean, n4) = counted(|| files_of(&cwd));
        assert_eq!((clean.len(), n4), (0, 1));

        // an untracked file alone neither counts nor defeats the skip
        fs::write(repo.0.join("u.txt"), "x\n").unwrap();
        let (_, _) = counted(|| files_of(&cwd));
        let (u, n5) = counted(|| files_of(&cwd));
        assert_eq!((u.len(), n5), (1, 1));
        fs::remove_file(repo.0.join("u.txt")).unwrap();

        // a rename must not reuse the counts of the old record
        g(&repo, &["mv", "f.txt", "r.txt"]).unwrap();
        assert_eq!(files_of(&cwd), fresh_files(&repo));
        assert_eq!(files_of(&cwd), fresh_files(&repo));
        fs::write(repo.0.join("r.txt"), "base\nmore\nthree\nfour\nfive\n").unwrap();
        assert_eq!(files_of(&cwd), fresh_files(&repo));
        assert_eq!(files_of(&cwd)[0].work_adds, Some(2));
        g(&repo, &["add", "r.txt"]).unwrap();
        assert_eq!(files_of(&cwd), fresh_files(&repo));
        assert_eq!(files_of(&cwd)[0].staged_adds, Some(2));
        commit_blocking(&cwd, "Renamed", false).unwrap();

        // an unmerged record: counts follow the file, never the first read
        let r = repo.0.join("r.txt");
        g(&repo, &["checkout", "-q", "-b", "side"]).unwrap();
        fs::write(&r, "side\n").unwrap();
        g(&repo, &["commit", "-q", "-am", "Side"]).unwrap();
        g(&repo, &["checkout", "-q", "main"]).unwrap();
        fs::write(&r, "main\n").unwrap();
        g(&repo, &["commit", "-q", "-am", "Main"]).unwrap();
        assert!(g(&repo, &["merge", "side"]).is_err(), "merge should conflict");
        assert!(files_of(&cwd).iter().any(|f| f.unmerged));
        assert_eq!(files_of(&cwd), fresh_files(&repo));
        assert_eq!(files_of(&cwd), fresh_files(&repo));
        fs::write(&r, "resolved by hand\nwith two lines\nand a third\n").unwrap();
        assert_eq!(files_of(&cwd), fresh_files(&repo));
    }

    #[test]
    fn changes_round_trip_in_temp_repo() {
        let repo = temp_repo("rt");
        let cwd = repo.0.to_string_lossy().into_owned();
        let a = repo.0.join("a.txt");

        fs::write(&a, "one\n").unwrap();
        let f = files_of(&cwd);
        assert!(f.len() == 1 && f[0].untracked);
        act_blocking(&cwd, ActVerb::Stage, &["a.txt".into()]).unwrap();
        let f = files_of(&cwd);
        assert_eq!((f[0].x.as_str(), f[0].staged_adds), ("A", Some(1)));
        assert!(act_blocking(&cwd, ActVerb::Revert, &["a.txt".into()]).unwrap_err().contains("not in HEAD"));
        assert!(commit_blocking(&cwd, "  \n ", false).is_err());
        let c = commit_blocking(&cwd, "First commit\n\nBody line.\n", false).unwrap();
        assert!(c.sha.len() >= 7, "{}", c.sha);
        assert!(files_of(&cwd).is_empty());

        fs::write(&a, "one\ntwo\n").unwrap();
        let f = files_of(&cwd);
        assert_eq!((f[0].y.as_str(), f[0].work_adds), ("M", Some(1)));
        act_blocking(&cwd, ActVerb::Stage, &["a.txt".into()]).unwrap();
        let f = files_of(&cwd);
        assert_eq!((f[0].x.as_str(), f[0].staged_adds, f[0].work_adds), ("M", Some(1), Some(0)));
        act_blocking(&cwd, ActVerb::Unstage, &["a.txt".into()]).unwrap();
        let f = files_of(&cwd);
        assert_eq!((f[0].x.as_str(), f[0].y.as_str()), (".", "M"));
        act_blocking(&cwd, ActVerb::Stage, &["a.txt".into()]).unwrap();
        // F1: more edits after staging; Revert drops only those, the staged edit survives
        fs::write(&a, "one\ntwo\nthree\n").unwrap();
        let f = files_of(&cwd);
        assert_eq!((f[0].x.as_str(), f[0].y.as_str()), ("M", "M"));
        act_blocking(&cwd, ActVerb::Revert, &["a.txt".into()]).unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "one\ntwo\n");
        let f = files_of(&cwd);
        assert_eq!((f[0].x.as_str(), f[0].y.as_str()), ("M", "."));
        act_blocking(&cwd, ActVerb::Unstage, &["a.txt".into()]).unwrap();
        act_blocking(&cwd, ActVerb::Revert, &["a.txt".into()]).unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "one\n");
        assert!(files_of(&cwd).is_empty());

        // untracked files are kept; unknown paths and globs are refused
        let b = repo.0.join("b.txt");
        fs::write(&b, "keep\n").unwrap();
        assert!(act_blocking(&cwd, ActVerb::Revert, &["b.txt".into()]).unwrap_err().contains("untracked"));
        assert!(b.exists());
        assert!(act_blocking(&cwd, ActVerb::Stage, &["*.txt".into()]).unwrap_err().contains("not in the current change list"));
        assert!(act_blocking(&cwd, ActVerb::Stage, &["nope.txt".into()]).is_err());

        // a subdirectory cwd still runs from the root
        let sub = repo.0.join("sub");
        fs::create_dir_all(&sub).unwrap();
        act_blocking(&sub.to_string_lossy(), ActVerb::Stage, &["b.txt".into()]).unwrap();
        assert_eq!(files_of(&cwd)[0].x, "A");

        // no upstream: sync refuses, the commit itself still lands
        assert!(sync_blocking(&cwd, SyncMode::Push).unwrap_err().contains("no upstream"));
        let c = commit_blocking(&cwd, "Second", true).unwrap();
        assert!(c.sync.is_none() && c.sync_error.as_deref().unwrap_or("").contains("no upstream"));
    }

    #[test]
    fn changes_bad_branch_name_is_refused() {
        let repo = temp_repo("br");
        let cwd = repo.0.to_string_lossy().into_owned();
        fs::write(repo.0.join("a.txt"), "x\n").unwrap();
        act_blocking(&cwd, ActVerb::Stage, &["a.txt".into()]).unwrap();
        commit_blocking(&cwd, "Init", false).unwrap();
        assert!(rename_blocking(&cwd, "-D").unwrap_err().contains("may not start"));
        assert!(rename_blocking(&cwd, "a..b").unwrap_err().contains("not a valid branch name"));
        assert!(rename_blocking(&cwd, "bad name").is_err());
        assert!(rename_blocking(&cwd, "").is_err());
        rename_blocking(&cwd, "feature/ok").unwrap();
        match status_blocking(&cwd).unwrap() {
            ChangesStatus::Repo(r) => assert_eq!(r.branch.as_deref(), Some("feature/ok")),
            _ => panic!(),
        }
    }

    #[test]
    fn changes_non_repo_and_missing_dir() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = TempRepo(std::env::temp_dir().join(format!("vidar-changes-norepo-{}-{nanos}", std::process::id())));
        fs::create_dir_all(&dir.0).unwrap();
        match status_blocking(&dir.0.to_string_lossy()).unwrap() {
            ChangesStatus::NoRepo { repo } => assert!(!repo),
            ChangesStatus::Repo(_) => panic!("plain temp dir read as a repo"),
        }
        assert!(act_blocking(&dir.0.to_string_lossy(), ActVerb::Stage, &["a".into()]).unwrap_err().contains("not a git repository"));
        assert!(status_blocking("C:\\definitely\\not\\here\\vidar").unwrap_err().contains("not a directory"));
    }
}
