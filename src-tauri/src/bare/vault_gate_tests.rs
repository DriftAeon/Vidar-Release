//! src-tauri\src\bare\vault_gate_tests.rs — the Rune Vault acceptance gate.
//! Contract: `docs/projects/bare/runeset-model.md` § Gate, R2, R3, R4, R6. Runs in plain
//! `cargo test`.
//!
//! Fixtures (the wire formats): `tests/fixtures/rune-vault/` — `vidar-runes/` (one rune per kind, the
//! `base` library), `installed/` (an import library whose set `installed` slots two own runes, one
//! cross-library `base/gate-fact` and `<?recall?>`), `vaults/` (vault.json v1 unlocked and locked
//! variant with `revs/<hash>/`, a session record, `defaults.json`). Every rune body carries a
//! `GATE-<KIND>-<ID>` sentinel the presence checks look for. Every spawn here runs against a temp
//! root (profiles copied in), never the checkout's `runtime\`.

use super::*;
use super::vault::session;
use super::vault::store::{EditMode, Op, Store};
use super::vault::{LockedBy, RuneRef, SetSource, Vault, VaultFrom};
use std::ffi::OsString;

// ---- harness ----

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-vault-gate-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn guard() -> home::Guard {
    home::Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) }
}

fn inherited() -> Vec<(OsString, OsString)> {
    [
        ("Path", r"C:\Windows\system32;C:\Tools"),
        ("SystemRoot", r"C:\Windows"),
        ("USERNAME", "testuser"),
        ("USERPROFILE", r"C:\Users\testuser"),
        ("APPDATA", r"C:\Users\testuser\AppData\Roaming"),
        ("LOCALAPPDATA", r"C:\Users\testuser\AppData\Local"),
    ]
    .iter()
    .map(|(k, v)| (OsString::from(k), OsString::from(v)))
    .collect()
}

fn fake_find(_: &Env, name: &str) -> Option<PathBuf> {
    Some(PathBuf::from(r"X:\bin").join(name))
}

fn codex_ok(env: &Env, _: &CodexBinary) -> Option<(PathBuf, Option<String>)> {
    env.get("Path")?;
    Some((PathBuf::from(r"X:\npm\node_modules\@openai\codex\bin\codex.js"), Some(pinned("codex"))))
}

/// The tests' `hooks/list` (as `bare::tests::mock_list`): every hook in hooks.json, trusted once
/// config.toml carries its trust table. A Codex spawn verifies its guard hooks this way (L2a harness).
fn mock_hooks_list() {
    let snake = |e: &str| e.chars().enumerate().fold(String::new(), |mut s, (i, c)| {
        if c.is_ascii_uppercase() && i > 0 {
            s.push('_');
        }
        s.push(c.to_ascii_lowercase());
        s
    });
    codex_hooks::LIST_MOCK.with(|m| {
        *m.borrow_mut() = Some(Box::new(move |ctx: &codex_hooks::ListCtx, _call: u32| {
            let path = ctx.codex_home.join("hooks.json");
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let config = std::fs::read_to_string(ctx.codex_home.join("config.toml")).unwrap_or_default();
            let mut out = Vec::new();
            for (event, groups) in v["hooks"].as_object().into_iter().flatten() {
                for (gi, g) in groups.as_array().into_iter().flatten().enumerate() {
                    for hi in 0..g["hooks"].as_array().map_or(0, Vec::len) {
                        let key = format!("{}:{}:{gi}:{hi}", path.display(), snake(event));
                        let trusted = config.contains(&format!("[hooks.state.\"{}\"]", key.replace('\\', "\\\\")));
                        out.push(codex_hooks::Listed {
                            key,
                            current_hash: format!("sha256:{}", "ab".repeat(32)),
                            trust_status: if trusted { "trusted" } else { "untrusted" }.into(),
                            source_path: path.to_string_lossy().into_owned(),
                        });
                    }
                }
            }
            Ok(out)
        }));
    });
}

