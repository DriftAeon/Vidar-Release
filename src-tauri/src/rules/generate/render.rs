//! src-tauri\src\rules\generate\render.rs — a checked envelope as a rune library (plan D3): one file per rune
//! in its kind's folder (`rules/`, `facts/`), headers written here with `import/write.rs` quoting (the agent never
//! writes header syntax), `origin` from the first citation; a rune holding the user-profile path or `{{` is
//! written `state: draft` and left out of the row set (Off), the profile-path one also scoped `"!bare"`.
//! `sets/row-<rowKey>.md` holds the sections as `##` headings and the On runes as slots in section order;
//! `set_text` is the one writer of it, for the toggle as well. `generate.json` records the provenance.

use serde::{Deserialize, Serialize};

use super::envelope::{Dropped, Envelope, RuneOut, Section, Source};
use super::Input;
use crate::rules::import::{split::sha256_hex, write::quote};
use crate::rules::rune::{check_id, CONTEXTS, KINDS};

/// Header keys of the frozen subset, in `tools/runes/header.mjs` order. Twin of its `KEYS`; a test keeps the two
/// equal.
pub const KEYS: [&str; 11] =
    ["name", "kind", "scope", "state", "activate", "description", "version", "paths", "origin", "closes-when", "enforced-by"];

/// `generate.json` layout version.
pub const VERSION: u32 = 1;

/// Who generated the library and for which row.
pub struct Meta<'a> {
    /// `gen-<rowKey>-<8 hex>`: the folder name and every rune's scope.
    pub library: &'a str,
    pub row_key: &'a str,
    /// `claude` or `codex`.
    pub agent: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    /// SHA-256 hex of the skill text the agent ran under.
    pub skill_sha256: &'a str,
    /// `YYYY-MM-DD`.
    pub date: &'a str,
    /// The user-profile path (`USERPROFILE`); `None` or empty skips the profile check.
    pub profile: Option<&'a str>,
}

/// `generate.json`, written once per generation next to `rules/`, `facts/` and `sets/`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateJson {
    pub version: u32,
    pub library: String,
    pub row_key: String,
    pub agent: String,
    pub model: String,
    pub effort: String,
    pub skill_sha256: String,
    pub date: String,
    pub inputs: Vec<GenInput>,
    /// In envelope order.
    pub runes: Vec<GenRune>,
    /// Every rune id, On or Off, in the agent's order; the row set is rebuilt from this.
    pub sections: Vec<Section>,
    pub dropped: Vec<Dropped>,
    /// Coverage, modal and build warnings, verbatim.
    pub warnings: Vec<String>,
    /// The row payload as a Codex spawn encodes it; `null` on Claude rows. Bare Codex rows have no cap.
    pub encoded_chars: Option<usize>,
    /// Written (as `null`) by older generations; read so those libraries still parse, never written again.
    #[serde(default, skip_serializing)]
    pub limit: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenInput {
    /// `~` form, as the agent cited it.
    pub path: String,
    pub sha256: String,
    pub lines: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenRune {
    pub id: String,
    pub kind: String,
    /// Written draft (profile path or `{{`): never slotted, so never On.
    pub locked: bool,
    pub sources: Vec<Source>,
}

/// The rendered library, before validation: files relative to the library folder (`/` separators), the On ids
/// in section order, and `generate.json` (draft-locked runes marked `locked`) still to fill with the validation
/// results.
#[derive(Debug)]
pub struct Rendered {
    pub files: Vec<(String, String)>,
    pub on: Vec<String>,
    pub manifest: GenerateJson,
}

/// Why a rune is locked draft: `(locked, holds the profile path)`.
fn lock_of(r: &RuneOut, profile: Option<&str>) -> (bool, bool) {
    let profile = profile.map(crate::bare::home::norm).filter(|p| !p.is_empty());
    let has_profile = profile.is_some_and(|p| [&r.body, &r.description].iter().any(|t| crate::bare::home::norm(t).contains(&p)));
    let braces = r.body.contains("{{") || r.description.contains("{{");
    (has_profile || braces, has_profile)
}

/// The kind folder for `kind` (`rule` → `rules`).
pub fn folder(kind: &str) -> Option<&'static str> {
    KINDS.iter().find(|(_, k)| *k == kind).map(|(f, _)| *f)
}

/// One rune file.
pub fn rune_text(r: &RuneOut, meta: &Meta, locked: bool, not_bare: bool) -> String {
    let scope = if not_bare { format!("{}, \"!bare\"", meta.library) } else { meta.library.to_string() };
    let mut h = format!("---\nname: {}\nkind: {}\nscope: [{scope}]\n", r.id, r.kind);
    h.push_str(if locked { "state: draft\n" } else { "state: active\n" });
    h.push_str("activate: always\n");
    h.push_str(&format!("description: {}\n", quote(r.description.trim())));
    if let Some(s) = r.sources.first() {
        h.push_str(&format!("origin: {}\n", quote(&format!("{} {}:{}", meta.date, s.path, s.line))));
    }
    let body = r.body.replace("\r\n", "\n");
    h.push_str(&format!("---\n\n{}\n", body.trim()));
    h
}

/// `sets/row-<rowKey>.md`: each section with an On rune as a `##` heading, its On runes as `- ` slots, in
/// section order. Nothing On gives the header alone (which builds empty).
pub fn set_text(library: &str, row_key: &str, sections: &[Section], on: &[String]) -> String {
    let mut body: Vec<String> = Vec::new();
    for s in sections {
        let ids: Vec<&String> = s.ids.iter().filter(|id| on.contains(id)).collect();
        if ids.is_empty() {
            continue;
        }
        if !body.is_empty() {
            body.push(String::new());
        }
        body.push(format!("## {}", s.heading.trim()));
        body.push(String::new());
        body.extend(ids.iter().map(|id| format!("- <?rune {id}?>")));
    }
    let body = if body.is_empty() { String::new() } else { body.join("\n") + "\n" };
    format!("---\nname: row-{row_key}\nkind: set\nscope: [{library}]\n---\n{body}")
}

