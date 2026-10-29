//! Output-style file hygiene (a switch leaves no stale style file; a body under a built-in name is not
//! carried) and the Codex built-in skill switch at spawn level (`codex_hosted::prepare_home` through
//! `prepare_codex_with`). Temp dirs only.

use super::home::{generate_settings_with, prepare_dirs, Guard, SettingsExtras};
use super::rune_items::{map_claude, MapEnv, OutputStyle, RuneItem};
use super::*;
use std::ffi::OsString;

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-style-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn guard() -> Guard {
    Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) }
}

fn style(id: &str, body: &str) -> SettingsExtras {
    SettingsExtras {
        output_style: Some(OutputStyle { name: id.to_uppercase(), id: id.into(), description: "d".into(), body: body.into() }),
        ..Default::default()
    }
}

fn md_files(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[test]
fn a_style_switch_leaves_only_the_current_style_file_and_an_unchanged_launch_writes_nothing() {
    let t = Tmp::new("switch");
    let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
    prepare_dirs(&home, &["claude-config".into()]).unwrap();
    let template = crate::paths::root().join("profiles").join("bare").join("claude.settings.template.json");
    let target = home.join("claude-config").join("settings.json");
    let styles = home.join("claude-config").join("output-styles");
    let run = |extras: &SettingsExtras| generate_settings_with(&template, &target, &root, &home, &guard(), &[], extras).unwrap();

    run(&style("alpha", "Be alpha."));
    assert_eq!(md_files(&styles), ["alpha.md"]);
    run(&style("beta", "Be beta."));
    assert_eq!(md_files(&styles), ["beta.md"], "the old style's file stayed");

    let mtime = |p: &Path| std::fs::metadata(p).unwrap().modified().unwrap();
    let (style_at, settings_at) = (mtime(&styles.join("beta.md")), mtime(&target));
    std::thread::sleep(std::time::Duration::from_millis(40));
    run(&style("beta", "Be beta."));
    assert_eq!((mtime(&styles.join("beta.md")), mtime(&target)), (style_at, settings_at), "an unchanged launch wrote");

    run(&SettingsExtras::default());
    assert!(md_files(&styles).is_empty(), "{:?}", md_files(&styles));
    // A name-only style writes no file and clears the old one too.
    run(&style("gamma", "Be gamma."));
    run(&style("gamma", ""));
    assert!(md_files(&styles).is_empty());
}

#[test]
fn a_style_dir_outside_the_home_is_never_swept() {
    let t = Tmp::new("outside");
    let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
    prepare_dirs(&home, &["claude-config".into()]).unwrap();
    let outside = t.0.join("elsewhere");
    std::fs::create_dir_all(outside.join("output-styles")).unwrap();
    std::fs::write(outside.join("output-styles").join("keep.md"), "x").unwrap();
    let template = crate::paths::root().join("profiles").join("bare").join("claude.settings.template.json");
    generate_settings_with(&template, &outside.join("settings.json"), &root, &home, &guard(), &[], &SettingsExtras::default()).unwrap();
    assert_eq!(md_files(&outside.join("output-styles")), ["keep.md"]);
}

fn rune(text: &str) -> RuneItem {
    RuneItem::from_rune(&crate::rules::rune::parse(text).unwrap()).unwrap().unwrap()
}

#[test]
fn a_body_under_a_built_in_style_name_warns_and_is_dropped_but_a_name_only_rune_carries() {
    let root = crate::paths::root();
    let env = MapEnv { root: &root, user_home: None };
    let head = |name: &str, style: &str, body: &str| format!("---\nname: {name}\nkind: output-style\nscope: [global]\nstyle: {style}\n---\n{body}");
    let shadow = rune(&head("shadow", "explanatory", "\nOverride the built-in.\n"));
    let p = map_claude(&[shadow.clone()], &env);
    assert!(p.output_style.is_none());
    assert_eq!(p.warnings, ["Rune `shadow` carries a body under the built-in style name explanatory; the built-in stays"]);

    let named = rune(&head("pick", "Learning", ""));
    let p = map_claude(&[named], &env);
    assert!(p.warnings.is_empty(), "{:?}", p.warnings);
    assert_eq!(p.output_style.unwrap().name, "Learning");

    // A dropped shadow does not hold the slot: the next style rune is the pick.
    let own = rune(&head("brief", "Brief", "\nOne line.\n"));
    let p = map_claude(&[shadow, own], &env);
    assert_eq!(p.output_style.unwrap().name, "Brief");
}

// ---- Codex built-ins at spawn ----

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        match e.file_type().unwrap().is_dir() {
            true => copy_dir(&src, &dst),
            false => drop(std::fs::copy(&src, &dst).unwrap()),
        }
    }
}

