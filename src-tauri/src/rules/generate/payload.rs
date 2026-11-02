//! src-tauri\src\rules\generate\payload.rs — the template `validate::PayloadCtx` needs for the agent's Bare
//! spawn: the fixed in-code `layer::PAYLOAD_TEMPLATE` (`{{sets}}` plus the marker a spawn adds), and on Codex the
//! skills listing of the profile's home folded in after `{{sets}}` (`layer::with_skills`, the listing read
//! without syncing: `copies::listing_now`). No launcher row is read (model R5): the generated set is measured on
//! its own.

use std::path::Path;

use super::land::LandEnv;
use crate::agent_spec::Agent;
use crate::bare::layer;

/// The template string of `PayloadCtx`.
pub struct Parts {
    pub template: String,
}

/// The template for `agent` (`claude` or `codex`); `bare_home` is where the Codex skills copies and their ledger
/// sit.
pub fn parts(agent: &str, root: &Path, bare_home: &Path, env: &LandEnv) -> Result<Parts, String> {
    let agent = super::home::agent_of(agent)?;
    let mut template = layer::PAYLOAD_TEMPLATE.to_string();
    match agent {
        Agent::Claude => {}
        Agent::Codex => {
            let listing = crate::bare::codex_home_for_profile_with("bare", root, bare_home)
                .map(|codex_home| crate::bare::copies::listing_now(env.config, bare_home, &codex_home))
                .unwrap_or_default();
            template = layer::with_skills(&template, &listing);
        }
    }
    Ok(Parts { template })
}
