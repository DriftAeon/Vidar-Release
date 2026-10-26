//! src-tauri\src\rules\import\local.rs — `bare_local_sources {cwd}`: the local files the Bare Runes tab offers
//! (docs/runs/2026-10-17-bare-runes-flow plan § Design, fold 6-8; TS `BareLocalSources` in `src/ipc.ts`).
//! Read-only: nothing here writes. Kinds, in this order:
//! - rules: `sources::list` (the user and cwd CLAUDE.md / AGENTS.md), then `~\.claude\rules\*.md` and
//!   `<cwd>\.claude\rules\*.md`; a file whose front matter holds `paths:` starts unticked (`pathScoped`).
//! - memory: `~\.claude\projects\<memory_slug(cwd)>\memory\*.md` but `MEMORY.md`, one library for the folder.
//! - skill: `~\.claude\skills\<name>\SKILL.md` (the folder); agent: `~\.claude\agents\*.md`.
//! - hook: each command of `~\.claude\settings.json` `hooks`, a port of `guardList` in
//!   `tools/bare/guard-probe.mjs`: `guard-driver` and a command with no `.mjs` script are not pickable. A
//!   vidar.json holding `bareGuards` ticks its entries (block targets included); with no key the block
//!   targets start ticked, as `--emit` has them.
//!   Every `.mjs` hook but guard-driver carries the `guard` entry it would write.
//! - mcp: the user-scope servers of `~/.claude.json` (`claude_json.rs`), after the hooks.
//! - Codex home files (`codex_home.rs`) follow each kind's own Claude files, and its `mcp` rows come last;
//!   each carries `agent: "codex"`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::memory;
use super::sources::{self, tilde, MAX_BYTES};

/// The block targets of `tools/bare/guard-probe.mjs` (`BLOCK_TARGETS`, from `probeCases`); keep the two equal.
pub const BLOCK_TARGETS: [&str; 6] = ["guard-install", "guard-bash-write", "guard-crawl", "guard-cwd", "guard-agent-brief", "guard-blender"];
/// The PreToolUse wrapper a guard command may lead with (`WRAPPER`).
const WRAPPER: &str = "fail-closed";
/// The aliasing dispatcher guard-probe leaves out.
const DRIVER: &str = "guard-driver";

/// A `bareGuards` entry (`{ event, matcher?, run }`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Guard {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub run: Vec<String>,
    /// An opaque Codex hooks.json selection; resolved on the server before a rune is saved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// One offered file (`BareLocalFile`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub path: String,
    pub shown: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    pub scope: &'static str,
    pub ticked: bool,
    pub pickable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guard: Option<Guard>,
    /// Hook rows shared with Codex are hidden there when its event or matcher cannot run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_supported: Option<bool>,
    /// `codex` for a file Codex reads (a Codex home's files, a cwd AGENTS.md); absent for Claude's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<&'static str>,
    /// A pickable `mcp` row's catalog server name, matched by url for this agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted: Option<String>,
    /// Catalog URL retained during matching; stripped before command IPC.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// `BareLocalSources`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSources {
    pub files: Vec<LocalFile>,
    pub memory_dir: Option<String>,
    /// vidar.json has a `bareGuards` key.
    pub guards_key: bool,
}

/// What discovery reads, explicit so tests run on temp roots.
pub struct LocalEnv<'a> {
    pub imports: &'a Path,
    /// vidar.json (read for `bareGuards` only).
    pub config: &'a Path,
    pub home: Option<&'a Path>,
    pub cwd: &'a Path,
    pub primary: &'a str,
    /// The global settings.json whose hooks are offered.
    pub settings: Option<&'a Path>,
    /// The Codex home whose files are offered (`sources::live_codex_home`; `codex_home.rs`).
    pub codex_home: Option<&'a Path>,
    /// The Bare agent homes root; a Claude home (`home`) or a Codex home under it offers nothing.
    pub homes: Option<&'a Path>,
    /// The real home's `~/.claude.json`, whose user-scope `mcpServers` are offered (`claude_json.rs`).
    pub claude_json: Option<&'a Path>,
    /// The module catalog an MCP row's url must match to be pickable.
    pub catalog: Option<&'a crate::bare::bundles::Bundles>,
}

