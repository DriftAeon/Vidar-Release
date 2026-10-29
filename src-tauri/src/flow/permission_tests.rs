//! src-tauri\src\flow\permission_tests.rs — Flow node permissions come from the vault (FV1b): the
//! mode a node's vault holds, limited by `effective`, and the allow entries its agent carries.

use std::path::{Path, PathBuf};

use super::*;
use crate::bare::vault::store::Store;
use crate::bare::vault::{RuneRef, Template};

struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn perm_rune(id: &str, agent: Option<&str>, body: &str) -> String {
    let agent = agent.map(|a| format!("agent: {a}\n")).unwrap_or_default();
    format!("---\nname: {id}\nkind: permission\nscope: [global]\n{agent}{body}description: Test permission\n---\n")
}

/// A temp root with a copy of the shipped stock library plus `perm-plan`, `perm-auto` and `perm-mcp`, and a
/// `stock-claude` template.
fn root(tag: &str) -> Root {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let p = std::env::temp_dir().join(format!("vidar-fv1b-{tag}-{}-{nanos}", std::process::id()));
    let stock = crate::paths::rune_stock_dir_in(&p);
    copy_dir(&crate::paths::rune_stock_dir_in(&crate::paths::root()), &stock);
    let dir = stock.join("permissions");
    std::fs::write(dir.join("perm-plan.md"), perm_rune("perm-plan", None, "mode: plan\n")).unwrap();
    std::fs::write(dir.join("perm-auto.md"), perm_rune("perm-auto", None, "mode: auto\nallow:\n  - Bash(ls)\n")).unwrap();
    std::fs::write(dir.join("perm-mcp.md"), perm_rune("perm-mcp", None, "allow:\n  - mcp__x__y\n  - Bash(ls)\n")).unwrap();
    let tdir = crate::paths::rune_templates_dir_in(&p);
    std::fs::create_dir_all(&tdir).unwrap();
    let t = Template { version: 1, id: "stock-claude".into(), name: "Stock Claude".into(), runesets: vec![], runes: vec![stock_ref("bare-identity")] };
    std::fs::write(tdir.join("stock-claude.json"), serde_json::to_string(&t).unwrap()).unwrap();
    Root(p)
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

fn stock_ref(id: &str) -> RuneRef {
    RuneRef { library: "stock".into(), id: id.into() }
}

/// A Custom vault holding the named stock runes; its id.
fn vault(r: &Root, runes: &[&str]) -> String {
    let refs: Vec<RuneRef> = runes.iter().map(|i| stock_ref(i)).collect();
    Store::open(&r.0).create_custom(&[], &refs).unwrap().id
}

fn ask(node: &str, model: &str, vault: Option<&str>, agent: Option<&str>) -> NodeAsk {
    NodeAsk { node: node.into(), model: model.into(), vault: vault.map(str::to_string), agent: agent.map(str::to_string).unwrap_or_else(|| crate::agent_spec::ALL[0].as_str().to_string()) }
}

#[test]
fn a_plan_rune_gives_default() {
    let r = root("plan");
    let v = vault(&r, &["perm-plan"]);
    assert_eq!(node_grant(&r.0, &ask("n1", "claude-sonnet-5", Some(&v), None)).unwrap().mode, "default");
}

#[test]
fn auto_on_a_gateway_model_gives_default() {
    let r = root("gateway");
    let v = vault(&r, &["perm-auto"]);
    assert_eq!(node_grant(&r.0, &ask("n1", "claude-sonnet-5", Some(&v), None)).unwrap().mode, "auto");
    assert_eq!(node_grant(&r.0, &ask("n2", "glm-5", Some(&v), None)).unwrap().mode, "default");
}

#[test]
fn no_mode_rune_gives_default() {
    let r = root("nomode");
    let v = vault(&r, &["bare-identity"]);
    let g = node_grant(&r.0, &ask("n1", "claude-sonnet-5", Some(&v), None)).unwrap();
    assert_eq!((g.mode.as_str(), g.allow.is_empty()), ("default", true));
}

#[test]
fn two_nodes_on_one_model_get_their_own_vaults_modes() {
    let r = root("pair");
    let (plan, auto) = (vault(&r, &["perm-plan"]), vault(&r, &["perm-auto"]));
    let a = node_grant(&r.0, &ask("a", "claude-sonnet-5", Some(&plan), None)).unwrap();
    let b = node_grant(&r.0, &ask("b", "claude-sonnet-5", Some(&auto), None)).unwrap();
    assert_eq!((a.mode.as_str(), b.mode.as_str()), ("default", "auto"));
    assert_eq!(b.allow, ["Bash(ls)"]);
    assert_ne!(a.hash, b.hash);
}

#[test]
fn codex_nodes_keep_only_mcp_allows_and_no_mode() {
    let r = root("codex");
    let v = vault(&r, &["perm-mcp", "perm-auto"]);
    let g = node_grant(&r.0, &ask("c", "gpt-6", Some(&v), Some(crate::agent_spec::spec(crate::agent_spec::ALL[1]).label.to_lowercase().as_str()))).unwrap();
    assert_eq!((g.mode.as_str(), g.allow.as_slice()), ("default", &["mcp__x__y".to_string()][..]));
}

#[test]
fn unknown_and_foreign_stock_vaults_refuse() {
    let r = root("refuse");
    assert!(node_grant(&r.0, &ask("n", "claude-sonnet-5", Some("nope"), None)).unwrap_err().contains("Unknown Vault"));
    let other = crate::agent_spec::spec(crate::agent_spec::ALL[1]).label.to_lowercase();
    let e = node_grant(&r.0, &ask("n", "claude-sonnet-5", Some(&format!("stock-{other}")), Some(crate::agent_spec::spec(crate::agent_spec::ALL[0]).label.to_lowercase().as_str()))).unwrap_err();
    assert!(e.contains("Stock Vault for Another Agent"), "{e}");
}

#[test]
fn a_rune_names_its_agent_for_mode_and_allow() {
    let agent = crate::agent_spec::ALL[0];
    let other = crate::agent_spec::spec(crate::agent_spec::ALL[1]).label.to_lowercase();
    let body = |a: Option<&str>| perm_rune("x", a, "mode: plan\n");
    assert_eq!(crate::bare::vault_spawn::rune_mode(&body(None), agent).as_deref(), Some("plan"));
    assert_eq!(crate::bare::vault_spawn::rune_mode(&body(Some(&other)), agent), None, "another agent's mode");
    assert_eq!(crate::bare::vault_spawn::rune_mode("---\nkind: permission\nallow:\n  - Read\n---\n", agent), None, "no mode");
    assert_eq!(crate::bare::vault_spawn::rune_mode("---\nkind: rule\nmode: plan\n---\n", agent), None, "not a permission rune");
    assert_eq!(crate::bare::vault_spawn::rune_mode(&body(None), crate::agent_spec::ALL[1]), None, "Codex has no mode");
}
