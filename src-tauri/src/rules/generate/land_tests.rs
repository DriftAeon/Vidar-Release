//! Tests for `land.rs`: landing, the stale check, toggling and the Actives read, all on temp roots.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::super::envelope::{Envelope, RuneOut, Section, Source};
use super::super::render::Meta;
use super::super::validate::{PayloadCtx, RowRefs};
use super::super::{prepare, Input, Prepared};
use super::*;
use crate::bare::actives::{self, ActivesEnv};
use crate::bare::home::Guard;
use crate::bare::layer::SetRef;
use crate::rules::{build, context::RenderCtx, library::Library};

const ROW: &str = "claude-rendered-bare";
const PATH: &str = r"~\.claude\CLAUDE.md";
const GEN_A: &str = "gen-claude-rendered-bare-0a1b2c3d";
const GEN_B: &str = "gen-claude-rendered-bare-4e5f6a7b";

struct Fx {
    base: PathBuf,
    root: PathBuf,
    imports: PathBuf,
    index: PathBuf,
    home: PathBuf,
    config: PathBuf,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("vidar-land-{tag}-{}-{nanos}", std::process::id()));
        let (root, home) = (base.join("root"), base.join("home"));
        let imports = root.join("imports");
        std::fs::create_dir_all(&imports).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude").join("CLAUDE.md"), "Line 1.\nLine 2.\nLine 3.\n").unwrap();
        let config = root.join("config.json");
        let index = imports.join("rowlib.json");
        Fx { base, root, imports, index, home, config }
    }

    fn env(&self) -> LandEnv<'_> {
        LandEnv { config: &self.config, root: &self.root, imports: &self.imports, index: &self.index, home: Some(&self.home), cwd: None, primary: "claude" }
    }

    fn input_lib(&self) -> String {
        let p = sources::expand(PATH, Some(&self.home));
        sources::library_of(&self.imports, &p, Some(&self.home), None, "claude")
    }

    fn write_config(&self, sets: Value) {
        let v = json!({ "agents": [{ "key": ROW, "sets": sets }] });
        std::fs::write(&self.config, v.to_string()).unwrap();
    }

    fn config_json(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&self.config).unwrap()).unwrap()
    }

    /// The row's library names in ref order.
    fn refs(&self) -> Vec<String> {
        let v = self.config_json();
        v["agents"][0]["sets"].as_array().unwrap().iter().map(|r| r["library"].as_str().unwrap().to_string()).collect()
    }

    fn revision(&self) -> String {
        row_revision_at(&self.env(), ROW).unwrap()
    }

    fn actives(&self) -> actives::Actives {
        actives::read(&ActivesEnv { config: &self.config, root: &self.root, imports: &self.imports, index: &self.index, home: Some(&self.home) }, ROW).unwrap()
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn input() -> Vec<Input> {
    vec![Input { path: PATH.into(), text: "Line 1.\nLine 2.\nLine 3.\n".into() }]
}

fn rune(id: &str, body: &str, line: usize) -> RuneOut {
    RuneOut {
        id: id.into(),
        kind: "rule".into(),
        description: format!("About {id}"),
        body: body.into(),
        sources: vec![Source { path: PATH.into(), line }],
    }
}

/// A prepared generation named `library`: `keep-a` and `keep-b` On, plus `braces` locked draft.
fn prepared(library: &str) -> Prepared {
    let runes = vec![rune("keep-a", "Never guess.", 1), rune("keep-b", "Always test.", 2), rune("braces", "Fill {{name}} in.", 3)];
    let ids = runes.iter().map(|r| r.id.clone()).collect();
    let env = Envelope { runes, sections: vec![Section { heading: "Rules".into(), ids }], dropped: vec![] };
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let template = std::fs::read_to_string(repo.join("profiles/bare/payload-sets.md")).unwrap().replace("{{root}}", r"D:\Vidar");
    let guard = Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) };
    let ctx = PayloadCtx { agent: "claude", template: &template, row: None, root: r"D:\Vidar", home: r"D:\Home", guard: &guard };
    let meta = Meta {
        library,
        row_key: ROW,
        agent: "claude",
        model: "sonnet",
        effort: "medium",
        skill_sha256: "00",
        date: "2026-10-17",
        profile: Some(r"C:\Users\testuser"),
    };
    prepare(&serde_json::to_string(&env).unwrap(), &input(), &meta, &ctx).unwrap_or_else(|e| panic!("{e:?}"))
}

