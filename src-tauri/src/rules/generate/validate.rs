//! src-tauri\src\rules\generate\validate.rs — the D3 check of a rendered generation, result split per E5.
//! Structural (Output Rejected, nothing lands): a rune file `rune::parse` refuses or whose header holds a key
//! outside `render::KEYS`; `Library::open` or `build::build_in` (Bare context) of the row set failing; and the
//! `bare/layer.rs` spawn refusals re-run on the payload this row would get: the `{{sets}}` slot count and the empty
//! build (`:86-98`), the marker and the profile-path / placeholder guard (`:126-137`). Advisory: build warnings and,
//! on Codex rows the encoded payload size is reported (`encoded_chars`); there is no length cap.
//! The library is written to a scratch folder under `%TEMP%` and removed after.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use super::render::{Meta, Rendered, KEYS};
use crate::bare::home::{guard_brick, Guard};
use crate::bare::layer::{self, RowSets, SetRef};
use crate::rules::codex::encode_toml_string;
use crate::rules::{build, context::RenderCtx, library::Library, rune};

/// The spawn this generation is checked against.
pub struct PayloadCtx<'a> {
    /// `claude` or `codex`.
    pub agent: &'a str,
    /// The profile's `setsPayload` text with `{{root}}` filled and, on Codex, the skills listing folded in after
    /// `{{sets}}` (as `bare/mod.rs` `codex_instructions` does).
    pub template: &'a str,
    /// The row's other refs, placed ahead of the generated set; `None` when it has none.
    pub row: Option<RowRefs<'a>>,
    /// Install root and Bare home, so their paths pass the profile guard as at spawn.
    pub root: &'a str,
    pub home: &'a str,
    pub guard: &'a Guard,
}

/// The refs of the row that survive the commit, resolved as a spawn resolves them.
pub struct RowRefs<'a> {
    pub refs: &'a [SetRef],
    /// `rulesLibrary`, under `PayloadCtx::root`.
    pub rules_library: Option<&'a str>,
    /// `runtime\runes\`.
    pub imports: &'a Path,
}

#[derive(Debug, Default)]
pub struct Checked {
    pub structural: Vec<String>,
    pub warnings: Vec<String>,
    pub encoded_chars: Option<usize>,
}

/// Header keys of a rune file (the lines between the opening and closing `---`, list items skipped).
fn header_keys(text: &str) -> Vec<String> {
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Vec::new();
    }
    lines
        .take_while(|l| *l != "---")
        .filter(|l| !l.starts_with([' ', '\t']))
        .filter_map(|l| l.split_once(':').map(|(k, _)| k.to_string()))
        .collect()
}