fn read_root(path: &Path) -> Option<Value> {
    let text = crate::fsx::read_text(path).ok()?;
    serde_json::from_str(crate::fsx::strip_bom(&text)).ok()
}

pub(super) fn readable_md(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) && std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES)
}

/// Files of `dir` passing `keep`, in name order (case-insensitive).
pub(super) fn listed(dir: &Path, keep: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| keep(p)).collect();
    out.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default());
    out
}

/// A rules file whose front matter names `paths:` (Claude Code loads it only for matching files).
fn path_scoped(path: &Path) -> bool {
    let Ok(text) = crate::fsx::read_text_capped(path, MAX_BYTES) else { return false };
    let text = text.replace("\r\n", "\n");
    let Some(rest) = text.strip_prefix("---\n") else { return false };
    rest.split('\n').take_while(|l| l.trim_end() != "---").any(|l| l.starts_with("paths:"))
}

fn under(path: &Path, dir: &Path) -> bool {
    let (p, d) = (path.to_string_lossy().replace('/', "\\").to_lowercase(), dir.to_string_lossy().replace('/', "\\").to_lowercase());
    let d = d.trim_end_matches('\\');
    !d.is_empty() && p.starts_with(d) && (p.len() == d.len() || p[d.len()..].starts_with('\\'))
}

/// The one "project" rule for every offered file, Codex home files included: a path under the cwd is
/// `project`, anything else `global`. It reads the path itself, so a `CODEX_HOME` outside the profile
/// still reads global.
pub(super) fn file(env: &LocalEnv, path: &Path, kind: &'static str) -> LocalFile {
    let codex_rules = kind == "rules"
        && path.file_name().is_some_and(|n| {
            let n = n.to_string_lossy();
            n.eq_ignore_ascii_case("AGENTS.md") || n.eq_ignore_ascii_case(sources::AGENTS_OVERRIDE)
        });
    LocalFile {
        path: path.to_string_lossy().into_owned(),
        shown: tilde(path, env.home),
        kind,
        library: None,
        section: None,
        scope: if under(path, env.cwd) { "project" } else { "global" },
        // Each agent ticks its own instruction files: AGENTS.md stays pickable but starts unticked (Codex ticks it by name).
        ticked: !codex_rules,
        pickable: true,
        reason: None,
        guard: None,
        codex_supported: None,
        agent: codex_rules.then_some("codex"),
        hosted: None,
        url: None,
    }
}

fn rules(env: &LocalEnv) -> Vec<LocalFile> {
    let (cwd, codex_home) = (Some(env.cwd), super::codex_home::usable(env));
    let mut out: Vec<LocalFile> = Vec::new();
    // in a linked worktree the project CLAUDE.md / AGENTS.md list from the main checkout when it has them
    let wt = super::worktree::roots(env.cwd);
    for s in sources::list_in(env.imports, env.home, codex_home, cwd, env.primary) {
        let mut f = LocalFile { library: Some(s.library), ..file(env, Path::new(&s.path), "rules") };
        if let (Some((root, main)), "project") = (&wt, f.scope) {
            let moved = super::worktree::main_copy(Path::new(&f.path), root, main);
            if moved != Path::new(&f.path) {
                let library = sources::library_of_in(env.imports, &moved, env.home, codex_home, Some(main), env.primary);
                f = LocalFile { library: Some(library), path: moved.to_string_lossy().into_owned(), shown: tilde(&moved, env.home), ..f };
            }
        }
        if !out.iter().any(|o| Path::new(&o.path) == Path::new(&f.path)) {
            out.push(f);
        }
    }
    let mut dirs = Vec::new();
    if let Some(h) = env.home {
        dirs.push(h.join(".claude").join("rules"));
    }
    dirs.push(env.cwd.join(".claude").join("rules"));
    for p in dirs.iter().flat_map(|d| listed(d, readable_md)) {
        if out.iter().any(|f| Path::new(&f.path) == p) {
            continue;
        }
        // Applied in listed order, a base name an earlier file takes moves this one to `-2` (as `sources::list`).
        let base = sources::library_of_in(env.imports, &p, env.home, codex_home, cwd, env.primary);
        let (mut library, mut n) = (base.clone(), 2);
        while out.iter().any(|f| f.library.as_deref() == Some(library.as_str())) {
            library = format!("{base}-{n}");
            n += 1;
        }
        let scoped = path_scoped(&p);
        out.push(LocalFile {
            library: Some(library),
            ticked: !scoped,
            reason: scoped.then_some("pathScoped"),
            ..file(env, &p, "rules")
        });
    }
    out
}

