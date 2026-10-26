//! Per-launch Claude MCP config (`--mcp-config <file> --strict-mcp-config`). Every Bare Claude
//! launch is strict: the file holds the launch's module servers (`Loadout.mcp`, looked up in the
//! bundle catalog; Q5: modules only, never the user's own servers) plus `plugin_vidar_drive` when
//! the session's vault holds the `vidar-app` plugin rune.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{bundles, bundles::Mcp, home::HomeLock};

/// The catalog servers the loadout names (`Loadout.mcp`, case-insensitive) that Claude loads: a
/// server with no `agents` list, or one naming claude. First match wins; the twin of
/// `codex_mcp::for_launch`.
pub(super) fn for_launch(names: &[String], catalog: &bundles::Bundles) -> Vec<Mcp> {
    let claude = |m: &Mcp| m.agents.is_empty() || m.agents.iter().any(|a| a.eq_ignore_ascii_case("claude"));
    let mut out: Vec<Mcp> = Vec::new();
    for n in names {
        if out.iter().any(|o| o.name.eq_ignore_ascii_case(n)) {
            continue;
        }
        if let Some(m) = catalog.bundles.values().flat_map(|b| b.mcp.iter()).find(|m| m.name.eq_ignore_ascii_case(n) && claude(m)) {
            out.push(m.clone());
        }
    }
    out
}

pub(super) struct Prepared {
    pub file: Option<PathBuf>,
    pub warnings: Vec<String>,
}


fn drive(root: &Path) -> Result<Value, String> {
    let file = root.join("plugins/vidar-app/.mcp.json");
    let body = crate::fsx::read_text(&file).map_err(|e| format!("Bare drive MCP {}: {e}; spawn refused", file.display()))?;
    let plugin: Value = serde_json::from_str(crate::fsx::strip_bom(&body))
        .map_err(|e| format!("Bare drive MCP {}: {e}; spawn refused", file.display()))?;
    let mut entry = plugin.pointer("/mcpServers/drive").cloned()
        .ok_or_else(|| format!("Bare drive MCP {} has no drive server; spawn refused", file.display()))?;
    let plugin_root = root.join("plugins/vidar-app");
    let args = entry.get_mut("args").and_then(Value::as_array_mut)
        .ok_or_else(|| format!("Bare drive MCP {} has no args; spawn refused", file.display()))?;
    for arg in args {
        let s = arg.as_str().ok_or_else(|| "Bare drive MCP has a non-string arg; spawn refused".to_string())?;
        if let Some(rel) = s.strip_prefix("${CLAUDE_PLUGIN_ROOT}/") {
            let resolved = plugin_root.join(rel).canonicalize()
                .map_err(|e| format!("Bare drive MCP server {}: {e}; spawn refused", plugin_root.join(rel).display()))?;
            *arg = Value::String(resolved.to_string_lossy().into_owned());
        } else if s.contains("${CLAUDE_PLUGIN_ROOT}") {
            return Err("Bare drive MCP has an unsupported plugin-root placeholder; spawn refused".into());
        }
    }
    Ok(entry)
}

/// `prepare_for` with the drive server always in: Flow's Claude node, which is not a Bare session
/// and has no vault.
pub(super) fn prepare(
    lock: &HomeLock, root: &Path, home: &Path, mcp: &[Mcp],
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<Prepared, String> {
    prepare_for(lock, root, home, mcp, inherited, true)
}

/// Writes `<home>\layer\mcp-<hash12>.json` (only when its bytes differ) holding `mcp`, plus the
/// drive server when `drive` says the session's vault holds the `vidar-app` plugin rune (run
/// 2026-10-25-rune-vault L2b: dropping that rune drops the server). Refuses a server with no
/// transport or one named `plugin_vidar_drive`.
pub(super) fn prepare_for(
    _lock: &HomeLock, root: &Path, home: &Path, mcp: &[Mcp],
    inherited: impl IntoIterator<Item = (OsString, OsString)>, drive_in: bool,
) -> Result<Prepared, String> {
    let vars: BTreeMap<_, _> = inherited.into_iter()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
    let mut servers = BTreeMap::<String, Value>::new();
    let mut warnings = Vec::new();
    for server in mcp {
        let value = if let Some(http) = &server.http {
            json!({ "type": "http", "url": http.url })
        } else if let Some(stdio) = &server.stdio {
            let mut env = BTreeMap::<String, String>::new();
            for key in &stdio.env_from {
                if let Some(value) = vars.get(key) { env.insert(key.clone(), value.clone()); }
                else { warnings.push(format!("Claude MCP {}: environment variable {key} is unset", server.name)); }
            }
            json!({ "command": stdio.command, "args": stdio.args, "env": env })
        } else { return Err(format!("Claude MCP {} has no transport; spawn refused", server.name)); };
        if server.name == "plugin_vidar_drive" { return Err("Module MCP cannot replace plugin_vidar_drive; spawn refused".into()); }
        servers.insert(server.name.clone(), value);
    }
    if drive_in {
        servers.insert("plugin_vidar_drive".into(), drive(root)?);
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
