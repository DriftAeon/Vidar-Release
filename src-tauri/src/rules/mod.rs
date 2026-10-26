//! src-tauri\src\rules\mod.rs — per-tab rule injection, build side. `rules_prepare` turns a tab's
//! module ids into one built file under `<root>\runtime\rules\built\` (or the key's last-good file
//! when the build fails) and, for Codex, the `-c` / `--profile` form. One concern per file:
//! `rune` (header parse, id grammar), `library` (kind folders, tombstones, containment),
//! `set` (template render, recall), `check` (dangling references),
//! `build` (concatenate, hash, last-good), `codex` (TOML encoding, length rule, app-server argv).
//! Design: docs/runs/2026-10-06-rule-injection/plan.md.

pub mod build;
pub mod catalog;
pub mod check;
pub mod codex;
pub mod context;
pub mod generate;
pub mod fork;
pub mod import;
pub mod library;
pub mod load_history;
pub mod loaded;
pub mod rune;
pub mod set;

use std::path::Path;

use serde::{Deserialize, Serialize};

use codex::CodexRules;
use library::Library;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Client {
    Claude,
    Codex,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RulesPrepared {
    /// Absolute path of the built (or last-good) file; `None` = launch without rules.
    pub file: Option<String>,
    /// Set only for `client = codex` when there is a file.
    pub codex: Option<CodexRules>,
    pub warnings: Vec<String>,
}

fn failed(rules_dir: &Path, key: &str, mut warnings: Vec<String>, errors: Vec<String>) -> RulesPrepared {
    warnings.splice(0..0, errors.into_iter().map(|e| format!("Rules build failed: {e}")));
    match build::last_good(rules_dir, key) {
        build::LastGood::Found(file) => {
            warnings.push("Launched with the last good rules for this tab.".into());
            RulesPrepared { file: Some(file.to_string_lossy().into_owned()), codex: None, warnings }
        }
        build::LastGood::Missing => {
            warnings.push("Launched without rules: the last good build is missing.".into());
            RulesPrepared { warnings, ..Default::default() }
        }
        build::LastGood::None => {
            warnings.push("Launched without rules: no earlier build for this tab.".into());
            RulesPrepared { warnings, ..Default::default() }
        }
    }
}

pub fn prepare_in(
    lib_root: Option<&Path>,
    rules_dir: &Path,
    codex_home: Option<&Path>,
    key: &str,
    ids: &[String],
    client: Client,
) -> RulesPrepared {
    if ids.is_empty() {
        return RulesPrepared::default();
    }
    if key.trim().is_empty() {
        return RulesPrepared {
            warnings: vec!["Rules refused: this row has no key, so a last good build cannot be tracked.".into()],
            ..Default::default()
        };
    }
    let Some(lib_root) = lib_root else {
        return RulesPrepared {
            warnings: vec!["Rules skipped: no rulesLibrary is set in vidar.json.".into()],
            ..Default::default()
        };
    };
    let outcome = Library::open(lib_root)
        .map_err(|e| build::BuildFail { errors: vec![e], warnings: Vec::new() })
        .and_then(|lib| build::build(&lib, ids));
    let mut prepared = match outcome {
        Err(fail) => failed(rules_dir, key, fail.warnings, fail.errors),
        Ok(built) if built.bytes.is_empty() => {
            RulesPrepared { warnings: built.warnings, ..Default::default() }
        }
        Ok(built) => match build::store(rules_dir, key, &built.bytes) {
            Ok((file, note)) => {
                let mut warnings = built.warnings;
                warnings.extend(note);
                RulesPrepared { file: Some(file.to_string_lossy().into_owned()), codex: None, warnings }
            }
            Err(e) => failed(rules_dir, key, built.warnings, vec![e]),
        },
    };
    if client == Client::Codex {
        if let Some(file) = prepared.file.clone() {
            let path = Path::new(&file);
            let hash = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            match crate::fsx::read_text(path).map_err(|e| e.to_string()).and_then(|t| codex::choose(&t, hash, codex_home)) {
                Ok(c) => prepared.codex = Some(c),
                Err(e) => {
                    prepared.file = None;
                    prepared.warnings.push(format!("Launched without rules: Codex form failed: {e}"));
                }
            }
        }
    }
    prepared
}

/// Concurrency note: the build and the last-good map are read-modify-write with no lock; that is safe
/// only because this command is sync (Tauri runs sync commands on the main thread). If it ever goes
/// async, a mutex must wrap `prepare_in`.
#[tauri::command]
pub fn rules_prepare(key: String, ids: Vec<String>, client: Client) -> RulesPrepared {
    if ids.is_empty() {
        return RulesPrepared::default();
    }
    let lib_root = crate::config::load()
        .config
        .rules_library
        .filter(|p| !p.trim().is_empty())
        .map(|p| crate::paths::root().join(p)); // an absolute path replaces the root in `join`
    prepare_in(
        lib_root.as_deref(),
        &crate::paths::rules_dir(),
        codex::codex_home().as_deref(),
        &key,
        &ids,
        client,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fx {
        root: PathBuf,
        lib: PathBuf,
        rules: PathBuf,
    }

    impl Fx {
        fn new(name: &str) -> Fx {
            let root = std::env::temp_dir().join(format!("vidar-rules-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let lib = root.join("lib");
            std::fs::create_dir_all(&lib).unwrap();
            let fx = Fx { rules: root.join("rules"), lib, root };
            fx.put("tombstones.md", "| id | date | superseded_by |\n|----|------|---------------|\n");
            fx
        }
        fn put(&self, rel: &str, text: &str) {
            let p = self.lib.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        /// A rune file: `folder` is `rules|facts|procedures|sets`, `extra` more header lines.
        fn rune(&self, folder: &str, id: &str, extra: &str, body: &str) {
            let kind = rune::KINDS.iter().find(|(f, _)| *f == folder).unwrap().1;
            let text = format!("---\nname: {id}\nkind: {kind}\nscope: [global]\n{extra}---\n{body}");
            self.put(&format!("{folder}/{id}.md"), &text);
        }
        fn rule(&self, id: &str, body: &str) {
            self.rune("rules", id, "", body);
        }
        fn run(&self, key: &str, ids: &[&str]) -> RulesPrepared {
            let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
            prepare_in(Some(&self.lib), &self.rules, None, key, &ids, Client::Claude)
        }
        fn built_files(&self) -> usize {
            std::fs::read_dir(self.rules.join("built")).map(|d| d.count()).unwrap_or(0)
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn joined(p: &RulesPrepared) -> String {
        p.warnings.join(" | ")
    }

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/rune-lib")
    }

    #[test]
    fn missing_id_fails() {
        let fx = Fx::new("missing-id");
        fx.rule("core", "Core rule.\n");
        let p = fx.run("claude-rendered", &["core", "ghost"]);
        assert!(p.file.is_none());
        assert!(joined(&p).contains("`ghost` is not in the rules library"), "{}", joined(&p));
        assert_eq!(fx.built_files(), 0);
    }

    #[test]
    fn tombstoned_id_fails_and_names_it() {
        let fx = Fx::new("tombstone");
        fx.rule("old-rule", "Old.\n");
        fx.put(
            "tombstones.md",
            "| id | date | superseded_by |\n|----|------|---------------|\n| old-rule | 2026-10-01 | core-rules |\n",
        );
        let p = fx.run("k", &["old-rule"]);
        assert!(p.file.is_none());
        let w = joined(&p);
        assert!(w.contains("`old-rule` is tombstoned") && w.contains("core-rules"), "{w}");
    }

    #[test]
    fn missing_import_fails() {
        let fx = Fx::new("import");
        fx.rule("imp", "See @refs/missing.md for more.\n");
        fx.rule("ok", "See @refs/there.md.\n");
        fx.put("refs/there.md", "x");
        let p = fx.run("k", &["imp"]);
        assert!(p.file.is_none() && joined(&p).contains("@refs/missing.md"), "{}", joined(&p));
        let p = fx.run("k", &["ok"]);
        assert!(p.file.is_some(), "{}", joined(&p));
    }

    #[test]
    fn procedure_id_fails() {
        let fx = Fx::new("procedure");
        fx.rune("procedures", "bounded-review", "", "Steps.\n");
        let p = fx.run("k", &["bounded-review"]);
        assert!(p.file.is_none());
        assert!(joined(&p).contains("is a procedure"), "{}", joined(&p));
    }

    #[test]
    fn backtick_path_miss_warns_only() {
        let fx = Fx::new("backtick");
        fx.rule(
            "core",
            "Never edit `src\\gone\\file.rs`. Use the `ghost-skill` skill. See `notes/here.md` and `extra/up.md`.\n",
        );
        fx.put("notes/here.md", "x");
        std::fs::create_dir_all(fx.root.join("extra")).unwrap();
        std::fs::write(fx.root.join("extra").join("up.md"), "x").unwrap(); // the library root's parent
        let p = fx.run("k", &["core"]);
        assert!(p.file.is_some(), "{}", joined(&p));
        let w = joined(&p);
        assert!(w.contains("src\\gone\\file.rs"), "{w}");
        assert!(!w.contains("ghost-skill"), "skill-name heuristic is gone: {w}");
        assert!(!w.contains("notes/here.md") && !w.contains("extra/up.md"), "{w}");
    }

    #[test]
    fn at_tokens_that_are_not_paths_are_prose() {
        let fx = Fx::new("at-tokens");
        fx.rule("p", "Install @scope/pkg or @types/node.d and ping @someone.\n");
        fx.rule("q", "Read @./nothing.txt first.\n");
        let p = fx.run("k", &["p"]);
        assert!(p.file.is_some(), "{}", joined(&p));
        let q = fx.run("other", &["q"]);
        assert!(q.file.is_none() && joined(&q).contains("@./nothing.txt"), "{}", joined(&q));
    }

    #[test]
    fn deleted_last_good_file_says_missing() {
        let fx = Fx::new("last-good-missing");
        fx.rule("core", "Core rule.\n");
        let ok = fx.run("tab", &["core"]);
        std::fs::remove_file(ok.file.unwrap()).unwrap();
        fx.put("tombstones.md", "- core — retired\n");
        let bad = fx.run("tab", &["core"]);
        assert!(bad.file.is_none());
        assert!(joined(&bad).contains("last good build is missing"), "{}", joined(&bad));
        assert!(!joined(&bad).contains("no earlier build"), "{}", joined(&bad));
    }

    #[test]
    fn corrupt_last_good_map_warns_and_is_not_overwritten() {
        let fx = Fx::new("last-good-corrupt");
        fx.rule("core", "Core rule.\n");
        std::fs::create_dir_all(&fx.rules).unwrap();
        std::fs::write(fx.rules.join("last-good.json"), "{ not json").unwrap();
        let p = fx.run("tab", &["core"]);
        assert!(p.file.is_some(), "{}", joined(&p));
        assert!(joined(&p).contains("unreadable"), "{}", joined(&p));
        assert_eq!(std::fs::read_to_string(fx.rules.join("last-good.json")).unwrap(), "{ not json");
    }

    #[test]
    fn disabled_module_skipped_with_warning() {
        let fx = Fx::new("disabled");
        fx.rule("a", "Alpha.\n");
        fx.rune("rules", "b", "state: disabled\n", "Beta.\n");
        fx.rune("rules", "d", "state: draft\n", "Delta.\n");
        fx.rule("c", "Gamma.\n");
        let p = fx.run("k", &["a", "b", "d", "c"]);
        let text = std::fs::read_to_string(p.file.as_ref().unwrap()).unwrap();
        assert_eq!(text, "Alpha.\n\nGamma.\n");
        assert!(joined(&p).contains("`b` is disabled"), "{}", joined(&p));
        assert!(!joined(&p).contains("`d`"), "draft is silent: {}", joined(&p));
    }

    #[test]
    fn id_escape_fails() {
        let fx = Fx::new("escape");
        std::fs::write(fx.root.join("secret.md"), "secret").unwrap();
        let abs = fx.root.join("secret.md").to_string_lossy().into_owned();
        for id in ["..\\secret", "../secret", "a/b", abs.as_str(), "Bad_Id", "con"] {
            let p = fx.run("k", &[id]);
            assert!(p.file.is_none() && joined(&p).contains(" id "), "{id}: {}", joined(&p));
        }
    }

    #[test]
    fn failed_build_keeps_last_good() {
        let fx = Fx::new("last-good");
        fx.rule("core", "Core rule.\n");
        let ok = fx.run("tab", &["core"]);
        let file = ok.file.clone().expect("first build");
        let name = PathBuf::from(&file).file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.len() == 15 && name.ends_with(".md"), "{name}");
        let map_before = std::fs::read(fx.rules.join("last-good.json")).unwrap();
        let count_before = fx.built_files();

        fx.put("tombstones.md", "- core — retired\n");
        let bad = fx.run("tab", &["core"]);
        assert_eq!(bad.file.as_deref(), Some(file.as_str()));
        assert!(joined(&bad).contains("tombstoned") && joined(&bad).contains("last good"), "{}", joined(&bad));
        assert_eq!(std::fs::read(fx.rules.join("last-good.json")).unwrap(), map_before);
        assert_eq!(fx.built_files(), count_before);

        let other = fx.run("other-tab", &["core"]);
        assert!(other.file.is_none(), "no last-good for another key");
    }

    #[test]
    fn empty_key_refused() {
        let fx = Fx::new("empty-key");
        fx.rule("core", "Core rule.\n");
        for key in ["", "  "] {
            let p = fx.run(key, &["core"]);
            assert!(p.file.is_none() && joined(&p).contains("no key"), "{}", joined(&p));
        }
        assert_eq!(fx.built_files(), 0);
    }

    #[test]
    fn codex_client_gets_inline_value() {
        let fx = Fx::new("codex-client");
        fx.rule("core", "Core \"rule\".\n");
        let p = prepare_in(Some(&fx.lib), &fx.rules, None, "k", &["core".to_string()], Client::Codex);
        assert_eq!(p.codex, Some(CodexRules::C { value: "\"Core \\\"rule\\\".\\n\"".into() }));
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["codex"]["mode"], "c");
        assert!(json["file"].is_string() && json["warnings"].is_array());
    }

    #[test]
    fn golden_matches_node() {
        if !fixture_root().exists() {
            eprintln!("skipped: tests/fixtures/rune-lib is not in this tree (not shipped)");
            return;
        }
        let lib = Library::open(&fixture_root().join("runes")).unwrap();
        let entry = lib.entry("fixture-set").unwrap().expect("fixture-set");
        let set = lib.load(&entry).unwrap();
        let rendered = set::render(&lib, &set).unwrap();
        let expected =
            std::fs::read_to_string(fixture_root().join("expected").join("fixture-set.md")).unwrap().replace("\r\n", "\n");
        assert_eq!(rendered.text, expected);
        assert!(rendered.warnings.iter().any(|w| w.contains("`old-rule` is disabled")), "{:?}", rendered.warnings);
    }

    #[test]
    fn header_cases() {
        if !fixture_root().exists() {
            eprintln!("skipped: tests/fixtures/rune-lib is not in this tree (not shipped)");
            return;
        }
        let dir = fixture_root().join("headers");
        let cases: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("cases.json")).unwrap()).unwrap();
        for (file, case) in cases.as_object().unwrap() {
            let mut text = std::fs::read_to_string(dir.join(file)).unwrap().replace("\r\n", "\n");
            if case["crlf"] == true {
                text = text.replace('\n', "\r\n");
            }
            let got = rune::parse(&text);
            let want = case["rust"].as_str().unwrap();
            if want == "ok" {
                let r = got.unwrap_or_else(|e| panic!("{file}: {e}"));
                if let Some(f) = case.get("fields") {
                    if let Some(n) = f.get("name") {
                        assert_eq!(n, &serde_json::json!(r.id), "{file} name");
                    }
                    if let Some(d) = f.get("description") {
                        assert_eq!(d, &serde_json::json!(r.description), "{file} description");
                    }
                    if let Some(s) = f.get("scope") {
                        assert_eq!(s, &serde_json::json!(r.scope), "{file} scope");
                    }
                    if let Some(e) = f.get("enforcedBy") {
                        assert_eq!(e, &serde_json::json!(r.enforced_by), "{file} enforcedBy");
                    }
                }
            } else {
                let e = got.err().unwrap_or_else(|| panic!("{file}: expected an error containing `{want}`"));
                assert!(e.to_lowercase().contains(want), "{file}: `{e}` lacks `{want}`");
            }
        }
    }

    #[test]
    fn nested_set_refused() {
        let fx = Fx::new("nested");
        fx.rune("sets", "inner", "", "Inner.\n");
        fx.rune("sets", "outer", "", "- <?rune inner?>\n");
        let p = fx.run("k", &["outer"]);
        assert!(p.file.is_none() && joined(&p).contains("sets do not nest"), "{}", joined(&p));
    }

    #[test]
    fn contract_decisions() {
        let head = |extra: &str| format!("---\nname: x\nkind: rule\n{extra}---\nb\n");
        assert!(rune::parse(&head("version: 0\n")).unwrap_err().contains("version"));
        assert!(rune::parse(&head("version: 2\n")).is_ok());
        assert!(rune::parse(&head("activate: sometimes\n")).unwrap_err().contains("activate"));
        assert!(rune::parse(&head("activate: paths\n")).is_ok());
        assert!(rune::parse(&head("")).unwrap().scope.is_empty());
        assert_eq!(rune::parse(&head("scope: x\n")).unwrap().scope, vec!["x".to_string()]);
        assert!(!rune::parse(&head("")).unwrap().meets(&["x".to_string()]));

        let fx = Fx::new("scope-meet");
        fx.rune("sets", "s", "", "- <?rune r?>\n");
        fx.put("rules/r.md", "---\nname: r\nkind: rule\nscope: [ue]\n---\nR.\n");
        let p = fx.run("k", &["s"]);
        assert!(joined(&p).contains("slot r: scope does not meet set scope"), "{}", joined(&p));
        // name must equal the stem
        fx.put("rules/q.md", "---\nname: other\nkind: rule\n---\nQ.\n");
        assert!(joined(&fx.run("k", &["q"])).contains("does not match"));
        // a tombstoned slot fails though the file exists
        fx.rule("t", "T.\n");
        fx.rune("sets", "s2", "", "- <?rune t?>\n");
        fx.put("tombstones.md", "- t — gone\n");
        assert!(joined(&fx.run("k2", &["s2"])).contains("`t` is tombstoned"));
    }

    #[test]
    fn duplicate_id_refused() {
        let fx = Fx::new("duplicate");
        fx.rune("rules", "twin", "", "A.\n");
        fx.rune("facts", "twin", "", "B.\n");
        let p = fx.run("k", &["twin"]);
        assert!(p.file.is_none() && joined(&p).contains("exists more than once"), "{}", joined(&p));
        let w = joined(&p);
        assert!(w.contains("rules/twin.md") && w.contains("facts/twin.md"), "{w}");
    }

    fn nested_text(id: &str, kind: &str) -> String {
        format!("---\nname: {id}\nkind: {kind}\nscope: [global]\n---\nBody of {id}.\n")
    }

    #[test]
    fn nested_rune_loads_with_top_folder_kind() {
        let fx = Fx::new("nested-tree");
        fx.put("rules/code/ui/deep.md", &nested_text("deep", "rule"));
        let lib = Library::open(&fx.lib).unwrap();
        let entry = lib.entry("deep").unwrap().expect("deep");
        assert_eq!((entry.kind, entry.folder), ("rule", "rules"));
        assert_eq!(lib.load(&entry).unwrap().kind, "rule");
        let p = fx.run("k", &["deep"]);
        assert!(p.file.is_some(), "{}", joined(&p));
    }

    #[test]
    fn duplicate_id_in_one_tree_names_both_paths() {
        let fx = Fx::new("dup-tree");
        fx.put("rules/core/same.md", &nested_text("same", "rule"));
        fx.put("rules/code/same.md", &nested_text("same", "rule"));
        let p = fx.run("k", &["same"]);
        let w = joined(&p);
        assert!(p.file.is_none() && w.contains("rules/core/same.md") && w.contains("rules/code/same.md"), "{w}");
    }
}