fn memories(env: &LocalEnv) -> (Vec<LocalFile>, Option<String>) {
    let Some(home) = env.home else { return (Vec::new(), None) };
    let dir = memory::memory_dir(home, env.cwd);
    if !dir.is_dir() {
        return (Vec::new(), None);
    }
    let library = memory::library_id(env.cwd);
    let files = memory::files(&dir)
        .into_iter()
        .map(|p| {
            let text = crate::fsx::read_text_capped(&p, MAX_BYTES).unwrap_or_default();
            LocalFile { library: Some(library.clone()), section: Some(memory::section_of(&p, &text)), ..file(env, &p, "memory") }
        })
        .collect();
    (files, Some(dir.to_string_lossy().into_owned()))
}

fn skills_and_agents(env: &LocalEnv) -> Vec<LocalFile> {
    let Some(home) = env.home else { return Vec::new() };
    let claude = home.join(".claude");
    let skills = listed(&claude.join("skills"), |p| p.is_dir() && p.join("SKILL.md").is_file()).into_iter().map(|p| file(env, &p, "skill"));
    let agents = listed(&claude.join("agents"), readable_md).into_iter().map(|p| file(env, &p, "agent"));
    skills.chain(agents).collect()
}

/// Quoted-or-bare tokens of a hook command, a leading `node` dropped (`commandTokens`).
pub fn command_tokens(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = command;
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        if let Some(q) = rest.strip_prefix('"') {
            if let Some(end) = q.find('"') {
                out.push(q[..end].to_string());
                rest = &q[end + 1..];
                continue;
            }
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        out.push(rest[..end].to_string());
        rest = &rest[end..];
    }
    let node = out.first().is_some_and(|t| t.eq_ignore_ascii_case("node") || t.eq_ignore_ascii_case("node.exe"));
    if node {
        out.remove(0);
    }
    out
}

/// The script name of a `.mjs` token (`basename(t, ".mjs")`).
fn script_name(token: &str) -> String {
    let base = token.replace('\\', "/").rsplit('/').next().unwrap_or_default().to_string();
    base.strip_suffix(".mjs").map(str::to_string).unwrap_or(base)
}

/// One hook command of the settings: its event, matcher, command text and tokens.
struct Hook {
    event: String,
    matcher: Option<String>,
    run: Vec<String>,
}

fn hooks_of(settings: &Value) -> Vec<Hook> {
    let mut out = Vec::new();
    let Some(events) = settings.get("hooks").and_then(Value::as_object) else { return out };
    for (event, groups) in events {
        for g in groups.as_array().into_iter().flatten() {
            let matcher = g.get("matcher").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_string);
            for h in g.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                let (Some("command"), Some(command)) = (h.get("type").and_then(Value::as_str), h.get("command").and_then(Value::as_str)) else {
                    continue;
                };
                out.push(Hook { event: event.clone(), matcher: matcher.clone(), run: command_tokens(command) });
            }
        }
    }
    out
}

/// The guard a hook runs: the last `.mjs` script that is not the wrapper (`guardList`).
fn guard_name(run: &[String]) -> Option<String> {
    run.iter().filter(|t| t.to_lowercase().ends_with(".mjs")).map(|t| script_name(t)).filter(|s| s != WRAPPER).last()
}

/// The `bareGuards` value guard-probe `--emit` prints for `settings`.
pub fn emit_bare_guards(settings: &Value) -> Vec<Guard> {
    hooks_of(settings)
        .into_iter()
        .filter(|h| guard_name(&h.run).is_some_and(|g| BLOCK_TARGETS.contains(&g.as_str())))
        .map(|h| Guard { event: h.event, matcher: h.matcher, run: h.run, source: None })
        .collect()
}