fn set_ref(library: &str) -> Value {
    json!({ "library": library, "set": format!("row-{ROW}") })
}

#[test]
fn commit_lands_a_readable_library_and_swaps_refs() {
    let fx = Fx::new("commit");
    let input_lib = fx.input_lib();
    fx.write_config(json!([set_ref(&input_lib), { "library": "other-lib", "set": "x" }, set_ref(GEN_A)]));
    let start = fx.revision();
    let landed = commit_at(&fx.env(), &prepared(GEN_B), ROW, &start, &input()).unwrap();
    assert_eq!(landed.library, GEN_B);
    assert_eq!(landed.dropped.len(), 2);
    assert!(landed.dropped.contains(&input_lib) && landed.dropped.contains(&GEN_A.to_string()));
    assert_eq!(fx.refs(), ["other-lib", GEN_B]);
    assert_eq!(read_index(&fx.index).get(ROW).map(String::as_str), Some(GEN_B));
    let lib = Library::open(&fx.imports.join(GEN_B)).unwrap();
    let built = build::build_in(&lib, &[format!("row-{ROW}")], &RenderCtx::bare(Default::default())).map_err(|f| f.errors).unwrap();
    let text = String::from_utf8(built.bytes).unwrap();
    assert!(text.contains("Never guess.") && text.contains("Always test.") && !text.contains("Fill"), "{text}");
    assert!(fx.imports.join(GEN_B).join("generate.json").is_file());
    assert!(!std::fs::read_dir(&fx.imports).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".tmp-")));
    assert!(commit_at(&fx.env(), &prepared(GEN_B), ROW, &fx.revision(), &input()).unwrap_err().starts_with("invalid:"), "write-once");
}

fn old_sidecar(fx: &Fx, set: &str, body: &str) {
    let dir = fx.imports.join(GEN_A).join("sets");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{set}.layer.json")), body).unwrap();
}

#[test]
fn regenerating_carries_the_set_layer_sidecar_byte_identical() {
    let fx = Fx::new("carry");
    fx.write_config(json!([set_ref(GEN_A)]));
    let body = "{ \"codexSkills\": [\"~/s/one\"] }\r\n";
    old_sidecar(&fx, &format!("row-{ROW}"), body);
    let start = fx.revision();
    let landed = commit_at(&fx.env(), &prepared(GEN_B), ROW, &start, &input()).unwrap();
    let got = std::fs::read(fx.imports.join(GEN_B).join("sets").join(format!("row-{ROW}.layer.json"))).unwrap();
    assert_eq!(got, body.as_bytes());
    assert!(landed.warnings.is_empty(), "{:?}", landed.warnings);
}

#[test]
fn a_set_missing_from_the_new_library_is_skipped_with_a_warning() {
    let fx = Fx::new("carry-missing");
    fx.write_config(json!([set_ref(GEN_A)]));
    old_sidecar(&fx, "gone", "{}");
    let start = fx.revision();
    let landed = commit_at(&fx.env(), &prepared(GEN_B), ROW, &start, &input()).unwrap();
    assert!(!fx.imports.join(GEN_B).join("sets").join("gone.layer.json").exists());
    assert!(landed.warnings.iter().any(|w| w.contains("`gone`") && w.contains("no longer exists")), "{:?}", landed.warnings);
}

#[test]
fn an_existing_sidecar_in_the_new_library_is_not_overwritten() {
    let fx = Fx::new("carry-keep");
    fx.write_config(json!([set_ref(GEN_A)]));
    old_sidecar(&fx, &format!("row-{ROW}"), "{ \"skills\": [\"old\"] }");
    let mut p = prepared(GEN_B);
    p.files.push((format!("sets/row-{ROW}.layer.json"), "{ \"skills\": [\"new\"] }".into()));
    let start = fx.revision();
    commit_at(&fx.env(), &p, ROW, &start, &input()).unwrap();
    let got = std::fs::read_to_string(fx.imports.join(GEN_B).join("sets").join(format!("row-{ROW}.layer.json"))).unwrap();
    assert_eq!(got, "{ \"skills\": [\"new\"] }");
}

