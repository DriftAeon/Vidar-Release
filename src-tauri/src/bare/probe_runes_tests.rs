//! src-tauri\src\bare\probe_runes_tests.rs — the headless runes probe (`node tools/bare/probe-runes.mjs`
//! runs it): one real Raw Bare turn through the real prepare with a row whose set slots two inline
//! runes and one recall rune, copied from the checkout's rune library (`paths::runes_dir`) into a temp
//! library. Claude runs `claude -p` on the `prepare` line; Codex runs `codex exec` (`Surface::Exec`,
//! profile `execArgs`) on the `codex-bare` row admitted from the temp vidar.json. The runner, not
//! these tests, judges the turn: each writes what it saw (reply, payload, transcript or rollout,
//! `runeReads`) to VIDAR_PROBE_OUT.
//!
//! VIDAR_PROBE_CASE (both arms) names a pinned eval case
//! JSON: its runes are slotted with the target's `activate:` rewritten per arm, its scaffold is written
//! into the scratch cwd, VIDAR_ROOT points at the scratch dir, and the result adds `arm`, `model`,
//! `timedOut`, `stdout`, `stderr` and `cwdFiles`. Without it the probe runs as before.

use super::*;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Component;
use std::time::Duration;

/// The row keys the temp vidar.json names; the sets ride them as the launcher's would.
const ROW: &str = "claude-bare";
const CODEX_ROW: &str = "codex-bare";
/// The fixture set and the real runes it slots: two `activate: always` rules (inline, so markers)
/// and one `activate: recall` fact (a pointer into the `vidar-runes` skill).
const SET: &str = "probe-runes";
const RUNES: [&str; 3] = ["ctl-bus-cli-pointer", "workbench-display-routing", "paths-scan-tracked-only"];

/// The row's sets in the temp vidar.json as the launcher's per-launch pick (L2a: the spawn turns the
/// pick into a Custom vault; it never reads the row itself).
fn row_pick(config: &Path, row: &str) -> Vec<LaunchSetRef> {
    super::tests::fixture_row_sets(config, row).expect("row sets").sets.into_iter().map(|s| LaunchSetRef { library: s.library, set: s.set }).collect()
}

/// Newest `.jsonl` under `dir` (recursive) modified at or after `since`.
fn newest_jsonl(dir: &Path, since: std::time::SystemTime) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                let m = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                if m >= since && best.as_ref().is_none_or(|(b, _)| m > *b) {
                    best = Some((m, p));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

/// The `--append-system-prompt-file '<path>'` value on the host line.
fn payload_path(line: &str) -> Option<PathBuf> {
    let at = line.find("'--append-system-prompt-file' '")? + "'--append-system-prompt-file' '".len();
    let rest = &line[at..];
    let end = rest.find('\'')?;
    Some(PathBuf::from(&rest[..end]))
}

/// A pinned eval case (`VIDAR_PROBE_CASE`); the shape is the W2a/W2b contract.
#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Case {
    runes: Vec<String>,
    target: String,
    /// `off` (target not slotted), `always` or `recall` (target's `activate:` rewritten).
    arm: String,
    prompt: String,
    #[serde(default)]
    scaffold: Scaffold,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    timeout_sec: Option<u64>,
    #[serde(default)]
    unset_tab: bool,
}

#[derive(serde::Deserialize, Debug, Default)]
struct Scaffold {
    #[serde(default)]
    files: BTreeMap<String, String>,
}

/// A `cwdFiles` entry above this many bytes carries `truncated: true` instead of its text.
const CWD_FILE_CAP: usize = 64 * 1024;

/// A case file's text (a BOM stripped), checked: a known arm, the target among the runes, a
/// non-empty model when one is given, and every scaffold path relative without `..`.
fn parse_case(text: &str) -> Result<Case, String> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let case: Case = serde_json::from_str(text).map_err(|e| format!("case: {e}"))?;
    if !["off", "always", "recall"].contains(&case.arm.as_str()) {
        return Err(format!("case: arm `{}` is not off, always or recall", case.arm));
    }
    if !case.runes.contains(&case.target) {
        return Err(format!("case: target `{}` is not among its runes", case.target));
    }
    if case.model.as_deref().is_some_and(|m| m.trim().is_empty()) {
        return Err("case: model is empty".into());
    }
    for p in case.scaffold.files.keys() {
        scaffold_rel(p)?;
    }
    Ok(case)
}

/// The case named by VIDAR_PROBE_CASE; None when it is unset or empty.
fn load_case() -> Option<Result<Case, String>> {
    let path = std::env::var_os("VIDAR_PROBE_CASE").filter(|v| !v.is_empty())?;
    Some(std::fs::read_to_string(&path).map_err(|e| format!("case {}: {e}", Path::new(&path).display())).and_then(|t| parse_case(&t)))
}

/// Writes `{ "error": why }` to the out file, then fails the run.
fn refuse(out_json: &Path, why: &str) -> ! {
    let _ = crate::fsx::atomic_write(out_json, serde_json::json!({ "error": why }).to_string().as_bytes());
    panic!("probe case refused: {why}");
}

