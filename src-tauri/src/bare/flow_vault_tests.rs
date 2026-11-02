//! src-tauri\src\bare\flow_vault_tests.rs — a Flow agent node loads its own Rune Vault (FV1).
//! Every vault lives in a temp store root (`TEST_VAULT_ROOT`); profiles come from the checkout and
//! every home is a temp folder.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::*;
use crate::agent_spec::{self, Agent};
use crate::bare::vault::store::Store;
use crate::bare::vault::RuneRef;
use crate::bare::{admit_hosted, Ambient, CodexBinary, CodexProbes, Probes};

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const CLAUDE: Agent = Agent::Claude;
const CODEX: Agent = Agent::Codex;
const TAB: &str = "flow:r1:n1";

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

fn vidar_ref(id: &str) -> RuneRef {
    RuneRef { library: "vidar".into(), id: id.into() }
}

fn perm_rune(id: &str, body: &str) -> String {
    format!("---\nname: {id}\nkind: permission\nscope: [global]\n{body}description: Test permission\n---\n")
}

/// A temp store root: a copy of the shipped Vidar library plus `perm-mcp` (a Codex-carried `mcp__`
/// entry and a Claude-only one), and the thread's store pointed at it.
fn root(tag: &str) -> Root {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let p = std::env::temp_dir().join(format!("vidar-fv1-{tag}-{}-{nanos}", std::process::id()));
    let vidar = crate::paths::rune_vidar_dir_in(&p);
    copy_dir(&crate::paths::rune_vidar_dir_in(&crate::paths::root()), &vidar);
    std::fs::write(vidar.join("permissions").join("perm-mcp.md"), perm_rune("perm-mcp", "allow:\n  - mcp__x__y\n  - Bash(ls)\n")).unwrap();
    // The shipped Vidar set is swapped for one required rune, so a node's payload holds only what the test adds.
    crate::bare::vault::vidar::seed_core(&p);
    vault_spawn::TEST_VAULT_ROOT.with(|r| *r.borrow_mut() = Some(p.clone()));
    Root(p)
}

fn custom(r: &Root, runes: &[&str]) -> String {
    let refs: Vec<RuneRef> = runes.iter().map(|i| vidar_ref(i)).collect();
    crate::bare::vault::create_at(&r.0, Some(format!("Pick {}", runes.join(" "))), None, &[], &refs).unwrap().id
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
    Some((PathBuf::from(r"X:\npm\node_modules\@openai\codex\bin\codex.js"), Some(crate::bare::pinned("codex"))))
}

/// The Claude node for `vault` on a temp home: the hosted prepare and its sidecar inputs. `between`
/// runs after the prepare and before the lock, where an edit can land.
fn claude_between(r: &Root, vault: &str, between: impl FnOnce()) -> Result<ClaudeNode, String> {
    admit_hosted(PROFILE, None, None)?;
    let home_dir = r.0.join("home");
    let probes = Probes { find: &|_, _| None, version: &|_, _| None, remote_control: &|| false };
    let opts = LaunchOpts { vault: Some(vault), ..Default::default() };
    let hash = loaded_hash(&crate::paths::root(), vault)?;
    let launch = super::super::prepare_hosted_with(PROFILE, &crate::paths::root(), &home_dir, inherited(), &Ambient::default(), &guard(), &probes, &opts)?;
    between();
    finish_claude(launch, &crate::paths::root(), &home_dir, inherited(), vault, &hash, TAB)
}

fn claude(r: &Root, vault: &str) -> Result<ClaudeNode, String> {
    claude_between(r, vault, || {})
}

fn codex_between(r: &Root, vault: &str, between: impl FnOnce()) -> Result<CodexNode, String> {
    let home_dir = r.0.join("home");
    let cwd = r.0.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let probes = CodexProbes { find: &fake_find, codex: &codex_ok };
    let opts = LaunchOpts { vault: Some(vault), ..Default::default() };
    let hash = loaded_hash(&crate::paths::root(), vault)?;
    let launch = super::super::prepare_codex_in(PROFILE, &crate::paths::root(), &home_dir, inherited(), &Ambient::default(), &guard(), &probes, &opts, Some(&cwd.to_string_lossy()))?;
    between();
    finish_codex(launch, &crate::paths::root(), vault, &hash, TAB)
}

