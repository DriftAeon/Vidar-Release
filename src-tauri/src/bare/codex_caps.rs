//! src-tauri\src\bare\codex_caps.rs — the Codex-owned facts the Bare home check reads: the capability SIDs
//! Codex's sandbox records in a home, and the name of its notify script. Moved from home.rs so the shared home check names no agent.

use std::path::Path;

use serde_json::Value;

use super::agent_homes::Agent;
use super::home::acl;

/// The capability SIDs Codex's workspace-write sandbox recorded in THIS home's
/// `codex-home\cap_sid` (`workspace`, `readonly`, `workspace_by_cwd.*`, `writable_root_by_path.*`).
/// It grants one of them write on the TEMP it runs with (the bare overlay points TEMP into
/// `user-home`) and never revokes, so those ACEs are Codex's own, not a foreign principal. A missing
/// or unparsable file, or any entry that is not a SID, yields no exemptions at all.
/// Every Codex home gets the same rule (W3 L9): the legacy `codex-home` and each indexed
/// combination home (`agent_homes::listed`) are read alike, each file on its own, so a bad file
/// voids only itself and no home grants more than a legacy file would. Flow's `flow-codex` home
/// (W2-L2d) is read alike: its Codex runs on the same TEMP.
pub(super) fn cap_sids(home: &Path) -> Vec<acl::Sid> {
    let legacy = home.join("codex-home");
    let homes = super::agent_homes::listed(Agent::Codex, home, &legacy).into_iter().map(|(dir, _)| dir);
    homes.chain([home.join("flow-codex")]).flat_map(|dir| cap_sids_in(&dir)).collect()
}

/// The exemptions one Codex home's own `cap_sid` records.
fn cap_sids_in(codex_home: &Path) -> Vec<acl::Sid> {
    let Ok(text) = std::fs::read_to_string(codex_home.join("cap_sid")) else { return Vec::new() };
    let Ok(Value::Object(doc)) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { return Vec::new() };
    let mut texts: Vec<&Value> = Vec::new();
    for (k, v) in &doc {
        match (k.as_str(), v) {
            ("workspace" | "readonly", v) => texts.push(v),
            ("workspace_by_cwd" | "writable_root_by_path", Value::Object(m)) => texts.extend(m.values()),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for t in texts {
        match t.as_str().and_then(acl::parse_sid) {
            Some(s) => out.push(s),
            None => return Vec::new(),
        }
    }
    out
}

/// The file name of Codex's notify script, which the template's `notify` argv must end in.
pub(super) const NOTIFY_SCRIPT: &str = "codex-notify.ps1";
