//! src-tauri\src\bare\launch_row.rs — a spawn's row key and per-launch set pick: key trimming, Codex
//! Bare row admission, the picked-sets type and the row's sets read before any home is touched.
//! Moved from mod.rs for the module-size cap.

use std::path::Path;

use super::{config_of, LaunchOpts};
use crate::agent_spec::{self, Agent};

/// One set of a per-launch pick: an absent `library` means the config's `rulesLibrary`.
#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSetRef {
    #[serde(default)]
    pub library: Option<String>,
    pub set: String,
}

/// A spawn's row key, trimmed; empty or blank is no key (as `falcon_spawn`'s `none_if_blank`).
pub fn row_key_of(raw: Option<String>) -> Option<String> {
    raw.map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// The agent whose Bare spawns ride a row key (`AgentSpec::rides_row_key`; the Codex Bare rows today).
fn row_agent() -> Agent {
    agent_spec::ALL.into_iter().find(|a| agent_spec::spec(*a).rides_row_key).expect("an agent rides a row key")
}

/// A spawn's row key for `agent`: admitted (`admit_row_key`) where the spec says the agent rides one,
/// else only trimmed. The one place a row key meets an agent.
pub fn admit_row_key_for(agent: Agent, raw: Option<String>, profile: Option<&str>, config: Option<&Path>) -> Result<Option<String>, String> {
    match agent_spec::spec(agent).rides_row_key {
        true => admit_row_key(raw, profile, config),
        false => Ok(row_key_of(raw)),
    }
}

/// The built-in Bare rows of the row agent (`src/launcher/roster.ts`), Rendered and Raw: the agent's id, profile `bare`.
fn bare_rows(agent: Agent) -> [String; 2] {
    let id = agent.as_str();
    [format!("{id}-rendered-bare"), format!("{id}-bare")]
}

/// A Codex Bare spawn's row key (Rendered or Raw), admitted before the profile prepare: blank
/// is none; a key without a profile refuses; a key must name a Codex Bare row, so a caller cannot
/// feed a Claude or non-Bare row's sets into Codex Bare. The row is folded from vidar.json
/// `agents` as `src/config-agents.ts` overlays it: a built-in (`codex-rendered-bare`, `codex-bare`) starts as
/// id `codex`, profile `bare`; each entry with that key lays its given `id` (non-empty) and
/// `profile` (non-null) over the row, a `disabled: true` one removes it, and an unknown key's first
/// entry adds it. The row must end as id `codex`, profile `bare`, and the spawn's own profile must
/// be `bare`. The fold reads keyed entries only, with no keyless legacy matching
/// or root-disable cascade: the launcher never spawns a row it removed, and a Rust false-reject
/// fails visibly rather than admitting the wrong sets. `config` `None` is the live vidar.json
/// (none in tests, as `config_of`).
pub fn admit_row_key(raw: Option<String>, profile: Option<&str>, config: Option<&Path>) -> Result<Option<String>, String> {
    let Some(key) = row_key_of(raw) else { return Ok(None) };
    let Some(profile) = profile else {
        return Err("A row key rides only a profiled spawn; spawn refused".into());
    };
    if profile != "bare" {
        return Err(format!("Row {key:?} is not a Codex Bare row; Bare spawn refused"));
    }
    let path = config_of(&LaunchOpts { config, ..Default::default() });
    let root: serde_json::Value = match crate::fsx::read_text(&path) {
        Ok(t) => serde_json::from_str(crate::fsx::strip_bom(&t)).map_err(|e| format!("vidar.json {} is unreadable ({e}); Bare spawn refused", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Value::Null,
        Err(e) => return Err(format!("vidar.json {} is unreadable ({e}); Bare spawn refused", path.display())),
    };
    // (id, profile) of the row as the launcher would show it; `None` = no such row.
    let mut row: Option<(String, Option<String>)> = bare_rows(row_agent()).contains(&key).then(|| (row_agent().as_str().to_string(), Some("bare".to_string())));
    let entries = root.get("agents").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    for e in entries.iter().filter(|e| e.get("key").and_then(serde_json::Value::as_str) == Some(key.as_str())) {
        let id = e.get("id").and_then(serde_json::Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let given_profile = e.get("profile").filter(|v| !v.is_null()).map(|v| v.as_str().map(str::to_string).unwrap_or_default());
        if e.get("disabled").and_then(serde_json::Value::as_bool) == Some(true) {
            row = None;
            continue;
        }
        row = Some(match row {
            Some((rid, rprofile)) => (id.unwrap_or(rid), given_profile.or(rprofile)),
            None => (id.unwrap_or_default(), given_profile),
        });
    }
    let refuse_row = || Err(format!("Row {key:?} is not a Codex Bare row; Bare spawn refused"));
    match row {
        Some((id, Some(p))) if p == "bare" && agent_spec::parse(&id) == Some(row_agent()) => Ok(Some(key)),
        _ => refuse_row(),
    }
}

#[cfg(test)]
#[path = "launch_row_tests.rs"]
mod tests;

/// Tests only: a vault id no store accepts, read by `vault_for` as "spawn on the profile's own home
/// with no vault" so the launch-mechanics tests keep running without a vaults folder.
#[cfg(test)]
pub(crate) const TEST_NO_VAULT: &str = "<test: no vault>";

/// The one Rune Vault a spawn loads, read before any home is touched.
/// `opts.vault` names it; an unknown id refuses. A vault without the Vidar Runeset at
/// index 0 refuses. Else `opts.blank_vault` is the in-memory blank vault (`vidar::blank_vault`), and a pre-vault
/// `opts.custom_sets` refuses. Nothing here reads a launcher row's `sets` (model R1).
pub(super) fn vault_for(root: &Path, opts: &LaunchOpts, agent: super::agent_homes::Agent) -> Result<Option<super::vault::Vault>, String> {
    use super::vault::{store::Store, vidar};
    if let Some(id) = opts.vault.map(str::trim) {
        #[cfg(test)]
        if id == TEST_NO_VAULT {
            return Ok(None);
        }
        let store = Store::open(&super::vault_spawn::store_root(root));
        let v = store.get(id).map_err(|e| format!("Unknown vault {id:?} ({e}); Bare spawn refused"))?;
        if !v.runesets.first().is_some_and(|c| vidar::is_reserved(&c.source)) {
            return Err("Vault lacks the Vidar Runeset; spawn refused".into());
        }
        return Ok(Some(v));
    }
    if opts.blank_vault {
        return Ok(Some(vidar::blank_vault(agent)));
    }
    if opts.custom_sets.is_some() {
        return Err("This session predates Rune Vaults; spawn refused".into());
    }
    Err("No vault named for this spawn; Bare spawn refused".into())
}
