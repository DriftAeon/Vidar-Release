//! src-tauri\src\bare\codex_hooks.rs — Vidar's guard hooks for a Codex Bare home (plan
//! p1-codex-hooks.md § 4 and Revisions, run 2026-10-19-codex-primary P1 W2). One writer for every
//! Codex Bare prepare (in-process Rendered, Raw TUI, Falcon-hosted: all go through
//! `codex_hosted::prepare_home`).
//!
//! `write` puts the groups `guards::copy_codex` built into `<CODEX_HOME>\hooks.json` (Codex loads it as
//! source `user`); no groups removes a stale one. Codex skips any non-managed hook whose hash is not
//! trusted, and its hash is not locally reproducible (p1w0), so `trust` asks Codex: a short-lived
//! `codex app-server` answers `hooks/list` with each hook's `key` and `currentHash`; the caller rewrites
//! config.toml with a `[hooks.state."<key>"] trusted_hash` table per Vidar hook; a second `hooks/list`
//! must then show every one of them `trusted`, or the spawn is refused. Only hooks whose `sourcePath`
//! is this hooks.json are trusted: a repo's own `.codex/hooks.json` is never touched, and no
//! `bypass_hook_trust` override is used.

use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::env::Env;
use super::guards::CodexGroup;
use super::home::HomeLock;

/// The file Codex reads user hooks from, under `CODEX_HOME`.
pub const HOOKS_FILE: &str = "hooks.json";

/// One `hooks/list` call's cap (the app-server answers in ~0.2 s once started; p1w0).
const LIST_CAP: Duration = Duration::from_secs(20);

/// Writes `<codex_home>\hooks.json` from `groups` (`{"hooks":{"<Event>":[group, ...]}}`, entry
/// order kept within an event) and returns the handler count. No groups: a stale hooks.json is
/// removed and the count is 0. Under the caller's `HomeLock`.
pub fn write(_lock: &HomeLock, codex_home: &Path, groups: &[CodexGroup]) -> Result<usize, String> {
    let path = codex_home.join(HOOKS_FILE);
    if groups.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(0),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(e) => Err(format!("Bare Codex hooks {}: a stale file could not be removed ({e}); Bare spawn refused", path.display())),
        };
    }
    let mut events = Map::new();
    let mut handlers = 0;
    for (event, group) in groups {
        handlers += group.get("hooks").and_then(Value::as_array).map_or(0, Vec::len);
        match events.entry(event.clone()).or_insert_with(|| json!([])) {
            Value::Array(a) => a.push(group.clone()),
            _ => unreachable!("hooks.<event> is always an array here"),
        }
    }
    let text = serde_json::to_string_pretty(&json!({ "hooks": events })).map_err(|e| e.to_string())? + "\n";
    crate::fsx::atomic_write(&path, text.as_bytes()).map_err(|e| format!("Bare Codex hooks {}: {e}; Bare spawn refused", path.display()))?;
    Ok(handlers)
}

/// One hook as `hooks/list` reports it (`data[].hooks[]`).
#[derive(Clone, Debug, PartialEq)]
pub struct Listed {
    pub key: String,
    pub current_hash: String,
    pub trust_status: String,
    pub source_path: String,
}

/// `hooks/list` result -> every hook in every cwd entry.
pub fn parse_list(result: &Value) -> Vec<Listed> {
    let s = |h: &Value, k: &str| h.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    result
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|e| e.get("hooks").and_then(Value::as_array).cloned().unwrap_or_default())
        .map(|h| Listed { key: s(&h, "key"), current_hash: s(&h, "currentHash"), trust_status: s(&h, "trustStatus"), source_path: s(&h, "sourcePath") })
        .collect()
}

/// What a `hooks/list` run needs: the spawn's env (its `CODEX_HOME`), the node and codex.js it
/// runs (`js` None: no installed Codex found, which refuses), the home (the process cwd, so no
/// stray `<cwd>\.codex` loads) and the launch folder listed.
pub struct ListCtx<'a> {
    pub env: &'a Env,
    pub node: &'a Path,
    pub js: Option<PathBuf>,
    pub codex_home: &'a Path,
    pub cwd: &'a Path,
}

