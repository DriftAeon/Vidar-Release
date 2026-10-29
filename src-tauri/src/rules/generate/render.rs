//! src-tauri\src\rules\generate\render.rs — a checked envelope as a rune library: one file per rune
//! in its kind's folder (`rules/`, `facts/`), headers written here with `import/write.rs` quoting (the agent never
//! writes header syntax), `origin` from the first citation; a rune holding the user-profile path or `{{` is
//! written `state: draft` and left out of the set (Off), the profile-path one also scoped `"!bare"`.
//! `sets/generated-<yyyymmdd>.md` holds the sections as `##` headings and the On runes as slots in section order;
//! `named_set_text` writes it (`set_text` keeps the toggle's older call shape). Ticked local skills, agents and
//! hooks (`items.rs`) land as item runes in their kind folders, slotted under a last `Items` section.
//! `generate.json` records the provenance. No launcher row is named anywhere (model R5).

use serde::{Deserialize, Serialize};

use super::envelope::{Dropped, Envelope, RuneOut, Section, Source};
use super::items::{self, ItemSpec};
use super::Input;
use crate::rules::import::{split::sha256_hex, write::quote};
use crate::rules::rune::{check_id, CONTEXTS, KINDS};

/// Header keys of the frozen subset, in `tools/runes/header.mjs` order. Twin of its `KEYS`; a test keeps the two
/// equal.
pub const KEYS: [&str; 13] =
    ["name", "kind", "scope", "state", "activate", "description", "version", "paths", "origin", "closes-when", "why", "example", "enforced-by"];

/// `generate.json` layout version.
pub const VERSION: u32 = 1;

/// The heading the item runes are slotted under.
pub const ITEMS_HEADING: &str = "Items";

/// Who generated the library and what it holds beside the agent's runes.
pub struct Meta<'a> {
    /// `gen-<runId>`: the folder name and every rune's scope.
    pub library: &'a str,
    /// `generated-<yyyymmdd>`: the one set the library writes.
    pub set: &'a str,
    /// Ticked local skills, agents and hooks (`items::resolve`).
    pub items: &'a [ItemSpec],
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
    /// Written by older, row-bound generations; new ones leave it empty and it is not written.
    #[serde(default, skip_serializing_if = "String::is_empty")]
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
    h.push_str(&format!("activate: {}\n", r.activate.as_deref().unwrap_or("always")));
    if let Some(paths) = &r.paths {
        h.push_str("paths:\n");
        for path in paths {
            h.push_str(&format!("  - {}\n", quote(path)));
        }
    }
    h.push_str(&format!("description: {}\n", quote(r.description.trim())));
    if let Some(s) = r.sources.first() {
        h.push_str(&format!("origin: {}\n", quote(&format!("{} {}:{}", meta.date, s.path, s.line))));
    }
    let body = r.body.replace("\r\n", "\n");
    h.push_str(&format!("---\n\n{}\n", body.trim()));
    h
}

/// `sets/<set>.md`: each section with an On rune as a `##` heading, its On runes as `- ` slots, in
/// section order. Nothing On gives the header alone (which builds empty).
pub fn named_set_text(library: &str, set: &str, sections: &[Section], on: &[String]) -> String {
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
    format!("---\nname: {set}\nkind: set\nscope: [{library}]\n---\n{body}")
}

pub fn generate_json_text(g: &GenerateJson) -> String {
    serde_json::to_string_pretty(g).unwrap_or_default() + "\n"
}

