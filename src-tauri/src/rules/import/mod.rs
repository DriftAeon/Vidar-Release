//! src-tauri\src\rules\import\mod.rs — import an existing rules file (CLAUDE.md, AGENTS.md) as a rune library
//! of bricks, for Bare onboarding (docs/projects/bare/onboarding-plan.md). `split` turns text into bricks and
//! a slot template; `write` puts them on disk as a standard library (`Library::open`, `cook --root`).
//! `sources` lists the files to offer, `assign` keeps the row refs in vidar.json, and `commands` is the
//! `rules_import_*` IPC over all of them. For the Bare Runes tab, `local` lists every local file it offers
//! (`bare_local_sources`), `codex_home` adds what a Codex home offers to it, `claude_json` the user-scope
//! MCP servers of `~/.claude.json`, and `memory` reads a Claude memory folder as one source.
#![cfg_attr(not(test), allow(dead_code))] // split.rs keeps `Brick::kind`, `Split::text` and `warnings` for its tests.

pub mod assign;
pub mod claude_json;
pub mod codex_home;
pub mod commands;
pub mod local;
pub mod memory;
pub mod sources;
pub mod split;
pub mod worktree;
pub mod write;

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::split::{split, Kind, Part};
    use super::write::{set_body, write_library, Meta};
    use crate::rules::library::Library;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/rune-import")
    }

    /// Fixture text LF-normalised (a CRLF checkout must not change the goldens).
    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap().replace("\r\n", "\n")
    }

    /// `source.md` as an editor might save it: a BOM and one CRLF line (git would normalise both on disk).
    fn raw_source() -> String {
        format!("\u{FEFF}{}", read(&fixture().join("source.md")).replacen('\n', "\r\n", 1))
    }

    const META: Meta = Meta { name: "acme-claude-md", source: "~/Acme/CLAUDE.md", date: "2026-10-16" };
    /// A synthetic user profile; tests never read the real one.
    const PROFILE: &str = r"C:\Users\example-user";

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-rune-import-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn splitting_the_fixture_gives_the_golden_bricks() {
        let raw = raw_source();
        assert!(raw.starts_with('\u{FEFF}') && raw.contains("\r\n") && raw.contains("lands.   \n"));
        let s = split(&raw, &[], PROFILE);
        assert!(s.warnings.is_empty() && s.bricks.iter().all(|b| !b.not_bare));
        // `text` (hashed) is BOM, CRLF and trailing-space normalised; `normalised.md` is the full keep, where
        // `+ ` bullets also read `- `.
        let full = read(&fixture().join("normalised.md"));
        assert_eq!(s.text, full.replace("\n- Use", "\n+ Use").replace("\n- Wrap", "\n+ Wrap"));
        assert_eq!(s.sha256, super::split::sha256_hex(&s.text));
        let got: Vec<(&str, Kind, &str, usize, Option<&str>)> = s
            .bricks
            .iter()
            .map(|b| (b.id.as_str(), b.kind, b.prefix, b.line, b.section.last().map(String::as_str)))
            .collect();
        let golden = vec![
            ("keep-every-change-small-1", Kind::Prose, "", 3, Some("Acme Rules")),
            ("run-the-build-with-1", Kind::List, "", 9, Some("Build")),
            ("keep-build-output-in-1", Kind::List, "- ", 11, Some("Build")),
            ("tests-run-through-the-1", Kind::List, "- ", 13, Some("Build")),
            ("sh-run-from-the-1", Kind::Fence, "", 14, Some("Build")),
            ("use-sentence-case-in-1", Kind::List, "- ", 21, Some("Style")),
            ("wrap-commit-bodies-at-1", Kind::List, "- ", 22, Some("Style")),
            ("tool-use-npm-builds-1", Kind::Table, "", 26, Some("Style")),
            ("lint-too-1", Kind::List, "- ", 30, Some("Style")),
        ];
        assert_eq!(got, golden);
        // Short items merge into their own kind only: prose into prose, a list item into a list item.
        assert_eq!(s.bricks[0].body, "Keep every change small and reviewed before it lands.\n\nAsk first.");
        assert_eq!(s.bricks[1].body, "- Run the build with `npm run build` before every commit.\n- Short one here.");
        assert_eq!(s.bricks[2].body, "Keep build output in C:\\Projects\\Acme\\dist and never commit it.\nThe release script copies it from there.");
        assert_eq!(s.bricks[6].body, "Wrap commit bodies at seventy-two characters.\n- A nested detail stays with its parent item.");
        assert!(s.bricks[4].body.starts_with("```sh\n# run") && s.bricks[4].body.ends_with("\n```"));
        assert_eq!(s.bricks[0].section, vec!["Acme Rules".to_string()]);
        assert_eq!(s.bricks[0].sha256, super::split::sha256_hex(&s.bricks[0].body));
        // A full keep renders back to the normalised text, bullet markers as `- `.
        let all: Vec<String> = s.bricks.iter().map(|b| b.id.clone()).collect();
        let slots = set_body(&s, &all);
        assert_eq!(slots.lines().count(), 20, "{slots}");
        assert!(s.parts.iter().any(|p| matches!(p, Part::Heading { level: 2, .. })));
    }

    #[test]
    fn a_row_without_a_section_drops_its_heading_and_doubled_blank() {
        let s = split(&raw_source(), &[], PROFILE);
        let ids: Vec<String> = s.bricks.iter().filter(|b| b.section.last().is_some_and(|h| h != "Build")).map(|b| b.id.clone()).collect();
        let body = set_body(&s, &ids);
        assert!(!body.contains("## Build") && !body.contains("\n\n\n") && body.contains("## Style"), "{body}");
        let taken = vec!["lint-too-1".to_string()];
        assert_eq!(split(&raw_source(), &taken, PROFILE).bricks[8].id, "lint-too-2");
        assert_eq!(super::split::slug("— ü ★"), "rule");
    }

    fn files(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
                }
            }
        }
        out.sort();
        out
    }

    #[test]
    fn the_writer_output_matches_the_fixture_library_and_opens_with_library_open() {
        let s = split(&raw_source(), &[], PROFILE);
        let dir = std::env::temp_dir().join(format!("vidar-rune-import-{}", std::process::id())).join("acme-claude-md");
        let _ = std::fs::remove_dir_all(&dir);
        let all: Vec<String> = s.bricks.iter().map(|b| b.id.clone()).collect();
        let rows = vec![("claude-bare".to_string(), all.clone()), ("claude-rendered-bare".to_string(), Vec::new())];
        let written = write_library(&dir, &s, &META, &all, &rows, false).unwrap();
        assert_eq!(written.len(), s.bricks.len() + 2);
        // Writing the same library again changes nothing.
        assert!(write_library(&dir, &s, &META, &all, &rows, false).unwrap().is_empty());

        let golden = fixture().join("acme-claude-md");
        assert_eq!(files(&dir), files(&golden));
        for f in files(&golden) {
            assert_eq!(read(&dir.join(&f)), read(&golden.join(&f)), "{f} differs (output in {})", dir.display());
        }

        let lib = Library::open(&dir).unwrap();
        let (runes, errors) = lib.all_runes();
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(runes.len(), s.bricks.len() + 1);
        let set = lib.load(&lib.entry("acme-claude-md").unwrap().unwrap()).unwrap();
        let rendered = crate::rules::set::render(&lib, &set).map_err(|e| e.join("; ")).unwrap();
        assert_eq!(rendered.text, read(&fixture().join("normalised.md")));
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_scope_context_is_refused_as_a_library_name() {
        let s = split("Keep every change small and reviewed.\n", &[], PROFILE);
        let dir = temp("context");
        let meta = Meta { name: "bare", ..META };
        let err = write_library(&dir, &s, &meta, &[], &[], false).unwrap_err();
        assert!(err.contains("scope context"), "{err}");
        assert!(!dir.exists());
    }

    #[test]
    fn a_row_key_never_names_a_file() {
        let s = split("Keep every change small and reviewed.\n", &[], PROFILE);
        let dir = temp("badkey").join("acme-claude-md");
        let rows = vec![("Bad_Key".to_string(), Vec::new())];
        write_library(&dir, &s, &META, &[], &rows, false).unwrap();
        assert!(!dir.join("sets").exists(), "no row takes a brick, so no set");
        let with_ids = vec![("Bad_Key".to_string(), vec![s.bricks[0].id.clone()])];
        write_library(&dir, &s, &META, &[], &with_ids, true).unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.join("sets")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["acme-claude-md.md".to_string()]);
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn an_msys_profile_path_is_scoped_out_of_bare() {
        let s = split("Keep scripts in /c/Users/EXAMPLE-USER/bin for now.\n", &[], PROFILE);
        assert!(s.bricks[0].not_bare, "{:?}", s.bricks[0].body);
        assert_eq!(s.warnings.len(), 1);
    }

    #[test]
    fn a_brick_naming_the_profile_path_is_scoped_out_of_bare_with_one_warning() {
        let src = "# Paths\n\nLogs go to c:/users/EXAMPLE-USER/logs on this machine.\n\nKeep every change small and reviewed.\n";
        let s = split(src, &[], PROFILE);
        let flagged: Vec<&str> = s.bricks.iter().filter(|b| b.not_bare).map(|b| b.id.as_str()).collect();
        assert_eq!(flagged, vec![s.bricks[0].id.as_str()]);
        assert_eq!(s.warnings.len(), 1);
        assert!(s.warnings[0].contains(&s.bricks[0].id) && s.warnings[0].contains("(Paths)"), "{}", s.warnings[0]);
        let text = super::write::rune_text(&s.bricks[0], &META, true);
        assert!(text.contains("\nscope: [acme-claude-md, \"!bare\"]\n"), "{text}");
        assert!(super::write::rune_text(&s.bricks[1], &META, true).contains("\nscope: [acme-claude-md]\n"));
        // The written library still parses, the `!bare` brick included.
        let dir = temp("profile").join("acme-claude-md");
        let all: Vec<String> = s.bricks.iter().map(|b| b.id.clone()).collect();
        write_library(&dir, &s, &META, &all, &[("claude-bare".to_string(), all.clone())], false).unwrap();
        let lib = Library::open(&dir).unwrap();
        let (runes, errors) = lib.all_runes();
        assert!(errors.is_empty(), "{errors:?}");
        assert!(runes.iter().any(|(r, _)| r.scope.iter().any(|x| x == "!bare")));
        assert!(split(src, &[], "").warnings.is_empty());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn a_bad_brick_id_is_refused_before_any_write() {
        let mut s = split("Keep every change small and reviewed.\n", &[], PROFILE);
        s.bricks[0].id = "Bad Id".to_string();
        let dir = temp("bad-id");
        let err = write_library(&dir, &s, &META, &[], &[], false).unwrap_err();
        assert!(err.contains("brick"), "{err}");
        assert!(!dir.exists());
    }

    #[test]
    fn a_differing_file_is_kept_unless_overwrite() {
        let s = split("Keep every change small and reviewed.\n", &[], PROFILE);
        let dir = temp("overwrite");
        let target = dir.join("rules").join(format!("{}.md", s.bricks[0].id));
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "hand edited\n").unwrap();
        let err = write_library(&dir, &s, &META, &[], &[], false).unwrap_err();
        assert!(err.contains("other content"), "{err}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hand edited\n");
        assert!(!dir.join("import.json").exists(), "nothing is written when one file is refused");
        let written = write_library(&dir, &s, &META, &[], &[], true).unwrap();
        assert_eq!(written.len(), 2);
        assert!(std::fs::read_to_string(&target).unwrap().contains("state: draft"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn front_matter_is_skipped_not_kept_as_template_text() {
        let s = split("---\ntitle: x\n---\n\n# Rules\n\nKeep every change small and reviewed.\n", &[], PROFILE);
        assert_eq!(s.bricks.len(), 1);
        assert_eq!(s.bricks[0].line, 7);
        let body = set_body(&s, &[s.bricks[0].id.clone()]);
        assert_eq!(body, format!("# Rules\n\n<?rune {}?>\n", s.bricks[0].id));
    }
}