#[test]
fn stale_when_the_rows_refs_change() {
    let fx = Fx::new("stale-refs");
    fx.write_config(json!([set_ref(&fx.input_lib())]));
    let start = fx.revision();
    fx.write_config(json!([set_ref(&fx.input_lib()), { "library": "added", "set": "y" }]));
    let before = std::fs::read_to_string(&fx.config).unwrap();
    let err = commit_at(&fx.env(), &prepared(GEN_A), ROW, &start, &input()).unwrap_err();
    assert!(err.starts_with("stale:"), "{err}");
    assert_eq!(std::fs::read_to_string(&fx.config).unwrap(), before);
    assert!(fx.imports.join(GEN_A).is_dir(), "the new folder stays, unreferenced");
    assert!(read_index(&fx.index).is_empty());
}

#[test]
fn stale_when_a_set_files_bytes_change_by_a_toggle() {
    let fx = Fx::new("stale-toggle");
    fx.write_config(json!([]));
    commit_at(&fx.env(), &prepared(GEN_A), ROW, &fx.revision(), &input()).unwrap();
    let start = fx.revision();
    toggle_at(&fx.env(), GEN_A, ROW, "keep-a", false).unwrap();
    let err = commit_at(&fx.env(), &prepared(GEN_B), ROW, &start, &input()).unwrap_err();
    assert!(err.starts_with("stale:"), "{err}");
    assert_eq!(fx.refs(), [GEN_A], "old refs untouched");
}

#[test]
fn stale_after_import_as_is() {
    let fx = Fx::new("stale-import");
    fx.write_config(json!([]));
    commit_at(&fx.env(), &prepared(GEN_A), ROW, &fx.revision(), &input()).unwrap();
    let start = fx.revision();
    let lib = fx.input_lib();
    crate::rules::import::assign::set_row_refs(&fx.config, &lib, &[(ROW.to_string(), vec!["a".to_string()])]).unwrap();
    assert_eq!(fx.refs(), [lib], "Import Raw drops the generation ref in the same write");
    let err = commit_at(&fx.env(), &prepared(GEN_B), ROW, &start, &input()).unwrap_err();
    assert!(err.starts_with("stale:"), "{err}");
}

#[test]
fn a_crash_before_the_transaction_leaves_the_old_refs() {
    let fx = Fx::new("crash");
    fx.write_config(json!([set_ref(&fx.input_lib())]));
    let before = std::fs::read_to_string(&fx.config).unwrap();
    write_library(&fx.imports, GEN_A, &prepared(GEN_A).files).unwrap();
    assert_eq!(std::fs::read_to_string(&fx.config).unwrap(), before);
    assert!(read_index(&fx.index).is_empty());
    assert!(Library::open(&fx.imports.join(GEN_A)).is_ok(), "an orphan is a complete library");
}

