//! The permission mode Flow Claude nodes spawn with: the mode the node's vault holds, limited to the modes a
//! node can act in. `bypassPermissions` and `plan` are never followed; `auto` needs a classifier a
//! gateway model cannot run, so it falls back to `default` there.

use super::env::CLAUDE_MODELS;

const ACCEPTED: &[&str] = &["default", "acceptEdits", "auto"];

/// The mode `requested` becomes for `model`: re-validated against the accepted set, and `auto`
/// drops to `default` for a model outside `CLAUDE_MODELS`.
pub(super) fn effective(requested: &str, model: &str) -> &'static str {
    let mode = ACCEPTED.iter().copied().find(|m| *m == requested).unwrap_or("default");
    if mode == "auto" && !CLAUDE_MODELS.contains(&model) { "default" } else { mode }
}

/// One node's approval question: the model it runs, the vault it loads (`None` = the stock vault of
/// its agent) and its agent id (required).
#[derive(serde::Deserialize)]
pub struct NodeAsk {
    node: String,
    model: String,
    vault: Option<String>,
    agent: String,
}

/// What approval binds for one node: the vault, the mode it spawns in, the exact allow entries and the
/// vault hash `flow_run_node` is handed back.
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct NodeGrant {
    node: String,
    vault: String,
    mode: String,
    allow: Vec<String>,
    hash: String,
}

/// `ask` answered from the vault under `root`: an unknown vault or another agent's stock vault refuses.
fn node_grant(root: &std::path::Path, ask: &NodeAsk) -> Result<NodeGrant, String> {
    let agent = crate::agent_spec::parse(&ask.agent).ok_or_else(|| format!("Unknown Agent: {}", ask.agent))?;
    let vault = ask.vault.clone().unwrap_or_else(|| format!("stock-{}", agent.as_str()));
    let perms = crate::bare::vault_spawn::node_permissions(root, &vault, agent).map_err(|e| format!("Node {}: {e}", ask.node))?;
    let mode = effective(perms.mode.as_deref().unwrap_or("default"), &ask.model).to_string();
    Ok(NodeGrant { node: ask.node.clone(), vault, mode, allow: perms.allow, hash: perms.hash })
}

/// Each node's vault, mode, allow entries and hash, keyed by node (two nodes on one model may differ).
#[tauri::command]
pub fn flow_node_permissions(nodes: Vec<NodeAsk>) -> Result<Vec<NodeGrant>, String> {
    let root = crate::paths::root();
    nodes.iter().map(|n| node_grant(&root, n)).collect()
}

#[cfg(test)]
#[path = "permission_tests.rs"]
mod grant_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_holds_for_claude_models_only() {
        assert_eq!(effective("auto", "claude-sonnet-5"), "auto");
        assert_eq!(effective("auto", "glm-5"), "default");
        assert_eq!(effective("acceptEdits", "glm-5"), "acceptEdits");
        assert_eq!(effective("bypassPermissions", "claude-sonnet-5"), "default");
        assert_eq!(effective("plan", "claude-sonnet-5"), "default");
    }
}