fn fixture() -> PathBuf {
    crate::paths::root().join("tests").join("fixtures").join("rune-vault")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type().unwrap().is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

/// A temp root: the shipped `profiles\bare` and the two Vidar plugins, the fixture `base` runes
/// merged into the `base` library, `installed` as an import library, and the fixture skill/agent/hook sources.
struct Fx {
    t: TempDir,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let t = TempDir::new(tag);
        let real = crate::paths::root();
        copy_dir(&real.join("profiles").join("bare"), &t.0.join("profiles").join("bare"));
        for name in ["roster", "gate"] {
            let src = real.join("plugins").join(name);
            if src.is_dir() {
                copy_dir(&src, &t.0.join("plugins").join(name));
            }
        }
        // The scripts a spawn checks for on disk: the drive MCP server and the Codex guard shim (L2a).
        // Multi-segment literals: the paths contract scan caps bare layout literals.
        let (drive, shim) = (r"tools\mcp\vidar-drive", r"tools\bare\codex-shim.mjs");
        copy_dir(&real.join(drive), &t.0.join(drive));
        std::fs::create_dir_all(t.0.join(shim).parent().unwrap()).unwrap();
        std::fs::copy(real.join(shim), t.0.join(shim)).unwrap();
        copy_dir(&fixture().join("vidar-runes"), &crate::paths::rune_imports_dir_in(&t.0).join("base"));
        // The catalog row the drive mcp rune names (a Claude test may overwrite the file).
        std::fs::create_dir_all(t.0.join("contracts")).unwrap();
        std::fs::copy(real.join("contracts").join("module-bundles.json"), t.0.join("contracts").join("module-bundles.json")).unwrap();
        super::vault::vidar::seed_core(&t.0);
        // The two runes the app recognises by their Vidar library (drive server, app plugin) live there.
        for rel in ["mcp/vidar-drive.md", "plugins/roster.md"] {
            let dst = crate::paths::rune_vidar_dir_in(&t.0).join(rel);
            std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
            std::fs::copy(fixture().join("vidar-runes").join(rel), dst).unwrap();
        }
        copy_dir(&fixture().join("installed"), &crate::paths::rune_imports_dir_in(&t.0).join("installed"));
        copy_dir(&fixture().join("sources"), &t.0.join("tests").join("fixtures").join("rune-vault").join("sources"));
        Fx { t }
    }
    fn root(&self) -> &Path {
        &self.t.0
    }
    fn store(&self) -> Store {
        Store::open(self.root())
    }
    fn home(&self, tag: &str) -> PathBuf {
        self.t.0.join(format!("home-{tag}"))
    }
    /// Rewrites one library rune file in place (an edit after lock).
    fn edit_rune(&self, lib: &str, folder: &str, id: &str, text: &str) {
        let dir = crate::paths::rune_imports_dir_in(self.root()).join(lib);
        std::fs::create_dir_all(dir.join(folder)).unwrap();
        std::fs::write(dir.join(folder).join(format!("{id}.md")), text).unwrap();
    }
    fn raw(&self, home: &Path, vault: &str) -> Result<Launch, String> {
        let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
        prepare_with("bare", self.root(), home, inherited(), &Ambient::default(), &guard(), &probes, &LaunchOpts { vault: Some(vault), ..LaunchOpts::default() })
    }
    fn hosted(&self, home: &Path, vault: &str) -> Result<HostedLaunch, String> {
        let probes = Probes { find: &|_, _| None, version: &|_, _| None, remote_control: &|| false };
        prepare_hosted_with("bare", self.root(), home, inherited(), &Ambient::default(), &guard(), &probes, &LaunchOpts { vault: Some(vault), ..LaunchOpts::default() })
    }
    fn codex(&self, home: &Path, vault: &str) -> Result<CodexLaunch, String> {
        let probes = CodexProbes { find: &fake_find, codex: &codex_ok };
        mock_hooks_list();
        prepare_codex_with("bare", self.root(), home, inherited(), &Ambient::default(), &guard(), &probes, &LaunchOpts { vault: Some(vault), ..LaunchOpts::default() })
    }
}

fn base_ref(id: &str) -> RuneRef {
    // The drive server and the app plugin are the Vidar library's; every other fixture rune sits in `base`.
    let library = if matches!(id, "vidar-drive" | "roster") { "vidar" } else { "base" };
    RuneRef { library: library.into(), id: id.into() }
}