fn same_guard(a: &Guard, b: &Value) -> bool {
    let run: Vec<&str> = b.get("run").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    b.get("event").and_then(Value::as_str) == Some(a.event.as_str())
        && b.get("matcher").and_then(Value::as_str).filter(|m| !m.is_empty()) == a.matcher.as_deref()
        && run.len() == a.run.len()
        && run.iter().zip(&a.run).all(|(x, y)| x.replace('/', "\\").eq_ignore_ascii_case(&y.replace('/', "\\")))
}

fn hooks(env: &LocalEnv, bare_guards: Option<&Vec<Value>>) -> Vec<LocalFile> {
    let Some(settings) = env.settings.and_then(read_root) else { return Vec::new() };
    hooks_of(&settings)
        .into_iter()
        .map(|h| {
            // Only plain script lists can cross IPC. Arbitrary command arguments may hold secrets;
            // they have no opaque server-side pick in the Claude import path.
            let scripts_only = !h.run.is_empty() && h.run.iter().all(|t| Path::new(t).is_absolute() && t.to_ascii_lowercase().ends_with(".mjs") && !t.contains('='));
            let script = h.run.iter().rev().find(|t| {
                Path::new(t).is_absolute() && !t.contains('=')
                    && (t.to_ascii_lowercase().ends_with(".mjs") || t.to_ascii_lowercase().ends_with(".ps1"))
            }).map(String::as_str).unwrap_or_else(|| env.settings.and_then(|p| p.to_str()).unwrap_or("Settings"));
            let base = LocalFile { scope: "global", ticked: false, ..file(env, Path::new(script), "hook") };
            if !scripts_only {
                return LocalFile { pickable: false, reason: Some(if guard_name(&h.run).is_some() { "commandArgs" } else { "notMjs" }), ..base };
            }
            let Some(name) = guard_name(&h.run) else {
                return LocalFile { pickable: false, reason: Some("notMjs"), ..base };
            };
            if name == DRIVER {
                return LocalFile { pickable: false, reason: Some("guardDriver"), ..base };
            }
            let guard = Guard { event: h.event, matcher: h.matcher, run: h.run, source: None };
            let codex_supported = crate::bare::guards::codex_unsupported(&guard.event, guard.matcher.as_deref()).is_none();
            // With no `bareGuards` key yet (first import) the block targets start on, as guard-probe --emit has them;
            // once the key exists a block target is on only when the list holds it, like any other hook.
            let ticked = match bare_guards {
                Some(list) => list.iter().any(|b| same_guard(&guard, b)),
                None => BLOCK_TARGETS.contains(&name.as_str()),
            };
            LocalFile { ticked, guard: Some(guard), codex_supported: Some(codex_supported), ..base }
        })
        .collect()
}

/// Every offered local file for `env.cwd`. A Claude home under the agent homes root offers nothing of
/// any kind: its rules, memory, skills, agents, settings hooks and `~/.claude.json` are not read.
pub fn discover(env: &LocalEnv) -> LocalSources {
    if env.home.is_some_and(|h| env.homes.is_some_and(|r| sources::under_root(h, r))) {
        return discover(&LocalEnv { home: None, settings: None, claude_json: None, ..*env });
    }
    let root = read_root(env.config);
    let bare_guards = root.as_ref().and_then(|r| r.get("bareGuards"));
    let guards_key = bare_guards.is_some();
    let codex = super::codex_home::discover(env);
    let mut files = rules(env);
    files.extend(codex.rules);
    let (mem, memory_dir) = memories(env);
    files.extend(mem);
    files.extend(codex.memory);
    files.extend(skills_and_agents(env));
    files.extend(codex.skills);
    files.extend(codex.agents);
    files.extend(hooks(env, bare_guards.and_then(Value::as_array)));
    files.extend(super::codex_home::hooks(env));
    files.extend(super::claude_json::rows(env));
    files.extend(codex.mcp);
    LocalSources { files, memory_dir, guards_key }
}

