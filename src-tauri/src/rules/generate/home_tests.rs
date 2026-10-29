//! Tests for `home.rs`: the generator home on a temp Bare home, never the real one.

use std::path::{Path, PathBuf};

use super::*;

struct Fx(PathBuf);

impl Fx {
    fn new(tag: &str) -> Fx {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("vidar-genhome-{tag}-{}-{nanos}", std::process::id()));
        for (folder, file) in [("claude-config", ".credentials.json"), ("codex-home", "auth.json")] {
            std::fs::create_dir_all(base.join(folder)).unwrap();
            std::fs::write(base.join(folder).join(file), format!("fake-{folder}")).unwrap();
        }
        Fx(base)
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Every file under `dir` relative to it, `/`-separated, sorted; empty folders listed with a trailing `/`.
fn listing(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let mut empty = true;
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            empty = false;
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                out.push(p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
        if empty {
            out.push(format!("{}/", dir.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/")));
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort();
    out
}

#[test]
fn the_claude_home_holds_exactly_the_login_settings_skill_and_empty_folders() {
    let fx = Fx::new("claude");
    let run = build_run("claude", &fx.0, "0a1b2c3d", "SKILL TEXT", None).unwrap();
    let h = call(&run, "c01-0").unwrap();
    assert_eq!(run.dir, fx.0.join("gen-claude"));
    assert_eq!(h.dir, fx.0.join("gen-claude").join("calls").join("c01-0"));
    assert_eq!(
        listing(&run.dir),
        [
            "calls/c01-0/config/.credentials.json",
            "calls/c01-0/config/settings.json",
            "calls/c01-0/user-home/AppData/Local/Temp/",
            "calls/c01-0/user-home/AppData/Roaming/",
            "calls/c01-0/work/",
            "skill.md",
        ]
    );
    assert_eq!(std::fs::read_to_string(h.config.join("settings.json")).unwrap(), "{}");
    assert_eq!(std::fs::read_to_string(h.skill.as_ref().unwrap()).unwrap(), "SKILL TEXT");
    assert_eq!(std::fs::read_to_string(h.config.join(".credentials.json")).unwrap(), "fake-claude-config");
    assert_eq!(h.cwd, h.dir.join("work"));
    assert_clean(&h).unwrap();
}

#[test]
fn the_credential_is_a_hard_link_to_the_bare_home_file() {
    let fx = Fx::new("link");
    let h = call(&build_run("claude", &fx.0, "0a1b2c3d", "S", None).unwrap(), "c01-0").unwrap();
    assert_eq!(h.placed, Placed::Link);
    // A write through the Bare home's file shows in the generator home: one file, two names.
    std::fs::write(fx.0.join("claude-config").join(".credentials.json"), "refreshed").unwrap();
    assert_eq!(std::fs::read_to_string(h.config.join(".credentials.json")).unwrap(), "refreshed");
    // Rebuilding unlinks the generator name only; the Bare home's file stays.
    build_run("claude", &fx.0, "4e5f6a7b", "S", None).unwrap();
    assert_eq!(std::fs::read_to_string(fx.0.join("claude-config").join(".credentials.json")).unwrap(), "refreshed");
}

#[test]
fn the_codex_home_holds_auth_and_a_config_without_instructions() {
    let fx = Fx::new("codex");
    let run = build_run("codex", &fx.0, "0a1b2c3d", "S", None).unwrap();
    let h = call(&run, "c01-0").unwrap();
    assert_eq!(
        listing(&h.dir),
        ["config/auth.json", "config/config.toml", "user-home/AppData/Local/Temp/", "user-home/AppData/Roaming/", "work/"]
    );
    let toml = std::fs::read_to_string(h.config.join("config.toml")).unwrap();
    assert_eq!(toml, "cli_auth_credentials_store = \"file\"\n");
    assert!(!toml.contains("developer_instructions"));
}

#[test]
fn a_rebuild_clears_what_the_last_run_left() {
    let fx = Fx::new("rebuild");
    let h = call(&build_run("claude", &fx.0, "0a1b2c3d", "S", None).unwrap(), "c01-0").unwrap();
    std::fs::write(h.config.join("stray.txt"), "x").unwrap();
    std::fs::write(h.cwd.join("AGENTS.md"), "x").unwrap();
    let run2 = build_run("claude", &fx.0, "4e5f6a7b", "S", None).unwrap();
    let h2 = call(&run2, "c01-0").unwrap();
    assert!(!h2.config.join("stray.txt").exists() && !h2.cwd.join("AGENTS.md").exists());
    assert_clean(&h2).unwrap();
}

#[test]
fn an_instruction_file_in_the_config_dir_or_the_cwd_refuses_the_spawn() {
    let fx = Fx::new("plant");
    for agent in ["claude", "codex"] {
        for name in ["AGENTS.md", "CLAUDE.md"] {
            let run = build_run(agent, &fx.0, "0a1b2c3d", "S", None).unwrap();
            let h = call(&run, "c01-0").unwrap();
            std::fs::write(h.config.join(name), "# planted").unwrap();
            assert_eq!(assert_clean(&h), Err(format!("spawn: generator home holds {name}")));
            let h = call(&run, "c01-0").unwrap();
            std::fs::write(h.cwd.join(name), "# planted").unwrap();
            assert_eq!(assert_clean(&h), Err(format!("spawn: generator home holds {name}")));
        }
    }
}

#[test]
fn an_extra_file_or_skills_dir_in_the_config_dir_refuses_the_spawn() {
    let fx = Fx::new("extra");
    for agent in ["claude", "codex"] {
        let run = build_run(agent, &fx.0, "0a1b2c3d", "S", None).unwrap();
        let h = call(&run, "c01-0").unwrap();
        std::fs::write(h.config.join("notes.txt"), "x").unwrap();
        assert_eq!(assert_clean(&h), Err("spawn: generator home holds notes.txt".to_string()));
        let h = call(&run, "c01-0").unwrap();
        std::fs::create_dir_all(h.config.join("skills")).unwrap();
        assert_eq!(assert_clean(&h), Err("spawn: generator home holds skills".to_string()));
        let h = call(&run, "c01-0").unwrap();
        std::fs::write(h.cwd.join("x.txt"), "x").unwrap();
        assert!(assert_clean(&h).unwrap_err().starts_with("spawn: generator home holds"));
    }
}

#[test]
fn a_canary_instruction_file_in_an_ancestor_refuses_the_spawn() {
    let fx = Fx::new("ancestor");
    for name in ["CLAUDE.md", "AGENTS.md", "AGENTS.override.md"] {
        let run = build_run("codex", &fx.0, "0a1b2c3d", "S", None).unwrap();
        let h = call(&run, "c01-0").unwrap();
        assert_clean(&h).unwrap();
        std::fs::write(fx.0.join(name), "# canary").unwrap();
        let err = assert_clean(&h).unwrap_err();
        assert!(err.starts_with(&format!("spawn: generator home sits under {name}")), "{err}");
        std::fs::remove_file(fx.0.join(name)).unwrap();
    }
    // A `.git` alone is no reason to refuse.
    let run = build_run("claude", &fx.0, "0a1b2c3d", "S", None).unwrap();
    let h = call(&run, "c01-0").unwrap();
    std::fs::create_dir_all(fx.0.join(".git")).unwrap();
    assert_clean(&h).unwrap();
}

#[test]
fn a_missing_bare_credential_is_a_login_error_and_touches_nothing() {
    let fx = Fx::new("nologin");
    std::fs::remove_file(fx.0.join("codex-home").join("auth.json")).unwrap();
    let err = build_run("codex", &fx.0, "0a1b2c3d", "S", None).unwrap_err();
    assert!(err.starts_with("login: "), "{err}");
    assert!(!fx.0.join("gen-codex").exists());
}

#[test]
fn bad_agent_and_run_id_are_invalid() {
    let fx = Fx::new("bad");
    assert!(build_run("gemini", &fx.0, "0a1b2c3d", "S", None).unwrap_err().starts_with("invalid: "));
    assert!(build_run("claude", &fx.0, "..\\x", "S", None).unwrap_err().starts_with("invalid: "));
}

#[test]
fn two_call_homes_in_one_run_are_disjoint_clean_and_linked() {
    let fx = Fx::new("calls");
    let run = build_run("claude", &fx.0, "0a1b2c3d", "SKILL", Some("MERGE")).unwrap();
    assert_eq!(std::fs::read_to_string(&run.skill).unwrap(), "SKILL");
    assert_eq!(std::fs::read_to_string(run.merge_skill.as_ref().unwrap()).unwrap(), "MERGE");
    let (a, b) = (call(&run, "c01-0").unwrap(), call(&run, "c02-0").unwrap());
    assert_eq!((a.dir.clone(), b.dir.clone()), (fx.0.join("gen-claude/calls/c01-0"), fx.0.join("gen-claude/calls/c02-0")));
    assert!(!a.dir.starts_with(&b.dir) && !b.dir.starts_with(&a.dir) && a.cwd != b.cwd && a.config != b.config);
    for h in [&a, &b] {
        assert_eq!(
            listing(&h.dir),
            ["config/.credentials.json", "config/settings.json", "user-home/AppData/Local/Temp/", "user-home/AppData/Roaming/", "work/"]
        );
        assert_eq!(std::fs::read_to_string(h.config.join("settings.json")).unwrap(), "{}");
        assert_eq!(h.placed, Placed::Link);
        assert_eq!(h.skill.as_ref(), Some(&run.skill));
        assert_clean(h).unwrap();
    }
    // One file, three names: a write through the Bare home shows in both call homes.
    std::fs::write(fx.0.join("claude-config").join(".credentials.json"), "refreshed").unwrap();
    for h in [&a, &b] {
        assert_eq!(std::fs::read_to_string(h.config.join(".credentials.json")).unwrap(), "refreshed");
    }
    // Planting in one home leaves the other clean.
    std::fs::write(a.cwd.join("AGENTS.md"), "x").unwrap();
    assert!(assert_clean(&a).is_err() && assert_clean(&b).is_ok());
    // A repeated name starts clean.
    assert!(!call(&run, "c01-0").unwrap().cwd.join("AGENTS.md").exists());
    assert!(call(&run, "..").unwrap_err().starts_with("invalid: "));
    remove_calls(&run);
    assert!(!run.dir.join("calls").exists() && run.skill.is_file());
    assert_eq!(std::fs::read_to_string(fx.0.join("claude-config").join(".credentials.json")).unwrap(), "refreshed");
}

#[test]
fn a_codex_call_home_has_its_own_config_and_a_run_without_merge_has_no_merge_skill() {
    let fx = Fx::new("codexcall");
    let run = build_run("codex", &fx.0, "0a1b2c3d", "SKILL", None).unwrap();
    assert!(run.merge_skill.is_none() && !run.dir.join("merge-skill.md").exists());
    let h = call(&run, "merge-0").unwrap();
    assert_eq!(listing(&h.dir), ["config/auth.json", "config/config.toml", "user-home/AppData/Local/Temp/", "user-home/AppData/Roaming/", "work/"]);
    assert_eq!(std::fs::read_to_string(h.config.join("config.toml")).unwrap(), "cli_auth_credentials_store = \"file\"\n");
}

#[test]
fn build_run_clears_the_last_run_and_needs_a_login() {
    let fx = Fx::new("buildrun");
    let run = build_run("claude", &fx.0, "0a1b2c3d", "S", None).unwrap();
    let h = call(&run, "c01-0").unwrap();
    std::fs::write(h.config.join("stray.txt"), "x").unwrap();
    let run = build_run("claude", &fx.0, "4e5f6a7b", "S", None).unwrap();
    assert!(!h.dir.exists() && run.skill.is_file());
    std::fs::remove_file(fx.0.join("codex-home").join("auth.json")).unwrap();
    assert!(build_run("codex", &fx.0, "0a1b2c3d", "S", None).unwrap_err().starts_with("login: "));
    assert!(build_run("claude", &fx.0, "..\\x", "S", None).unwrap_err().starts_with("invalid: "));
}

#[test]
fn a_build_guard_removes_a_half_built_cwd_and_a_disarmed_one_leaves_it() {
    let fx = Fx::new("guard");
    let (gone, kept) = (fx.0.join("gone"), fx.0.join("kept"));
    for d in [&gone, &kept] {
        std::fs::create_dir_all(d.join("inner")).unwrap();
    }
    drop(BuildGuard(Some(gone.clone())));
    let mut disarmed = BuildGuard(Some(kept.clone()));
    disarmed.0 = None;
    drop(disarmed);
    assert!(!gone.exists() && kept.exists());
    // A finished call home stays for the run to use.
    let h = call(&build_run("claude", &fx.0, "0a1b2c3d", "S", None).unwrap(), "c01-0").unwrap();
    assert!(h.cwd.is_dir());
}

#[test]
fn the_runner_refuses_a_stray_file_in_the_config_dir_before_spawning() {
    use super::super::run::{execute, Spec};
    use crate::job::Job;
    let fx = Fx::new("runner");
    for agent in ["claude", "codex"] {
        let run = build_run(agent, &fx.0, "0a1b2c3d", "S", None).unwrap();
        let h = call(&run, "c01-0").unwrap();
        // The program does not exist: only a refusal before the spawn gives the "holds" text.
        let spec = Spec {
            program: PathBuf::from(r"C:\definitely\not\here.exe"),
            args: Vec::new(),
            env: Vec::new(),
            cwd: h.cwd.clone(),
            agent: run.agent,
            config: Some(h.config.clone()),
            stdin: String::new(),
        };
        let job = Job::new().unwrap();
        let run_it = || execute(&spec, &job, std::time::Duration::from_secs(5), 1000).unwrap_err();
        assert!(!run_it().contains("holds"), "{}", run_it());
        std::fs::write(h.config.join("stray.txt"), "x").unwrap();
        assert_eq!(run_it(), "spawn: generator home holds stray.txt");
    }
}