#[cfg(test)]
type ListMock = Box<dyn Fn(&ListCtx, u32) -> Result<Vec<Listed>, String>>;

#[cfg(test)]
thread_local! {
    /// The tests' `hooks/list`: called with the run number (0 before the trust write, 1 after).
    pub static LIST_MOCK: std::cell::RefCell<Option<ListMock>> = const { std::cell::RefCell::new(None) };
}

/// One `hooks/list` (a test's mock, never a real Codex, under `cfg(test)`).
fn list(ctx: &ListCtx, call: u32) -> Result<Vec<Listed>, String> {
    #[cfg(test)]
    {
        LIST_MOCK.with(|m| match &*m.borrow() {
            Some(f) => f(ctx, call),
            None => Err("no hooks/list mock in this test".into()),
        })
    }
    #[cfg(not(test))]
    {
        let _ = call;
        app_server_list(ctx)
    }
}

/// Waits for the response carrying `id`; notifications and other lines are skipped.
#[cfg_attr(test, allow(dead_code))]
fn await_response(rx: &mpsc::Receiver<String>, id: u64, deadline: Instant) -> Result<Value, String> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = match rx.recv_timeout(left) {
            Ok(l) => l,
            Err(RecvTimeoutError::Timeout) => return Err(format!("Codex did not answer in {} s", LIST_CAP.as_secs())),
            Err(RecvTimeoutError::Disconnected) => return Err("Codex exited before answering".into()),
        };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("id").and_then(Value::as_u64) != Some(id) || v.get("method").is_some() {
            continue;
        }
        if let Some(err) = v.get("error") {
            return Err(format!("Codex refused the request: {err}"));
        }
        return Ok(v.get("result").cloned().unwrap_or(Value::Null));
    }
}