fn installed_set() -> SetSource {
    SetSource { library: "installed".into(), set: "installed".into() }
}

/// Every fixture rune, one per kind (the fact arrives through installed's cross-library slot).
const ALL_ONE_OFFS: &[&str] = &[
    "bare-identity", "gate-recall", "gate-skill", "gate-agent", "gate-hook-run", "gate-hook-command", "vidar-drive", "gate-permission", "roster",
];

/// The bundle catalog the Claude every-kind case writes: one command-form server for the Claude
/// MCP rune `fixture-echo` (no url, no env, no secret).
const CLAUDE_ECHO_CATALOG: &str = r#"{"version":1,"bundles":{"vidar-drive":{"mcp":[{"name":"vidar_drive","approval":"none","stdio":{"command":"node","args":["{{root}}\\tools\\mcp\\vidar-drive\\server.mjs"],"envFrom":[],"envPass":["VIDAR_CTL_TOKEN"]},"reads":["*"]}],"skills":[],"agents":[],"guards":[]},"fixture-echo":{"mcp":[{"name":"fixture_echo","stdio":{"command":"node","args":["fixture-echo.mjs"],"envFrom":[]},"agents":["claude"],"reads":[]}],"skills":[],"agents":[],"guards":[]}}}"#;

fn full_vault(fx: &Fx, name: &str) -> Vault {
    let runes: Vec<RuneRef> = ALL_ONE_OFFS.iter().map(|id| base_ref(id)).collect();
    super::vault::create_at(fx.root(), Some(name.into()), None, &[installed_set()], &runes).unwrap()
}

