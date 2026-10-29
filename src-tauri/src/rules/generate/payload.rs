//! src-tauri\src\rules\generate\payload.rs — the template `validate::PayloadCtx` needs from the agent's Bare
//! launch profile, read the way `bare/layer.rs` and `bare/mod.rs` read it for a spawn: the profile's
//! `setsPayload` file (`profiles/bare/{claude,codex}.json`), `{{root}}` filled on Codex, and on Codex the skills
//! listing of the profile's home folded in after `{{sets}}` (`layer::with_skills`, the listing read without
//! syncing: `copies::listing_now`). No launcher row is read (model R5): the generated set is measured on its own.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::land::LandEnv;
use crate::agent_spec::{spec, Agent};
use crate::bare::layer;

/// The profile-derived string of `PayloadCtx`.
pub struct Parts {
    pub template: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    sets_payload: Option<String>,
}

fn under(base: &Path, rel: &str) -> PathBuf {
    rel.split(['/', '\\']).filter(|s| !s.is_empty()).fold(base.to_path_buf(), |p, s| p.join(s))
}

/// The template for `agent` (`claude` or `codex`), profiles read under `root`; `bare_home` is where the Codex
/// skills copies and their ledger sit.
pub fn parts(agent: &str, root: &Path, bare_home: &Path, env: &LandEnv) -> Result<Parts, String> {
    let agent = super::home::agent_of(agent)?;
    let profile_path = root.join("profiles").join("bare").join(spec(agent).profile_file);
    let p: Profile = crate::fsx::read_json(&profile_path).map_err(|e| format!("invalid: launch profile {}: {e}", profile_path.display()))?;
    let rel = p.sets_payload.ok_or_else(|| format!("invalid: launch profile {} has no setsPayload", profile_path.display()))?;
    let tpl_path = under(root, &rel);
    let mut template = crate::fsx::read_text(&tpl_path).map_err(|e| format!("invalid: sets payload {}: {e}", tpl_path.display()))?;
    match agent {
        Agent::Claude => {}
        Agent::Codex => {
            template = template.replace("{{root}}", &root.to_string_lossy());
            let listing = crate::bare::codex_home_for_profile_with("bare", root, bare_home)
                .map(|codex_home| crate::bare::copies::listing_now(env.config, bare_home, &codex_home))
                .unwrap_or_default();
            template = layer::with_skills(&template, &listing);
        }
    }
    Ok(Parts { template })
}