fn codex(r: &Root, vault: &str) -> Result<CodexNode, String> {
    codex_between(r, vault, || {})
}

/// A global rule rune in the temp Vidar library, for either agent.
fn write_rule(r: &Root, id: &str, text: &str) {
    let body = format!("---\nname: {id}\nkind: rule\nscope: [global]\ndescription: Test rule\n---\n{text}\n");
    std::fs::write(crate::paths::rune_vidar_dir_in(&r.0).join("rules").join(format!("{id}.md")), body).unwrap();
}

/// Adds a rune to an unlocked vault: the vault's hash moves.
fn add_rune(r: &Root, vault: &str, id: &str) {
    use crate::bare::vault::store::{EditMode, Op};
    Store::open(&r.0).edit(vault, &[Op::AddRune(vidar_ref(id))], EditMode::Unlocked).unwrap();
}

fn payload_text(n: &ClaudeNode) -> String {
    let i = n.args.iter().position(|a| a == "--payload").unwrap_or_else(|| panic!("no --payload: {:?}", n.args));
    std::fs::read_to_string(&n.args[i + 1]).unwrap()
}

#[test]
fn a_node_with_no_vault_refuses() {
    let r = root("unset");
    for agent in [CLAUDE, CODEX] {
        for unset in [None, Some("  ")] {
            assert_eq!(approve(&r.0, agent, unset, None).unwrap_err(), "Pick a Rune Vault for this node.");
        }
    }
    assert_eq!(vault_id(Some(" mine ")).unwrap(), "mine");
    assert!(approve(&r.0, CLAUDE, Some("base-main"), None).unwrap_err().contains("Unknown Vault"), "a base id is no vault");
    assert!(Store::open(&r.0).list().unwrap().is_empty(), "a refused node wrote no vault");
}

#[test]
fn an_unknown_vault_refuses() {
    let r = root("unknown");
    let e = approve(&r.0, CLAUDE, Some("nope"), None).unwrap_err();
    assert!(e.contains("Unknown Vault"), "{e}");
}

#[test]
fn a_hash_mismatch_refuses_and_a_match_or_none_passes() {
    let r = root("hash");
    let v = custom(&r, &["bare-identity"]);
    let hash = approve(&r.0, CLAUDE, Some(&v), None).unwrap().perms.hash;
    assert!(approve(&r.0, CLAUDE, Some(&v), Some(&hash)).is_ok());
    let e = approve(&r.0, CLAUDE, Some(&v), Some("000000000000")).unwrap_err();
    assert!(e.contains("Vault Changed Since Approval"), "{e}");
    // Another node on another vault is unaffected.
    let w = custom(&r, &["perm-mcp"]);
    assert!(approve(&r.0, CLAUDE, Some(&w), None).is_ok());
}

#[test]
fn the_spec_names_the_vault_home_with_no_payload_flag_or_mcp_servers() {
    let r = root("claude");
    let v = custom(&r, &["bare-identity"]);
    let n = claude(&r, &v).unwrap();
    let home_dir = r.0.join("home");
    assert_eq!(n.args[..4], ["--flow", "--profile", "bare", "--root"]);
    let at = |flag: &str| n.args.iter().position(|a| a == flag).map(|i| n.args[i + 1].clone());
    assert_eq!(at("--home"), Some(home_dir.to_string_lossy().into_owned()));
    assert_eq!(at("--root"), Some(crate::paths::root().to_string_lossy().into_owned()));
    assert!(at("--mcp-file").is_some_and(|f| Path::new(&f).starts_with(&home_dir)), "{:?}", n.args);
    assert!(!n.args.iter().any(|a| a == "--flow-payload" || a == "--mcp-servers"), "{:?}", n.args);
    assert!(n.config_dir.starts_with(&home_dir), "{}", n.config_dir.display());
    assert_eq!(n.env.get("CLAUDE_CONFIG_DIR"), Some(n.config_dir.as_os_str()));
    // The node locked its vault at spawn, and the launch is recorded.
    assert!(Store::open(&r.0).get(&v).unwrap().locked_utc.is_some());
    assert!(std::fs::read_dir(home_dir.join("manifests")).unwrap().count() >= 1);
}