fn probe_case(out_json: &Path) -> Option<Case> {
    match load_case() {
        None => None,
        Some(Ok(c)) => Some(c),
        Some(Err(e)) => refuse(out_json, &e),
    }
}

fn case_fixture(row: &str, case: Option<&Case>, out_json: &Path) -> (PathBuf, PathBuf, PathBuf, Vec<String>) {
    let (scratch, cwd, config, slotted) = match fixture(row, case) {
        Ok(f) => f,
        Err(e) if case.is_some() => refuse(out_json, &e),
        Err(e) => panic!("{e}"),
    };
    if let Some(c) = case {
        if let Err(e) = write_scaffold(&cwd, &c.scaffold.files) {
            refuse(out_json, &e);
        }
    }
    (scratch, cwd, config, slotted)
}

fn probe_root<'a>(case: Option<&Case>, scratch: &'a Path, live: &'a Path) -> &'a Path {
    if case.is_some() { scratch } else { live }
}

fn add_case_result(result: &mut serde_json::Value, case: Option<&Case>, status: Option<std::process::ExitStatus>, stdout: &str, err: Option<&Path>, cwd: &Path) {
    let Some(c) = case else { return };
    let stderr = err.and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let extra = serde_json::json!({
        "arm": c.arm,
        "model": c.model,
        "timedOut": status.is_none(),
        "stdout": stdout,
        "stderr": stderr,
        "cwdFiles": cwd_files(cwd, &c.scaffold.files),
    });
    result.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
}

/// A scaffold key as a relative path: only normal (and `.`) components, at least one name.
fn scaffold_rel(rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    let plain = p.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !plain || !p.components().any(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("case: scaffold path `{rel}` must be relative, without `..`"));
    }
    Ok(p.components().filter(|c| matches!(c, Component::Normal(_))).collect())
}

/// `/`-joined names of a relative path, the key `cwdFiles` compares on.
fn rel_key(p: &Path) -> String {
    p.components().filter_map(|c| match c { Component::Normal(n) => Some(n.to_string_lossy().into_owned()), _ => None }).collect::<Vec<_>>().join("/")
}

/// Writes every scaffold file under `cwd` (parents created).
fn write_scaffold(cwd: &Path, files: &BTreeMap<String, String>) -> Result<(), String> {
    for (rel, text) in files {
        let dest = cwd.join(scaffold_rel(rel)?);
        std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| format!("scaffold {rel}: {e}"))?;
        std::fs::write(&dest, text).map_err(|e| format!("scaffold {rel}: {e}"))?;
    }
    Ok(())
}

/// Files under `cwd` that are new or differ from the scaffold, sorted by path, each with its text
/// (lossy UTF-8) or, above `CWD_FILE_CAP` bytes, `truncated: true`. Links are not followed.
fn cwd_files(cwd: &Path, scaffold: &BTreeMap<String, String>) -> Vec<serde_json::Value> {
    let before: BTreeMap<String, &[u8]> = scaffold.iter().filter_map(|(k, v)| scaffold_rel(k).ok().map(|p| (rel_key(&p), v.as_bytes()))).collect();
    let mut found: Vec<(String, Vec<u8>)> = Vec::new();
    let mut stack = vec![cwd.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                stack.push(e.path());
            } else if t.is_file() {
                let key = rel_key(e.path().strip_prefix(cwd).unwrap_or(&e.path()));
                let bytes = std::fs::read(e.path()).unwrap_or_default();
                if before.get(&key).is_none_or(|b| *b != bytes.as_slice()) {
                    found.push((key, bytes));
                }
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
        .into_iter()
        .map(|(path, bytes)| {
            if bytes.len() > CWD_FILE_CAP {
                serde_json::json!({ "path": path, "truncated": true })
            } else {
                serde_json::json!({ "path": path, "text": String::from_utf8_lossy(&bytes) })
            }
        })
        .collect()
}

/// `text` with its header's `activate:` line set to `activate` (inserted before the closing `---`
/// when absent; an explicit `activate:` wins over the kind default). LF line ends.
fn with_activate(text: &str, activate: &str) -> Result<String, String> {
    let line = format!("activate: {activate}");
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text).replace("\r\n", "\n");
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return Err("missing header".into());
    }
    let close = lines.iter().skip(1).position(|l| *l == "---").map(|i| i + 1).ok_or("header is not closed")?;
    match lines[1..close].iter().position(|l| l.starts_with("activate:")) {
        Some(i) => lines[i + 1] = &line,
        None => lines.insert(close, &line),
    }
    Ok(lines.join("\n"))
}