/// Render a checked envelope plus `meta.items`. `Err` for a library or set name outside the id grammar, or an
/// item id the envelope also uses.
pub fn render(env: &Envelope, inputs: &[Input], meta: &Meta) -> Result<Rendered, Vec<String>> {
    let mut errs = Vec::new();
    if let Err(e) = check_id(meta.library) {
        errs.push(format!("library name: {e}"));
    } else if CONTEXTS.contains(&meta.library) {
        errs.push(format!("library name: `{}` is a scope context name", meta.library));
    }
    if let Err(e) = check_id(meta.set) {
        errs.push(format!("set name: {e}"));
    }
    for i in meta.items.iter().filter(|i| env.runes.iter().any(|r| r.id == i.id)) {
        errs.push(format!("item `{}`: id is also a generated rune", i.id));
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
    let mut sections = env.sections.clone();
    if !meta.items.is_empty() {
        for i in meta.items {
            files.push((format!("{}/{}.md", items::folder(i.kind), i.id), items::item_text(i, meta.library)));
            runes.push(GenRune { id: i.id.clone(), kind: i.kind.into(), locked: false, sources: Vec::new() });
        }
        sections.push(Section { heading: ITEMS_HEADING.into(), ids: meta.items.iter().map(|i| i.id.clone()).collect() });
    }
    for s in &sections {
        on.extend(s.ids.iter().filter(|id| !locked.contains(id)).cloned());
    }
    files.push((format!("sets/{}.md", meta.set), named_set_text(meta.library, meta.set, &sections, &on)));
    let manifest = GenerateJson {
        version: VERSION,
        library: meta.library.into(),
        row_key: String::new(),
        agent: meta.agent.into(),
        model: meta.model.into(),
        effort: meta.effort.into(),
        skill_sha256: meta.skill_sha256.into(),
        date: meta.date.into(),
        inputs: inputs.iter().map(|i| GenInput { path: i.path.clone(), sha256: sha256_hex(&i.text), lines: i.lines().len() }).collect(),
        runes,
        sections,
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
            library: "gen-0a1b2c3d",
            set: "generated-20261017",
            items: &[],
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
            ..Default::default()
        };
        let text = rune_text(&r, &meta, false, false);
        let parsed = crate::rules::rune::parse(&text).unwrap();
        assert_eq!((parsed.description.as_str(), parsed.body.as_str()), (r#"Say "hi" \ bye"#, "\nBody.\n"));
        assert!(text.contains("origin: \"2026-10-17 ~\\\\a.md:2\"\n"), "{text}");
        assert!(text.contains("activate: always\n"), "{text}");
        let mut picked = r.clone();
        picked.activate = Some("paths".into());
        picked.paths = Some(vec!["src/**/*.rs".into()]);
        let text = rune_text(&picked, &meta, false, false);
        let parsed = crate::rules::rune::parse(&text).unwrap();
        assert_eq!((parsed.activate.as_str(), parsed.paths.as_slice()), ("paths", ["src/**/*.rs".to_string()].as_slice()));
        picked.activate = Some("recall".into());
        picked.paths = None;
        assert!(rune_text(&picked, &meta, false, false).contains("activate: recall\n"));
        assert_eq!(named_set_text("gen-x-0a1b2c3d", "row-x", &[Section { heading: "A".into(), ids: vec!["q".into()] }], &[]), "---\nname: row-x\nkind: set\nscope: [gen-x-0a1b2c3d]\n---\n");
        let a = Section { heading: "A".into(), ids: vec!["q".into()] };
        assert_eq!(named_set_text("gen-0a1b2c3d", "generated-20261017", &[a], &["q".into()]), "---\nname: generated-20261017\nkind: set\nscope: [gen-0a1b2c3d]\n---\n## A\n\n- <?rune q?>\n");
    }

    #[test]
    fn a_new_generate_json_names_no_row() {
        let env = Envelope { runes: Vec::new(), sections: Vec::new(), dropped: Vec::new() };
        let item = ItemSpec { id: "s".into(), kind: "skill", description: "D".into(), source: Some(r"~\s".into()), hook: None, agent: None };
        let meta = Meta { library: "gen-0a1b2c3d", set: "generated-20261017", items: std::slice::from_ref(&item), agent: "claude", model: "m", effort: "e", skill_sha256: "00", date: "2026-10-17", profile: None };
        let r = render(&env, &[], &meta).unwrap();
        let text = generate_json_text(&r.manifest);
        assert!(!text.contains("rowKey"), "{text}");
        let paths: Vec<&str> = r.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, ["skills/s.md", "sets/generated-20261017.md"]);
        assert!(r.files[1].1.contains("## Items\n\n- <?rune s?>\n"), "{}", r.files[1].1);
        assert_eq!(r.on, ["s"]);
    }
}