#[test]
fn a_gateway_node_loads_the_vault_through_admit_hosted() {
    assert!(admit_hosted(PROFILE, None, None).is_ok());
    assert!(admit_hosted("lean", None, None).unwrap_err().contains("Unknown launch profile"));
    // A gateway model has no login in the home, and still gets the vault's argv.
    let r = root("gateway");
    let v = custom(&r, &["bare-identity"]);
    let n = claude(&r, &v).unwrap();
    assert!(!n.config_dir.join(".credentials.json").exists());
    assert!(n.args.iter().any(|a| a == "--home"));
}

#[test]
fn a_codex_node_drops_a_claude_only_allow_with_a_warning_and_spawns() {
    let r = root("codex");
    let v = custom(&r, &["bare-identity", "perm-mcp"]);
    let a = approve(&r.0, CODEX, Some(&v), None).unwrap();
    assert_eq!(a.perms.allow, ["mcp__x__y"], "the Claude-only entry is gone");
    let w = dropped_allow_warning(&r.0, CODEX, &v).expect("a warning");
    assert!(w.contains("Codex has no per-tool list") && w.contains("dropped for this node") && w.contains(&v), "{w}");
    assert_eq!(dropped_allow_warning(&r.0, CLAUDE, &v), None, "Claude carries both");

    let n = codex(&r, &v).unwrap();
    assert_eq!(n.node, PathBuf::from(r"X:\bin\node.exe"));
    assert!(n.js.ends_with("codex.js"), "{}", n.js.display());
    assert_eq!(n.args[..2], ["-c", "sandbox_workspace_write.network_access=true"]);
    assert!(!n.args.iter().any(|a| a == "app-server"), "the adapter adds the subcommand: {:?}", n.args);
    assert_eq!(n.ctl_token, None, "no ctl rune, no token");
    assert!(n.env.get("VIDAR_CTL_TOKEN").is_none());
    assert!(n.instructions.as_deref().is_some_and(|t| !t.trim().is_empty()), "the vault's runes ride thread/start");
    assert!(n.home.starts_with(r.0.join("home")), "{}", n.home.display());
    assert!(Store::open(&r.0).get(&v).unwrap().locked_utc.is_some());
}

#[test]
fn one_vaults_failure_does_not_fail_another_nodes_vault() {
    let r = root("pair");
    let (good, _) = (custom(&r, &["bare-identity"]), ());
    // A vault that is not there fails its own node only.
    assert!(approve(&r.0, CLAUDE, Some("gone"), None).is_err());
    assert!(approve(&r.0, CLAUDE, Some(&good), None).is_ok());
    assert!(claude(&r, &good).is_ok());
    let _ = agent_spec::ALL;
}

#[test]
fn an_unlocked_edit_between_prepare_and_lock_refuses_and_the_node_does_not_spawn() {
    let r = root("race-claude");
    let v = custom(&r, &["bare-identity"]);
    let e = claude_between(&r, &v, || add_rune(&r, &v, "perm-mcp")).unwrap_err();
    assert!(e.contains("lock refused") && e.contains("Bare spawn refused"), "{e}");
    assert!(Store::open(&r.0).get(&v).unwrap().locked_utc.is_none(), "the vault stays unlocked");

    let w = custom(&r, &["bare-identity"]);
    let e = codex_between(&r, &w, || add_rune(&r, &w, "perm-mcp")).unwrap_err();
    assert!(e.contains("lock refused") && e.contains("Bare spawn refused"), "{e}");
    assert!(Store::open(&r.0).get(&w).unwrap().locked_utc.is_none());
}

#[test]
fn a_second_node_on_a_locked_vault_approves_and_leaves_the_lock_alone() {
    let r = root("share");
    let v = custom(&r, &["bare-identity"]);
    let bound = approve(&r.0, CLAUDE, Some(&v), None).unwrap().perms.hash;
    claude(&r, &v).unwrap();
    let first = Store::open(&r.0).get(&v).unwrap();
    assert!(first.locked_utc.is_some());
    assert_eq!(first.hash, bound, "the lock keeps the hash");
    assert!(approve(&r.0, CLAUDE, Some(&v), Some(&bound)).is_ok(), "approve still passes on the locked vault");
    claude(&r, &v).unwrap();
    let second = Store::open(&r.0).get(&v).unwrap();
    assert_eq!((second.hash, second.locked_utc), (first.hash, first.locked_utc), "the second lock is a no-op");
}