fn payload_text(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

fn claude_warnings(l: &Launch) -> String {
    l.manifest.payload.warnings.iter().chain(&l.manifest.warnings).cloned().collect::<Vec<_>>().join("\n")
}

fn codex_warnings(l: &CodexLaunch) -> String {
    l.manifest.payload.warnings.iter().chain(&l.manifest.warnings).cloned().collect::<Vec<_>>().join("\n")
}

/// What a Claude Raw spawn on `vault` carries, per kind.
struct ClaudeSeen {
    payload: String,
    recall: String,
    settings: String,
    line: String,
    skill: bool,
    agent: bool,
    /// The MCP config text the session sees (`--mcp-config` file and `.claude.json` files).
    mcp: String,
    warnings: String,
}

fn claude_seen(fx: &Fx, tag: &str, vault: &str) -> ClaudeSeen {
    let home = fx.home(tag);
    let launch = fx.raw(&home, vault).unwrap();
    let config = PathBuf::from(&launch.manifest.homes.claude_config);
    let settings = read(&config.join("settings.json"));
    let line = launch.args.join(" ");
    // MCP config only: the `--mcp-config` file and the `.claude.json` files. settings.json and the
    // spawn line name `mcp__vidar_drive` through the `drive-allow` permission rune either way.
    let flag = "'--mcp-config' '";
    let mcp_config = line.find(flag).map(|at| &line[at + flag.len()..]).and_then(|r| r.split('\'').next()).map(|p| read(Path::new(p))).unwrap_or_default();
    let mcp_files = mcp_config + &read(&config.join(".claude.json")) + &read(&home.join("user-home").join(".claude.json"));
    // The on-demand skill copied into the session's config dir (`vidar-runes`): a recall-activated
    // rune's body lives there, the payload holds its pointer (fact defaults to `activate: recall`).
    let mut recall = String::new();
    for f in std::fs::read_dir(config.join("skills").join("vidar-runes")).into_iter().flatten().flatten() {
        recall += &read(&f.path());
    }
    ClaudeSeen {
        recall,
        payload: payload_text(&launch.manifest.payload.path),
        skill: config.join("skills").join("gate-skill").join("SKILL.md").is_file(),
        agent: config.join("agents").join("gate-agent.md").is_file(),
        mcp: mcp_files,
        warnings: claude_warnings(&launch),
        settings,
        line,
    }
}

// ---- wire formats (L1a store and L1b session record turn these green) ----

#[test]
fn the_fixture_vault_json_round_trips_through_the_vault_type() {
    for id in ["astra-code", "astra-code-no-skill"] {
        let path = fixture().join("vaults").join(id).join("vault.json");
        let raw: serde_json::Value = serde_json::from_str(&read(&path)).unwrap();
        let v: Vault = serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(v.id, id);
        assert_eq!(serde_json::to_value(&v).unwrap(), raw, "{id}: vault.json shape drifted from the fixture");
    }
    let locked: Vault = serde_json::from_str(&read(&fixture().join("vaults").join("astra-code-no-skill").join("vault.json"))).unwrap();
    assert_eq!(locked.locked_by, Some(LockedBy::FirstMessage));
    assert!(matches!(&locked.from, Some(VaultFrom::Vault { vault, .. }) if vault == "astra-code"));
    assert!(locked.pins.contains_key("installed/team-recall-tip"), "a recall member is pinned at lock");
    let revs = fixture().join("vaults").join("astra-code-no-skill").join("revs").join(&locked.hash);
    for key in locked.pins.keys() {
        let (lib, id) = key.split_once('/').unwrap();
        assert!(revs.join("runes").join(lib).join(format!("{id}.md")).is_file(), "revs holds no body for {key}");
    }
}

#[test]
fn the_fixture_session_record_round_trips_and_names_no_row() {
    let dir = fixture().join("vaults").join("sessions");
    let file = std::fs::read_dir(&dir).unwrap().flatten().next().unwrap().path();
    let raw: serde_json::Value = serde_json::from_str(&read(&file)).unwrap();
    let r: session::Record = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(serde_json::to_value(&r).unwrap(), raw, "session record shape drifted from the fixture");
    assert_eq!(r.vault.id, "astra-code-no-skill");
    assert!(raw.get("rowKey").is_none(), "a session record never binds a launcher row (model R2)");
}

// ---- per kind, Claude (L2a spawn on a vault, L2b item kinds and floor, L2e plugins) ----

#[test]
fn every_kind_in_a_vault_reaches_a_claude_session_and_a_variant_without_it_does_not() {
    let fx = Fx::new("claude-kinds");
    // A command-form Claude server with no secrets, for the Claude MCP rune `fixture-echo`, plus the
    // drive server both agents get from the `vidar-drive` mcp rune.
    let catalog = fx.root().join("contracts").join("module-bundles.json");
    std::fs::create_dir_all(catalog.parent().unwrap()).unwrap();
    std::fs::write(&catalog, CLAUDE_ECHO_CATALOG).unwrap();
    let mut runes: Vec<RuneRef> = ALL_ONE_OFFS.iter().map(|id| base_ref(id)).collect();
    runes.push(base_ref("fixture-echo"));
    let full = super::vault::create_at(fx.root(), Some("Gate Full".into()), None, &[installed_set()], &runes).unwrap();
    let seen = claude_seen(&fx, "full", &full.id);
    for needle in ["GATE-RULE-BARE-IDENTITY", "GATE-RULE-TEAM-VERDICT-FIRST", "gate-recall", "team-recall-tip"] {
        assert!(seen.payload.contains(needle), "payload lacks {needle}: {}", seen.payload);
    }
    // The fact is recall-activated: its pointer in the payload, its body in the session's on-demand skill.
    assert!(seen.payload.contains("gate-fact.md") && seen.recall.contains("GATE-FACT-GATE-FACT"), "fact not delivered: {}", seen.payload);
    assert!(seen.skill, "skill rune not copied into the session's config dir");
    assert!(seen.agent, "agent rune not copied into the session's config dir");
    assert!(seen.settings.contains("gate-hook-run"), "run-list hook not in settings.json");
    assert!(seen.mcp.contains("fixture_echo"), "mcp rune fixture-echo not delivered: {}", seen.mcp);
    assert!(seen.mcp.contains("vidar_drive"), "the vidar-drive mcp rune's server not delivered: {}", seen.mcp);
    assert!(seen.settings.contains("mcp__vidar_drive"), "permission allow list not in settings.json");
    assert!(seen.settings.contains("mcp__gate_write"), "permission ask list not in settings.json");
    assert!(seen.line.contains("'--permission-mode' 'auto'"), "permission mode not on the spawn line: {}", seen.line);
    assert!(seen.line.contains("plugins\\roster"), "plugin rune not passed by path: {}", seen.line);
    assert!(!seen.warnings.contains("gate-hook-command"), "a Codex-only rune is absent on Claude, with no warning: {}", seen.warnings);
    assert!(!seen.settings.contains("gate-notify"), "a Codex-only hook is absent from Claude's settings.json");

    // One variant per kind, each dropping that kind's rune; the rest stays.
    let drops: &[(&str, &str)] = &[
        ("bare-identity", "identity"),
        ("gate-recall", "recall"),
        ("gate-skill", "skill"),
        ("gate-agent", "agent"),
        ("gate-hook-run", "hook"),
        ("fixture-echo", "mcp"),
        ("gate-permission", "permission"),
        ("roster", "plugin"),
    ];
    for (id, kind) in drops {
        let v = fx.store().edit(&full.id, &[Op::RemoveRune(base_ref(id))], EditMode::Variant).unwrap();
        assert_ne!(v.id, full.id, "{kind}: a variant is a new vault");
        let s = claude_seen(&fx, kind, &v.id);
        let present = match *kind {
            "identity" => s.payload.contains("GATE-RULE-BARE-IDENTITY"),
            "recall" => s.payload.contains("gate-recall"),
            "skill" => s.skill,
            "agent" => s.agent,
            "hook" => s.settings.contains("gate-hook-run"),
            "mcp" => s.mcp.contains("fixture_echo"),
            "permission" => s.settings.contains("mcp__gate_write") || s.line.contains("--permission-mode"),
            "plugin" => s.line.contains("plugins\\roster") || s.line.contains("--plugin-dir"),
            _ => unreachable!(),
        };
        assert!(!present, "{kind}: rune {id} still reached a session on a variant without it");
        assert!(s.payload.contains("GATE-RULE-TEAM-VERDICT-FIRST"), "{kind}: the variant lost an unrelated rune");
    }
    // Rule and fact ride a runeset: dropping the runeset drops them.
    let no_installed = fx.store().edit(&full.id, &[Op::RemoveRuneset(installed_set())], EditMode::Variant).unwrap();
    let s = claude_seen(&fx, "no-installed", &no_installed.id);
    assert!(!s.payload.contains("GATE-RULE-TEAM-VERDICT-FIRST") && !s.payload.contains("GATE-FACT-GATE-FACT") && !s.payload.contains("gate-fact.md"), "{}", s.payload);
    // Dropping the identity rune never bars the spawn (the Vidar Runeset still gives the payload a body).
    let no_id = fx.store().edit(&full.id, &[Op::RemoveRune(base_ref("bare-identity"))], EditMode::Variant).unwrap();
    claude_seen(&fx, "no-identity", &no_id.id);
}

#[test]
fn a_claude_spawn_without_a_vault_refuses() {
    // L2a: no vault, no spawn (R2); never a launcher row's sets.
    let fx = Fx::new("claude-novault");
    let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
    let e = prepare_with("bare", fx.root(), &fx.home("x"), inherited(), &Ambient::default(), &guard(), &probes, &LaunchOpts::default()).err().unwrap();
    assert!(e.contains("vault") && e.contains("refused"), "{e}");
    assert!(fx.raw(&fx.home("ghost"), "no-such-vault").is_err());
}

// ---- per kind, Codex (L2c) ----

#[test]
fn every_kind_in_a_vault_reaches_a_codex_session_and_mode_and_plugin_warn_unsupported() {
    let fx = Fx::new("codex-kinds");
    let full = full_vault(&fx, "Gate Codex");
    let home = fx.home("codex-full");
    let launch = fx.codex(&home, &full.id).unwrap();
    let text = launch.developer_instructions.clone().unwrap_or_else(|| payload_text(&launch.manifest.payload.path));
    // The fact is recall-activated: a pointer by file name, as on Claude.
    for needle in ["GATE-RULE-BARE-IDENTITY", "GATE-RULE-TEAM-VERDICT-FIRST", "gate-fact.md", "gate-recall"] {
        assert!(text.contains(needle), "codex payload lacks {needle}: {text}");
    }
    let ch = launch.codex_home.clone();
    assert!(ch.join("skills").join("gate-skill").join("SKILL.md").is_file(), "skill rune not in CODEX_HOME");
    // Codex loads agents as TOML roles: an `.md` agent rune lands derived (`copies::derive_roles`).
    let role = read(&ch.join("agents").join("gate-agent.toml"));
    assert!(role.contains("GATE-AGENT-GATE-AGENT"), "agent rune not in CODEX_HOME as a role: {role}");
    let hooks = read(&ch.join("hooks.json"));
    assert!(hooks.contains("gate-hook-run") && hooks.contains("gate-notify.mjs"), "hook runes not in hooks.json: {hooks}");
    assert!(read(&ch.join("config.toml")).contains("mcp_servers.vidar_drive"), "mcp rune not in config.toml");
    let w = codex_warnings(&launch);
    assert!(w.contains("gate-permission") && w.contains("roster"), "Codex must warn mode and plugin unsupported: {w}");
    let mut launch = launch;
    let m = launch.write_manifest("s-cx-kinds", ["Path"]).unwrap();
    assert!(!read(&m).contains("sk-secret-1"), "a hook command reached the manifest");
    drop(launch);

    for (id, check) in [("vidar-drive", "mcp"), ("gate-skill", "skill"), ("gate-hook-command", "hook")] {
        let v = fx.store().edit(&full.id, &[Op::RemoveRune(base_ref(id))], EditMode::Variant).unwrap();
        let home = fx.home(&format!("codex-{check}"));
        let _l = fx.codex(&home, &v.id).unwrap();
        let ch = _l.codex_home.clone();
        let present = match check {
            "mcp" => read(&ch.join("config.toml")).contains("mcp_servers.vidar_drive"),
            "skill" => ch.join("skills").join("gate-skill").is_dir(),
            "hook" => read(&ch.join("hooks.json")).contains("gate-notify.mjs"),
            _ => unreachable!(),
        };
        assert!(!present, "codex {check}: rune {id} still reached a session on a variant without it");
    }
}

// ---- restart and re-adopt (L1b record, L2a writes, L3a lookup) ----

#[test]
fn a_hosted_session_still_shows_its_original_vault_after_a_variant_and_a_new_tab() {
    let fx = Fx::new("readopt");
    let v = full_vault(&fx, "Gate Readopt");
    let mut launch = fx.hosted(&fx.home("hosted"), &v.id).unwrap();
    launch.write_manifest("t1-tab", "s-gate-0001", ["Path"]).unwrap();
    drop(launch);
    let variant = fx.store().edit(&v.id, &[Op::RemoveRune(base_ref("gate-skill"))], EditMode::Variant).unwrap();
    assert_ne!(variant.id, v.id);
    // A restart re-reads from disk; the re-adopted tab has a new id but the same Falcon session.
    let r = session::find(fx.root(), "t2-tab", Some("s-gate-0001"), None).unwrap().expect("record by falconSession");
    assert_eq!((r.vault.id.as_str(), r.vault.hash.as_str()), (v.id.as_str(), v.hash.as_str()));
    let shown = fx.store().load_at(&r.vault.id, &r.vault.hash).unwrap();
    assert!(shown.runes.contains(&base_ref("gate-skill")), "the view shows the vault the session loaded");
}

#[test]
fn a_codex_hosted_session_keeps_its_vault_across_re_adopt() {
    let fx = Fx::new("readopt-codex");
    let v = full_vault(&fx, "Gate Codex Readopt");
    let cwd = fx.t.0.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    mock_hooks_list();
    let mut launch = codex_hosted::prepare_codex_hosted_with(
        "bare", fx.root(), &fx.home("cx"), inherited(), &Ambient::default(), &guard(), &fake_find,
        &LaunchOpts { vault: Some(&v.id), ..LaunchOpts::default() }, &cwd.to_string_lossy(),
    )
    .unwrap();
    launch.write_manifest("t1-cx", "s-gate-cx01", ["Path"]).unwrap();
    drop(launch);
    fx.store().edit(&v.id, &[Op::RemoveRune(base_ref("vidar-drive"))], EditMode::Variant).unwrap();
    let r = session::find(fx.root(), "t2-cx", Some("s-gate-cx01"), None).unwrap().expect("record");
    assert_eq!((r.vault.id.as_str(), r.vault.hash.as_str(), r.agent.as_str()), (v.id.as_str(), v.hash.as_str(), "codex"));
}

// ---- lock (L1a store, L3a send-path lock) ----

#[test]
fn a_pre_lock_edit_changes_the_hash_and_lock_refuses_a_stale_session_hash() {
    // D-d: lock pins the session's hash; a mismatch refuses.
    let fx = Fx::new("lock");
    let v = full_vault(&fx, "Gate Lock");
    let edited = fx.store().edit(&v.id, &[Op::RemoveRune(base_ref("gate-agent"))], EditMode::Unlocked).unwrap();
    assert_eq!(edited.id, v.id, "an unlocked edit stays on the vault");
    assert_ne!(edited.hash, v.hash);
    let e = fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).err().unwrap();
    assert!(e.contains("hash"), "{e}");
    let locked = fx.store().lock(&v.id, LockedBy::FirstMessage, &edited.hash).unwrap();
    assert_eq!(locked.hash, edited.hash, "lock is outside the hash");
    assert_eq!(locked.locked_by, Some(LockedBy::FirstMessage));
    assert!(locked.locked_utc.is_some() && !locked.pins.is_empty());
    let again = fx.store().lock(&v.id, LockedBy::Button, &edited.hash).unwrap();
    assert_eq!(again.locked_by, Some(LockedBy::FirstMessage), "lock is idempotent; the first lock stands");
    // After lock: no silent edit; a variant or an invalidating edit only (R3).
    assert!(fx.store().edit(&v.id, &[Op::AddRune(base_ref("gate-agent"))], EditMode::Unlocked).is_err());
    let var = fx.store().edit(&v.id, &[Op::AddRune(base_ref("gate-agent"))], EditMode::Variant).unwrap();
    assert!(matches!(&var.from, Some(VaultFrom::Vault { vault, hash }) if vault == &v.id && hash == &edited.hash));
    assert!(var.locked_utc.is_none(), "a variant starts unlocked");
    let inv = fx.store().edit(&v.id, &[Op::AddRune(base_ref("gate-agent"))], EditMode::Invalidate).unwrap();
    assert_eq!(inv.id, v.id);
    assert!(fx.store().load_at(&v.id, &edited.hash).is_ok(), "the invalidated revision stays readable in revs/");
}