pub fn generate_json_text(g: &GenerateJson) -> String {
    serde_json::to_string_pretty(g).unwrap_or_default() + "\n"
}

/// Render a checked envelope. `Err` only for a library name or row key outside the id grammar.
pub fn render(env: &Envelope, inputs: &[Input], meta: &Meta) -> Result<Rendered, Vec<String>> {
    let mut errs = Vec::new();
    if let Err(e) = check_id(meta.library) {
        errs.push(format!("library name: {e}"));
    } else if CONTEXTS.contains(&meta.library) {
        errs.push(format!("library name: `{}` is a scope context name", meta.library));
    }
    if let Err(e) = check_id(&format!("row-{}", meta.row_key)) {
        errs.push(format!("row key: {e}"));
    }
    if !errs.is_empty() {
        return Err(errs);
    }
    let (mut files, mut on, mut locked, mut runes) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for r in &env.runes {
        let (is_locked, not_bare) = lock_of(r, meta.profile);
        let Some(dir) = folder(&r.kind) else {
            errs.push(format!("`{}`: kind `{}` has no folder", r.id, r.kind));
            continue;
        };
        files.push((format!("{dir}/{}.md", r.id), rune_text(r, meta, is_locked, not_bare)));
        if is_locked {
            locked.push(r.id.clone());
        }
        runes.push(GenRune { id: r.id.clone(), kind: r.kind.clone(), locked: is_locked, sources: r.sources.clone() });
    }
    if !errs.is_empty() {
        return Err(errs);
    }
    for s in &env.sections {
        on.extend(s.ids.iter().filter(|id| !locked.contains(id)).cloned());
    }
    files.push((format!("sets/row-{}.md", meta.row_key), set_text(meta.library, meta.row_key, &env.sections, &on)));
    let manifest = GenerateJson {
        version: VERSION,
        library: meta.library.into(),
        row_key: meta.row_key.into(),
        agent: meta.agent.into(),
        model: meta.model.into(),
        effort: meta.effort.into(),
        skill_sha256: meta.skill_sha256.into(),
        date: meta.date.into(),
        inputs: inputs.iter().map(|i| GenInput { path: i.path.clone(), sha256: sha256_hex(&i.text), lines: i.lines().len() }).collect(),
        runes,
        sections: env.sections.clone(),
        dropped: env.dropped.clone(),
        warnings: Vec::new(),
        encoded_chars: None,
        limit: None,
    };
    Ok(Rendered { files, on, manifest })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_generate_json_with_a_null_limit_still_parses_and_is_not_rewritten_with_it() {
        let now = GenerateJson {
            version: VERSION,
            library: "gen-x-1".into(),
            row_key: "x".into(),
            agent: "claude".into(),
            model: "m".into(),
            effort: "low".into(),
            skill_sha256: "s".into(),
            date: "2026-10-18".into(),
            inputs: Vec::new(),
            runes: Vec::new(),
            sections: Vec::new(),
            dropped: Vec::new(),
            warnings: Vec::new(),
            encoded_chars: None,
            limit: None,
        };
        let written = serde_json::to_string(&now).unwrap();
        assert!(!written.contains("limit"));
        let older = format!("{},\"limit\":null}}", written.trim_end_matches('}'));
        let g: GenerateJson = serde_json::from_str(&older).expect("a null limit parses");
        assert_eq!(g, now);
    }

    #[test]
    fn keys_equal_header_mjs() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/runes/header.mjs");
        if !path.exists() {
            eprintln!("skipped: tools/runes/header.mjs is not in this tree (runes cooking is not shipped)");
            return;
        }
        let text = std::fs::read_to_string(path).unwrap();
        let line = text.lines().find_map(|l| l.strip_prefix("export const KEYS = ")).expect("KEYS line in header.mjs");
        let node: Vec<String> = serde_json::from_str(line.trim_end().trim_end_matches(';')).unwrap();
        assert_eq!(node, KEYS);
    }

    #[test]
    fn kind_folders_and_header_quoting() {
        assert_eq!((folder("rule"), folder("fact"), folder("procedure")), (Some("rules"), Some("facts"), Some("procedures")));
        let meta = Meta {
            library: "gen-x-0a1b2c3d",
            row_key: "x",
            agent: "claude",
            model: "m",
            effort: "e",
            skill_sha256: "00",
            date: "2026-10-17",
            profile: None,
        };
        let r = RuneOut {
            id: "q".into(),
            kind: "fact".into(),
            description: r#"Say "hi" \ bye"#.into(),
            body: "\r\nBody.\r\n\r\n".into(),
            sources: vec![Source { path: r"~\a.md".into(), line: 2 }],
        };
        let text = rune_text(&r, &meta, false, false);
        let parsed = crate::rules::rune::parse(&text).unwrap();
        assert_eq!((parsed.description.as_str(), parsed.body.as_str()), (r#"Say "hi" \ bye"#, "\nBody.\n"));
        assert!(text.contains("origin: \"2026-10-17 ~\\\\a.md:2\"\n"), "{text}");
        assert_eq!(set_text("gen-x-0a1b2c3d", "x", &[Section { heading: "A".into(), ids: vec!["q".into()] }], &[]), "---\nname: row-x\nkind: set\nscope: [gen-x-0a1b2c3d]\n---\n");
    }
}