#[test]
fn a_locked_vault_serves_its_pinned_rune_text_after_the_library_edit() {
    let r = root("pinned");
    write_rule(&r, "flow-rule", "PINNED-ORIGINAL-TEXT");
    let v = custom(&r, &["bare-identity", "flow-rule"]);
    assert!(payload_text(&claude(&r, &v).unwrap()).contains("PINNED-ORIGINAL-TEXT"));
    write_rule(&r, "flow-rule", "EDITED-LIBRARY-TEXT");
    let p = payload_text(&claude(&r, &v).unwrap());
    assert!(p.contains("PINNED-ORIGINAL-TEXT") && !p.contains("EDITED-LIBRARY-TEXT"), "{p}");

    let r = root("pinned-codex");
    write_rule(&r, "flow-rule", "PINNED-CODEX-TEXT");
    let w = custom(&r, &["bare-identity", "flow-rule"]);
    let first = codex(&r, &w).unwrap().instructions.unwrap();
    assert!(first.contains("PINNED-CODEX-TEXT"), "{first}");
    write_rule(&r, "flow-rule", "EDITED-LIBRARY-TEXT");
    let t = codex(&r, &w).unwrap().instructions.unwrap();
    assert!(t.contains("PINNED-CODEX-TEXT") && !t.contains("EDITED-LIBRARY-TEXT"), "{t}");
}

#[test]
fn a_rule_rune_rides_the_claude_payload_and_the_codex_instructions() {
    let r = root("rule");
    write_rule(&r, "flow-rule", "RULE-RUNE-TEXT");
    let v = custom(&r, &["bare-identity", "flow-rule"]);
    assert!(payload_text(&claude(&r, &v).unwrap()).contains("RULE-RUNE-TEXT"));
    let w = custom(&r, &["bare-identity", "flow-rule"]);
    assert!(codex(&r, &w).unwrap().instructions.is_some_and(|t| t.contains("RULE-RUNE-TEXT")));
}

#[test]
fn a_plugin_rune_rides_the_claude_argv_as_set_plugin() {
    let r = root("plugin");
    let vidar = crate::paths::rune_vidar_dir_in(&r.0);
    std::fs::write(
        vidar.join("plugins").join("roster.md"),
        "---\nname: roster\nkind: plugin\nscope: [global]\nagent: claude\nsource: {{root}}/plugins/roster\ndescription: Test plugin\n---\n",
    ).unwrap();
    let v = custom(&r, &["bare-identity", "roster"]);
    let n = claude(&r, &v).unwrap();
    let plugin = super::super::plugin_dir(&crate::paths::root(), "roster").unwrap().to_string_lossy().into_owned();
    let i = n.args.iter().position(|a| a == "--set-plugin").unwrap_or_else(|| panic!("{:?}", n.args));
    assert_eq!(n.args[i + 1], plugin);
}

#[test]
fn a_flow_claude_node_mints_a_control_token_only_with_a_ctl_rune() {
    let r = root("ctl-claude");
    let with = custom(&r, &["bare-identity", "vidar-control"]);
    let n = claude(&r, &with).unwrap();
    let token = n.env.get("VIDAR_CTL_TOKEN").map(|t| t.to_string_lossy().into_owned()).expect("a token in the node env");
    assert!(!token.is_empty());
    let without = custom(&r, &["bare-identity"]);
    let n = claude(&r, &without).unwrap();
    assert!(n.env.get("VIDAR_CTL_TOKEN").is_none(), "a vault without a ctl rune gets no token");
}