#[test]
fn a_locked_vault_resolves_its_copied_body_after_a_library_edit_and_reports_drift() {
    // D-e: lock copies resolved bodies into revs/<hash>/; drift is a hash compare at read.
    let fx = Fx::new("drift");
    let v = full_vault(&fx, "Gate Drift");
    fx.store().lock(&v.id, LockedBy::Button, &v.hash).unwrap();
    fx.edit_rune("installed", "rules", "team-verdict-first", "---\nname: team-verdict-first\nkind: rule\nscope: [global]\ndescription: Team rule one\n---\nEDITED-AFTER-LOCK\n");
    let r = fx.store().resolve(&v.id).unwrap();
    let body = &r.runes.iter().find(|x| x.library == "installed" && x.id == "team-verdict-first").unwrap().body;
    assert!(body.contains("GATE-RULE-TEAM-VERDICT-FIRST") && !body.contains("EDITED-AFTER-LOCK"), "{body}");
    assert_eq!(r.drift, vec![RuneRef { library: "installed".into(), id: "team-verdict-first".into() }]);
    let seen = claude_seen(&fx, "drift", &v.id);
    assert!(seen.payload.contains("GATE-RULE-TEAM-VERDICT-FIRST") && !seen.payload.contains("EDITED-AFTER-LOCK"));
}