#[test]
fn toggling_the_last_rune_off_drops_the_ref_and_actives_still_lists_it() {
    let fx = Fx::new("toggle");
    fx.write_config(json!([]));
    commit_at(&fx.env(), &prepared(GEN_A), ROW, &fx.revision(), &input()).unwrap();

    let a = fx.actives();
    assert_eq!(a.libraries.len(), 1);
    let lib = &a.libraries[0];
    let g = lib.generated.as_ref().expect("generated");
    assert_eq!((g.agent.as_str(), g.model.as_str(), g.effort.as_str(), g.date.as_str()), ("claude", "sonnet", "medium", "2026-10-17"));
    assert_eq!(g.inputs, [PATH]);
    assert!(lib.source.is_none());
    let state: Vec<(&str, bool)> = lib.bricks.iter().map(|b| (b.id.as_str(), b.on)).collect();
    assert_eq!(state, [("keep-a", true), ("keep-b", true), ("braces", false)]);

    toggle_at(&fx.env(), GEN_A, ROW, "keep-a", false).unwrap();
    assert_eq!(fx.refs(), [GEN_A]);
    let applied = toggle_at(&fx.env(), GEN_A, ROW, "keep-b", false).unwrap();
    assert_eq!((applied.library.as_str(), applied.rows.len()), (GEN_A, 0));
    assert!(fx.refs().is_empty(), "nothing On drops the ref");
    assert_eq!(read_index(&fx.index).get(ROW).map(String::as_str), Some(GEN_A), "the library stays indexed");
    let a = fx.actives();
    assert_eq!(a.libraries.len(), 1);
    assert!(a.libraries[0].bricks.iter().all(|b| !b.on) && a.libraries[0].bricks.len() == 3);
    assert!(a.libraries[0].generated.is_some());

    let applied = toggle_at(&fx.env(), GEN_A, ROW, "keep-b", true).unwrap();
    assert_eq!(applied.rows, [ROW]);
    assert_eq!(fx.refs(), [GEN_A], "On re-adds the ref");
    let on: Vec<String> = fx.actives().libraries[0].bricks.iter().filter(|b| b.on).map(|b| b.id.clone()).collect();
    assert_eq!(on, ["keep-b"]);
}

#[test]
fn a_locked_rune_refuses_on_and_bad_targets_are_invalid() {
    let fx = Fx::new("locked");
    fx.write_config(json!([]));
    commit_at(&fx.env(), &prepared(GEN_A), ROW, &fx.revision(), &input()).unwrap();
    let before = std::fs::read_to_string(&fx.config).unwrap();
    let err = toggle_at(&fx.env(), GEN_A, ROW, "braces", true).unwrap_err();
    assert_eq!(err, "invalid: `braces` is locked draft (profile path or placeholder)");
    assert!(toggle_at(&fx.env(), GEN_A, ROW, "nope", true).unwrap_err().starts_with("invalid:"));
    assert!(toggle_at(&fx.env(), GEN_B, ROW, "keep-a", true).unwrap_err().starts_with("invalid:"), "not in gen-index");
    assert!(toggle_at(&fx.env(), "claude-user", ROW, "keep-a", true).unwrap_err().starts_with("invalid:"));
    assert_eq!(std::fs::read_to_string(&fx.config).unwrap(), before);
}

#[test]
fn a_memory_folder_input_has_its_import_ref_dropped_on_commit() {
    let fx = Fx::new("memory");
    let mem = fx.home.join("proj").join("memory");
    std::fs::create_dir_all(&mem).unwrap();
    std::fs::write(mem.join("note.md"), "Line 1.\n").unwrap();
    let inputs = vec![Input { path: r"~\proj\memory".into(), text: "Line 1.\n".into() }];
    let named = input_libraries(&fx.env(), &inputs);
    assert_eq!(named, ["memory-proj"], "named as import names a memory folder");
    fx.write_config(json!([set_ref("memory-proj"), { "library": "other-lib", "set": "x" }]));
    let landed = commit_at(&fx.env(), &prepared(GEN_A), ROW, &fx.revision(), &inputs).unwrap();
    assert_eq!(landed.dropped, ["memory-proj"]);
    assert_eq!(fx.refs(), ["other-lib", GEN_A]);
}

#[test]
fn a_failed_config_write_leaves_the_index_untouched() {
    let fx = Fx::new("config-fails");
    fx.write_config(json!([]));
    commit_at(&fx.env(), &prepared(GEN_A), ROW, &fx.revision(), &input()).unwrap();
    let mut perms = std::fs::metadata(&fx.config).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&fx.config, perms.clone()).unwrap();
    let err = commit_at(&fx.env(), &prepared(GEN_B), ROW, &fx.revision(), &input());
    perms.set_readonly(false);
    std::fs::set_permissions(&fx.config, perms).unwrap();
    assert!(err.is_err(), "the read-only config cannot be replaced");
    assert_eq!(read_index(&fx.index).get(ROW).map(String::as_str), Some(GEN_A));
    assert_eq!(fx.refs(), [GEN_A]);
}