/// A short-lived `node <codex.js> app-server` under exactly the spawn's env: initialize,
/// initialized, `hooks/list {cwds:[cwd]}`; the process tree is killed when it returns.
#[cfg_attr(test, allow(dead_code))]
fn app_server_list(ctx: &ListCtx) -> Result<Vec<Listed>, String> {
    let js = ctx.js.as_deref().ok_or("no installed Codex (codex.js) on the Bare Path to list hooks with")?;
    let deadline = Instant::now() + LIST_CAP;
    let mut cmd = Command::new(ctx.node);
    cmd.arg(js)
        .arg("app-server")
        .current_dir(ctx.codex_home)
        .env_clear()
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (k, v) in ctx.env.iter() {
        cmd.env(k, v);
    }
    let mut child = crate::proc_job::JobChild::spawn(&mut cmd)?;
    let mut stdin = child.stdin.take().ok_or("missing codex stdin")?;
    let stdout = child.stdout.take().ok_or("missing codex stdout")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("codex-hooks-list".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(l) = line else { break };
                if tx.send(l).is_err() {
                    break;
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let mut send = |v: Value| -> Result<(), String> { writeln!(stdin, "{v}").and_then(|_| stdin.flush()).map_err(|e| e.to_string()) };
    send(json!({"jsonrpc":"2.0","id":1,"method":"initialize",
        "params":{"clientInfo":{"name":"vidar","title":"Vidar","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}))?;
    await_response(&rx, 1, deadline)?;
    send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}))?;
    send(json!({"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{"cwds":[ctx.cwd.to_string_lossy()]}}))?;
    let result = await_response(&rx, 2, deadline)?;
    drop(child);
    Ok(parse_list(&result))
}

/// The listed hooks that come from `hooks_json` (path compared case-insensitively).
fn ours<'a>(listed: &'a [Listed], hooks_json: &Path) -> Vec<&'a Listed> {
    let want = hooks_json.to_string_lossy().to_lowercase();
    listed.iter().filter(|h| h.source_path.to_lowercase() == want).collect()
}

/// The caller's config.toml rewrite with the `(key, currentHash)` trust records.
pub type WriteTrust<'w> = dyn FnMut(&[(String, String)]) -> Result<(), String> + 'w;

/// The verified-trust cache, next to hooks.json (`<CODEX_HOME>\hooks.trust.json`).
const CACHE_FILE: &str = "hooks.trust.json";

/// What a verified trust was made against: hooks.json's bytes, the codex.js it ran under, and the
/// `(key, currentHash)` records Codex reported then. The hashes are only reused, never computed.
#[derive(Clone, Debug, PartialEq)]
struct Fingerprint {
    hooks_sha256: String,
    codex_js: String,
    codex_version: String,
}

/// The cache file's path for `hooks_json`.
fn cache_path(hooks_json: &Path) -> PathBuf {
    hooks_json.with_file_name(CACHE_FILE)
}

/// The version in the nearest `package.json` above `js` (codex.js sits in `<pkg>\bin\`).
fn codex_version(js: &Path) -> Option<String> {
    js.ancestors().skip(1).take(4).find_map(|d| {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(d.join("package.json")).ok()?).ok()?;
        v.get("version").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
    })
}

/// hooks.json's bytes + codex.js identity now; `None` on any read problem or no codex.js (no cache).
fn fingerprint(ctx: &ListCtx, hooks_json: &Path) -> Option<Fingerprint> {
    use sha2::{Digest, Sha256};
    let js = ctx.js.as_deref()?;
    let bytes = std::fs::read(hooks_json).ok()?;
    Some(Fingerprint { hooks_sha256: format!("{:x}", Sha256::digest(&bytes)), codex_js: js.to_string_lossy().to_lowercase(), codex_version: codex_version(js)? })
}

/// The cache as stored, `None` when missing, unreadable or malformed.
fn read_cache(hooks_json: &Path) -> Option<(Fingerprint, Vec<(String, String)>)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(cache_path(hooks_json)).ok()?).ok()?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let fp = Fingerprint { hooks_sha256: s("hooksSha256")?, codex_js: s("codexJs")?, codex_version: s("codexVersion")? };
    let entries = v.get("entries")?.as_object()?.iter().map(|(k, h)| Some((k.clone(), h.as_str()?.to_string()))).collect::<Option<Vec<_>>>()?;
    Some((fp, entries))
}

/// Best effort: a failed cache write only costs the next spawn its lists.
fn write_cache(hooks_json: &Path, fp: &Fingerprint, entries: &[(String, String)]) {
    let map: Map<String, Value> = entries.iter().map(|(k, h)| (k.clone(), json!(h))).collect();
    let v = json!({ "hooksSha256": fp.hooks_sha256, "codexJs": fp.codex_js, "codexVersion": fp.codex_version, "entries": map });
    if let Ok(text) = serde_json::to_string_pretty(&v) {
        let _ = crate::fsx::atomic_write(&cache_path(hooks_json), (text + "\n").as_bytes());
    }
}


/// Trusts Vidar's `expected` handlers in `hooks_json`: list, `write_config` with each one's
/// `(key, currentHash)`, list again. Refuses when the first list does not show exactly `expected`
/// of them, or the second shows any not `trusted`.
///
/// Fast path: when hooks.json's bytes and codex.js's version match the last verified trust (the
/// cache file), the cached records are written with `write_config` and ONE `hooks/list` must show
/// exactly `expected` of ours, all `trusted` (Codex's own verdict, so a stale or tampered cache
/// cannot fail open); only the first list is skipped. Any mismatch, read error or untrusted hook
/// there runs the full path.
pub fn trust(ctx: &ListCtx, hooks_json: &Path, expected: usize, write_config: &mut WriteTrust) -> Result<(), String> {
    let fp = fingerprint(ctx, hooks_json);
    if let (Some(fp), Some((cached_fp, entries))) = (&fp, read_cache(hooks_json)) {
        let want = hooks_json.to_string_lossy().to_lowercase();
        let ours_keys = entries.iter().all(|(k, _)| k.to_lowercase().starts_with(&want));
        if cached_fp == *fp && entries.len() == expected && ours_keys && write_config(&entries).is_ok() && verified(ctx, hooks_json, expected, 1) {
            return Ok(());
        }
    }
    let entries = trust_listed(ctx, hooks_json, expected, write_config)?;
    if let Some(fp) = &fp {
        write_cache(hooks_json, fp, &entries);
    }
    Ok(())
}

/// One `hooks/list` (run number `call`) showing exactly `expected` of ours, all `trusted`. A list
/// error counts as not verified (the caller then runs the full path).
fn verified(ctx: &ListCtx, hooks_json: &Path, expected: usize, call: u32) -> bool {
    let Ok(l) = list(ctx, call) else { return false };
    let o = ours(&l, hooks_json);
    o.len() == expected && o.iter().all(|h| h.trust_status == "trusted")
}

/// The full path: two lists around the config write. Returns the records Codex then trusted.
fn trust_listed(ctx: &ListCtx, hooks_json: &Path, expected: usize, write_config: &mut WriteTrust) -> Result<Vec<(String, String)>, String> {
    let unverified = |e: String| format!("Codex hooks/list failed ({e}); guard hooks unverified, Bare spawn refused");
    let first = list(ctx, 0).map_err(unverified)?;
    let found = ours(&first, hooks_json);
    if found.len() != expected {
        return Err(format!("Codex lists {} of Vidar's {expected} guard hooks in {}; Bare spawn refused", found.len(), hooks_json.display()));
    }
    let entries: Vec<(String, String)> = found.iter().map(|h| (h.key.clone(), h.current_hash.clone())).collect();
    write_config(&entries)?;
    let second = list(ctx, 1).map_err(unverified)?;
    let after = ours(&second, hooks_json);
    let untrusted: Vec<String> = after.iter().filter(|h| h.trust_status != "trusted").map(|h| format!("{} is {}", h.key, h.trust_status)).collect();
    if after.len() != expected || !untrusted.is_empty() {
        let what = if untrusted.is_empty() { format!("{} of {expected} listed", after.len()) } else { untrusted.join(", ") };
        return Err(format!("Codex does not trust Vidar's guard hooks after the trust write ({what}); Bare spawn refused"));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    struct Dir(PathBuf);
    impl Dir {
        fn new(tag: &str) -> Dir {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let d = std::env::temp_dir().join(format!("vidar-hooks-cache-{}-{tag}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            std::fs::create_dir_all(d.join("pkg").join("bin")).unwrap();
            std::fs::write(d.join("pkg").join("package.json"), r#"{"version":"0.163.0"}"#).unwrap();
            std::fs::write(d.join("hooks.json"), "{\"hooks\":{}}\n").unwrap();
            Dir(d)
        }
        fn hooks(&self) -> PathBuf {
            self.0.join("hooks.json")
        }
        fn js(&self) -> PathBuf {
            self.0.join("pkg").join("bin").join("codex.js")
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const HASH: &str = "sha256:abababababababababababababababababababababababababababababababab";

    /// A mock `hooks/list` counting its calls: two hooks of `hooks.json`, trusted once config.toml
    /// carries their tables.
    fn mock(d: &Dir) -> Rc<Cell<u32>> {
        let calls = Rc::new(Cell::new(0));
        let c = calls.clone();
        let hooks = d.hooks();
        LIST_MOCK.with(|m| {
            *m.borrow_mut() = Some(Box::new(move |ctx: &ListCtx, _| {
                c.set(c.get() + 1);
                let config = std::fs::read_to_string(ctx.codex_home.join("config.toml")).unwrap_or_default();
                Ok((0..2)
                    .map(|i| {
                        let key = format!("{}:pre_tool_use:0:{i}", hooks.display());
                        let trusted = config.contains(&format!("[hooks.state.\"{}\"]", super::super::home::toml_escape(&key)));
                        Listed { key, current_hash: HASH.into(), trust_status: if trusted { "trusted" } else { "untrusted" }.into(), source_path: hooks.to_string_lossy().into_owned() }
                    })
                    .collect())
            }));
        });
        calls
    }

    /// Runs `trust` for two handlers; `write` counts config writes and stores them like `HookTrust` does.
    fn run(d: &Dir, writes: &Rc<RefCell<u32>>, write_nothing: bool) -> Result<(), String> {
        let env = Env::default();
        let ctx = ListCtx { env: &env, node: Path::new("node"), js: Some(d.js()), codex_home: &d.0, cwd: &d.0 };
        let mut w = |entries: &[(String, String)]| {
            *writes.borrow_mut() += 1;
            if write_nothing {
                return Ok(());
            }
            let t: String = entries.iter().map(|(k, h)| format!("\n[hooks.state.\"{}\"]\ntrusted_hash = \"{h}\"\n", super::super::home::toml_escape(k))).collect();
            std::fs::write(d.0.join("config.toml"), t).map_err(|e| e.to_string())
        };
        trust(&ctx, &d.hooks(), 2, &mut w)
    }

    fn warm(d: &Dir) -> (Rc<Cell<u32>>, Rc<RefCell<u32>>) {
        let (calls, writes) = (mock(d), Rc::new(RefCell::new(0)));
        run(d, &writes, false).unwrap();
        assert_eq!(calls.get(), 2, "the first trust lists twice");
        assert!(cache_path(&d.hooks()).is_file());
        (calls, writes)
    }

    #[test]
    fn a_current_cache_skips_the_first_list_only() {
        let d = Dir::new("hit");
        let (calls, writes) = warm(&d);
        std::fs::remove_file(d.0.join("config.toml")).unwrap(); // the prepare rewrote it without the tables
        run(&d, &writes, false).unwrap();
        assert_eq!(calls.get(), 3, "a hit makes exactly one list call");
        assert_eq!(*writes.borrow(), 2, "the cached records are written again");
    }

    #[test]
    fn a_cache_hit_codex_does_not_trust_falls_back() {
        let d = Dir::new("untrusted");
        let (calls, _) = warm(&d);
        std::fs::remove_file(d.0.join("config.toml")).unwrap();
        // The cached records write nothing Codex accepts on the first write; the full path's write works.
        let n = Cell::new(0);
        let env = Env::default();
        let ctx = ListCtx { env: &env, node: Path::new("node"), js: Some(d.js()), codex_home: &d.0, cwd: &d.0 };
        let mut w = |entries: &[(String, String)]| {
            n.set(n.get() + 1);
            if n.get() == 1 {
                return Ok(());
            }
            let t: String = entries.iter().map(|(k, h)| format!("\n[hooks.state.\"{}\"]\ntrusted_hash = \"{h}\"\n", super::super::home::toml_escape(k))).collect();
            std::fs::write(d.0.join("config.toml"), t).map_err(|e| e.to_string())
        };
        trust(&ctx, &d.hooks(), 2, &mut w).unwrap();
        assert_eq!(calls.get(), 5, "1 verify list (untrusted) + 2 full-path lists after the first 2");
        assert_eq!(n.get(), 2);
    }

    #[test]
    fn a_changed_hooks_json_lists_again() {
        let d = Dir::new("hooks");
        let (calls, writes) = warm(&d);
        std::fs::write(d.hooks(), "{\"hooks\":{\"Stop\":[]}}\n").unwrap();
        run(&d, &writes, false).unwrap();
        assert_eq!(calls.get(), 4);
    }

    #[test]
    fn a_changed_codex_version_lists_again() {
        let d = Dir::new("version");
        let (calls, writes) = warm(&d);
        std::fs::write(d.0.join("pkg").join("package.json"), r#"{"version":"0.164.0"}"#).unwrap();
        run(&d, &writes, false).unwrap();
        assert_eq!(calls.get(), 4);
        assert_eq!(read_cache(&d.hooks()).unwrap().0.codex_version, "0.164.0");
    }

    #[test]
    fn a_missing_key_lists_again() {
        let d = Dir::new("key");
        let (calls, writes) = warm(&d);
        // The cache holds one of the two keys: the count no longer matches.
        let (fp, mut entries) = read_cache(&d.hooks()).unwrap();
        entries.truncate(1);
        write_cache(&d.hooks(), &fp, &entries);
        run(&d, &writes, false).unwrap();
        assert_eq!(calls.get(), 4);
        assert_eq!(read_cache(&d.hooks()).unwrap().1.len(), 2, "the cache is rewritten whole");
        // A config write that leaves the tables out fails the read-back, so the full path runs.
        let before = calls.get();
        std::fs::remove_file(d.0.join("config.toml")).unwrap();
        run(&d, &writes, true).unwrap_err();
        assert_eq!(calls.get(), before + 3, "verify list, then the full path's two");
    }

    #[test]
    fn a_corrupt_cache_lists_again_and_is_replaced() {
        let d = Dir::new("corrupt");
        let (calls, writes) = warm(&d);
        std::fs::write(cache_path(&d.hooks()), "{not json").unwrap();
        run(&d, &writes, false).unwrap();
        assert_eq!(calls.get(), 4);
        assert!(read_cache(&d.hooks()).is_some());
    }

    #[test]
    fn a_refused_trust_writes_no_cache() {
        let d = Dir::new("refused");
        let _ = mock(&d);
        let writes = Rc::new(RefCell::new(0));
        run(&d, &writes, true).unwrap_err();
        assert!(!cache_path(&d.hooks()).exists());
    }

    /// Timing against a real Codex (`cargo test ... -- --ignored --nocapture measure`).
    #[test]
    #[ignore]
    fn measure_app_server_list() {
        let home = PathBuf::from(std::env::var("VIDAR_PROBE_HOME").unwrap());
        let js = PathBuf::from(std::env::var("VIDAR_CODEX_JS").unwrap());
        let node = PathBuf::from(std::env::var("VIDAR_NODE").unwrap());
        let mut env = Env::default();
        for k in ["SystemRoot", "PATH", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ComSpec", "PATHEXT"] {
            if let Ok(v) = std::env::var(k) {
                env.set(k, v);
            }
        }
        env.set("CODEX_HOME", home.clone().into_os_string());
        let ctx = ListCtx { env: &env, node: &node, js: Some(js), codex_home: &home, cwd: &home };
        for i in 0..3 {
            let t = Instant::now();
            let r = app_server_list(&ctx).unwrap();
            println!("app-server start {i}: {} ms, {} hooks", t.elapsed().as_millis(), r.len());
        }
    }

    fn hook(key: &str, hash: &str, status: &str, source: &str) -> Value {
        json!({ "key": key, "currentHash": hash, "trustStatus": status, "sourcePath": source, "isManaged": false })
    }

    #[test]
    fn the_list_result_parses_every_hook_of_every_cwd() {
        let r = json!({ "data": [
            { "cwd": "C:\\w", "hooks": [hook("a:pre_tool_use:0:0", "sha256:1", "untrusted", "C:\\h\\hooks.json")], "errors": [], "warnings": [] },
            { "cwd": "C:\\v", "hooks": [hook("b:stop:0:0", "sha256:2", "trusted", "C:\\v\\.codex\\hooks.json")] }
        ]});
        let l = parse_list(&r);
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].key.as_str(), l[0].current_hash.as_str(), l[0].trust_status.as_str()), ("a:pre_tool_use:0:0", "sha256:1", "untrusted"));
        assert_eq!(l[1].source_path, "C:\\v\\.codex\\hooks.json");
        assert!(parse_list(&json!({})).is_empty());
    }

    #[test]
    fn a_repo_hook_is_never_counted_as_vidars() {
        let hooks_json = Path::new(r"C:\H\codex-home\hooks.json");
        let listed = parse_list(&json!({ "data": [{ "hooks": [
            hook(r"c:\h\codex-home\hooks.json:pre_tool_use:0:0", "sha256:1", "untrusted", r"c:\h\codex-home\hooks.json"),
            hook(r"C:\repo\.codex\hooks.json:pre_tool_use:0:0", "sha256:2", "untrusted", r"C:\repo\.codex\hooks.json"),
        ]}]}));
        let o = ours(&listed, hooks_json);
        assert_eq!(o.len(), 1);
        assert!(o[0].key.starts_with(r"c:\h\codex-home"));
    }
}