#[test]
fn a_flow_codex_node_gets_its_control_token_after_resolve_only_with_a_ctl_rune() {
    let r = root("ctl-codex");
    let with = custom(&r, &["bare-identity-codex", "vidar-control"]);
    let n = codex(&r, &with).unwrap();
    let token = n.ctl_token.clone().expect("a token after resolve");
    assert_eq!(n.env.get("VIDAR_CTL_TOKEN").map(|t| t.to_string_lossy().into_owned()), Some(token));
    let without = custom(&r, &["bare-identity-codex"]);
    let n = codex(&r, &without).unwrap();
    assert_eq!(n.ctl_token, None);
    assert!(n.env.get("VIDAR_CTL_TOKEN").is_none());
}

#[test]
fn a_skill_rune_is_copied_into_the_vault_home_not_the_argv() {
    // Skills reach a Flow node through the prepare (`copies::sync_home` into the vault home's config
    // dir), never through `ClaudeNode.args`.
    let r = root("skill");
    let v = custom(&r, &["bare-identity", "vidar-control"]);
    let n = claude(&r, &v).unwrap();
    assert!(n.config_dir.join("skills").join("vidar-control").is_dir(), "{}", n.config_dir.display());
    assert!(!n.args.iter().any(|a| a.contains("vidar-control")), "{:?}", n.args);
}

// ---- Env runes on every Claude surface (Raw, Rendered and Flow share this harness) ----

/// A permission rune carrying one `env` pair, in the temp Vidar library.
fn write_env_rune(r: &Root, id: &str, pair: &str) {
    let body = perm_rune(id, &format!("allow:\n  - Bash(ls)\nenv:\n  - {pair}\n"));
    std::fs::write(crate::paths::rune_vidar_dir_in(&r.0).join("permissions").join(format!("{id}.md")), body).unwrap();
}

/// The Raw Claude prepare for `vault` on the temp home.
fn raw(r: &Root, vault: &str) -> Result<crate::bare::Launch, String> {
    let probes = Probes { find: &fake_find, version: &|_, _| None, remote_control: &|| false };
    let opts = LaunchOpts { vault: Some(vault), ..Default::default() };
    super::super::prepare_with(PROFILE, &crate::paths::root(), &r.0.join("home"), inherited(), &Ambient::default(), &guard(), &probes, &opts)
}

/// The Rendered (Falcon-hosted) Claude prepare for `vault` on the temp home.
fn rendered(r: &Root, vault: &str) -> Result<HostedLaunch, String> {
    let probes = Probes { find: &|_, _| None, version: &|_, _| None, remote_control: &|| false };
    let opts = LaunchOpts { vault: Some(vault), ..Default::default() };
    super::super::prepare_hosted_with(PROFILE, &crate::paths::root(), &r.0.join("home"), inherited(), &Ambient::default(), &guard(), &probes, &opts)
}

#[test]
fn a_loadout_env_pair_reaches_the_raw_and_flow_env_and_the_rendered_spawn_params() {
    let r = root("env-pair");
    write_env_rune(&r, "env-x", "RUNE_X=y");
    let v = custom(&r, &["bare-identity", "env-x"]);
    let launch = raw(&r, &v).unwrap();
    assert_eq!(launch.env.get("RUNE_X"), Some(std::ffi::OsStr::new("y")));
    drop(launch);
    let hosted = rendered(&r, &v).unwrap();
    assert_eq!(hosted.env, [("RUNE_X".to_string(), "y".to_string())], "Rendered hands it to SpawnParams.env");
    drop(hosted);
    let n = claude(&r, &v).unwrap();
    assert_eq!(n.env.get("RUNE_X"), Some(std::ffi::OsStr::new("y")));
}

#[test]
fn a_rune_env_name_the_overlay_sets_is_refused_on_raw_rendered_and_flow() {
    let r = root("env-refuse");
    for (id, name) in [("env-home", "HOME"), ("env-home-lower", "home"), ("env-homedrive", "HomeDrive")] {
        write_env_rune(&r, id, &format!("{name}=x"));
        let v = custom(&r, &["bare-identity", id]);
        let want = format!("Rune Vault env {name} conflicts with the Claude home overlay; Bare spawn refused");
        assert_eq!(raw(&r, &v).err().unwrap(), want, "Raw");
        assert_eq!(rendered(&r, &v).err().unwrap(), want, "Rendered");
        assert_eq!(claude(&r, &v).err().unwrap(), want, "Flow");
    }
}