#[test]
fn recall_members_of_a_locked_vault_come_only_from_its_pins() {
    let fx = Fx::new("recall-pins");
    let v = full_vault(&fx, "Gate Recall");
    let locked = fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    assert!(locked.pins.contains_key("installed/team-recall-tip"));
    fx.edit_rune("installed", "procedures", "team-recall-late", "---\nname: team-recall-late\nkind: procedure\nscope: [global]\nactivate: recall\ndescription: Added after lock\n---\nGATE-PROCEDURE-TEAM-RECALL-LATE\n");
    let r = fx.store().resolve(&v.id).unwrap();
    assert!(r.runes.iter().any(|x| x.id == "team-recall-tip" && x.recall));
    assert!(!r.runes.iter().any(|x| x.id == "team-recall-late"), "a recall rune added after lock joined a locked vault");
    assert!(!claude_seen(&fx, "recall", &v.id).payload.contains("team-recall-late"));
}

// ---- adopt, Custom, cross-library (L3a adopt, L1a Custom, L1d slots) ----

#[test]
fn adopt_with_no_record_builds_or_reuses_a_vault_from_the_echoed_sets() {
    // D-g: a running session never gets the vault pick; the record is written at adopt.
    let fx = Fx::new("adopt");
    assert!(session::find(fx.root(), "t-old", Some("s-old-0001"), None).unwrap().is_none());
    let a = session::adopt(fx.root(), "claude", "t-old", "s-old-0001", &[installed_set()]).unwrap();
    let b = session::adopt(fx.root(), "claude", "t-old2", "s-old-0002", &[installed_set()]).unwrap();
    assert_ne!(a.vault.id, b.vault.id, "each adopted session starts its own copy");
    assert_eq!(a.vault.hash, b.vault.hash);
    let r = session::find(fx.root(), "t-other", Some("s-old-0001"), None).unwrap().expect("adopt wrote the record");
    assert_eq!(r.vault, a.vault);
    let v = fx.store().get(&a.vault.id).unwrap();
    assert_eq!(v.runesets.iter().map(|s| s.source.clone()).collect::<Vec<_>>(), vec![super::vault::vidar::source(), installed_set()]);
}