/// The target rune's file text for `arm`: unchanged for `off`, else rewritten and re-parsed. A
/// recall arm on a rune with no description is refused (its pointer line would carry nothing).
fn arm_text(id: &str, text: &str, arm: &str) -> Result<String, String> {
    if arm == "off" {
        return Ok(text.to_string());
    }
    let out = with_activate(text, arm).map_err(|e| format!("{id}: {e}"))?;
    let rune = crate::rules::rune::parse(&out).map_err(|e| format!("{id}: {e}"))?;
    if rune.activate != arm {
        return Err(format!("{id}: rewrite left activate `{}`, not `{arm}`", rune.activate));
    }
    if arm == "recall" && rune.description.trim().is_empty() {
        return Err(format!("{id}: a recall arm needs a description, and the rune has none"));
    }
    Ok(out)
}

/// The ids a case slots: all its runes, less the target on the `off` arm.
fn case_slots(case: &Case) -> Vec<String> {
    case.runes.iter().filter(|id| case.arm != "off" || **id != case.target).cloned().collect()
}

/// The host line with `--model` (when given) and `-p <prompt>`, each value through `ps_quote`.
fn host_line(line: &str, prompt: &str, model: Option<&str>) -> String {
    let model = model.map(|m| format!(" '--model' {}", ps_quote(m))).unwrap_or_default();
    format!("{line}{model} -p {}", ps_quote(prompt))
}

/// A fresh scratch folder (probe folders over an hour old removed) with `cwd\`, a temp library holding the real
/// rune files slotted in set `probe-runes`, and a temp vidar.json whose row `row` names it. With a
/// case, its runes are copied (the target rewritten per arm) and `case_slots` slotted; without one,
/// `RUNES`. Returns (scratch, cwd, config, slotted).
fn fixture(row: &str, case: Option<&Case>) -> Result<(PathBuf, PathBuf, PathBuf, Vec<String>), String> {
    // Only stale probe folders go: another test process (a parallel worktree's `cargo test`) may be
    // mid-fixture in a fresh one, and deleting it fails that run with os error 3.
    let stale = std::time::Duration::from_secs(3600);
    for e in std::fs::read_dir(std::env::temp_dir()).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > stale);
        if n.starts_with("vidar-runes-probe-") && e.path().is_dir() && old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    // Unique per call, not per process: two fixtures (threads or processes) never share a scratch root.
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let scratch = std::env::temp_dir().join(format!("vidar-runes-probe-{}-{nanos}-{n}", std::process::id()));
    let cwd = scratch.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    // No launchable set in the checkout's library holds both kinds (it ships no
    // launchable set; recipes are not launchable), so a temp library copies
    // the real rune files in and slots them in one set. A temp vidar.json names it by absolute path
    // (`root.join` keeps it); the live vidar.json is never read or written.
    let lib = scratch.join("lib");
    let real = crate::rules::library::Library::open(&crate::paths::runes_dir()).expect("rune library");
    let copied: Vec<String> = match case {
        Some(c) => c.runes.clone(),
        None => RUNES.iter().map(|s| s.to_string()).collect(),
    };
    for id in &copied {
        let e = real.entry(id)?.ok_or_else(|| format!("{id} is not in the rune library"))?;
        let dest = lib.join(e.folder).join(format!("{id}.md"));
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        match case {
            Some(c) if *id == c.target => {
                let text = std::fs::read_to_string(&e.path).map_err(|err| format!("{id}: {err}"))?;
                std::fs::write(&dest, arm_text(id, &text, &c.arm)?).unwrap();
            }
            _ => {
                std::fs::copy(&e.path, &dest).unwrap();
            }
        }
    }
    let slotted = match case {
        Some(c) => case_slots(c),
        None => copied,
    };
    let slots: String = slotted.iter().map(|id| format!("- <?rune {id}?>\n")).collect();
    std::fs::create_dir_all(lib.join("sets")).unwrap();
    std::fs::write(lib.join("sets").join(format!("{SET}.md")), format!("---\nname: {SET}\nkind: set\nscope: [vidar]\n---\n# Probe rules\n\n{slots}")).unwrap();
    // The scratch root's vidar.json: the vault store sits in the scratch dir (`TEST_VAULT_ROOT`, L2a)
    // and finds the temp library by its folder name through this file.
    let config = crate::paths::config_path_in(&scratch);
    super::vault_spawn::TEST_VAULT_ROOT.with(|r| *r.borrow_mut() = Some(scratch.clone()));
    let cfg = serde_json::json!({
        "rulesLibrary": lib.to_string_lossy(),
        "agents": [{ "key": row, "sets": [{ "set": SET }] }],
    });
    std::fs::write(&config, cfg.to_string()).unwrap();
    seed_stock_templates(&scratch);
    Ok((scratch, cwd, config, slotted))
}

/// The checkout's stock vault templates copied into the scratch root: a Custom vault refuses without its
/// agent's floor template (`vault::floored_custom`), and the scratch root is where the store sits.
fn seed_stock_templates(scratch: &Path) {
    let from = crate::paths::rune_templates_dir_in(&crate::paths::root());
    let to = crate::paths::rune_templates_dir_in(scratch);
    std::fs::create_dir_all(&to).unwrap();
    for id in ["stock-claude", "stock-codex"] {
        let name = format!("{id}.json");
        std::fs::copy(from.join(&name), to.join(&name)).unwrap_or_else(|e| panic!("stock template {name}: {e}"));
    }
}

