//! src-tauri\src\bare\flow_vault_tests.rs — a Flow agent node loads its own Rune Vault (FV1).
//! Every vault lives in a temp store root (`TEST_VAULT_ROOT`); profiles come from the checkout and
//! every home is a temp folder.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::*;
use crate::agent_spec::{self, Agent};
use crate::bare::vault::store::Store;
use crate::bare::vault::{RuneRef, Template};
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

fn stock_ref(id: &str) -> RuneRef {
    RuneRef { library: "stock".into(), id: id.into() }
}

fn perm_rune(id: &str, body: &str) -> String {
    format!("---\nname: {id}\nkind: permission\nscope: [global]\n{body}description: Test permission\n---\n")
}

/// A temp store root: a copy of the shipped stock library plus `perm-mcp` (a Codex-carried `mcp__`
/// entry and a Claude-only one), both agents' stock templates (each holds `bare-identity`), and the
/// thread's store pointed at it.
fn root(tag: &str) -> Root {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let p = std::env::temp_dir().join(format!("vidar-fv1-{tag}-{}-{nanos}", std::process::id()));
    let stock = crate::paths::rune_stock_dir_in(&p);
    copy_dir(&crate::paths::rune_stock_dir_in(&crate::paths::root()), &stock);
    std::fs::write(stock.join("permissions").join("perm-mcp.md"), perm_rune("perm-mcp", "allow:\n  - mcp__x__y\n  - Bash(ls)\n")).unwrap();
    let tdir = crate::paths::rune_templates_dir_in(&p);
    std::fs::create_dir_all(&tdir).unwrap();
    for agent in [CLAUDE, CODEX] {
        let id = format!("stock-{}", agent.as_str());
        let t = Template { version: 1, id: id.clone(), name: id.clone(), runesets: vec![], runes: vec![stock_ref("bare-identity")] };
        std::fs::write(tdir.join(format!("{id}.json")), serde_json::to_string(&t).unwrap()).unwrap();
    }
    vault_spawn::TEST_VAULT_ROOT.with(|r| *r.borrow_mut() = Some(p.clone()));
    Root(p)
}

fn custom(r: &Root, runes: &[&str]) -> String {
    let refs: Vec<RuneRef> = runes.iter().map(|i| stock_ref(i)).collect();
    Store::open(&r.0).create_custom(&[], &refs).unwrap().id
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

/// The Claude node for `vault` on a temp home: the hosted prepare and its sidecar inputs.
fn claude(r: &Root, vault: &str) -> Result<ClaudeNode, String> {
    admit_hosted(PROFILE, None, None)?;
    let home_dir = r.0.join("home");
    let probes = Probes { find: &|_, _| None, version: &|_, _| None, remote_control: &|| false };
    let opts = LaunchOpts { vault: Some(vault), ..Default::default() };
    let launch = super::super::prepare_hosted_with(PROFILE, &crate::paths::root(), &home_dir, inherited(), &Ambient::default(), &guard(), &probes, &opts)?;
    finish_claude(launch, &crate::paths::root(), &home_dir, inherited(), vault, TAB)
}

fn codex(r: &Root, vault: &str) -> Result<CodexNode, String> {
    let home_dir = r.0.join("home");
    let cwd = r.0.join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let probes = CodexProbes { find: &fake_find, codex: &codex_ok };
    let opts = LaunchOpts { vault: Some(vault), ..Default::default() };
    let launch = super::super::prepare_codex_in(PROFILE, &crate::paths::root(), &home_dir, inherited(), &Ambient::default(), &guard(), &probes, &opts, Some(&cwd.to_string_lossy()))?;
    finish_codex(launch, &crate::paths::root(), vault, TAB, "tok123")
}

#[test]
fn an_unset_vault_is_the_agents_stock_vault() {
    let r = root("stock");
    for agent in [CLAUDE, CODEX] {
        let a = approve(&r.0, agent, None, None).unwrap();
        assert_eq!(a.vault, format!("stock-{}", agent.as_str()));
        assert_eq!(vault_id(agent, Some("  ")), a.vault, "a blank id is unset");
    }
}

#[test]
fn an_unknown_vault_refuses() {
    let r = root("unknown");
    let e = approve(&r.0, CLAUDE, Some("nope"), None).unwrap_err();
    assert!(e.contains("Unknown Vault"), "{e}");
}

#[test]
fn another_agents_stock_vault_refuses() {
    let r = root("foreign");
    let other = format!("stock-{}", CODEX.as_str());
    let e = approve(&r.0, CLAUDE, Some(&other), None).unwrap_err();
    assert!(e.contains("Stock Vault for Another Agent"), "{e}");
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
    assert_eq!(n.env.get("VIDAR_CTL_TOKEN"), Some(std::ffi::OsStr::new("tok123")));
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