#[test]
fn identical_custom_picks_give_two_vaults() {
    // Runes Q1 = a: every pick starts `copy-<utc>-<hex>`; none is reused.
    let fx = Fx::new("custom");
    let a = super::vault::create_at(fx.root(), None, None, &[installed_set()], &[]).unwrap();
    let b = super::vault::create_at(fx.root(), None, None, &[installed_set()], &[]).unwrap();
    assert_ne!(a.id, b.id);
    assert_eq!(a.hash, b.hash, "a copy shares its source's content hash");
    assert!(a.id.starts_with("copy-"), "{}", a.id);
    let c = super::vault::create_at(fx.root(), None, None, &[installed_set()], &[base_ref("gate-skill")]).unwrap();
    assert_ne!(c.hash, a.hash);
}

#[test]
fn a_cross_library_slot_resolves_against_its_named_library() {
    // D-h: `<?rune base/gate-fact?>` in installed's set.
    let fx = Fx::new("cross-lib");
    let v = super::vault::create_at(fx.root(), Some("Gate Installed Only".into()), None, &[installed_set()], &[base_ref("bare-identity")]).unwrap();
    assert!(v.runesets[1].file.ends_with("installed--installed.md"), "the Vidar Runeset is first");
    let seen = claude_seen(&fx, "cross", &v.id);
    assert!(seen.payload.contains("gate-fact.md") && seen.recall.contains("GATE-FACT-GATE-FACT"), "{}", seen.payload);
    // The snapshot is a dated copy: editing the library set later does not reach the vault.
    fx.edit_rune("installed", "sets", "installed", "---\nname: installed\nkind: set\nscope: [global]\n---\n- <?rune team-plain-words?>\n");
    let again = claude_seen(&fx, "cross-again", &v.id);
    assert!(again.payload.contains("gate-fact.md") && again.recall.contains("GATE-FACT-GATE-FACT"), "the vault's runeset copy followed its original");
}
