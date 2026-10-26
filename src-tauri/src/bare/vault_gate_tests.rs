//! src-tauri\src\bare\vault_gate_tests.rs — the Rune Vault acceptance gate (run 2026-10-25-rune-vault, wave 0).
//! Contract: `docs/projects/bare/runeset-model.md` § Gate, R2, R3, R4, R6. Compiled only under
//! `--features vault-gate` because it calls the vault API later lanes add; the run ends when
//! `cargo test --features vault-gate -- vault_gate_tests` is green. Each test names the lane that turns it green.
//!
//! Fixtures (the wire formats): `tests/fixtures/rune-vault/` — `stock-runes/` (one rune per kind, the
//! `stock` library), `kit/` (an import library whose set `kit` slots two own runes, one
//! cross-library `stock/gate-fact` and `<?recall?>`), `vaults/` (vault.json v1 unlocked and locked
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

/// A temp root: the shipped `profiles\bare` and the two Vidar plugins, the fixture `stock` runes
/// merged into the stock library, `kit` as an import library, and the fixture skill/agent/hook sources.
struct Fx {
    t: TempDir,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let t = TempDir::new(tag);
        let real = crate::paths::root();
        copy_dir(&real.join("profiles").join("bare"), &t.0.join("profiles").join("bare"));
        for name in ["vidar-app", "gate"] {
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
        copy_dir(&fixture().join("stock-runes"), &crate::paths::rune_stock_dir_in(&t.0));
        copy_dir(&fixture().join("kit"), &crate::paths::rune_imports_dir_in(&t.0).join("kit"));
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
        let dir = if lib == "stock" { crate::paths::rune_stock_dir_in(self.root()) } else { crate::paths::rune_imports_dir_in(self.root()).join(lib) };
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

fn stock(id: &str) -> RuneRef {
    RuneRef { library: "stock".into(), id: id.into() }
}

fn kit_set() -> SetSource {
    SetSource { library: "kit".into(), set: "kit".into() }
}

/// Every stock rune in the fixture, one per kind (the fact arrives through kit's cross-library slot).
const ALL_ONE_OFFS: &[&str] = &[
    "bare-identity", "gate-recall", "gate-skill", "gate-agent", "gate-hook-run", "gate-hook-command", "vidar-drive", "gate-permission", "vidar-app",
];

/// The bundle catalog the Claude every-kind case writes: one command-form server for the Claude
/// MCP rune `fixture-echo` (no url, no env, no secret).
const CLAUDE_ECHO_CATALOG: &str = r#"{"version":1,"bundles":{"fixture-echo":{"mcp":[{"name":"fixture_echo","stdio":{"command":"node","args":["fixture-echo.mjs"],"envFrom":[]},"agents":["claude"],"reads":[]}],"skills":[],"agents":[],"guards":[]}}}"#;

fn full_vault(fx: &Fx, name: &str) -> Vault {
    let runes: Vec<RuneRef> = ALL_ONE_OFFS.iter().map(|id| stock(id)).collect();
    fx.store().create(name, None, &[kit_set()], &runes).unwrap()
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
    // spawn line name `mcp__plugin_vidar_drive` through the `drive-allow` permission rune either way.
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
    assert!(locked.pins.contains_key("kit/kit-recall-tip"), "a recall member is pinned at lock");
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
    // A command-form Claude server with no secrets, for the Claude MCP rune `fixture-echo`. On
    // Claude the drive server comes from the `vidar-app` plugin rune; `vidar-drive` is Codex's.
    let catalog = fx.root().join("contracts").join("module-bundles.json");
    std::fs::create_dir_all(catalog.parent().unwrap()).unwrap();
    std::fs::write(&catalog, CLAUDE_ECHO_CATALOG).unwrap();
    let mut runes: Vec<RuneRef> = ALL_ONE_OFFS.iter().map(|id| stock(id)).collect();
    runes.push(stock("fixture-echo"));
    let full = fx.store().create("Gate Full", None, &[kit_set()], &runes).unwrap();
    let seen = claude_seen(&fx, "full", &full.id);
    for needle in ["GATE-RULE-BARE-IDENTITY", "GATE-RULE-KIT-VERDICT-FIRST", "gate-recall", "kit-recall-tip"] {
        assert!(seen.payload.contains(needle), "payload lacks {needle}: {}", seen.payload);
    }
    // The fact is recall-activated: its pointer in the payload, its body in the session's on-demand skill.
    assert!(seen.payload.contains("gate-fact.md") && seen.recall.contains("GATE-FACT-GATE-FACT"), "fact not delivered: {}", seen.payload);
    assert!(seen.skill, "skill rune not copied into the session's config dir");
    assert!(seen.agent, "agent rune not copied into the session's config dir");
    assert!(seen.settings.contains("gate-hook-run"), "run-list hook not in settings.json");
    assert!(seen.mcp.contains("fixture_echo"), "mcp rune fixture-echo not delivered: {}", seen.mcp);
    assert!(seen.mcp.contains("plugin_vidar_drive"), "the vidar-app plugin rune's drive server not delivered: {}", seen.mcp);
    assert!(seen.settings.contains("mcp__plugin_vidar_drive"), "permission allow list not in settings.json");
    assert!(seen.settings.contains("mcp__gate_write"), "permission ask list not in settings.json");
    assert!(seen.line.contains("'--permission-mode' 'auto'"), "permission mode not on the spawn line: {}", seen.line);
    assert!(seen.line.contains("plugins\\vidar-app"), "plugin rune not passed by path: {}", seen.line);
    assert!(seen.warnings.contains("gate-hook-command"), "a Codex-only rune warns on Claude, never barred: {}", seen.warnings);

    // One variant per kind, each dropping that kind's rune; the rest stays.
    let drops: &[(&str, &str)] = &[
        ("bare-identity", "identity"),
        ("gate-recall", "recall"),
        ("gate-skill", "skill"),
        ("gate-agent", "agent"),
        ("gate-hook-run", "hook"),
        ("fixture-echo", "mcp"),
        ("gate-permission", "permission"),
        ("vidar-app", "plugin"),
    ];
    for (id, kind) in drops {
        let v = fx.store().edit(&full.id, &[Op::RemoveRune(stock(id))], EditMode::Variant).unwrap();
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
            // The plugin rune carries the drive server on Claude: both go with it (R1).
            "plugin" => s.line.contains("plugins\\vidar-app") || s.line.contains("--plugin-dir") || s.mcp.contains("vidar_drive"),
            _ => unreachable!(),
        };
        assert!(!present, "{kind}: rune {id} still reached a session on a variant without it");
        assert!(s.payload.contains("GATE-RULE-KIT-VERDICT-FIRST"), "{kind}: the variant lost an unrelated rune");
    }
    // Rule and fact ride a runeset: dropping the runeset drops them.
    let no_kit = fx.store().edit(&full.id, &[Op::RemoveRuneset(kit_set())], EditMode::Variant).unwrap();
    let s = claude_seen(&fx, "no-kit", &no_kit.id);
    assert!(!s.payload.contains("GATE-RULE-KIT-VERDICT-FIRST") && !s.payload.contains("GATE-FACT-GATE-FACT") && !s.payload.contains("gate-fact.md"), "{}", s.payload);
    // Dropping a `required-by: vidar` rune warns, never bars (identity also refuses an empty payload: L2b).
    let no_id = fx.store().edit(&full.id, &[Op::RemoveRune(stock("bare-identity"))], EditMode::Variant).unwrap();
    let s = claude_seen(&fx, "no-identity", &no_id.id);
    assert!(s.warnings.contains("bare-identity"), "{}", s.warnings);
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
    for needle in ["GATE-RULE-BARE-IDENTITY", "GATE-RULE-KIT-VERDICT-FIRST", "gate-fact.md", "gate-recall"] {
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
    assert!(w.contains("gate-permission") && w.contains("vidar-app"), "Codex must warn mode and plugin unsupported: {w}");
    let mut launch = launch;
    let m = launch.write_manifest("s-cx-kinds", ["Path"]).unwrap();
    assert!(!read(&m).contains("sk-secret-1"), "a hook command reached the manifest");
    drop(launch);

    for (id, check) in [("vidar-drive", "mcp"), ("gate-skill", "skill"), ("gate-hook-command", "hook")] {
        let v = fx.store().edit(&full.id, &[Op::RemoveRune(stock(id))], EditMode::Variant).unwrap();
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
    let variant = fx.store().edit(&v.id, &[Op::RemoveRune(stock("gate-skill"))], EditMode::Variant).unwrap();
    assert_ne!(variant.id, v.id);
    // A restart re-reads from disk; the re-adopted tab has a new id but the same Falcon session.
    let r = session::find(fx.root(), "t2-tab", Some("s-gate-0001"), None).unwrap().expect("record by falconSession");
    assert_eq!((r.vault.id.as_str(), r.vault.hash.as_str()), (v.id.as_str(), v.hash.as_str()));
    let shown = fx.store().load_at(&r.vault.id, &r.vault.hash).unwrap();
    assert!(shown.runes.contains(&stock("gate-skill")), "the view shows the vault the session loaded");
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
    fx.store().edit(&v.id, &[Op::RemoveRune(stock("vidar-drive"))], EditMode::Variant).unwrap();
    let r = session::find(fx.root(), "t2-cx", Some("s-gate-cx01"), None).unwrap().expect("record");
    assert_eq!((r.vault.id.as_str(), r.vault.hash.as_str(), r.agent.as_str()), (v.id.as_str(), v.hash.as_str(), "codex"));
}

// ---- lock (L1a store, L3a send-path lock) ----

#[test]
fn a_pre_lock_edit_changes_the_hash_and_lock_refuses_a_stale_session_hash() {
    // D-d: lock pins the session's hash; a mismatch refuses.
    let fx = Fx::new("lock");
    let v = full_vault(&fx, "Gate Lock");
    let edited = fx.store().edit(&v.id, &[Op::RemoveRune(stock("gate-agent"))], EditMode::Unlocked).unwrap();
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
    assert!(fx.store().edit(&v.id, &[Op::AddRune(stock("gate-agent"))], EditMode::Unlocked).is_err());
    let var = fx.store().edit(&v.id, &[Op::AddRune(stock("gate-agent"))], EditMode::Variant).unwrap();
    assert!(matches!(&var.from, Some(VaultFrom::Vault { vault, hash }) if vault == &v.id && hash == &edited.hash));
    assert!(var.locked_utc.is_none(), "a variant starts unlocked");
    let inv = fx.store().edit(&v.id, &[Op::AddRune(stock("gate-agent"))], EditMode::Invalidate).unwrap();
    assert_eq!(inv.id, v.id);
    assert!(fx.store().load_at(&v.id, &edited.hash).is_ok(), "the invalidated revision stays readable in revs/");
}

#[test]
fn a_locked_vault_resolves_its_copied_body_after_a_library_edit_and_reports_drift() {
    // D-e: lock copies resolved bodies into revs/<hash>/; drift is a hash compare at read.
    let fx = Fx::new("drift");
    let v = full_vault(&fx, "Gate Drift");
    fx.store().lock(&v.id, LockedBy::Button, &v.hash).unwrap();
    fx.edit_rune("kit", "rules", "kit-verdict-first", "---\nname: kit-verdict-first\nkind: rule\nscope: [global]\ndescription: Kit rule one\n---\nEDITED-AFTER-LOCK\n");
    let r = fx.store().resolve(&v.id).unwrap();
    let body = &r.runes.iter().find(|x| x.library == "kit" && x.id == "kit-verdict-first").unwrap().body;
    assert!(body.contains("GATE-RULE-KIT-VERDICT-FIRST") && !body.contains("EDITED-AFTER-LOCK"), "{body}");
    assert_eq!(r.drift, vec![RuneRef { library: "kit".into(), id: "kit-verdict-first".into() }]);
    let seen = claude_seen(&fx, "drift", &v.id);
    assert!(seen.payload.contains("GATE-RULE-KIT-VERDICT-FIRST") && !seen.payload.contains("EDITED-AFTER-LOCK"));
}

#[test]
fn recall_members_of_a_locked_vault_come_only_from_its_pins() {
    let fx = Fx::new("recall-pins");
    let v = full_vault(&fx, "Gate Recall");
    let locked = fx.store().lock(&v.id, LockedBy::FirstMessage, &v.hash).unwrap();
    assert!(locked.pins.contains_key("kit/kit-recall-tip"));
    fx.edit_rune("kit", "procedures", "kit-recall-late", "---\nname: kit-recall-late\nkind: procedure\nscope: [global]\nactivate: recall\ndescription: Added after lock\n---\nGATE-PROCEDURE-KIT-RECALL-LATE\n");
    let r = fx.store().resolve(&v.id).unwrap();
    assert!(r.runes.iter().any(|x| x.id == "kit-recall-tip" && x.recall));
    assert!(!r.runes.iter().any(|x| x.id == "kit-recall-late"), "a recall rune added after lock joined a locked vault");
    assert!(!claude_seen(&fx, "recall", &v.id).payload.contains("kit-recall-late"));
}

// ---- adopt, Custom, cross-library (L3a adopt, L1a Custom, L1d slots) ----

#[test]
fn adopt_with_no_record_builds_or_reuses_a_vault_from_the_echoed_sets() {
    // D-g: a running session never gets the vault pick; the record is written at adopt.
    let fx = Fx::new("adopt");
    assert!(session::find(fx.root(), "t-old", Some("s-old-0001"), None).unwrap().is_none());
    let a = session::adopt(fx.root(), "claude", "t-old", "s-old-0001", &[kit_set()]).unwrap();
    let b = session::adopt(fx.root(), "claude", "t-old2", "s-old-0002", &[kit_set()]).unwrap();
    assert_eq!(a.vault, b.vault, "identical echoed sets reuse one vault by content hash");
    let r = session::find(fx.root(), "t-other", Some("s-old-0001"), None).unwrap().expect("adopt wrote the record");
    assert_eq!(r.vault, a.vault);
    let v = fx.store().get(&a.vault.id).unwrap();
    assert_eq!(v.runesets.iter().map(|s| s.source.clone()).collect::<Vec<_>>(), vec![kit_set()]);
}

#[test]
fn an_identical_custom_pick_reuses_its_vault() {
    // D-i: id `custom-<content hash6>`.
    let fx = Fx::new("custom");
    let a = fx.store().create_custom(&[kit_set()], &[]).unwrap();
    let b = fx.store().create_custom(&[kit_set()], &[]).unwrap();
    assert_eq!(a.id, b.id);
    assert!(a.id.starts_with("custom-") && a.id.len() == "custom-".len() + 6, "{}", a.id);
    let c = fx.store().create_custom(&[kit_set()], &[stock("gate-skill")]).unwrap();
    assert_ne!(c.id, a.id);
    assert_eq!(fx.store().list().unwrap().iter().filter(|v| v.id.starts_with("custom-")).count(), 2);
}

#[test]
fn a_cross_library_slot_resolves_against_its_named_library() {
    // D-h: `<?rune stock/gate-fact?>` in kit's set.
    let fx = Fx::new("cross-lib");
    let v = fx.store().create("Gate Kit Only", None, &[kit_set()], &[stock("bare-identity")]).unwrap();
    assert!(v.runesets[0].file.ends_with("kit--kit.md"));
    let seen = claude_seen(&fx, "cross", &v.id);
    assert!(seen.payload.contains("gate-fact.md") && seen.recall.contains("GATE-FACT-GATE-FACT"), "{}", seen.payload);
    // The snapshot is a dated copy: editing the library set later does not reach the vault.
    fx.edit_rune("kit", "sets", "kit", "---\nname: kit\nkind: set\nscope: [global]\n---\n- <?rune kit-plain-words?>\n");
    let again = claude_seen(&fx, "cross-again", &v.id);
    assert!(again.payload.contains("gate-fact.md") && again.recall.contains("GATE-FACT-GATE-FACT"), "the vault's runeset copy followed its original");
}