#[test]
fn a_toggle_accepts_a_referenced_library_the_index_does_not_name_and_dropping_its_ref_indexes_it() {
    let fx = Fx::new("toggle-index");
    fx.write_config(json!([]));
    commit_at(&fx.env(), &prepared(GEN_A), ROW, &fx.revision(), &input()).unwrap();
    // The index names another generation (as after a failed index write); the row still references A.
    name_in_index(&fx.index, ROW, GEN_B).unwrap();
    toggle_at(&fx.env(), GEN_A, ROW, "keep-a", false).unwrap();
    assert_eq!(read_index(&fx.index).get(ROW).map(String::as_str), Some(GEN_B), "a kept ref leaves the index alone");
    toggle_at(&fx.env(), GEN_A, ROW, "keep-b", false).unwrap();
    assert!(fx.refs().is_empty());
    assert_eq!(read_index(&fx.index).get(ROW).map(String::as_str), Some(GEN_A), "the last ref dropped, the index names it");
}

#[test]
fn actives_lists_the_referenced_and_the_indexed_generation_once_each() {
    let fx = Fx::new("actives-two");
    fx.write_config(json!([]));
    commit_at(&fx.env(), &prepared(GEN_A), ROW, &fx.revision(), &input()).unwrap();
    assert_eq!(fx.actives().libraries.len(), 1, "referenced and indexed are the same library");
    write_library(&fx.imports, GEN_B, &prepared(GEN_B).files).unwrap();
    name_in_index(&fx.index, ROW, GEN_B).unwrap();
    let names: Vec<String> = fx.actives().libraries.iter().map(|l| l.library.clone()).collect();
    assert_eq!(names, [GEN_A, GEN_B]);
}

/// The Codex encoded size `prepare` reports for a generation named `library` beside the row's `row` refs.
fn codex_chars(library: &str, row: Option<RowRefs>) -> usize {
    let runes = vec![rune("keep-a", "Never guess.", 1), rune("keep-b", "Always test.", 2)];
    let ids = runes.iter().map(|r| r.id.clone()).collect();
    let env = Envelope { runes, sections: vec![Section { heading: "Rules".into(), ids }], dropped: vec![] };
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let template = std::fs::read_to_string(repo.join("profiles/bare/codex.payload-sets.md")).unwrap().replace("{{root}}", r"D:\Vidar");
    let guard = Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) };
    let ctx = PayloadCtx { agent: "codex", template: &template, row, root: r"D:\Vidar", home: r"D:\Home", guard: &guard };
    let meta = Meta { library, row_key: ROW, agent: "codex", model: "gpt", effort: "medium", skill_sha256: "00", date: "2026-10-17", profile: Some(r"C:\Users\testuser") };
    prepare(&serde_json::to_string(&env).unwrap(), &input(), &meta, &ctx).unwrap_or_else(|e| panic!("{e:?}")).encoded_chars.unwrap()
}

#[test]
fn the_size_follows_the_spawns_builder_with_its_cross_library_dedupe() {
    let fx = Fx::new("size");
    fx.write_config(json!([]));
    commit_at(&fx.env(), &prepared(GEN_A), ROW, &fx.revision(), &input()).unwrap();
    let alone = codex_chars(GEN_B, None);
    let refs = [SetRef { library: Some(GEN_A.into()), set: format!("row-{ROW}") }];
    let beside = codex_chars(GEN_B, Some(RowRefs { refs: &refs, rules_library: None, imports: &fx.imports }));
    // Every rune of the new set is already placed by A's set (same id, same body): the spawn drops them, and so does the size.
    let a_only = codex_chars(GEN_A, None);
    assert!(beside < alone + a_only, "the duplicated runes are counted once: {beside} vs {}", alone + a_only);
    assert!(beside.abs_diff(alone) < 100, "A's runes stand in for B's: {beside} vs {alone}");
}

#[test]
fn generation_names() {
    assert!(is_generation_of(GEN_A, ROW));
    assert!(!is_generation_of(GEN_A, "claude"), "a longer row key is another row");
    assert!(!is_generation_of("gen-claude-rendered-bare-0A1B2C3D", ROW));
    assert!(!is_generation_of("gen-claude-rendered-bare-0a1b2c3", ROW));
}