pub(super) fn redact_ipc(mut sources: LocalSources) -> LocalSources {
    for file in &mut sources.files { file.url = None; }
    sources
}

#[tauri::command]
pub fn bare_local_sources(cwd: String) -> LocalSources {
    let (imports, config, home) = (crate::paths::rune_imports_dir(), crate::paths::config_path(), crate::paths::home());
    let primary = read_root(&config)
        .and_then(|r| r.get("primaryAgent").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let settings = home.as_ref().map(|h| h.join(".claude").join("settings.json"));
    let (codex_home, homes) = (sources::live_codex_home(home.as_deref()), sources::agent_homes_root());
    let claude_json = home.as_ref().map(|h| h.join(".claude.json"));
    let (catalog, _) = crate::bare::bundles::load(&crate::paths::root());
    let env = LocalEnv {
        imports: &imports,
        config: &config,
        home: home.as_deref(),
        cwd: Path::new(cwd.trim()),
        primary: &primary,
        settings: settings.as_deref(),
        codex_home: codex_home.as_deref(),
        homes: homes.as_deref(),
        claude_json: claude_json.as_deref(),
        catalog: Some(&catalog),
    };
    redact_ipc(discover(&env))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use serde_json::{json, Value};

    use super::*;
    use crate::rules::import::commands::{scan_at, Env};

    /// A synthetic user profile; tests never read the real one.
    const PROFILE: &str = r"C:\Users\example-user";

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn fixture() -> PathBuf {
        repo().join("tests/fixtures/bare-hooks/settings.json")
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-import-local-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn ticked_guards(s: &LocalSources) -> Value {
        serde_json::to_value(s.files.iter().filter(|f| f.kind == "hook" && f.ticked).map(|f| f.guard.clone().unwrap()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn hook_preselection_equals_guard_probe_emit_on_the_fixture() {
        let root = temp("hooks");
        std::fs::create_dir_all(&root).unwrap();
        let (imports, config, cwd) = (root.join("imports"), root.join("config-under-test.json"), root.join("cwd"));
        let settings = fixture();
        let env = LocalEnv { imports: &imports, config: &config, home: None, cwd: &cwd, primary: "", settings: Some(&settings), codex_home: None, homes: None, claude_json: None, catalog: None };
        let got = discover(&env);
        assert!(!got.guards_key && got.memory_dir.is_none());
        let fx: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(ticked_guards(&got), fx["expectBareGuards"]);
        assert_eq!(serde_json::to_value(emit_bare_guards(&fx)).unwrap(), fx["expectBareGuards"]);
        // The same file through guard-probe itself.
        let out = std::process::Command::new("node")
            .arg(repo().join("tools/bare/guard-probe.mjs"))
            .args(["--emit", "--settings"])
            .arg(&settings)
            .output()
            .expect("node runs guard-probe");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let emitted: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(ticked_guards(&got), emitted["bareGuards"]);

        let by = |end: &str| got.files.iter().find(|f| f.path.ends_with(end)).unwrap_or_else(|| panic!("no hook {end}")).clone();
        let install = by("guard-install.mjs");
        assert_eq!((install.ticked, install.pickable, install.reason, install.scope), (true, true, None, "global"));
        let driver = by("guard-driver.mjs");
        assert_eq!((driver.ticked, driver.pickable, driver.reason, driver.guard.is_none()), (false, false, Some("guardDriver"), true));
        let pwsh = by("ctx-search.ps1");
        assert_eq!((pwsh.ticked, pwsh.pickable, pwsh.reason, pwsh.guard.is_none()), (false, false, Some("notMjs"), true));
        let seal = by("handoff-seal.mjs");
        assert_eq!((seal.ticked, seal.pickable, seal.reason), (false, true, None));
        assert_eq!(got.files.iter().filter(|f| f.kind == "hook").count(), 11);

        // An existing bareGuards ticks its own entries only; block targets are ordinary pickable hooks.
        let seal_guard = json!({ "event": "PostToolUse", "matcher": "Write", "run": [r"c:/users/example-user/.claude/hooks/handoff-seal.mjs"] });
        std::fs::write(&config, json!({ "bareGuards": [seal_guard] }).to_string()).unwrap();
        let again = discover(&env);
        assert!(again.guards_key);
        let ticked: Vec<&str> = again.files.iter().filter(|f| f.ticked).map(|f| f.path.as_str()).collect();
        assert_eq!(ticked.len(), 1, "{ticked:?}");
        assert!(again.files.iter().any(|f| f.path.ends_with("guard-install.mjs") && !f.ticked && f.pickable));
        assert!(again.files.iter().any(|f| f.path.ends_with("handoff-seal.mjs") && f.ticked && f.pickable));
        let json = serde_json::to_value(&again).unwrap();
        assert_eq!(json["guardsKey"], true);
        assert_ne!(json["files"][0]["reason"], "blockTarget");
        assert!(json["files"][0].get("library").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    struct Machine {
        root: PathBuf,
        home: PathBuf,
        codex: PathBuf,
        cwd: PathBuf,
        imports: PathBuf,
        config: PathBuf,
        settings: PathBuf,
    }

    impl Machine {
        fn new(tag: &str) -> Machine {
            let root = temp(tag);
            let (home, cwd) = (root.join("home"), root.join("Proj"));
            let rule = "# Rules\n\n- Keep every change small and reviewed.\n- Run the build before every commit lands.\n";
            put(&home.join(".claude/CLAUDE.md"), rule);
            put(&home.join(".codex/AGENTS.md"), "\u{FEFF}- Ask before any force push to master.\r\n");
            put(&cwd.join("CLAUDE.md"), "- Build with npm run build before commits.\n");
            put(&cwd.join("AGENTS.md"), "- Codex keeps diffs small in this project.\n");
            put(&home.join(".claude/rules/style.md"), "- Use sentence case in every commit body.\n");
            put(&cwd.join(".claude/rules/style.md"), "---\npaths:\n  - src/**\n---\n\n- Source files stay under twelve hundred lines.\n");
            put(&cwd.join(".claude/rules/notes.txt"), "not offered\n");
            let mem = memory::memory_dir(&home, &cwd);
            put(&mem.join("MEMORY.md"), "- [a](a.md)\n");
            put(&mem.join("b-second.md"), "---\nname: Second\n---\n\nThe second memory keeps its own section here.\n");
            put(&mem.join("a-first.md"), "---\nname: First\ndescription: x\n---\n\nThe first memory body is a full sentence.\n");
            put(&home.join(".claude/skills/demo/SKILL.md"), "---\nname: demo\n---\nDemo.\n");
            std::fs::create_dir_all(home.join(".claude/skills/no-skill-file")).unwrap();
            put(&home.join(".claude/agents/helper.md"), "---\nname: helper\n---\nHelps.\n");
            let settings = home.join(".claude/settings.json");
            put(&settings, &std::fs::read_to_string(fixture()).unwrap());
            let imports = crate::paths::rune_imports_dir_in(&root.join("vidar"));
            Machine { config: root.join("vidar/config-under-test.json"), imports, settings, codex: home.join(".codex"), home, cwd, root }
        }
        fn local(&self) -> LocalEnv<'_> {
            LocalEnv {
                imports: &self.imports,
                config: &self.config,
                home: Some(&self.home),
                cwd: &self.cwd,
                primary: "",
                settings: Some(&self.settings),
                codex_home: Some(&self.codex),
                homes: None,
                claude_json: None,
                catalog: None,
            }
        }
        fn env(&self) -> Env<'_> {
            Env { imports: &self.imports, config: &self.config, home: Some(&self.home), cwd: Some(&self.cwd), primary: "", profile: PROFILE }
        }
    }

    impl Drop for Machine {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn hook_arguments_and_mcp_urls_stay_out_of_local_source_ipc() {
        let m = Machine::new("secret-args");
        put(&m.settings, &json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"node C:/safe/check.mjs --token=sk-secret-1"}]}]}}).to_string());
        let mut got = discover(&m.local());
        let hook = got.files.iter().find(|f| f.kind == "hook").unwrap();
        assert!(!hook.pickable && hook.guard.is_none() && hook.reason == Some("commandArgs"));
        got.files.push(LocalFile { url: Some("https://example.test/?token=sk-secret-1".into()), ..file(&m.local(), &m.settings, "mcp") });
        let wire = serde_json::to_string(&redact_ipc(got)).unwrap();
        assert!(!wire.contains("sk-secret-1") && !wire.contains("https://"), "{wire}");
    }

    #[test]
    fn every_local_kind_is_listed_and_rules_sources_scan() {
        let m = Machine::new("kinds");
        let got = discover(&m.local());
        let kinds: Vec<&str> = got.files.iter().map(|f| f.kind).collect();
        let mut want = vec!["rules"; 6];
        want.extend(["memory", "memory", "skill", "agent"]);
        want.extend(["hook"; 11]);
        assert_eq!(kinds, want, "{:#?}", got.files);
        let rules: Vec<(&str, &str, bool, Option<&str>)> = got
            .files
            .iter()
            .filter(|f| f.kind == "rules")
            .map(|f| (f.library.as_deref().unwrap(), f.scope, f.ticked, f.reason))
            .collect();
        assert_eq!(
            rules,
            vec![
                ("claude-user", "global", true, None),
                ("proj-claude-md", "project", true, None),
                ("codex-user", "global", false, None),
                ("proj-agents-md", "project", false, None),
                ("rules-style-md", "global", true, None),
                ("rules-style-md-2", "project", false, Some("pathScoped")),
            ]
        );
        let mem_dir = memory::memory_dir(&m.home, &m.cwd);
        assert_eq!(got.memory_dir.as_deref(), Some(&*mem_dir.to_string_lossy()));
        let mems: Vec<(&str, &str)> = got.files.iter().filter(|f| f.kind == "memory").map(|f| (f.library.as_deref().unwrap(), f.section.as_deref().unwrap())).collect();
        let mem_lib = memory::library_id(&m.cwd);
        assert_eq!(mems, vec![(mem_lib.as_str(), "First"), (mem_lib.as_str(), "Second")]);
        crate::rules::rune::check_id(&mem_lib).unwrap();
        let skill = got.files.iter().find(|f| f.kind == "skill").unwrap();
        let demo = m.home.join(".claude").join("skills").join("demo");
        assert_eq!((skill.path.as_str(), skill.shown.as_str()), (&*demo.to_string_lossy(), r"~\.claude\skills\demo"));

        // Every offered rules file and the memory folder can still be scanned.
        let mut paths: Vec<(String, String)> =
            got.files.iter().filter(|f| f.kind == "rules").map(|f| (f.path.clone(), f.library.clone().unwrap())).collect();
        paths.push((got.memory_dir.clone().unwrap(), mem_lib.clone()));
        for (path, library) in &paths {
            let scan = scan_at(&m.env(), path).unwrap();
            assert!(!scan.library.is_empty() && !library.is_empty(), "{path}");
            let kept: Vec<String> = scan.bricks.iter().filter(|b| b.kept).map(|b| b.id.clone()).collect();
            assert!(!kept.is_empty(), "{path}");
        }
        // The memory library's bricks sit under their file's section.
        let scan = scan_at(&m.env(), &paths.last().unwrap().0).unwrap();
        let sections: Vec<&str> = scan.bricks.iter().map(|b| b.section[0].as_str()).collect();
        assert_eq!(sections, vec!["First", "Second"]);
    }

    #[test]
    fn command_tokens_match_guard_probe() {
        assert_eq!(command_tokens(r#"node "C:\a b\x.mjs" y.mjs"#), vec![r"C:\a b\x.mjs", "y.mjs"]);
        assert_eq!(command_tokens(r#"pwsh -File "C:\x.ps1" -Session"#), vec!["pwsh", "-File", r"C:\x.ps1", "-Session"]);
        assert_eq!(command_tokens(r#"node a"b c"#), vec![r#"a"b"#, "c"]);
        assert_eq!(command_tokens(r#"NODE.exe "unclosed"#), vec![r#""unclosed"#]);
    }
}
