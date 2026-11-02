//! Per-launch Claude MCP config (`--mcp-config <file> --strict-mcp-config`). Every Bare Claude
//! launch is strict: the file holds the launch's module servers (`Loadout.mcp`, looked up in the
//! bundle catalog; Q5: modules only, never the user's own servers). `vidar_drive` is one of them.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{bundles, bundles::Mcp, home::HomeLock};
use crate::agent_spec::Agent;

/// The catalog servers the loadout names (`Loadout.mcp`, case-insensitive) that Claude loads: a
/// server with no `agents` list, or one naming claude. First match wins; the twin of
/// `codex_mcp::for_launch`.
pub(super) fn for_launch(names: &[String], catalog: &bundles::Bundles) -> Vec<Mcp> {
    let mut out: Vec<Mcp> = Vec::new();
    for n in names {
        if out.iter().any(|o| o.name.eq_ignore_ascii_case(n)) {
            continue;
        }
        if let Some(m) = catalog.bundles.values().flat_map(|b| b.mcp.iter()).find(|m| m.name.eq_ignore_ascii_case(n) && bundles::serves(m, Agent::Claude)) {
            out.push(m.clone());
        }
    }
    out
}

pub(super) struct Prepared {
    pub file: Option<PathBuf>,
    pub warnings: Vec<String>,
}

/// Writes `<home>\layer\mcp-<hash12>.json` (only when its bytes differ) holding `mcp`, vidar_drive
/// included when the vault names it. Refuses a server with no transport. A stdio `env` key is
/// written only when it has a pair; `timeoutSec` becomes `timeout` in ms.
pub(super) fn prepare_for(
    _lock: &HomeLock, home: &Path, mcp: &[Mcp],
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<Prepared, String> {
    let vars: BTreeMap<_, _> = inherited.into_iter()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    let mut servers = BTreeMap::<String, Value>::new();
    let mut warnings = Vec::new();
    for server in mcp {
        let mut value = if let Some(http) = &server.http {
            json!({ "type": "http", "url": http.url })
        } else if let Some(stdio) = &server.stdio {
            let mut env = BTreeMap::<String, String>::new();
            for key in &stdio.env_from {
                if let Some(value) = vars.get(key) { env.insert(key.clone(), value.clone()); }
                else { warnings.push(format!("Claude MCP {}: environment variable {key} is unset", server.name)); }
            }
            let mut entry = json!({ "command": stdio.command, "args": stdio.args });
            if !env.is_empty() { entry["env"] = json!(env); }
            entry
        } else { return Err(format!("Claude MCP {} has no transport; spawn refused", server.name)); };
        if let Some(sec) = server.timeout_sec { value["timeout"] = json!(u64::from(sec) * 1000); }
        servers.insert(server.name.clone(), value);
    }
    let bytes = serde_json::to_vec(&json!({ "mcpServers": servers })).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let layer = home.join("layer");
    std::fs::create_dir_all(&layer).map_err(|e| format!("Bare MCP layer {}: {e}; spawn refused", layer.display()))?;
    let file = layer.join(format!("mcp-{}.json", &hash[..12]));
    if std::fs::read(&file).ok().as_deref() != Some(bytes.as_slice()) {
        crate::fsx::atomic_write(&file, &bytes).map_err(|e| format!("Bare MCP config {}: {e}; spawn refused", file.display()))?;
    }
    Ok(Prepared { file: Some(file), warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn for_launch_never_widens_an_unknown_agent_tag() {
        let catalog: bundles::Bundles = serde_json::from_value(json!({ "version": 1, "bundles": { "team": { "mcp": [
            { "name": "odd", "http": { "url": "https://a.test" }, "agents": ["grok"], "reads": [] },
            { "name": "mixed", "http": { "url": "https://b.test" }, "agents": ["grok", "claude"], "reads": [] },
            { "name": "other", "http": { "url": "https://c.test" }, "agents": ["codex"], "reads": [] },
            { "name": "open", "http": { "url": "https://d.test" }, "reads": [] }
        ], "skills": [], "agents": [], "guards": [] } } })).unwrap();
        let names = ["odd", "mixed", "other", "open"].map(String::from);
        assert_eq!(for_launch(&names, &catalog).iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["open"]);
    }

    #[test]
    fn the_catalog_drive_server_is_written_with_a_ms_timeout_and_no_empty_env() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let (catalog, warnings) = bundles::load(root);
        assert!(warnings.is_empty(), "{warnings:?}");
        let servers = for_launch(&["vidar_drive".to_string()], &catalog);
        assert_eq!(servers.len(), 1);
        let tmp = std::env::temp_dir().join(format!("vidar-claude-mcp-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let lock = super::super::home::lock(&tmp, super::super::home::LOCK_WAIT).unwrap();
        let prepared = prepare_for(&lock, &tmp, &servers, Vec::new()).unwrap();
        let doc: Value = serde_json::from_slice(&std::fs::read(prepared.file.unwrap()).unwrap()).unwrap();
        let entry = &doc["mcpServers"]["vidar_drive"];
        assert_eq!((entry["command"].as_str(), entry["timeout"].as_u64()), (Some("node"), Some(3_700_000)));
        assert!(entry.get("env").is_none(), "{entry}");
        let arg = entry["args"][0].as_str().unwrap();
        assert!(arg.ends_with(r"tools\mcp\vidar-drive\server.mjs") && !arg.contains("{{"), "{arg}");
        drop(lock);
        std::fs::remove_dir_all(tmp).ok();
    }
}