fn inherited() -> Vec<(OsString, OsString)> {
    [("Path", r"C:\Windows\system32;C:\Tools"), ("SystemRoot", r"C:\Windows"), ("USERNAME", "testuser"), ("USERPROFILE", r"C:\Users\testuser"), ("APPDATA", r"C:\Users\testuser\AppData\Roaming"), ("LOCALAPPDATA", r"C:\Users\testuser\AppData\Local")]
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
}

fn fake_find(_: &Env, name: &str) -> Option<PathBuf> {
    Some(PathBuf::from(r"X:\bin").join(name))
}

fn codex_ok(env: &Env, _: &CodexBinary) -> Option<(PathBuf, Option<String>)> {
    env.get("Path")?;
    Some((PathBuf::from(r"X:\npm\node_modules\@openai\codex\bin\codex.js"), Some(pinned("codex"))))
}

/// A Codex spawn in a temp root on a vault holding the given stock rune ids; its config.toml text and the launch.
fn spawn_with(tag: &str, runes: &[&str]) -> (String, String, Tmp) {
    spawn_off(tag, runes, &[])
}

/// As `spawn_with`, then Modify switches the `off` ids (a subset of the on list) off.
fn spawn_off(tag: &str, runes: &[&str], off: &[&str]) -> (String, String, Tmp) {
    let t = Tmp::new(tag);
    copy_dir(&crate::paths::root().join("profiles").join("bare"), &t.0.join("profiles").join("bare"));
    // The identity rule gives the payload a body (an empty one refuses the spawn).
    let stock = |id: &str| vault::RuneRef { library: "stock".into(), id: id.into() };
    let refs: Vec<vault::RuneRef> = ["bare-identity-codex"].iter().chain(runes).map(|id| stock(id)).collect();
    let store = vault::store::Store::open(&t.0);
    let mut v = store.create("builtin-probe", None, &[], &refs).unwrap();
    if !off.is_empty() {
        let ops: Vec<vault::store::Op> = off.iter().map(|id| vault::store::Op::RemoveRune(stock(id))).collect();
        v = store.edit(&v.id, &ops, vault::store::EditMode::Unlocked).unwrap();
    }
    let probes = CodexProbes { find: &fake_find, codex: &codex_ok };
    let opts = LaunchOpts { vault: Some(&v.id), ..LaunchOpts::default() };
    let launch = prepare_codex_with("bare", &t.0, &t.0.join("home"), inherited(), &Ambient::default(), &guard(), &probes, &opts).unwrap();
    let config = std::fs::read_to_string(launch.codex_home.join("config.toml")).unwrap();
    let seen = format!("{}\n{}", serde_json::to_string(&launch.manifest).unwrap(), md_files(&launch.codex_home.join("skills")).join(","));
    drop(launch);
    (config, seen, t)
}

#[test]
fn a_vault_with_one_codex_built_in_keeps_it_on_and_switches_the_other_four_off() {
    let (config, seen, _t) = spawn_with("cx-one", &["codex-imagegen"]);
    for off in ["openai-docs", "review-agent", "skill-creator", "skill-installer"] {
        assert!(config.contains(&format!("[[skills.config]]\nname = \"{off}\"\nenabled = false")), "{off}: {config}");
    }
    assert!(!config.contains("name = \"imagegen\""), "{config}");
    assert!(!config.contains("[skills.bundled]"), "{config}");
    assert_eq!(config.matches("[[skills.config]]").count(), 4, "{config}");
    assert!(!seen.contains("codex-builtin"), "the marker path reached the copy plan: {seen}");
}

const ALL_FIVE: [&str; 5] = ["codex-imagegen", "codex-openai-docs", "codex-review-agent", "codex-skill-creator", "codex-skill-installer"];

#[test]
fn a_vault_older_than_the_built_in_runes_leaves_codex_s_built_ins_alone() {
    let (config, seen, _t) = spawn_with("cx-none", &[]);
    assert!(!config.contains("[skills.bundled]") && !config.contains("[[skills.config]]"), "{config}");
    assert!(!seen.contains("codex-builtin"), "{seen}");
}

#[test]
fn a_vault_with_two_built_ins_switched_off_disables_those_two() {
    let (config, _seen, _t) = spawn_off("cx-two-off", &ALL_FIVE, &["codex-openai-docs", "codex-skill-installer"]);
    assert_eq!(config.matches("[[skills.config]]").count(), 2, "{config}");
    assert!(config.contains("name = \"openai-docs\"") && config.contains("name = \"skill-installer\""), "{config}");
    assert!(!config.contains("[skills.bundled]"), "{config}");
}

#[test]
fn a_vault_with_all_five_built_ins_switched_off_disables_the_bundled_set() {
    let (config, _seen, _t) = spawn_off("cx-all-off", &ALL_FIVE, &ALL_FIVE);
    assert!(config.contains("[skills.bundled]\nenabled = false"), "{config}");
}