/// Whether a home index entry is one a probe wrote: its sets name a temp `vidar-runes-probe-` library
/// (before vaults), or it is `vault:<id>` for a vault held in the probe's own scratch store.
fn probe_entry(e: &agent_homes::Entry, scratch: &Path) -> bool {
    e.sets.iter().any(|s| s.contains("vidar-runes-probe-"))
        || matches!(e.sets.as_slice(), [one] if one.strip_prefix("vault:").is_some_and(|id| !id.is_empty() && crate::paths::rune_vaults_dir_in(scratch).join(id).is_dir()))
}

/// Removes from `home`'s two index files the probe entries that were not there in `before`, under the
/// home lock. An index with nothing to remove is not rewritten. Folders stay: the runner reads the
/// transcript after the test exits, and the next probe's fixture clears its temp root.
fn drop_probe_entries(home: &Path, scratch: &Path, before: &[(Agent, Vec<String>)]) -> Result<usize, String> {
    let _lock = home::lock(home, home::LOCK_WAIT)?;
    let mut dropped = 0;
    for (a, had) in before {
        let file = agent_homes::index_file(*a, home);
        let Ok(text) = crate::fsx::read_text(&file) else { continue };
        let mut index: agent_homes::Index = serde_json::from_str(crate::fsx::strip_bom(&text)).map_err(|e| format!("{}: {e}", file.display()))?;
        let gone: Vec<String> = index.iter().filter(|(k, e)| !had.contains(k) && probe_entry(e, scratch)).map(|(k, _)| k.clone()).collect();
        if gone.is_empty() {
            continue;
        }
        for k in &gone {
            index.remove(k);
        }
        dropped += gone.len();
        let json = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
        crate::fsx::atomic_write(&file, &json).map_err(|e| format!("{}: {e}", file.display()))?;
    }
    Ok(dropped)
}

fn index_keys(home: &Path) -> Vec<(Agent, Vec<String>)> {
    [Agent::Claude, Agent::Codex]
        .into_iter()
        .map(|a| {
            let keys = crate::fsx::read_text(&agent_homes::index_file(a, home))
                .ok()
                .and_then(|t| serde_json::from_str::<agent_homes::Index>(crate::fsx::strip_bom(&t)).ok())
                .map(|i| i.into_keys().collect())
                .unwrap_or_default();
            (a, keys)
        })
        .collect()
}

/// Taken before `prepare`: on drop (pass, fail or panic) the probe's own home index entries go, so
/// the live index ends as it began. A failure to clean is printed, never a second panic.
struct ProbeEntries {
    home: PathBuf,
    scratch: PathBuf,
    before: Vec<(Agent, Vec<String>)>,
}

impl ProbeEntries {
    fn new(home: PathBuf, scratch: &Path) -> ProbeEntries {
        let before = index_keys(&home);
        ProbeEntries { home, scratch: scratch.to_path_buf(), before }
    }
}

impl Drop for ProbeEntries {
    fn drop(&mut self) {
        match drop_probe_entries(&self.home, &self.scratch, &self.before) {
            Ok(n) => println!("probe removed {n} home index entr{}", if n == 1 { "y" } else { "ies" }),
            Err(e) => eprintln!("probe left its home index entries: {e}"),
        }
    }
}

/// The launch env plus the tab identity a Raw tab would carry, VIDAR_ROOT = `root`; `unset_tab`
/// drops VIDAR_TAB.
fn tab_env(launch_env: &Env, root: &str, unset_tab: bool) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = launch_env.iter().map(|(k, v)| (k.to_os_string(), v.to_os_string())).collect();
    for (k, v) in [("TERM", "xterm-256color"), ("COLORTERM", "truecolor"), ("VIDAR_TAB", "runes-probe"), ("VIDAR_ROOT", root), ("VIDAR_CTL_TOKEN", "runes-probe")] {
        env.retain(|(n, _)| !n.to_string_lossy().eq_ignore_ascii_case(k));
        if !(unset_tab && k == "VIDAR_TAB") {
            env.push((k.into(), v.into()));
        }
    }
    env
}