static SCRATCH: AtomicUsize = AtomicUsize::new(0);

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn validate(rendered: &Rendered, meta: &Meta, payload: &PayloadCtx) -> Checked {
    let mut c = Checked::default();
    for (rel, text) in rendered.files.iter().filter(|(rel, _)| rel.ends_with(".md")) {
        if let Err(e) = rune::parse(text) {
            c.structural.push(format!("`{rel}`: {e}"));
        }
        for k in header_keys(text).iter().filter(|k| !KEYS.contains(&k.as_str())) {
            c.structural.push(format!("`{rel}`: header key `{k}` is not in the rune header subset"));
        }
    }

    let n = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let scratch = Scratch(std::env::temp_dir().join(format!("vidar-gen-validate-{}-{n}", std::process::id())));
    let dir = scratch.0.join(meta.library);
    for (rel, text) in &rendered.files {
        let path = dir.join(rel);
        let wrote = path.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::write(&path, text));
        if let Err(e) = wrote {
            c.structural.push(format!("scratch library {}: {e}", path.display()));
            return c;
        }
    }
    let lib = match Library::open(&dir) {
        Ok(l) => l,
        Err(e) => {
            c.structural.push(e);
            return c;
        }
    };
    let set = format!("row-{}", meta.row_key);
    let built = match build::build_in(&lib, std::slice::from_ref(&set), &RenderCtx::bare(BTreeSet::new())) {
        Ok(b) => b,
        Err(f) => {
            c.structural.extend(f.errors);
            c.warnings.extend(f.warnings);
            return c;
        }
    };
    c.warnings.extend(built.warnings);
    let text = String::from_utf8_lossy(&built.bytes).replace('\r', "");
    if text.trim().is_empty() {
        c.structural.push(format!("Rune set `{set}` built empty: no rune is On"));
        return c;
    }

    // bare/layer.rs build_payload :86-98, write_filled :126-137.
    let slots = payload.template.matches("{{sets}}").count();
    if slots != 1 {
        c.structural.push(format!("Bare sets payload template holds {{{{sets}}}} {slots} times, not once"));
        return c;
    }
    // The whole row as the spawn builds it (`layer::row_text`): the surviving refs, then the generated set.
    let mut sets: Vec<SetRef> = payload.row.as_ref().map(|r| r.refs.to_vec()).unwrap_or_default();
    sets.push(SetRef { library: Some(meta.library.to_string()), set: set.clone() });
    let row = RowSets { sets, rules_library: payload.row.as_ref().and_then(|r| r.rules_library.map(str::to_string)) };
    let imports = payload.row.as_ref().map(|r| r.imports);
    let resolve = |r: &SetRef| -> Result<PathBuf, String> {
        match r.library.as_deref() {
            Some(l) if l == meta.library => Ok(dir.clone()),
            Some(l) => match (rune::check_id(l), imports) {
                (Ok(_), Some(base)) => Ok(base.join(l)),
                _ => Err(format!("library {l:?} cannot be resolved")),
            },
            None => row.rules_library.as_deref().map(|r| Path::new(payload.root).join(r)).ok_or_else(|| "rulesLibrary is not set".to_string()),
        }
    };
    let filled = match layer::row_text(payload.template, &row, &RenderCtx::bare(BTreeSet::new()), &resolve) {
        Ok((filled, _, w)) => {
            let fresh: Vec<String> = w.into_iter().filter(|x| !c.warnings.contains(x)).collect();
            c.warnings.extend(fresh);
            filled
        }
        Err(e) => {
            c.warnings.push(format!("The row's payload size was not measured: {}", e.trim_end_matches("; Bare spawn refused")));
            return c;
        }
    };
    let body: String = filled.trim_end().lines().map(|l| format!("{l}\n")).collect();
    let marked = format!("{body}VIDAR-PAYLOAD-{}\n", build::hash12(body.as_bytes()));
    if let Err(e) = guard_brick(&marked, payload.root, payload.home, payload.guard) {
        c.structural.push(e.replacen("Rune brick", "Row payload", 1));
        return c;
    }

    // Bare Codex rows have no length cap (Raw rides `--profile`, Rendered `thread/start`); the size is only reported.
    if payload.agent == "codex" {
        c.encoded_chars = Some(encode_toml_string(&marked).chars().count());
    }
    c
}

#[cfg(test)]
mod tests {
    use super::super::envelope::{Envelope, RuneOut, Section, Source};
    use super::super::{input_text, prepare, render, Input};
    use super::*;
    use std::path::Path;

