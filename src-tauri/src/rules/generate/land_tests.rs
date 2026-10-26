//! Tests for `land.rs`: landing writes the library and nothing else; the generated set toggles and builds.

use std::path::PathBuf;

use super::super::envelope::{Envelope, RuneOut, Section, Source};
use super::super::render::Meta;
use super::super::validate::PayloadCtx;
use super::super::{prepare, Input, Prepared};
use super::*;
use crate::bare::home::Guard;
use crate::rules::{build, context::RenderCtx, library::Library};

const PATH: &str = r"~\.claude\CLAUDE.md";
const GEN_A: &str = "gen-0a1b2c3d";
const SET: &str = "generated-20261017";
const CONFIG: &str = "{\"agents\":[{\"key\":\"claude-rendered-bare\",\"sets\":[{\"library\":\"kit\",\"set\":\"kit\"}]}]}";

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
        std::fs::create_dir_all(&home).unwrap();
        let config = root.join("config.json");
        std::fs::write(&config, CONFIG).unwrap();
        let index = imports.join("gen-index.json");
        Fx { base, root, imports, index, home, config }
    }

    fn env(&self) -> LandEnv<'_> {
        LandEnv { config: &self.config, imports: &self.imports, home: Some(&self.home), cwd: None }
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
        ..Default::default()
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
        set: SET,
        items: &[],
        agent: "claude",
        model: "sonnet",
        effort: "medium",
        skill_sha256: "00",
        date: "2026-10-17",
        profile: Some(r"C:\Users\testuser"),
    };
    prepare(&serde_json::to_string(&env).unwrap(), &input(), &meta, &ctx).unwrap_or_else(|e| panic!("{e:?}"))
}

#[test]
fn commit_writes_only_the_library() {
    let fx = Fx::new("commit");
    let landed = commit_at(&fx.env(), &prepared(GEN_A)).unwrap();
    assert_eq!(landed, Landed { library: GEN_A.into(), set: SET.into() });
    assert_eq!(std::fs::read_to_string(&fx.config).unwrap(), CONFIG, "vidar.json is never written");
    assert!(!fx.index.exists(), "no gen-index entry");
    let names: Vec<String> = std::fs::read_dir(&fx.imports).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, [GEN_A]);
    let dir = fx.imports.join(GEN_A);
    assert!(dir.join("generate.json").is_file());
    let lib = Library::open(&dir).unwrap();
    let built = build::build_in(&lib, &[SET.to_string()], &RenderCtx::bare(Default::default())).map_err(|f| f.errors).unwrap();
    let text = String::from_utf8(built.bytes).unwrap();
    assert!(text.contains("Never guess.") && !text.contains("{{name}}"), "{text}");
    assert!(commit_at(&fx.env(), &prepared(GEN_A)).unwrap_err().starts_with("invalid:"), "write-once");
}

#[test]
fn a_row_bound_library_name_is_refused() {
    let fx = Fx::new("rowname");
    let err = commit_at(&fx.env(), &prepared("gen-claude-rendered-bare-0a1b2c3d")).unwrap_err();
    assert!(err.starts_with("invalid:"), "{err}");
    assert!(std::fs::read_dir(&fx.imports).unwrap().next().is_none());
}

#[test]
fn a_generate_run_writes_no_old_shape() {
    let fx = Fx::new("noold");
    commit_at(&fx.env(), &prepared(GEN_A)).unwrap();
    fn walk(dir: &std::path::Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            out.push(e.file_name().to_string_lossy().into_owned());
            if e.path().is_dir() {
                walk(&e.path(), out);
            }
        }
    }
    let mut names = Vec::new();
    walk(&fx.root, &mut names);
    for n in &names {
        let old = n.starts_with("row-") || n.starts_with("gen-index") || n == "overrides" || n.ends_with(".layer.json")
            || (n.starts_with("gen-") && !is_generated_library(n));
        assert!(!old, "a generate run wrote the old shape {n:?}: {names:?}");
    }
    assert!(names.iter().any(|n| n == GEN_A), "{names:?}");
    assert_eq!(std::fs::read_to_string(&fx.config).unwrap(), CONFIG);
}

#[test]
fn generation_names() {
    assert!(is_generated_library(GEN_A));
    assert!(!is_generated_library("gen-0A1B2C3D"));
    assert!(!is_generated_library("gen-claude-0a1b2c3d"));
    assert!(is_generation_of("gen-claude-rendered-bare-0a1b2c3d", "claude-rendered-bare"));
    assert!(!is_generation_of(GEN_A, "claude"));
}
