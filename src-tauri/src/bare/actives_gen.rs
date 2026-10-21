//! src-tauri\src\bare\actives_gen.rs — the Actives read of a generated rune library (rune generator plan E3,
//! `ipc.md` § `BareActiveLibraryGenerated`). A library holding `generate.json` reads with `generated` and its
//! runes in the agent's section order; a rune is On when the row's set file slots it and the row still references
//! the library. `listed_by_index` finds the row's current generation in runtime\runes\gen-index.json when no ref
//! names it any more (every rune turned Off, or Import Raw), so it can be turned back On.

use std::path::Path;

use serde::Serialize;

use super::actives::{rune_in, scope_of, studs, ActiveBrick, ActiveLibrary, ActivesEnv};
use crate::rules::generate::land::read_index;
use crate::rules::generate::render::GenerateJson;
use crate::rules::import::sources;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveGenerated {
    pub agent: String,
    pub model: String,
    pub effort: String,
    /// ISO date.
    pub date: String,
    /// `~`-relative input paths.
    pub inputs: Vec<String>,
    pub warnings: Vec<String>,
    pub encoded_chars: Option<usize>,
}

/// The row's indexed generation library when it carries `generate.json` and no listed library already is it.
pub(super) fn listed_by_index(env: &ActivesEnv, row_key: &str, listed: &[Option<String>]) -> Option<String> {
    let library = read_index(env.index).remove(row_key)?;
    let named = listed.iter().any(|l| l.as_deref() == Some(library.as_str()));
    (!named && env.imports.join(&library).join("generate.json").is_file()).then_some(library)
}

/// `Some` when `dir` holds `generate.json`; `on` is the row set's slot ids (empty for an unreferenced library).
pub(super) fn read(env: &ActivesEnv, dir: &Path, label: &str, on: &[String]) -> Option<ActiveLibrary> {
    let g: GenerateJson = crate::fsx::read_json(&dir.join("generate.json")).ok()?;
    let mut bricks = Vec::new();
    for section in &g.sections {
        for id in &section.ids {
            let Some(meta) = g.runes.iter().find(|r| &r.id == id) else { continue };
            let found = rune_in(dir, id);
            let body = found.as_ref().map(|(_, r)| r.body.trim_matches('\n')).unwrap_or("");
            let is_on = !meta.locked && on.contains(id);
            bricks.push(ActiveBrick::new(id, vec![section.heading.clone()], studs(body), is_on, found.as_ref()));
        }
    }
    let global = !g.inputs.is_empty() && g.inputs.iter().all(|i| scope_of(&i.path, &sources::expand(&i.path, env.home)) == "global");
    let generated = ActiveGenerated {
        agent: g.agent,
        model: g.model,
        effort: g.effort,
        date: g.date,
        inputs: g.inputs.into_iter().map(|i| i.path).collect(),
        warnings: g.warnings,
        encoded_chars: g.encoded_chars,
    };
    Some(ActiveLibrary {
        library: label.to_string(),
        source: None,
        scope: if global { "global" } else { "project" },
        source_gone: false,
        bricks,
        generated: Some(generated),
        sets: Vec::new(),
    })
}