/// Spawns `program args` in `cwd` with exactly `env`, stdout to `out` and stderr to `err` (to `out`
/// when None), killed after `limit`. None when it timed out.
fn run(program: &Path, args: &[String], cwd: &Path, env: Vec<(OsString, OsString)>, out: &Path, err: Option<&Path>, limit: Duration) -> Option<std::process::ExitStatus> {
    let file = std::fs::File::create(out).unwrap();
    let err_file = match err {
        Some(p) => std::fs::File::create(p).unwrap(),
        None => file.try_clone().unwrap(),
    };
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(file)
        .stderr(err_file);
    let mut child = cmd.spawn().expect("spawn host");
    let clock = std::time::Instant::now();
    loop {
        if let Some(s) = child.try_wait().unwrap() {
            return Some(s);
        }
        if clock.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// `rune_reads` and `reads` from a transcript or rollout, empty when none was found or it failed.
fn scanned(log: Option<&Path>) -> (Vec<String>, Vec<String>) {
    match log.map(crate::rules::loaded::scan_transcript) {
        Some(Ok(l)) => (l.rune_reads, l.reads),
        _ => (Vec::new(), Vec::new()),
    }
}

#[test]
#[ignore]
fn probe_runes_runs_one_real_bare_turn_with_a_recall_set() {
    let out_json = PathBuf::from(std::env::var("VIDAR_PROBE_OUT").expect("VIDAR_PROBE_OUT"));
    let case = probe_case(&out_json);
    let prompt = match &case {
        Some(c) => c.prompt.clone(),
        None => std::env::var("VIDAR_PROBE_PROMPT").expect("VIDAR_PROBE_PROMPT"),
    };
    let (scratch, cwd, config, slotted) = case_fixture(ROW, case.as_ref(), &out_json);

    // As the launcher sends until L3a: the row's sets as the pick, which becomes a Custom vault (L2a).
    let pick = row_pick(&config, ROW);
    let opts = LaunchOpts { row_key: Some(ROW), config: Some(&config), custom_sets: Some(&pick), ..Default::default() };
    let _entries = ProbeEntries::new(home::resolve().expect("home"), &scratch);
    let mut launch = prepare("bare", &opts).expect("prepare");
    // A case session's VIDAR_ROOT is the scratch dir, so a write task never reaches the live checkout.
    let root = crate::paths::root();
    let env = tab_env(&launch.env, &probe_root(case.as_ref(), &scratch, &root).to_string_lossy(), case.as_ref().is_some_and(|c| c.unset_tab));
    let names: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    launch.write_manifest("runes-probe", names.iter().map(String::as_str)).expect("manifest");
    let config_dir = PathBuf::from(launch.env.get("CLAUDE_CONFIG_DIR").expect("CLAUDE_CONFIG_DIR"));

    let mut args = launch.args.clone();
    let line = args.pop().unwrap().replace(" '--remote-control'", "");
    let payload_file = payload_path(&line).expect("payload path on the host line");
    let payload = std::fs::read_to_string(&payload_file).expect("payload");
    args.push(host_line(&line, &prompt, case.as_ref().and_then(|c| c.model.as_deref())));
    let out = scratch.join("reply.out");
    let err = case.as_ref().map(|_| scratch.join("reply.err"));
    let limit = Duration::from_secs(case.as_ref().and_then(|c| c.timeout_sec).unwrap_or(120));
    let start = std::time::SystemTime::now();
    let status = run(&launch.program, &args, &cwd, env, &out, err.as_deref(), limit);
    if case.is_none() && status.is_none() {
        panic!("probe timed out after {} s", limit.as_secs());
    }
    let reply = std::fs::read_to_string(&out).unwrap_or_default();
    let transcript = newest_jsonl(&config_dir.join("projects"), start);
    let (rune_reads, reads) = scanned(transcript.as_deref());
    let mut result = serde_json::json!({
        "agent": "claude",
        "status": status.and_then(|s| s.code()),
        "reply": reply,
        "payload": payload,
        "payloadFile": payload_file,
        "configDir": config_dir,
        "transcript": transcript,
        "runeReads": rune_reads,
        "reads": reads,
        "sets": [SET],
        "slotted": slotted,
    });
    add_case_result(&mut result, case.as_ref(), status, &reply, err.as_deref(), &cwd);
    crate::fsx::atomic_write(&out_json, result.to_string().as_bytes()).expect("probe result");
    let Some(status) = status else { panic!("probe timed out after {} s", limit.as_secs()) };
    println!("probe reply ({status}): {}", reply.trim());
    assert!(status.success(), "claude -p exited {status}");
}

#[test]
#[ignore]
fn probe_runes_runs_one_real_codex_exec_turn_with_a_recall_set() {
    let out_json = PathBuf::from(std::env::var("VIDAR_PROBE_OUT").expect("VIDAR_PROBE_OUT"));
    let case = probe_case(&out_json);
    let prompt = case.as_ref().map(|c| c.prompt.clone()).unwrap_or_else(|| std::env::var("VIDAR_PROBE_PROMPT").expect("VIDAR_PROBE_PROMPT"));
    let (scratch, cwd, config, slotted) = case_fixture(CODEX_ROW, case.as_ref(), &out_json);

    // The row is admitted as pty.rs admits a Raw Codex row, but from the temp vidar.json.
    let row = admit_row_key(Some(CODEX_ROW.into()), Some("bare"), Some(&config)).expect("admit").expect("row key");
    let pick = row_pick(&config, &row);
    let opts = LaunchOpts { row_key: Some(&row), config: Some(&config), custom_sets: Some(&pick), ..Default::default() };
    let probes = CodexProbes { find: &find_on_env_path, codex: &resolve_codex };
    let root = crate::paths::root();
    let cwd_text = cwd.to_string_lossy().into_owned();
    let _entries = ProbeEntries::new(home::resolve().expect("home"), &scratch);
    let mut launch = prepare_codex_for(Surface::Exec, "bare", &root, &home::resolve().expect("home"), std::env::vars_os(), &Ambient::from_env(), &home::Guard::from_vidar_env(), &probes, &opts, Some(&cwd_text)).expect("prepare");
    // Prepare stays keyed to the install root; only the tab sees the case's scratch root.
    let env = tab_env(&launch.env, &probe_root(case.as_ref(), &scratch, &root).to_string_lossy(), case.as_ref().is_some_and(|c| c.unset_tab));
    let names: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    launch.write_manifest("runes-probe", names.iter().map(String::as_str)).expect("manifest");

    // The sets ride the `--profile` file (`developer_instructions`), as on the Raw TUI line.
    let at = launch.args.iter().position(|a| a == "--profile").expect("--profile on the exec line");
    let payload_file = launch.codex_home.join(format!("{}.config.toml", launch.args[at + 1]));
    let doc = home::parse_toml_lite(&std::fs::read_to_string(&payload_file).expect("profile file")).expect("profile toml");
    let payload = doc.into_iter().find_map(|(k, v)| match (k.as_str(), v) { ("developer_instructions", home::Toml::Str(s)) => Some(s), _ => None }).expect("developer_instructions");

    let last = scratch.join("last-message.txt");
    let mut args = launch.args.clone();
    args.extend(["-o".to_string(), last.to_string_lossy().into_owned(), prompt]);
    let out = scratch.join("reply.out");
    let start = std::time::SystemTime::now();
    let err = case.as_ref().map(|_| scratch.join("reply.err"));
    let limit = Duration::from_secs(case.as_ref().and_then(|c| c.timeout_sec).unwrap_or(300));
    let status = run(&launch.program, &args, &cwd, env, &out, err.as_deref(), limit);
    if case.is_none() && status.is_none() {
        panic!("probe timed out after {} s", limit.as_secs());
    }
    let output = std::fs::read_to_string(&out).unwrap_or_default();
    let reply = std::fs::read_to_string(&last).unwrap_or_else(|_| output.clone());
    let rollout = newest_jsonl(&launch.codex_home.join("sessions"), start);
    let (rune_reads, reads) = scanned(rollout.as_deref());
    let mut result = serde_json::json!({
        "agent": "codex",
        "status": status.and_then(|s| s.code()),
        "reply": reply,
        "output": output,
        "payload": payload,
        "payloadFile": payload_file,
        "configDir": launch.codex_home,
        "transcript": rollout,
        "runeReads": rune_reads,
        "reads": reads,
        "sets": [SET],
        "slotted": slotted,
    });
    add_case_result(&mut result, case.as_ref(), status, &output, err.as_deref(), &cwd);
    crate::fsx::atomic_write(&out_json, result.to_string().as_bytes()).expect("probe result");
    let Some(status) = status else { panic!("probe timed out after {} s", limit.as_secs()) };
    println!("probe reply ({status}): {}", reply.trim());
    assert!(status.success(), "codex exec exited {status}");
}

/// A rune file with `activate` (when Some) and `description` (when Some) in its header.
fn rune_text(kind: &str, activate: Option<&str>, description: Option<&str>) -> String {
    let a = activate.map(|a| format!("activate: {a}\n")).unwrap_or_default();
    let d = description.map(|d| format!("description: {d}\n")).unwrap_or_default();
    format!("---\nname: sample-rune\nkind: {kind}\nscope: [vidar]\n{a}{d}---\n# Sample\n\nBody.\n")
}

/// The vault step of prepare, without a spawn or a model call: the fixture's pick builds a Custom vault
/// on each agent's stock floor in the scratch root.
#[test]
fn probe_fixture_builds_a_floored_custom_vault_for_both_agents() {
    if !crate::paths::runes_dir().exists() {
        eprintln!("skipped: the repo runes/ library is not in this tree (not shipped)");
        return;
    }
    let (scratch, _cwd, config, _slotted) = fixture(ROW, None).expect("fixture");
    let pick = row_pick(&config, ROW);
    let opts = LaunchOpts { row_key: Some(ROW), config: Some(&config), custom_sets: Some(&pick), ..Default::default() };
    for agent in [Agent::Claude, Agent::Codex] {
        let v = vault_for(&scratch, &opts, agent).unwrap_or_else(|e| panic!("{}: {e}", agent.as_str())).expect("vault");
        assert!(!v.id.is_empty(), "{} vault id", agent.as_str());
    }
    let _ = std::fs::remove_dir_all(&scratch);
}

#[test]
fn probe_case_arms_rewrite_the_target_header() {
    let rule = rune_text("rule", Some("always"), Some("A sample rule."));
    let parsed = |t: &str| crate::rules::rune::parse(t).unwrap();
    // off: byte-for-byte unchanged.
    assert_eq!(arm_text("sample-rune", &rule, "off").unwrap(), rule);
    // recall over an explicit `activate: always`: the line is replaced, not doubled.
    let recall = arm_text("sample-rune", &rule, "recall").unwrap();
    assert_eq!(parsed(&recall).activate, "recall");
    assert_eq!(recall.matches("activate:").count(), 1, "{recall}");
    assert_eq!(parsed(&recall).body, parsed(&rule).body);
    // always on a fact with no `activate:` (kind default recall): the line is inserted.
    let fact = rune_text("fact", None, Some("A sample fact."));
    assert_eq!(parsed(&fact).activate, "recall");
    let always = arm_text("sample-rune", &fact.replace('\n', "\r\n"), "always").unwrap();
    assert_eq!(parsed(&always).activate, "always");
    assert_eq!(parsed(&always).description, "A sample fact.");
    // A recall arm on a rune with no description is refused; always is not.
    let bare = rune_text("rule", None, None);
    assert!(arm_text("sample-rune", &bare, "recall").unwrap_err().contains("description"));
    assert_eq!(parsed(&arm_text("sample-rune", &bare, "always").unwrap()).activate, "always");
    assert!(with_activate("no header", "always").is_err());
}

#[test]
fn probe_case_parses_and_slots_per_arm() {
    let json = r#"{"runes":["a-rune","b-rune"],"target":"b-rune","arm":"off","prompt":"p","scaffold":{"files":{"sub/x.mjs":"x"}},"model":"sonnet","timeoutSec":30,"unsetTab":true}"#;
    let c = parse_case(&format!("\u{FEFF}{json}")).unwrap();
    assert_eq!((c.timeout_sec, c.unset_tab, c.model.as_deref()), (Some(30), true, Some("sonnet")));
    assert_eq!(case_slots(&c), ["a-rune"]);
    let c = parse_case(&json.replace("\"off\"", "\"recall\"")).unwrap();
    assert_eq!(case_slots(&c), ["a-rune", "b-rune"]);
    let min = parse_case(r#"{"runes":["a-rune"],"target":"a-rune","arm":"always","prompt":"p"}"#).unwrap();
    assert_eq!((min.model, min.timeout_sec, min.unset_tab, min.scaffold.files.len()), (None, None, false, 0));
    assert!(parse_case(&json.replace("\"off\"", "\"sometimes\"")).unwrap_err().contains("arm"));
    assert!(parse_case(&json.replace("\"target\":\"b-rune\"", "\"target\":\"c-rune\"")).unwrap_err().contains("target"));
    assert!(parse_case(&json.replace("\"sonnet\"", "\" \"")).unwrap_err().contains("model"));
}

#[test]
fn probe_case_refuses_scaffold_paths_that_leave_the_cwd() {
    for bad in ["../x.md", "a/../../x.md", "a\\..\\x.md", "..", "", ".", "/abs.md", "\\abs.md", "C:\\abs.md", "C:rel.md", "\\\\server\\share\\x.md"] {
        assert!(scaffold_rel(bad).is_err(), "{bad} should be refused");
    }
    assert_eq!(scaffold_rel("sub/new-tool.mjs").unwrap(), Path::new("sub").join("new-tool.mjs"));
    assert_eq!(scaffold_rel("./package.json").unwrap(), PathBuf::from("package.json"));
    let json = r#"{"runes":["a"],"target":"a","arm":"off","prompt":"p","scaffold":{"files":{"../escape.md":"x"}}}"#;
    assert!(parse_case(json).unwrap_err().contains("scaffold"));
}

#[test]
fn probe_case_codex_refuses_escaping_scaffold_before_a_model_turn() {
    let dir = std::env::temp_dir().join(format!("vidar-codex-case-refusal-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let case_file = dir.join("case.json");
    let out_file = dir.join("result.json");
    std::fs::write(&case_file, r#"{"runes":["paths-scan-tracked-only"],"target":"paths-scan-tracked-only","arm":"recall","prompt":"do not run","scaffold":{"files":{"../escape.md":"x"}}}"#).unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["probe_runes_runs_one_real_codex_exec_turn_with_a_recall_set", "--ignored", "--nocapture", "--test-threads=1"])
        .env("VIDAR_PROBE_CASE", &case_file)
        .env("VIDAR_PROBE_OUT", &out_file)
        .output()
        .unwrap();
    assert!(!child.status.success());
    let result: serde_json::Value = serde_json::from_slice(&std::fs::read(&out_file).unwrap()).unwrap();
    assert!(result["error"].as_str().unwrap().contains("scaffold path"));
    assert_eq!(result.as_object().unwrap().len(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn probe_case_model_is_one_quoted_token_on_the_host_line() {
    let hostile = "sonnet'; rm -r x; '";
    let line = host_line("& 'claude.exe' '--x'", "hi", Some(hostile));
    assert_eq!(line, "& 'claude.exe' '--x' '--model' 'sonnet''; rm -r x; ''' -p 'hi'");
    // Inside the quoted value every `'` is doubled, so PowerShell reads one literal token.
    let value = line.split(" '--model' ").nth(1).unwrap().split(" -p ").next().unwrap();
    let inner = &value[1..value.len() - 1];
    assert!(value.starts_with('\'') && value.ends_with('\'') && inner.replace("''", "").find('\'').is_none(), "{value}");
    // No model: the line is exactly the old one.
    assert_eq!(host_line("& 'claude.exe'", "it's", None), "& 'claude.exe' -p 'it''s'");
}

#[test]
fn probe_case_cwd_files_lists_new_and_changed_files_only() {
    let cwd = std::env::temp_dir().join(format!("vidar-probecase-cwd-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&cwd);
    let scaffold: BTreeMap<String, String> =
        [("package.json", "{}\n"), ("sub/new-tool.mjs", "export const x = 1;\n"), ("./kept.md", "same\n")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    write_scaffold(&cwd, &scaffold).unwrap();
    assert!(cwd_files(&cwd, &scaffold).is_empty(), "an untouched scaffold diffs empty");
    std::fs::write(cwd.join("sub").join("new-tool.mjs"), "export const x = 2;\n").unwrap();
    std::fs::write(cwd.join("notes.md"), "a note\n").unwrap();
    std::fs::create_dir_all(cwd.join("big")).unwrap();
    std::fs::write(cwd.join("big").join("blob.txt"), "x".repeat(CWD_FILE_CAP + 1)).unwrap();
    std::fs::write(cwd.join("big").join("edge.txt"), "y".repeat(CWD_FILE_CAP)).unwrap();
    let files = cwd_files(&cwd, &scaffold);
    let _ = std::fs::remove_dir_all(&cwd);
    let paths: Vec<&str> = files.iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["big/blob.txt", "big/edge.txt", "notes.md", "sub/new-tool.mjs"]);
    assert_eq!(files[0], serde_json::json!({ "path": "big/blob.txt", "truncated": true }));
    assert_eq!(files[1]["text"].as_str().unwrap().len(), CWD_FILE_CAP);
    assert_eq!(files[2]["text"], "a note\n");
    assert_eq!(files[3]["text"], "export const x = 2;\n");
}

/// M1: the probe's home index entries go when it ends; entries it did not write stay byte-for-byte,
/// and an index it added nothing to is never rewritten.
#[test]
fn probe_entries_leave_the_home_index_as_it_began() {
    let base = std::env::temp_dir().join(format!("vidar-probeentries-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (home, scratch) = (base.join("home"), base.join("scratch"));
    std::fs::create_dir_all(crate::paths::rune_vaults_dir_in(&scratch).join("custom-abc123")).unwrap();
    let entry = |set: &str, dir: &str| agent_homes::Entry { sets: vec![set.into()], dir: dir.into(), last_used: 1 };
    let write = |a: Agent, index: &agent_homes::Index| {
        let f = agent_homes::index_file(a, &home);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, serde_json::to_vec_pretty(index).unwrap()).unwrap();
    };
    let mut claude = agent_homes::Index::new();
    claude.insert("aaaaaaaaaaaa".into(), entry("vault:claude-rendered", "claude-homes/aaaaaaaaaaaa"));
    claude.insert("bbbbbbbbbbbb".into(), entry("c:/temp/vidar-runes-probe-7/lib/probe-runes", "claude-homes/bbbbbbbbbbbb"));
    write(Agent::Claude, &claude);
    let mut codex = agent_homes::Index::new();
    codex.insert("cccccccccccc".into(), entry("vault:codex-raw", "codex-home"));
    write(Agent::Codex, &codex);
    let codex_file = agent_homes::index_file(Agent::Codex, &home);
    let codex_before = std::fs::read(&codex_file).unwrap();
    let codex_mtime = std::fs::metadata(&codex_file).unwrap().modified().unwrap();

    let guard = ProbeEntries::new(home.clone(), &scratch);
    // What a probe's prepare records: its scratch vault and an old-style temp-library entry.
    claude.insert("dddddddddddd".into(), entry("vault:custom-abc123", "claude-homes/dddddddddddd"));
    claude.insert("eeeeeeeeeeee".into(), entry("c:/temp/vidar-runes-probe-9/lib/probe-runes", "claude-homes/eeeeeeeeeeee"));
    // Written by someone else meanwhile: a vault not in the scratch store.
    claude.insert("ffffffffffff".into(), entry("vault:custom-zzz999", "claude-homes/ffffffffffff"));
    write(Agent::Claude, &claude);
    drop(guard);

    let after: agent_homes::Index = serde_json::from_slice(&std::fs::read(agent_homes::index_file(Agent::Claude, &home)).unwrap()).unwrap();
    let keys: Vec<&str> = after.keys().map(String::as_str).collect();
    let codex_after = (std::fs::read(&codex_file).unwrap(), std::fs::metadata(&codex_file).unwrap().modified().unwrap());
    // A clean run: nothing to remove, nothing written.
    let quiet = drop_probe_entries(&home, &scratch, &index_keys(&home)).unwrap();
    let _ = std::fs::remove_dir_all(&base);
    assert_eq!(keys, ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "ffffffffffff"], "the probe's two entries go; earlier and foreign ones stay");
    assert_eq!(codex_after, (codex_before, codex_mtime), "an index the probe added nothing to is untouched");
    assert_eq!(quiet, 0);
}