    const PATH: &str = r"~\.claude\CLAUDE.md";

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn guard() -> Guard {
        Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) }
    }

    fn meta() -> Meta<'static> {
        Meta {
            library: "gen-claude-rendered-bare-0a1b2c3d",
            row_key: "claude-rendered-bare",
            agent: "claude",
            model: "sonnet",
            effort: "medium",
            skill_sha256: "00",
            date: "2026-10-17",
            profile: Some(r"C:\Users\testuser"),
        }
    }

    fn template(agent: &str) -> String {
        let file = if agent == "codex" { "codex.payload-sets.md" } else { "payload-sets.md" };
        std::fs::read_to_string(repo().join("profiles/bare").join(file)).unwrap().replace("{{root}}", r"D:\Vidar")
    }

    fn check(reply: &str, inputs: &[Input], agent: &str) -> Result<super::super::Prepared, Vec<String>> {
        let tpl = template(agent);
        let g = guard();
        let ctx = PayloadCtx { agent, template: &tpl, row: None, root: r"D:\Vidar", home: r"D:\Home", guard: &g };
        let m = Meta { agent, ..meta() };
        prepare(reply, inputs, &m, &ctx)
    }

    /// The first fenced block tagged `tag` in `text`.
    fn fenced<'a>(text: &'a str, tag: &str) -> &'a str {
        let open = format!("```{tag}\n");
        let start = text.find(&open).unwrap_or_else(|| panic!("no ```{tag} block")) + open.len();
        &text[start..start + text[start..].find("\n```").unwrap() + 1]
    }

    /// Inputs back out of the skill's documented stdin form.
    fn parse_input_text(text: &str) -> Vec<Input> {
        let mut out: Vec<Input> = Vec::new();
        for l in text.lines() {
            if let Some(rest) = l.strip_prefix("=== FILE ") {
                let path = rest.rsplit_once(" (").unwrap().0;
                out.push(Input { path: path.into(), text: String::new() });
            } else if let Some(rest) = l.strip_prefix('L').filter(|_| !out.is_empty()) {
                let (_, line) = rest.split_once(':').unwrap();
                let cur = out.last_mut().unwrap();
                cur.text.push_str(line.strip_prefix(' ').unwrap_or(line));
                cur.text.push('\n');
            }
        }
        out
    }

    fn rune(id: &str, kind: &str, body: &str, line: usize) -> RuneOut {
        RuneOut {
            id: id.into(),
            kind: kind.into(),
            description: format!("About {id}"),
            body: body.into(),
            sources: vec![Source { path: PATH.into(), line }],
        }
    }

    fn reply(runes: Vec<RuneOut>) -> String {
        let ids = runes.iter().map(|r| r.id.clone()).collect();
        let env = Envelope { runes, sections: vec![Section { heading: "Rules".into(), ids }], dropped: vec![] };
        serde_json::to_string(&env).unwrap()
    }

    fn input(lines: usize) -> Vec<Input> {
        vec![Input { path: PATH.into(), text: (1..=lines).map(|n| format!("Line {n}.\n")).collect() }]
    }

    fn file<'a>(p: &'a super::super::Prepared, rel: &str) -> &'a str {
        &p.files.iter().find(|(r, _)| r == rel).unwrap_or_else(|| panic!("no {rel}")).1
    }

    #[test]
    fn skill_example_parses_and_renders() {
        let skill = std::fs::read_to_string(repo().join("profiles/bare/rune-create/SKILL.md")).unwrap().replace("\r\n", "\n");
        assert!(skill.len() < 6 * 1024, "SKILL.md is {} bytes", skill.len());
        let shown = fenced(&skill, "text");
        let inputs = parse_input_text(shown);
        assert_eq!(input_text(&inputs, "claude", None), shown, "the documented input form drifted from input_text");
        let p = check(fenced(&skill, "json"), &inputs, "claude").unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!((p.runes, p.on), (3, 3));
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
        assert_eq!(p.encoded_chars, None);
        let set = file(&p, "sets/row-claude-rendered-bare.md");
        assert!(set.contains("## Git\n\n- <?rune no-force-push?>\n- <?rune test-before-commit?>\n\n## Layout\n\n- <?rune source-layout?>\n"), "{set}");
        let rule = file(&p, "rules/no-force-push.md");
        assert!(rule.contains("origin: \"2026-10-17 ~\\\\.claude\\\\CLAUDE.md:3\"\n"), "{rule}");
        let g: render::GenerateJson = serde_json::from_str(file(&p, "generate.json")).unwrap();
        assert_eq!(g.runes[0].sources.len(), 2);
        assert_eq!(g.dropped[0].line, 6);
        assert_eq!(p.files.last().unwrap().0, "generate.json");
    }

    #[test]
    fn facts_land_in_the_facts_folder_and_load() {
        let r = reply(vec![rune("core-rule", "rule", "Never guess.", 1), rune("repo-fact", "fact", "Sources live in src/.", 2)]);
        let p = check(&r, &input(2), "claude").unwrap_or_else(|e| panic!("{e:?}"));
        assert!(file(&p, "facts/repo-fact.md").contains("kind: fact\n"));
        assert!(!p.files.iter().any(|(rel, _)| rel == "rules/repo-fact.md"));
        let dir = std::env::temp_dir().join(format!("vidar-gen-facts-{}", std::process::id()));
        let _scratch = Scratch(dir.clone());
        for (rel, text) in &p.files {
            std::fs::create_dir_all(dir.join(rel).parent().unwrap()).unwrap();
            std::fs::write(dir.join(rel), text).unwrap();
        }
        let lib = Library::open(&dir).unwrap();
        let e = lib.entry("repo-fact").unwrap().expect("repo-fact");
        assert_eq!((e.kind, e.folder), ("fact", "facts"));
        assert_eq!(lib.load(&e).unwrap().activate, "always");
        let built = build::build(&lib, &["row-claude-rendered-bare".to_string()]).map_err(|f| f.errors).unwrap();
        assert!(String::from_utf8(built.bytes).unwrap().contains("- Sources live in src/."));
    }

    #[test]
    fn profile_path_and_placeholder_lock_draft_and_off() {
        let r = reply(vec![
            rune("keep-me", "rule", "Never guess.", 1),
            rune("profile-path", "rule", r"Read C:\Users\testuser\notes.md first.", 2),
            rune("braces", "rule", "Fill {{name}} in.", 3),
        ]);
        let p = check(&r, &input(3), "claude").unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!((p.runes, p.on), (3, 1));
        let prof = file(&p, "rules/profile-path.md");
        assert!(prof.contains("state: draft\n") && prof.contains("\"!bare\"]"), "{prof}");
        let br = file(&p, "rules/braces.md");
        assert!(br.contains("state: draft\n") && !br.contains("!bare"), "{br}");
        assert!(file(&p, "rules/keep-me.md").contains("state: active\n"));
        let set = file(&p, "sets/row-claude-rendered-bare.md");
        assert!(set.contains("<?rune keep-me?>") && !set.contains("profile-path") && !set.contains("braces"), "{set}");
        let locked: Vec<&str> = p.manifest.runes.iter().filter(|r| r.locked).map(|r| r.id.as_str()).collect();
        assert_eq!(locked, ["profile-path", "braces"]);
    }

    #[test]
    fn all_off_is_structural() {
        let r = reply(vec![rune("braces", "rule", "Fill {{name}} in.", 1)]);
        let e = check(&r, &input(1), "claude").expect_err("all-Off must not land");
        assert!(e.iter().any(|m| m.contains("built empty")), "{e:?}");
    }

    #[test]
    fn codex_rows_past_12000_characters_carry_no_limit_or_warning() {
        let runes = (0..14).map(|k| rune(&format!("long-{k}"), "rule", &format!("Never {}.", "x".repeat(950)), 1)).collect();
        let p = check(&reply(runes), &input(1), "codex").unwrap_or_else(|e| panic!("{e:?}"));
        let n = p.encoded_chars.unwrap();
        assert!(n > 12_000, "{n}");
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
        assert_eq!(p.manifest.encoded_chars, Some(n));
    }

    #[test]
    fn header_keys_outside_the_subset_are_structural() {
        assert_eq!(header_keys("---\nname: a\nscope:\n  - x\nbogus: 1\n---\nb\n"), ["name", "scope", "bogus"]);
    }
}
