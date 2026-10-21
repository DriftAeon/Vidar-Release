//! src-tauri\src\rules\generate\payload.rs — what `validate::PayloadCtx` needs from the row's Bare launch
//! profile and refs, read the way `bare/layer.rs` and `bare/mod.rs` read them for a spawn:
//! - `template`: the profile's `setsPayload` file (`profiles/bare/{claude,codex}.json`), `{{root}}` filled on Codex
//!   rows, and on Codex the skills listing folded in after `{{sets}}` (`layer::with_skills`, the listing read
//!   without syncing: `copies::listing_now`). `validate` fills it through `layer::row_text`, the builder the spawn
//!   itself uses, so `encodedChars` follows the spawn's own text, cross-library slot dedupe included.
//! - `refs`: the row's refs (`layer::row_sets`) except the ones the commit is about to drop (an earlier generation
//!   of the row, the import library of any input); the generated library stands in for them in `validate`.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::land::{is_generation_of, LandEnv};
use crate::bare::layer::{self, SetRef};

/// The profile-derived string and the row's surviving refs of `PayloadCtx`.
pub struct Parts {
    pub template: String,
    pub refs: Vec<SetRef>,
    pub rules_library: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    sets_payload: Option<String>,
}

fn under(base: &Path, rel: &str) -> PathBuf {
    rel.split(['/', '\\']).filter(|s| !s.is_empty()).fold(base.to_path_buf(), |p, s| p.join(s))
}

/// Template and surviving refs for `row_key` on `agent` (`claude` or `codex`), profiles read under `root`;
/// `bare_home` is where the Codex skills copies and their ledger sit.
pub fn parts(agent: &str, root: &Path, bare_home: &Path, env: &LandEnv, row_key: &str, input_libs: &[String]) -> Result<Parts, String> {
    let profile_path = root.join("profiles").join("bare").join(format!("{agent}.json"));
    let p: Profile = crate::fsx::read_json(&profile_path).map_err(|e| format!("invalid: launch profile {}: {e}", profile_path.display()))?;
    let rel = p.sets_payload.ok_or_else(|| format!("invalid: launch profile {} has no setsPayload", profile_path.display()))?;
    let tpl_path = under(root, &rel);
    let mut template = crate::fsx::read_text(&tpl_path).map_err(|e| format!("invalid: sets payload {}: {e}", tpl_path.display()))?;
    if agent == "codex" {
        template = template.replace("{{root}}", &root.to_string_lossy());
        let listing = crate::bare::codex_home_for_profile_with("bare", root, bare_home)
            .map(|codex_home| crate::bare::copies::listing_now(env.config, bare_home, &codex_home, Some(row_key)))
            .unwrap_or_default();
        template = layer::with_skills(&template, &listing);
    }
    let row = layer::row_sets(env.config, row_key).map_err(|e| format!("invalid: {e}"))?;
    let refs = row
        .sets
        .into_iter()
        .filter(|r| !r.library.as_deref().is_some_and(|l| is_generation_of(l, row_key) || input_libs.iter().any(|i| i == l)))
        .collect();
    Ok(Parts { template, refs, rules_library: row.rules_library })
}
