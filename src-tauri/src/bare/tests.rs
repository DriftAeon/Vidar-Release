//! bare/ wiring tests: Design 9 rejection, the payload marker, and one full prepare against a
//! temp home (never the real agent homes) with the binary lookup and version read faked.

use super::*;
use std::ffi::OsString;

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-bare-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn guard() -> home::Guard {
    home::Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) }
}

fn inherited() -> Vec<(OsString, OsString)> {
    [
        ("Path", r"C:\Windows\system32;C:\Tools"),
        ("SystemRoot", r"C:\Windows"),
        ("USERNAME", "testuser"),
        ("=C:", r"C:\Work"),
        ("USERPROFILE", r"C:\Users\testuser"),
        ("APPDATA", r"C:\Users\testuser\AppData\Roaming"),
        ("LOCALAPPDATA", r"C:\Users\testuser\AppData\Local"),
        ("ANTHROPIC_API_KEY", "sk-test"),
        ("CLAUDE_CONFIG_DIR", r"C:\Users\testuser\.claude"),
        ("CODEX_HOME", r"C:\Users\testuser\.codex"),
        ("VIDAR_CTL_TOKEN", "stale"),
        ("NO_COLOR", "1"),
    ]
    .iter()
    .map(|(k, v)| (OsString::from(k), OsString::from(v)))
    .collect()
}

fn fake_find(_: &Env, name: &str) -> Option<PathBuf> {
    Some(PathBuf::from(r"X:\bin").join(name))
}

#[test]
fn an_unknown_profile_refuses() {
    let e = admit("lean", Some("claude"), None, None).unwrap_err();
    assert!(e.contains("Unknown launch profile"), "{e}");
}

#[test]
fn a_vendor_row_with_a_profile_refuses() {
    let args = vec!["-NoExit".to_string(), "-Command".into(), "& \"$env:VIDAR_ROOT/tools/vendor/vendor-tab.ps1\" -Vendor acme".into()];
    let e = admit("bare", Some("claude"), None, Some(&args)).unwrap_err();
    assert!(e.contains("vendor row"), "{e}");
}

#[test]
fn a_profile_on_an_agent_other_than_claude_or_codex_refuses() {
    for agent in [None, Some("acme"), Some("gemini"), Some("shell"), Some("Claude"), Some("Codex"), Some("astra")] {
        let e = admit("bare", agent, None, None).unwrap_err();
        assert!(e.contains("Raw Claude and Raw Codex rows only"), "{agent:?}: {e}");
    }
}

#[test]
fn a_raw_codex_profile_is_admitted_bare_and_refused_with_a_shell_args_or_a_role() {
    let codex = Some("codex");
    admit("bare", codex, None, None).unwrap();
    assert!(admit("lean", codex, None, None).unwrap_err().contains("Unknown launch profile"));
    assert!(admit("bare", codex, Some("pwsh.exe"), None).unwrap_err().contains("carries no shell or args"));
    assert!(admit("bare", codex, None, Some(&[])).unwrap_err().contains("carries no shell or args"));
    // A role row (Astra) is a Codex row with its own args: the args rule refuses it.
    let astra = vec!["-NoExit".to_string(), "-Command".into(), "codex -a never -s workspace-write".into()];
    assert!(admit("bare", codex, None, Some(&astra)).unwrap_err().contains("carries no shell or args"));
}

#[test]
fn a_bare_spawn_carrying_shell_or_args_refuses() {
    let args = vec!["-NoExit".to_string(), "-Command".into(), "claude".into()];
    let claude = Some("claude");
    assert!(admit("bare", claude, None, Some(&args)).unwrap_err().contains("carries no shell or args"));
    assert!(admit("bare", claude, None, Some(&[])).is_err(), "an empty args list is still carried");
    assert!(admit("bare", claude, Some("pwsh.exe"), None).is_err());
    admit("bare", claude, None, None).unwrap();
}

/// A temp root holding only an edited copy of the shipped bare profile.
fn root_with_profile(t: &TempDir, edit: impl Fn(&mut serde_json::Value)) -> PathBuf {
    let src = crate::paths::root().join("profiles").join("bare").join("claude.json");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(src).unwrap()).unwrap();
    edit(&mut v);
    let dir = t.0.join("root").join("profiles").join("bare");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("claude.json"), serde_json::to_string(&v).unwrap()).unwrap();
    t.0.join("root")
}

#[test]
fn a_profile_missing_an_isolation_switch_refuses_before_the_home() {
    let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
    let t = TempDir::new("isolation");
    let no_sources = root_with_profile(&t, |v| {
        let args = v["args"].as_array_mut().unwrap();
        let at = args.iter().position(|a| a == "--setting-sources").unwrap();
        args.drain(at..at + 2);
    });
    let home = t.0.join("agent-home");
    let e = prepare_with("bare", &no_sources, &home, inherited(), &guard(), &probes, &LaunchOpts::default()).err().unwrap();
    assert!(e.contains("--setting-sources user"), "{e}");
    assert!(!home.exists(), "the home was touched before the refusal");

    let t2 = TempDir::new("isolation-mds");
    let no_mds = root_with_profile(&t2, |v| {
        v["overlay"]["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] = "0".into();
    });
    let e = prepare_with("bare", &no_mds, &t2.0.join("agent-home"), inherited(), &guard(), &probes, &LaunchOpts::default()).err().unwrap();
    assert!(e.contains("CLAUDE_CODE_DISABLE_CLAUDE_MDS=1"), "{e}");
}

#[test]
fn a_claude_config_dir_outside_the_home_refuses_raw_and_hosted() {
    let probes = Probes { find: &fake_find, version: &|_, _| None, remote_control: &|| false };
    for outside in [r"C:\Users\testuser\.claude", r"{{home}}\..\.claude", r"{{home}}"] {
        let t = TempDir::new("config-outside");
        let root = root_with_profile(&t, |v| {
            v["overlay"]["CLAUDE_CONFIG_DIR"] = outside.into();
        });
        let home = t.0.join("agent-home");
        let e = prepare_with("bare", &root, &home, inherited(), &guard(), &probes, &LaunchOpts::default()).err().unwrap();
        assert!(e.contains("CLAUDE_CONFIG_DIR outside the bare home"), "raw {outside}: {e}");
        let e = prepare_hosted_with("bare", &root, &home, &guard(), &LaunchOpts::default()).err().unwrap();
        assert!(e.contains("CLAUDE_CONFIG_DIR outside the bare home"), "hosted {outside}: {e}");
        assert!(!home.exists(), "the home was touched before the refusal");
    }
}

#[test]
fn the_payload_marker_matches_its_text() {
    let text = std::fs::read_to_string(crate::paths::root().join("profiles").join("bare").join("payload.md")).unwrap();
    let (marker, expected) = payload_marker(&text).unwrap();
    assert_eq!(marker, expected, "payload.md edited: set its last line to {expected}");
    let body_lines = text.lines().filter(|l| !l.trim().is_empty()).count() - 1;
    assert!((2..=5).contains(&body_lines), "payload holds {body_lines} lines (Design 7: 2-5)");
    assert!(payload_marker("no marker\n").is_err());
}

#[test]
fn remote_control_flag_follows_the_users_setting() {
    let t = TempDir::new("prepare-rc-off");
    let home = t.0.join("agent-home");
    let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
    let launch = prepare_with("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();
    let line = &launch.args[2];
    assert!(!line.contains("remote-control"), "{line}");
    assert!(line.ends_with("'--permission-mode' 'auto'"), "{line}");
}

#[test]
fn parse_remote_control_only_accepts_boolean_true() {
    assert!(parse_remote_control(r#"{"remoteControlAtStartup": true}"#));
    for off in [r#"{"remoteControlAtStartup": false}"#, r#"{"other": 1}"#, r#"{"remoteControlAtStartup": "true"}"#, "{not json", ""] {
        assert!(!parse_remote_control(off), "{off}");
    }
}

#[test]
fn prepare_builds_the_spawn_line_env_and_manifest() {
    let t = TempDir::new("prepare");
    let root = crate::paths::root();
    let home = t.0.join("agent-home");
    let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| true };
    let mut launch = prepare_with("bare", &root, &home, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();

    assert_eq!(launch.program, PathBuf::from(r"X:\bin\pwsh.exe"));
    assert_eq!(&launch.args[..2], ["-NoProfile", "-Command"], "no -NoExit: no half-bare shell after Claude exits");
    assert_eq!(launch.args.len(), 3);
    let line = &launch.args[2];
    let r = root.display();
    let payload = format!("{r}\\profiles\\bare\\payload.md");
    let expected = format!(
        "& 'X:\\bin\\claude.exe' '--setting-sources' 'user' '--append-system-prompt-file' '{payload}' '--plugin-dir' '{r}\\plugins\\vidar-app' '--allowedTools' 'mcp__plugin_vidar_drive' '--permission-mode' 'auto' '--remote-control'"
    );
    assert_eq!(line, &expected);
    assert!(launch.manifest.binary.warning.is_none());

    let h = home.display();
    let env = &launch.env;
    for (k, v) in [
        ("USERPROFILE", format!("{h}\\user-home")),
        ("HOME", format!("{h}\\user-home")),
        ("APPDATA", format!("{h}\\user-home\\AppData\\Roaming")),
        ("LOCALAPPDATA", format!("{h}\\user-home\\AppData\\Local")),
        ("TEMP", format!("{h}\\user-home\\AppData\\Local\\Temp")),
        ("TMP", format!("{h}\\user-home\\AppData\\Local\\Temp")),
        ("BROWSER", format!("{r}\\tools\\bare\\open-url.cmd")),
        ("CLAUDE_CONFIG_DIR", format!("{h}\\claude-config")),
        ("VIDAR_AGENT_HOME", format!("{h}\\claude-config")),
        ("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "0".into()),
        ("DISABLE_AUTOUPDATER", "1".into()),
        ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1".into()),
    ] {
        assert_eq!(env.get(k).map(|v| v.to_string_lossy().into_owned()), Some(v), "{k}");
    }
    let scrub = env.get("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB").map(|v| v.to_string_lossy().to_lowercase());
    assert!(
        !matches!(scrub.as_deref(), Some("1" | "true" | "yes" | "on")),
        "a truthy CLAUDE_CODE_SUBPROCESS_ENV_SCRUB forces default permission mode in the pinned Claude"
    );
    let (drive, path) = env::split_home(&format!("{h}\\user-home")).unwrap();
    assert_eq!(env.get("HOMEDRIVE").unwrap().to_string_lossy(), drive);
    assert_eq!(env.get("HOMEPATH").unwrap().to_string_lossy(), path);
    assert!(env.contains("=C:") && env.contains("Path") && env.contains("USERNAME"));
    for gone in ["ANTHROPIC_API_KEY", "CODEX_HOME", "VIDAR_CTL_TOKEN", "NO_COLOR"] {
        assert!(!env.contains(gone), "{gone} inherited into a bare env");
    }
    assert!(home.join("user-home").join("AppData").join("Local").join("Temp").is_dir());
    assert!(home.join("claude-config").join("settings.json").is_file());

    let names: Vec<String> = env.names();
    let m = launch.write_manifest("s1-ab", names.iter().map(String::as_str)).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["binary"]["version"], pinned("claude").as_str());
    assert_eq!(v["plugins"], serde_json::json!(["vidar-app"]));
    assert!(v["payload"]["marker"].as_str().unwrap().starts_with("VIDAR-PAYLOAD-"));
    // No sets: the static payload.md, no `payload.sets`, and `layer\` is never made.
    assert_eq!(v["payload"]["path"], payload);
    assert!(v["payload"].get("sets").is_none());
    assert!(!home.join("layer").exists(), "layer\\ made with no row sets");
    let text = std::fs::read_to_string(&m).unwrap();
    assert!(!text.contains("sk-test"), "an env value reached the manifest");
    assert!(m.starts_with(home.join("manifests")));
    println!("bare env names: {}", names.join(", "));
}

#[test]
fn a_version_mismatch_warns_and_still_launches() {
    let t = TempDir::new("version");
    let probes = Probes { find: &fake_find, version: &|_, _| Some("0.0.1".into()), remote_control: &|| false };
    let launch = prepare_with("bare", &crate::paths::root(), &t.0.join("agent-home"), inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();
    let w = launch.manifest.binary.warning.clone().unwrap();
    assert!(w.contains("0.0.1") && w.contains(&pinned("claude")) && w.ends_with("Verify: node tools/bare/verify-pin.mjs"), "{w}");
    assert!(launch.args[2].starts_with("Write-Host '[Vidar Bare: Claude 0.0.1"), "{}", launch.args[2]);
}

#[test]
fn a_generation_failure_or_missing_binary_refuses_the_launch() {
    let t = TempDir::new("refuse");
    let home = t.0.join("agent-home");
    let ok = Probes { find: &fake_find, version: &|_, _| None, remote_control: &|| false };
    // settings.json is a folder: the generation fails, so prepare fails.
    home::prepare_dirs(&home, &["claude-config".into()]).unwrap();
    std::fs::create_dir_all(home.join("claude-config").join("settings.json")).unwrap();
    assert!(prepare_with("bare", &crate::paths::root(), &home, inherited(), &guard(), &ok, &LaunchOpts::default()).is_err());
    assert!(std::fs::read_dir(home.join("manifests")).map(|d| d.count()).unwrap_or(0) == 0, "a refused launch left a manifest");

    let t2 = TempDir::new("refuse-bin");
    let none = Probes { find: &|_, _| None, version: &|_, _| None, remote_control: &|| false };
    let e = prepare_with("bare", &crate::paths::root(), &t2.0.join("agent-home"), inherited(), &guard(), &none, &LaunchOpts::default()).err().unwrap();
    assert!(e.contains("not on the allowlisted Path"), "{e}");
}

// ---- Claude Rendered (Falcon-hosted) ----

#[test]
fn a_hosted_spawn_refuses_an_unknown_profile_rules_or_a_gateway() {
    admit_hosted("bare", None, None).unwrap();
    admit_hosted("bare", Some("  "), Some("")).unwrap();
    assert!(admit_hosted("lean", None, None).unwrap_err().contains("Unknown launch profile"));
    assert!(admit_hosted("bare", Some(r"C:\v\runtime\rules\built\0123456789ab.md"), None).unwrap_err().contains("no rules file"));
    assert!(admit_hosted("bare", None, Some("acme")).unwrap_err().contains("no gateway"));
}

#[test]
fn prepare_hosted_readies_the_home_and_records_falcons_env_names() {
    let t = TempDir::new("hosted");
    let home = t.0.join("agent-home");
    let mut launch = prepare_hosted_with("bare", &crate::paths::root(), &home, &guard(), &LaunchOpts::default()).unwrap();
    assert!(home.join("claude-config").join("settings.json").is_file());
    assert!(home.join("user-home").join("AppData").join("Local").join("Temp").is_dir());
    let m = launch.write_manifest("s1-ab", "s1234abcd-00000001", ["=C:", "CLAUDE_CONFIG_DIR", "Path"]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["falconSession"], "s1234abcd-00000001");
    assert_eq!(v["envNames"], serde_json::json!(["=C:", "CLAUDE_CONFIG_DIR", "Path"]));
    assert_eq!(v["plugins"], serde_json::json!(["vidar-app", "gate"]), "the rendered set, gate included");
    assert_eq!(v["homes"]["claudeConfig"], format!("{}\\claude-config", home.display()));
    assert!(v["payload"]["marker"].as_str().unwrap().starts_with("VIDAR-PAYLOAD-"));
    assert!(m.starts_with(home.join("manifests")));
    // The lock is released once settings are written: a second launch on the same home need not wait.
    assert!(home::lock(&home, Duration::from_millis(50)).is_ok());
}

#[test]
fn a_profile_without_a_rendered_block_refuses_a_hosted_spawn_before_the_home() {
    let t = TempDir::new("hosted-norendered");
    let root = root_with_profile(&t, |v| {
        v.as_object_mut().unwrap().remove("rendered");
    });
    let home = t.0.join("agent-home");
    let e = prepare_hosted_with("bare", &root, &home, &guard(), &LaunchOpts::default()).err().unwrap();
    assert!(e.contains("no rendered block"), "{e}");
    assert!(!home.exists(), "the home was touched before the refusal");
}

/// The gate mod and the hooks-module overlay are Rendered only: the Raw bare spawn line, plugin
/// set and env carry neither (its line is pinned in `prepare_builds_the_spawn_line_env_and_manifest`).
#[test]
fn the_raw_bare_profile_output_is_unchanged_by_the_rendered_block() {
    let t = TempDir::new("raw-unchanged");
    let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
    let launch = prepare_with("bare", &crate::paths::root(), &t.0.join("agent-home"), inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();
    assert_eq!(launch.manifest.plugins, vec!["vidar-app".to_string()]);
    assert!(!launch.args[2].contains("gate"), "{}", launch.args[2]);
    assert!(!launch.env.contains("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"));
    // And the same line as a profile with no rendered block at all.
    let t2 = TempDir::new("raw-no-rendered");
    let root = root_with_profile(&t2, |v| {
        v.as_object_mut().unwrap().remove("rendered");
    });
    for rel in ["profiles/bare/payload.md", "profiles/bare/claude.settings.template.json"] {
        let to = under(&root, rel);
        std::fs::copy(under(&crate::paths::root(), rel), &to).unwrap();
    }
    std::fs::create_dir_all(root.join("plugins").join("vidar-app")).unwrap();
    let bare = prepare_with("bare", &root, &t2.0.join("agent-home"), inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();
    let swap = |s: &str| s.replace(&root.display().to_string(), "<root>");
    assert_eq!(swap(&bare.args[2]), launch.args[2].replace(&crate::paths::root().display().to_string(), "<root>"));
    let names = |e: &Env| e.names().join(",");
    assert_eq!(names(&bare.env), names(&launch.env));
}

// ---- Row rune sets (Bare slice 1, W1) ----

/// A temp rune library and a vidar.json stand-in naming it by absolute path.
struct RowFx {
    t: TempDir,
    lib: PathBuf,
    config: PathBuf,
}

impl RowFx {
    fn new(tag: &str) -> RowFx {
        let t = TempDir::new(tag);
        let lib = t.0.join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        std::fs::write(lib.join("tombstones.md"), "| id | date | superseded_by |\n|----|------|---------------|\n").unwrap();
        let config = t.0.join("row-config.json");
        RowFx { t, lib, config }
    }
    fn rune(&self, folder: &str, id: &str, body: &str) {
        let kind = crate::rules::rune::KINDS.iter().find(|(f, _)| *f == folder).unwrap().1;
        let dir = self.lib.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.md")), format!("---\nname: {id}\nkind: {kind}\nscope: [global]\n---\n{body}")).unwrap();
    }
    fn agents(&self, agents: serde_json::Value) {
        let v = serde_json::json!({ "rulesLibrary": self.lib.to_string_lossy(), "agents": agents });
        std::fs::write(&self.config, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    }
    fn opts<'a>(&'a self, key: &'a str) -> LaunchOpts<'a> {
        LaunchOpts { row_key: Some(key), config: Some(&self.config), claude_json: None }
    }
    fn home(&self, tag: &str) -> PathBuf {
        self.t.0.join(format!("home-{tag}"))
    }
    fn raw(&self, home: &Path, key: &str) -> Result<Launch, String> {
        let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
        prepare_with("bare", &crate::paths::root(), home, inherited(), &guard(), &probes, &self.opts(key))
    }
    fn hosted(&self, home: &Path, key: &str) -> Result<HostedLaunch, String> {
        prepare_hosted_with("bare", &crate::paths::root(), home, &guard(), &self.opts(key))
    }
}

fn layer_files(home: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(home.join("layer")).map(|d| d.filter_map(Result::ok).map(|e| e.path()).collect()).unwrap_or_default()
}

fn manifest_count(home: &Path) -> usize {
    std::fs::read_dir(home.join("manifests")).map(|d| d.count()).unwrap_or(0)
}

#[test]
fn a_bare_payload_carries_each_set_in_order_with_a_matching_marker() {
    let fx = RowFx::new("row-sets");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    fx.rune("sets", "beta", "Beta set text.\n");
    fx.agents(serde_json::json!([
        { "key": "claude-bare-review", "sets": [{ "set": "beta" }, { "set": "alpha" }] },
        { "key": "claude-bare-alpha", "sets": [{ "set": "alpha" }] }
    ]));
    let home = fx.home("raw");
    let mut launch = fx.raw(&home, "claude-bare-review").unwrap();
    let files = layer_files(&home);
    assert_eq!(files.len(), 1, "{files:?}");
    let file = &files[0];
    let bytes = std::fs::read(file).unwrap();
    assert_eq!(file.file_name().unwrap().to_string_lossy(), format!("payload-{}.md", crate::rules::build::hash12(&bytes)));
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.starts_with("You are a Claude Code session in a Vidar Bare tab"), "{text}");
    let (marker, expected) = payload_marker(&text).unwrap();
    assert_eq!(marker, expected);
    let (b, a) = (text.find("Beta set text.").unwrap(), text.find("Alpha set text.").unwrap());
    assert!(b < a, "sets out of row order: {text}");
    assert!(launch.args[2].contains(&format!("'--append-system-prompt-file' '{}'", file.display())), "{}", launch.args[2]);
    let m = launch.write_manifest("s1-ab", ["Path"]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["payload"]["sets"], serde_json::json!(["beta", "alpha"]));
    assert_eq!(v["payload"]["marker"], marker.as_str());
    assert_eq!(v["payload"]["path"], file.to_string_lossy().as_ref());
    drop(launch);

    // A second variant row on the same home: its own file and a different marker.
    let other = fx.raw(&home, "claude-bare-alpha").unwrap();
    assert_eq!(layer_files(&home).len(), 2);
    assert_ne!(other.manifest.payload.marker, marker);
}

#[test]
fn a_failing_set_build_refuses_the_spawn_and_writes_nothing() {
    let fx = RowFx::new("row-fail");
    fx.rune("sets", "old", "Old set.\n");
    fx.put_tombstone("old");
    fx.rune("rules", "plain", "A plain rule.\n");
    fx.rune("sets", "hollow", "\n");
    for (set, needle) in [
        ("ghost", "`ghost` is not in the rules library"),
        ("old", "`old` is tombstoned"),
        ("plain", "is a rule, not a set"),
        ("hollow", "built empty"),
    ] {
        fx.agents(serde_json::json!([{ "key": "row", "sets": [{ "set": set }] }]));
        let home = fx.home(set);
        let e = fx.raw(&home, "row").err().unwrap();
        assert!(e.contains(needle) && e.contains("spawn refused"), "raw {set}: {e}");
        let e = fx.hosted(&home, "row").err().unwrap();
        assert!(e.contains(needle), "hosted {set}: {e}");
        assert!(!home.join("layer").exists(), "{set}: layer\\ written by a refused spawn");
        assert!(!home.join("claude-config").join("settings.json").exists(), "{set}: settings written by a refused spawn");
        assert_eq!(manifest_count(&home), 0, "{set}: a refused spawn left a manifest");
    }
}

impl RowFx {
    fn put_tombstone(&self, id: &str) {
        let row = format!("| id | date | superseded_by |\n|----|------|---------------|\n| {id} | 2026-10-16 | none |\n");
        std::fs::write(self.lib.join("tombstones.md"), row).unwrap();
    }
}

#[test]
fn a_set_ref_without_library_resolves_through_rules_library() {
    let fx = RowFx::new("row-lib");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    // `rulesLibrary` relative to the root, as vidar.json holds it.
    let cfg = serde_json::json!({ "rulesLibrary": "lib", "agents": [{ "key": "k", "sets": [{ "set": "alpha" }] }] });
    std::fs::write(&fx.config, cfg.to_string()).unwrap();
    let row = layer::row_sets(&fx.config, "k").unwrap();
    assert_eq!(row.sets, vec![layer::SetRef { library: None, set: "alpha".into() }]);
    assert_eq!(row.rules_library.as_deref(), Some("lib"));
    let home = fx.home("lib");
    std::fs::create_dir_all(&home).unwrap();
    let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
    let built = layer::build_payload(&lock, &fx.t.0, &home, "Rules:\n\n{{sets}}\n", &row, &guard(), &[]).unwrap();
    assert!(String::from_utf8_lossy(&built.bytes).contains("Alpha set text."));
    assert!(built.path.starts_with(home.join("layer")));

    let none = layer::RowSets { rules_library: None, ..row };
    let e = layer::build_payload(&lock, &fx.t.0, &home, "{{sets}}\n", &none, &guard(), &[]).err().unwrap();
    assert!(e.contains("rulesLibrary"), "{e}");
}

impl RowFx {
    /// A rune in the import library `<temp root>\runtime\runes\<lib>\` (never the real one).
    fn import_rune(&self, lib: &str, folder: &str, id: &str, body: &str) {
        self.import_rune_with(lib, folder, id, "", body);
    }
    /// `import_rune` with `extra` header lines (`state: draft\n`).
    fn import_rune_with(&self, lib: &str, folder: &str, id: &str, extra: &str, body: &str) {
        let kind = crate::rules::rune::KINDS.iter().find(|(f, _)| *f == folder).unwrap().1;
        let dir = crate::paths::rune_imports_dir_in(&self.t.0).join(lib).join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.md")), format!("---\nname: {id}\nkind: {kind}\nscope: [global]\n{extra}---\n{body}")).unwrap();
    }
    /// `build_payload` against the temp root, under a fresh home's lock.
    fn build_in(&self, tag: &str, sets: &[(Option<&str>, &str)]) -> (PathBuf, Result<layer::BuiltPayload, String>) {
        let sets = sets.iter().map(|(l, s)| layer::SetRef { library: l.map(str::to_string), set: s.to_string() }).collect();
        let row = layer::RowSets { sets, rules_library: Some(self.lib.to_string_lossy().into_owned()) };
        let home = self.home(tag);
        std::fs::create_dir_all(&home).unwrap();
        let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
        let built = layer::build_payload(&lock, &self.t.0, &home, "Rules:\n\n{{sets}}\n", &row, &guard(), &[]);
        (home, built)
    }
}

#[test]
fn a_set_ref_naming_an_import_library_builds_from_runtime_runes() {
    let fx = RowFx::new("row-import-lib");
    // The folder's shape is pinned in paths.rs; this root is the temp one.
    assert!(crate::paths::rune_imports_dir_in(&fx.t.0).starts_with(&fx.t.0));
    fx.import_rune("team", "rules", "use-pnpm-1", "Use pnpm, never npm.\n");
    fx.import_rune("team", "sets", "row-k", "- <?rune use-pnpm-1?>\n");
    fx.import_rune("global", "rules", "verdict-first-1", "Verdict first.\n");
    fx.import_rune("global", "sets", "row-k", "- <?rune verdict-first-1?>\n");
    for (lib, text) in [("team", "- Use pnpm, never npm."), ("global", "- Verdict first.")] {
        let (_, built) = fx.build_in(lib, &[(Some(lib), "row-k")]);
        let built = built.unwrap();
        let body = String::from_utf8_lossy(&built.bytes).into_owned();
        assert!(body.contains(text), "{lib}: {body}");
        assert_eq!(built.sets, vec![format!("{lib}/row-k")]);
    }
    // No rulesLibrary is needed when every ref names a library.
    let row = layer::RowSets { sets: vec![layer::SetRef { library: Some("team".into()), set: "row-k".into() }], rules_library: None };
    let home = fx.home("no-rules-lib");
    std::fs::create_dir_all(&home).unwrap();
    let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
    layer::build_payload(&lock, &fx.t.0, &home, "{{sets}}\n", &row, &guard(), &[]).unwrap();

    // A library with no folder refuses the spawn and writes nothing.
    let (home, built) = fx.build_in("absent", &[(Some("absent"), "row-k")]);
    let e = built.err().unwrap();
    assert!(e.contains("names library \"absent\"") && e.contains("has no folder") && e.contains("spawn refused"), "{e}");
    assert!(e.contains("at runtime\\runes\\absent;") && !e.contains(&*fx.t.0.to_string_lossy()), "the path is not root-relative: {e}");
    assert!(!home.join("layer").exists());
}

#[test]
fn a_library_folder_junctioned_out_of_runtime_runes_is_refused() {
    let fx = RowFx::new("row-lib-junction");
    let outside = fx.t.0.join("outside");
    std::fs::create_dir_all(outside.join("sets")).unwrap();
    std::fs::write(outside.join("sets").join("row-k.md"), "---\nname: row-k\nkind: set\nscope: [global]\n---\nOutside.\n").unwrap();
    let base = crate::paths::rune_imports_dir_in(&fx.t.0);
    std::fs::create_dir_all(&base).unwrap();
    let link = base.join("team");
    let made = std::process::Command::new("cmd").arg("/c").arg("mklink").arg("/J").arg(&link).arg(&outside).output();
    if !made.as_ref().is_ok_and(|o| o.status.success()) || !link.is_dir() {
        eprintln!("skipped: mklink /J failed: {made:?}");
        return;
    }
    let (home, built) = fx.build_in("junction", &[(Some("team"), "row-k")]);
    let e = built.err().unwrap();
    assert!(e.contains("resolves outside runtime\\runes") && e.contains("spawn refused"), "{e}");
    assert!(!home.join("layer").exists());
}

#[test]
fn a_draft_rule_in_the_first_library_does_not_hide_the_second() {
    let fx = RowFx::new("row-draft-first");
    fx.import_rune_with("global", "rules", "x", "state: draft\n", "Global draft x.\n");
    fx.import_rune("global", "rules", "g-1", "Global one.\n");
    fx.import_rune("global", "sets", "row-k", "- <?rune x?>\n- <?rune g-1?>\n");
    fx.import_rune("team", "rules", "x", "Team x.\n");
    fx.import_rune("team", "sets", "row-k", "- <?rune x?>\n");
    let (_, built) = fx.build_in("draft", &[(Some("global"), "row-k"), (Some("team"), "row-k")]);
    let built = built.unwrap();
    let text = String::from_utf8_lossy(&built.bytes).into_owned();
    assert!(text.contains("- Global one.") && text.contains("- Team x.") && !text.contains("Global draft x."), "{text}");
    assert!(built.warnings.is_empty(), "{:?}", built.warnings);
}

#[test]
fn a_library_name_outside_the_id_grammar_is_refused() {
    let fx = RowFx::new("row-lib-grammar");
    fx.import_rune("team", "sets", "row-k", "Team text.\n");
    for name in ["Team", "../team", "..\\team", "team/sub", "a b", "", "a--b", "-team", "con", "C:\\team"] {
        let (home, built) = fx.build_in("grammar", &[(Some(name), "row-k")]);
        let e = built.err().unwrap_or_else(|| panic!("{name:?} built"));
        assert!(e.contains("not a library name") && e.contains("spawn refused"), "{name:?}: {e}");
        assert!(!home.join("layer").exists(), "{name:?}: layer\\ written");
    }
    // Raw and hosted spawns refuse it too, before any library folder is read.
    fx.agents(serde_json::json!([{ "key": "k", "sets": [{ "library": "../team", "set": "row-k" }] }]));
    let home = fx.home("spawn");
    assert!(fx.raw(&home, "k").err().unwrap().contains("not a library name"));
    assert!(fx.hosted(&home, "k").err().unwrap().contains("not a library name"));
    assert!(!home.join("layer").exists());
}

#[test]
fn two_libraries_on_one_row_build_in_ref_order_without_duplicates() {
    let fx = RowFx::new("row-two-libs");
    fx.import_rune("beta", "rules", "shared-1", "Shared from beta.\n");
    fx.import_rune("beta", "rules", "b-only-1", "Beta only.\n");
    fx.import_rune("beta", "sets", "row-k", "- <?rune shared-1?>\n- <?rune b-only-1?>\n");
    fx.import_rune("alpha", "rules", "shared-1", "Shared from beta.\n");
    fx.import_rune("alpha", "rules", "a-only-1", "Alpha only.\n");
    fx.import_rune("alpha", "sets", "row-k", "- <?rune a-only-1?>\n- <?rune shared-1?>\n");
    fx.rune("sets", "local", "Local set text.\n");
    let refs = [(Some("beta"), "row-k"), (Some("alpha"), "row-k"), (Some("beta"), "row-k"), (None, "local")];
    let (_, built) = fx.build_in("two", &refs);
    let built = built.unwrap();
    let text = String::from_utf8_lossy(&built.bytes).into_owned();
    assert_eq!(text.matches("Shared from beta.").count(), 1, "{text}");
    assert_eq!(text.matches("Beta only.").count(), 1, "a repeated ref built twice: {text}");
    let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("{s} missing: {text}"));
    assert!(at("Shared from beta.") < at("Beta only.") && at("Beta only.") < at("Alpha only.") && at("Alpha only.") < at("Local set text."), "{text}");
    assert!(text.contains("- Beta only.\n\n- Alpha only.\n\nLocal set text."), "{text}");
    let sets: Vec<&str> = built.sets.iter().map(String::as_str).collect();
    assert_eq!(sets, ["beta/row-k", "alpha/row-k", "beta/row-k", "local"]);
    let dup: Vec<&String> = built.warnings.iter().filter(|w| w.contains("already placed")).collect();
    assert_eq!(dup.len(), 1, "{:?}", built.warnings);
    assert!(dup[0].contains("`shared-1`") && dup[0].contains("alpha") && dup[0].contains("beta"), "{}", dup[0]);
}

#[test]
fn two_libraries_minting_one_id_for_different_rules_keep_both() {
    let fx = RowFx::new("row-same-id-two-bodies");
    fx.import_rune("beta", "rules", "use-the-powershell-tool-1", "Beta body.\n");
    fx.import_rune("beta", "sets", "row-k", "- <?rune use-the-powershell-tool-1?>\n");
    fx.import_rune("alpha", "rules", "use-the-powershell-tool-1", "Alpha body.\n");
    fx.import_rune("alpha", "sets", "row-k", "- <?rune use-the-powershell-tool-1?>\n");
    let (_, built) = fx.build_in("ids", &[(Some("beta"), "row-k"), (Some("alpha"), "row-k")]);
    let built = built.unwrap();
    let text = String::from_utf8_lossy(&built.bytes).into_owned();
    assert!(text.contains("Beta body.") && text.contains("Alpha body."), "{text}");
    assert!(built.warnings.iter().all(|w| !w.contains("already placed")), "{:?}", built.warnings);
}

#[test]
fn guard_brick_refuses_a_profile_path_or_placeholder_and_passes_home_paths() {
    let (root, home_s) = (r"X:\vidar", r"C:\Users\testuser\AppData\Local\Vidar\homes\k\bare");
    let g = guard();
    assert!(home::guard_brick("Notes live in C:\\Users\\testuser\\notes.", root, home_s, &g).err().unwrap().contains("user-profile path"));
    assert!(home::guard_brick("Fill {{name}} in.", root, home_s, &g).err().unwrap().contains("placeholder"));
    home::guard_brick(&format!("Logs sit in {home_s}\\logs."), root, home_s, &g).unwrap();
    home::guard_brick("Ask testuser before a push.", root, home_s, &g).unwrap();
}

#[test]
fn the_last_keyed_entry_for_a_row_key_supplies_its_sets() {
    let fx = RowFx::new("row-lookup");
    fx.agents(serde_json::json!([
        { "key": "r", "sets": [{ "set": "first" }] },
        { "key": "other", "sets": [{ "set": "other" }] },
        { "key": "r", "sets": [{ "set": "last" }, { "set": "more" }] },
        { "key": "plain", "label": "Plain" },
        { "key": "relabelled", "profile": "bare", "sets": [{ "set": "kept" }] },
        { "key": "relabelled", "label": "Bare Review" },
        { "key": "cleared", "sets": [{ "set": "x" }] },
        { "key": "cleared", "sets": null }
    ]));
    let ids = |key: &str| layer::row_sets(&fx.config, key).unwrap().sets.into_iter().map(|s| s.set).collect::<Vec<_>>();
    assert_eq!(ids("r"), ["last", "more"]);
    assert!(ids("ghost").is_empty(), "an unknown key has no sets");
    assert!(ids("plain").is_empty(), "a row without sets has none");
    // The frontend overlay merges same-key entries field by field: a later label-only entry
    // keeps the row's sets, so Rust must not launch it without them.
    assert_eq!(ids("relabelled"), ["kept"], "a label-only override dropped the row's sets");
    assert!(ids("cleared").is_empty(), "a later `sets: null` clears them");

    // A keyed row with no sets launches on the static payload, `layer\` untouched.
    let fx2 = RowFx::new("row-lookup-plain");
    fx2.agents(serde_json::json!([{ "key": "plain" }]));
    let home = fx2.home("plain");
    let launch = fx2.raw(&home, "plain").unwrap();
    assert!(launch.manifest.payload.path.ends_with("payload.md"), "{}", launch.manifest.payload.path);
    assert!(!home.join("layer").exists());
}

#[test]
fn an_unreadable_config_refuses_a_row_key_spawn() {
    let fx = RowFx::new("row-unreadable");
    std::fs::write(&fx.config, "{ \"agents\": [ not json").unwrap();
    let home = fx.home("bad");
    let e = fx.raw(&home, "claude-bare").err().unwrap();
    assert!(e.contains("unreadable") && e.contains("spawn refused"), "{e}");
    let e = fx.hosted(&home, "claude-bare").err().unwrap();
    assert!(e.contains("unreadable"), "{e}");
    assert!(!home.exists(), "the home was touched before the refusal");
    // Sets that are not a list of refs refuse too.
    fx.agents(serde_json::json!([{ "key": "k", "sets": ["alpha"] }]));
    assert!(fx.raw(&home, "k").err().unwrap().contains("not a list"));
}

#[test]
fn a_built_payload_holding_the_user_profile_path_is_refused() {
    let fx = RowFx::new("row-guard");
    fx.rune("sets", "leaky", "Notes live in C:\\Users\\testuser\\notes for now.\n");
    fx.rune("sets", "named", "Ask testuser before a push.\n");
    fx.agents(serde_json::json!([
        { "key": "leaky", "sets": [{ "set": "leaky" }] },
        { "key": "named", "sets": [{ "set": "named" }] }
    ]));
    let home = fx.home("guard");
    let e = fx.raw(&home, "leaky").err().unwrap();
    assert!(e.contains("user-profile path") && e.contains("spawn refused"), "{e}");
    assert!(layer_files(&home).is_empty(), "a refused payload was written");
    // The account name alone passes (the Codex payload rule): only paths are refused.
    fx.raw(&home, "named").unwrap();
}

#[test]
fn a_hosted_prepare_with_row_sets_records_the_built_payload() {
    let fx = RowFx::new("row-hosted");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    fx.agents(serde_json::json!([{ "key": "claude-rendered-bare", "sets": [{ "set": "alpha" }] }]));
    let home = fx.home("hosted");
    let mut launch = fx.hosted(&home, "claude-rendered-bare").unwrap();
    let file = launch.payload_file.clone().expect("the built payload's path");
    assert!(file.starts_with(home.join("layer")) && file.is_file(), "{}", file.display());
    let text = std::fs::read_to_string(&file).unwrap();
    let (marker, expected) = payload_marker(&text).unwrap();
    assert_eq!(marker, expected);
    let m = launch.write_manifest("s1-ab", "s1234abcd-00000001", ["Path"]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["payload"]["path"], file.to_string_lossy().as_ref());
    assert_eq!(v["payload"]["sets"], serde_json::json!(["alpha"]));
    assert_eq!(v["payload"]["marker"], marker.as_str());
    // The lock spans the payload write and is released before the host round-trip.
    assert!(home::lock(&home, Duration::from_millis(50)).is_ok());
    // No row key: the profile's own payload, nothing to hand Falcon.
    let plain = prepare_hosted_with("bare", &crate::paths::root(), &fx.home("plain"), &guard(), &LaunchOpts::default()).unwrap();
    assert!(plain.payload_file.is_none());
}

#[test]
fn a_blank_row_key_is_no_key() {
    assert_eq!(row_key_of(Some("   ".into())), None);
    assert_eq!(row_key_of(Some(String::new())), None);
    assert_eq!(row_key_of(None), None);
    assert_eq!(row_key_of(Some(" claude-bare ".into())).as_deref(), Some("claude-bare"));
    // A blank key reads no vidar.json, so even an unreadable one cannot refuse the spawn.
    let fx = RowFx::new("row-blank");
    std::fs::write(&fx.config, "{ not json").unwrap();
    assert!(layer::row_sets(&fx.config, "  ").unwrap().sets.is_empty());
    // An entry whose key is the same blank string is not this spawn's row.
    fx.agents(serde_json::json!([{ "key": "  ", "sets": [{ "set": "ghost" }] }]));
    let home = fx.home("blank");
    let launch = fx.raw(&home, "  ").unwrap();
    assert!(launch.manifest.payload.path.ends_with("payload.md"), "{}", launch.manifest.payload.path);
    drop(launch);
    // A padded key finds its row.
    fx.rune("sets", "alpha", "Alpha set text.\n");
    fx.agents(serde_json::json!([{ "key": "k", "sets": [{ "set": "alpha" }] }]));
    assert_eq!(layer::row_sets(&fx.config, " k ").unwrap().sets.len(), 1);
}

#[test]
fn a_sets_template_without_exactly_one_slot_is_refused_before_any_write() {
    let fx = RowFx::new("row-slot");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    fx.agents(serde_json::json!([{ "key": "k", "sets": [{ "set": "alpha" }] }]));
    let row = layer::row_sets(&fx.config, "k").unwrap();
    let home = fx.home("slot");
    std::fs::create_dir_all(&home).unwrap();
    let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
    for (tpl, n) in [("No slot here.\n", 0), ("{{sets}}\n\n{{sets}}\n", 2)] {
        let e = layer::build_payload(&lock, &fx.t.0, &home, tpl, &row, &guard(), &[]).err().unwrap();
        assert!(e.contains(&format!("{{{{sets}}}} {n} times, not once")) && e.ends_with("; Bare spawn refused"), "{e}");
        assert!(!home.join("layer").exists(), "a refused template wrote layer\\");
    }
}

#[test]
fn an_unchanged_row_payload_is_not_rewritten() {
    let fx = RowFx::new("row-same");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    fx.agents(serde_json::json!([{ "key": "k", "sets": [{ "set": "alpha" }] }]));
    let row = layer::row_sets(&fx.config, "k").unwrap();
    let home = fx.home("same");
    std::fs::create_dir_all(&home).unwrap();
    let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
    let first = layer::build_payload(&lock, &fx.t.0, &home, "Rules:\n\n{{sets}}\n", &row, &guard(), &[]).unwrap();
    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
    std::fs::File::options().write(true).open(&first.path).unwrap().set_modified(old).unwrap();
    let second = layer::build_payload(&lock, &fx.t.0, &home, "Rules:\n\n{{sets}}\n", &row, &guard(), &[]).unwrap();
    assert_eq!(second.path, first.path);
    assert_eq!(std::fs::metadata(&second.path).unwrap().modified().unwrap(), old, "the same bytes were written again");
    // Different bytes under the same name (a damaged file) are rewritten.
    std::fs::write(&first.path, "damaged").unwrap();
    layer::build_payload(&lock, &fx.t.0, &home, "Rules:\n\n{{sets}}\n", &row, &guard(), &[]).unwrap();
    assert_eq!(std::fs::read(&first.path).unwrap(), first.bytes);
}

#[test]
fn rune_build_warnings_reach_the_hosted_manifest() {
    let fx = RowFx::new("row-warn");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    std::fs::write(fx.lib.join("sets").join("off.md"), "---\nname: off\nkind: set\nscope: [global]\nstate: disabled\n---\nOff set.\n").unwrap();
    fx.agents(serde_json::json!([{ "key": "k", "sets": [{ "set": "alpha" }, { "set": "off" }] }]));
    let home = fx.home("warn");
    let mut hosted = fx.hosted(&home, "k").unwrap();
    // The spawn reply's list: the rune build's warnings first, as Raw's line orders them.
    assert!(hosted.bare_warnings().iter().any(|w| w.contains("`off` is disabled")), "{:?}", hosted.bare_warnings());
    let m = hosted.write_manifest("s1-ab", "s1234abcd-00000001", ["Path"]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    let warnings = v["payload"]["warnings"].as_array().cloned().unwrap_or_default();
    assert!(warnings.iter().any(|w| w.as_str().is_some_and(|w| w.contains("`off` is disabled"))), "{v}");
    // Raw records them too, beside its yellow line; a plain payload records none.
    let raw = fx.raw(&home, "k").unwrap();
    assert!(raw.args[2].contains("is disabled") && !raw.manifest.payload.warnings.is_empty());
    drop(raw);
    let plain = prepare_hosted_with("bare", &crate::paths::root(), &fx.home("plain"), &guard(), &LaunchOpts::default()).unwrap();
    assert!(plain.manifest.payload.warnings.is_empty());
}

#[test]
fn bare_layer_and_sets_payload_errors_say_the_spawn_was_refused() {
    let fx = RowFx::new("row-errs");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    fx.agents(serde_json::json!([{ "key": "k", "sets": [{ "set": "alpha" }] }]));
    let row = layer::row_sets(&fx.config, "k").unwrap();
    // `layer` taken by a file: the directory cannot be made.
    let home = fx.home("errs");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("layer"), "not a dir").unwrap();
    let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
    let e = layer::build_payload(&lock, &fx.t.0, &home, "{{sets}}\n", &row, &guard(), &[]).err().unwrap();
    assert!(e.starts_with("Bare layer") && e.ends_with("; Bare spawn refused"), "{e}");
    drop(lock);
    // The profile's sets template missing.
    let t = TempDir::new("row-errs-root");
    let root = root_with_profile(&t, |v| v["setsPayload"] = serde_json::json!("profiles/bare/missing-sets.md"));
    let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
    let e = prepare_with("bare", &root, &fx.home("tpl"), inherited(), &guard(), &probes, &fx.opts("k")).err().unwrap();
    assert!(e.starts_with("Bare sets payload") && e.ends_with("; Bare spawn refused"), "{e}");
}

#[test]
fn a_row_payload_keeps_a_hook_claim_only_when_bare_guards_carry_it() {
    let fx = RowFx::new("row-hook-claim");
    let head = |name: &str, scope: &str, extra: &str| format!("---\nname: {name}\nkind: rule\nscope: {scope}\nactivate: always\n{extra}---\n");
    let rules = fx.lib.join("rules");
    std::fs::create_dir_all(&rules).unwrap();
    std::fs::write(rules.join("hook-x.md"), format!("{}Hook claim text.\n", head("hook-x", "[global]", "enforced-by: [guard-x.mjs]\n"))).unwrap();
    std::fs::write(rules.join("bare-x.md"), format!("{}Bare excluded text.\n", head("bare-x", "[global, \"!bare\"]", ""))).unwrap();
    std::fs::write(rules.join("plain-x.md"), format!("{}Plain text.\n", head("plain-x", "[global]", ""))).unwrap();
    fx.rune("sets", "mixed", "<?rune hook-x?>\n\n<?rune bare-x?>\n\n<?rune plain-x?>\n");
    let script = fx.script("hooks", "guard-x.mjs", "// guard x\n");
    let config = |guards: serde_json::Value| {
        let v = serde_json::json!({ "rulesLibrary": fx.lib.to_string_lossy(), "agents": [{ "key": "k", "sets": [{ "set": "mixed" }] }], "bareGuards": guards });
        std::fs::write(&fx.config, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    };
    let payload_of = |l: &Launch| String::from_utf8(std::fs::read(&l.manifest.payload.path).unwrap()).unwrap();

    // No guard carries guard-x.mjs: the claim is dropped and says so in the manifest record.
    config(serde_json::json!([]));
    let without = fx.raw(&fx.home("without"), "k").unwrap();
    let text = payload_of(&without);
    assert!(!text.contains("Hook claim text.") && !text.contains("Bare excluded text.") && text.contains("Plain text."), "{text}");
    let w = &without.manifest.payload.warnings;
    assert!(w.iter().any(|w| w.contains("`hook-x`") && w.contains("guard-x.mjs")), "{w:?}");
    assert!(!w.iter().any(|w| w.contains("bare-x")), "{w:?}");
    let hosted = fx.hosted(&fx.home("without-hosted"), "k").unwrap();
    assert!(hosted.manifest.payload.warnings.iter().any(|w| w.contains("`hook-x`")), "{:?}", hosted.manifest.payload.warnings);

    // A guard that copies guard-x.mjs keeps it; the `!bare` member stays out either way.
    config(serde_json::json!([{ "event": "PreToolUse", "run": [script] }]));
    let with = fx.raw(&fx.home("with"), "k").unwrap();
    let text = payload_of(&with);
    assert!(text.contains("Hook claim text.") && text.contains("Plain text.") && !text.contains("Bare excluded text."), "{text}");
    assert!(with.manifest.payload.warnings.is_empty(), "{:?}", with.manifest.payload.warnings);
    let hosted = fx.hosted(&fx.home("with-hosted"), "k").unwrap();
    assert!(hosted.manifest.payload.warnings.is_empty(), "{:?}", hosted.manifest.payload.warnings);
}

// ---- Guard copies (Bare slice 1, W3) ----

impl RowFx {
    /// A script under the fixture's temp dir (never a machine path); returns its absolute path.
    fn script(&self, folder: &str, name: &str, body: &str) -> String {
        let dir = self.t.0.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }
    fn guards(&self, guards: serde_json::Value) {
        let v = serde_json::json!({ "rulesLibrary": self.lib.to_string_lossy(), "bareGuards": guards });
        std::fs::write(&self.config, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    }
    fn plain(&self) -> LaunchOpts<'_> {
        LaunchOpts { row_key: None, config: Some(&self.config), claude_json: None }
    }
    fn raw_plain(&self, home: &Path) -> Result<Launch, String> {
        let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
        prepare_with("bare", &crate::paths::root(), home, inherited(), &guard(), &probes, &self.plain())
    }
    fn hosted_plain(&self, home: &Path) -> Result<HostedLaunch, String> {
        prepare_hosted_with("bare", &crate::paths::root(), home, &guard(), &self.plain())
    }
}

fn settings_of(home: &Path) -> Option<String> {
    std::fs::read_to_string(home.join("claude-config").join("settings.json")).ok()
}

#[test]
fn copied_guards_land_in_settings_for_raw_and_hosted_alike() {
    let fx = RowFx::new("guards-land");
    let wrapper = fx.script("hooks", "fail-closed.mjs", "// wrapper v1\n");
    let crawl = fx.script("hooks", "guard-crawl.mjs", "// crawl v1\n");
    let install = fx.script("hooks", "guard-install.mjs", "// install v1\n");
    fx.guards(serde_json::json!([
        { "event": "PreToolUse", "matcher": "Bash", "run": [wrapper, crawl] },
        { "event": "PreToolUse", "run": [wrapper, install] }
    ]));
    let home = fx.home("land");
    drop(fx.raw_plain(&home).unwrap());
    let raw = settings_of(&home).unwrap();

    let copies = home.join("layer").join("hooks");
    for (name, body) in [("fail-closed.mjs", "// wrapper v1\n"), ("guard-crawl.mjs", "// crawl v1\n"), ("guard-install.mjs", "// install v1\n")] {
        assert_eq!(std::fs::read_to_string(copies.join(name)).unwrap(), body, "{name}");
    }
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
    assert!(pre.len() >= 3, "the template's own groups stay ahead of the guards: {pre:?}");
    let quoted = |n: &str| format!("\"{}\"", copies.join(n).display());
    let crawl_group = &pre[pre.len() - 2];
    assert_eq!(crawl_group["matcher"], "Bash");
    assert_eq!(crawl_group["hooks"][0]["type"], "command");
    assert_eq!(crawl_group["hooks"][0]["command"], format!("node {} {}", quoted("fail-closed.mjs"), quoted("guard-crawl.mjs")));
    let install_group = &pre[pre.len() - 1];
    assert!(install_group.get("matcher").is_none());
    assert_eq!(install_group["hooks"][0]["command"], format!("node {} {}", quoted("fail-closed.mjs"), quoted("guard-install.mjs")));
    assert!(!raw.contains(&fx.t.0.join("hooks").to_string_lossy().replace('\\', "\\\\")), "settings name a source, not the copy");

    // Hosted writes the same file, so the shared settings.json never flips between the two.
    let mut hosted = fx.hosted_plain(&home).unwrap();
    assert_eq!(settings_of(&home).unwrap(), raw);
    hosted.write_manifest("s1-ab", "s1234abcd-00000001", ["Path"]).unwrap();

    // Copies refresh on every spawn.
    std::fs::write(&crawl, "// crawl v2\n").unwrap();
    drop(fx.raw_plain(&home).unwrap());
    assert_eq!(std::fs::read_to_string(copies.join("guard-crawl.mjs")).unwrap(), "// crawl v2\n");

    // No guards: no layer\ and the template's hooks alone, as before W3.
    let none = fx.home("none");
    fx.guards(serde_json::json!([]));
    drop(fx.raw_plain(&none).unwrap());
    assert!(!none.join("layer").exists());
    let v: serde_json::Value = serde_json::from_str(&settings_of(&none).unwrap()).unwrap();
    assert_eq!(v["hooks"]["PreToolUse"].as_array().unwrap().len(), pre.len() - 2);
}

#[test]
fn a_missing_guard_script_refuses_the_spawn() {
    let fx = RowFx::new("guards-missing");
    let wrapper = fx.script("hooks", "fail-closed.mjs", "// wrapper\n");
    let gone = fx.t.0.join("hooks").join("guard-gone.mjs").to_string_lossy().into_owned();
    fx.guards(serde_json::json!([{ "event": "PreToolUse", "run": [wrapper, gone] }]));
    let home = fx.home("missing");
    let e = fx.raw_plain(&home).err().unwrap();
    assert!(e.contains("missing") && e.contains("spawn refused"), "{e}");
    let e = fx.hosted_plain(&home).err().unwrap();
    assert!(e.contains("missing"), "{e}");
    assert!(!home.join("layer").exists(), "a refused guard set copied something");
    assert!(settings_of(&home).is_none(), "settings.json was written before the refusal");
    assert_eq!(manifest_count(&home), 0);
    // A malformed `bareGuards` refuses before the home is touched.
    let bad = fx.home("malformed");
    fx.guards(serde_json::json!([{ "event": "PreToolUse", "run": "not a list" }]));
    let e = fx.raw_plain(&bad).err().unwrap();
    assert!(e.contains("bareGuards") && e.contains("spawn refused"), "{e}");
    assert!(!bad.exists());
}

#[test]
fn a_guard_script_must_be_an_absolute_mjs_path() {
    let fx = RowFx::new("guards-mjs");
    let js = fx.script("hooks", "guard-crawl.js", "// not a module\n");
    let home = fx.home("mjs");
    for run in [serde_json::json!([js]), serde_json::json!(["hooks\\guard-crawl.mjs"]), serde_json::json!([])] {
        fx.guards(serde_json::json!([{ "event": "PreToolUse", "run": run }]));
        let e = fx.raw_plain(&home).err().unwrap();
        assert!(e.contains("spawn refused"), "{e}");
        assert!(e.contains(".mjs") || e.contains("empty"), "{e}");
    }
    let ok = fx.script("hooks", "guard-crawl.MJS", "// upper-case extension\n");
    fx.guards(serde_json::json!([{ "event": "PreToolUse", "run": [ok] }]));
    drop(fx.raw_plain(&home).unwrap());
    fx.guards(serde_json::json!([{ "event": "Pre Tool", "run": [ok] }]));
    assert!(fx.raw_plain(&home).err().unwrap().contains("hook event"));
}

#[test]
fn guard_scripts_of_one_name_from_different_folders_are_refused() {
    let fx = RowFx::new("guards-names");
    let a = fx.script("a", "guard-crawl.mjs", "// a\n");
    let b = fx.script("b", "Guard-Crawl.mjs", "// b\n");
    let home = fx.home("names");
    fx.guards(serde_json::json!([
        { "event": "PreToolUse", "run": [a] },
        { "event": "PreToolUse", "run": [b] }
    ]));
    let e = fx.raw_plain(&home).err().unwrap();
    assert!(e.contains("different folders") && e.contains("spawn refused"), "{e}");
    assert!(!home.join("layer").exists());
    // The same file named twice (a shared wrapper) is one copy, not a clash.
    fx.guards(serde_json::json!([
        { "event": "PreToolUse", "run": [a] },
        { "event": "Stop", "run": [a] }
    ]));
    drop(fx.raw_plain(&home).unwrap());
    assert_eq!(std::fs::read_dir(home.join("layer").join("hooks")).unwrap().count(), 1);
}

#[test]
fn a_guard_event_must_be_a_claude_hook_event_and_the_wrapper_pre_tool_use_only() {
    let fx = RowFx::new("guards-events");
    let wrapper = fx.script("hooks", "fail-closed.mjs", "// wrapper\n");
    let crawl = fx.script("hooks", "guard-crawl.mjs", "// crawl\n");
    let home = fx.home("events");
    for event in ["pretooluse", "PreToolUSE", "OnSave", "Pre Tool"] {
        fx.guards(serde_json::json!([{ "event": event, "run": [crawl] }]));
        let e = fx.raw_plain(&home).err().unwrap();
        assert!(e.contains("not a Claude Code hook event") && e.ends_with("; Bare spawn refused"), "{event}: {e}");
    }
    for event in guards::HOOK_EVENTS {
        fx.guards(serde_json::json!([{ "event": event, "run": [crawl] }]));
        drop(fx.raw_plain(&home).unwrap_or_else(|e| panic!("{event}: {e}")));
    }
    fx.guards(serde_json::json!([{ "event": "Stop", "run": [wrapper, crawl] }]));
    let e = fx.raw_plain(&home).err().unwrap();
    assert!(e.contains("wraps PreToolUse only") && e.ends_with("; Bare spawn refused"), "{e}");
    fx.guards(serde_json::json!([{ "event": "PreToolUse", "run": [wrapper] }]));
    let e = fx.hosted_plain(&home).err().unwrap();
    assert!(e.contains("no guard after it"), "{e}");
    fx.guards(serde_json::json!([{ "event": "PreToolUse", "run": [wrapper, crawl] }]));
    drop(fx.raw_plain(&home).unwrap());
}

#[test]
fn the_manifest_names_the_guard_copies_and_a_missing_bare_guards_key_stays_quiet() {
    let fx = RowFx::new("guards-visible");
    let wrapper = fx.script("hooks", "fail-closed.mjs", "// wrapper\n");
    let crawl = fx.script("hooks", "guard-crawl.mjs", "// crawl\n");
    fx.guards(serde_json::json!([{ "event": "PreToolUse", "run": [wrapper, crawl] }]));
    let home = fx.home("visible");
    let mut raw = fx.raw_plain(&home).unwrap();
    assert!(!raw.args[2].contains("No bareGuards"), "{}", raw.args[2]);
    let m = raw.write_manifest("s1-ab", ["Path"]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["guards"], serde_json::json!(["fail-closed.mjs", "guard-crawl.mjs"]));
    assert!(v.get("warnings").is_none(), "{v}");
    drop(raw);

    // A readable vidar.json without the key is quiet: no banner, no warning;
    // Settings > Agents shows the guard state.
    fx.agents(serde_json::json!([]));
    let raw = fx.raw_plain(&home).unwrap();
    assert!(!raw.args[2].contains("bareGuards"), "{}", raw.args[2]);
    assert_eq!(raw.manifest.guards, Vec::<String>::new());
    assert!(raw.manifest.warnings.is_empty(), "{:?}", raw.manifest.warnings);
    drop(raw);
    let mut hosted = fx.hosted_plain(&home).unwrap();
    let m = hosted.write_manifest("s1-cd", "s1234abcd-00000002", ["Path"]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["guards"], serde_json::json!([]));
    assert!(v.get("warnings").is_none(), "{v}");
    // An empty list and no vidar.json at all stay quiet too.
    fx.guards(serde_json::json!([]));
    assert!(fx.hosted_plain(&home).unwrap().manifest.warnings.is_empty());
    let plain = prepare_hosted_with("bare", &crate::paths::root(), &fx.home("nofile"), &guard(), &LaunchOpts::default()).unwrap();
    assert!(plain.manifest.warnings.is_empty());
}

// ---- Codex Rendered ----

#[test]
fn the_codex_rendered_bare_row_is_admitted_and_every_other_shape_refused() {
    admit_rendered("bare", Some("codex"), None).unwrap();
    admit_rendered("bare", Some("codex"), Some("  ")).unwrap();
    assert!(admit_rendered("lean", Some("codex"), None).unwrap_err().contains("Unknown launch profile"));
    for agent in [None, Some("claude"), Some("acme"), Some("Codex"), Some("astra")] {
        assert!(admit_rendered("bare", agent, None).unwrap_err().contains("Codex rows only"), "{agent:?}");
    }
    assert!(admit_rendered("bare", Some("codex"), Some(r"C:\rules\built\abc.md")).unwrap_err().contains("no rules file"));
    // Codex Raw with a profile goes through the PTY admit, which takes Raw Codex too.
    admit("bare", Some("codex"), None, None).unwrap();
}

/// A temp Path folder shaped like the npm global folder: shim, codex.js, package.json.
fn fake_npm(t: &TempDir, shim: &str, version: &str) -> PathBuf {
    let dir = t.0.join("npm");
    let pkg = dir.join("node_modules").join("@openai").join("codex");
    std::fs::create_dir_all(pkg.join("bin")).unwrap();
    std::fs::write(dir.join(shim), "#shim").unwrap();
    std::fs::write(pkg.join("bin").join("codex.js"), "//js").unwrap();
    std::fs::write(pkg.join("package.json"), format!("{{\"name\":\"@openai/codex\",\"version\":\"{version}\"}}")).unwrap();
    dir
}

fn codex_bin() -> CodexBinary {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(crate::paths::root().join("profiles").join("bare").join("codex.json")).unwrap()).unwrap();
    serde_json::from_value(v["binary"].clone()).unwrap()
}

#[test]
fn the_codex_resolver_walks_the_path_for_a_shim_folder_never_appdata() {
    let t = TempDir::new("codex-resolve");
    let npm = fake_npm(&t, "codex.cmd", "0.100.0");
    let empty = t.0.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    // A shim folder without the script is skipped; a script without a shim is never picked.
    let shim_only = t.0.join("shim-only");
    std::fs::create_dir_all(&shim_only).unwrap();
    std::fs::write(shim_only.join("codex.ps1"), "#").unwrap();
    let mut env = Env::default();
    env.set("Path", std::env::join_paths([&empty, &shim_only, &npm]).unwrap());
    env.set("APPDATA", t.0.join("elsewhere"));
    let (js, version) = resolve_codex(&env, &codex_bin()).unwrap();
    assert_eq!(js, npm.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js"));
    assert_eq!(version.as_deref(), Some("0.100.0"));

    let mut none = Env::default();
    none.set("Path", std::env::join_paths([&empty, &shim_only]).unwrap());
    assert!(resolve_codex(&none, &codex_bin()).is_none());
    std::fs::remove_file(npm.join("codex.cmd")).unwrap();
    assert!(resolve_codex(&env, &codex_bin()).is_none(), "the script alone, with no shim beside it, was picked");
}

fn codex_probes_ok(env: &Env, _: &CodexBinary) -> Option<(PathBuf, Option<String>)> {
    env.get("Path")?;
    Some((PathBuf::from(r"X:\npm\node_modules\@openai\codex\bin\codex.js"), Some(pinned("codex"))))
}

#[test]
fn prepare_codex_builds_the_app_server_line_env_config_and_manifest() {
    let t = TempDir::new("codex-prepare");
    let root = crate::paths::root();
    let home = t.0.join("agent-home");
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let mut launch = prepare_codex_with("bare", &root, &home, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();

    assert_eq!(launch.program, PathBuf::from(r"X:\bin\node.exe"));
    assert_eq!(launch.args[..2], [r"X:\npm\node_modules\@openai\codex\bin\codex.js".to_string(), "app-server".into()]);
    // No sets: the built-in vidar-control skill still makes a layer payload, handed back as the text.
    assert_eq!(launch.args.len(), 2, "{:?}", launch.args);
    let (_, built) = codex_payload(&home);
    assert!(built.contains("- $vidar-control: "));
    assert_eq!(launch.developer_instructions.as_deref(), Some(built.as_str()));
    assert!(launch.warning.is_none());
    let h = home.display();
    assert_eq!(launch.codex_home, home.join("codex-home"));
    for (k, v) in [
        ("USERPROFILE", format!("{h}\\user-home")),
        ("HOME", format!("{h}\\user-home")),
        ("APPDATA", format!("{h}\\user-home\\AppData\\Roaming")),
        // The Codex process runs on the real LOCALAPPDATA (T5); Claude's stays redirected (above).
        ("LOCALAPPDATA", r"C:\Users\testuser\AppData\Local".to_string()),
        ("TEMP", format!("{h}\\user-home\\AppData\\Local\\Temp")),
        ("TMP", format!("{h}\\user-home\\AppData\\Local\\Temp")),
        ("CODEX_HOME", format!("{h}\\codex-home")),
        ("VIDAR_AGENT_HOME", format!("{h}\\codex-home")),
    ] {
        assert_eq!(launch.env.get(k).map(|v| v.to_string_lossy().into_owned()), Some(v), "{k}");
    }
    for gone in ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "VIDAR_CTL_TOKEN", "NO_COLOR", "CLAUDE_CODE_DISABLE_CLAUDE_MDS"] {
        assert!(!launch.env.contains(gone), "{gone} in a bare Codex env");
    }
    let config = std::fs::read_to_string(home.join("codex-home").join("config.toml")).unwrap();
    let doc = home::parse_toml_lite(&config).unwrap();
    let dev = doc.iter().find(|(k, _)| k == "developer_instructions").map(|(_, v)| v.clone()).unwrap();
    let payload = std::fs::read_to_string(root.join("profiles").join("bare").join("codex.payload.md")).unwrap().replace('\r', "").replace("{{root}}", &root.to_string_lossy());
    assert_eq!(dev, home::Toml::Str(payload));

    let names = launch.env.names();
    let m = launch.write_manifest("s3-cx", names.iter().map(String::as_str)).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["agent"], "codex");
    assert_eq!(v["binary"]["version"], pinned("codex").as_str());
    assert_eq!(v["homes"]["codexHome"], format!("{h}\\codex-home"));
    assert!(v["homes"].get("claudeConfig").is_none());
    assert_eq!(v["codexRules"], serde_json::json!([]));
    assert!(v["payload"]["marker"].as_str().unwrap().starts_with("VIDAR-PAYLOAD-"));
    assert!(!std::fs::read_to_string(&m).unwrap().contains("sk-test"), "an env value reached the manifest");
    println!("bare codex env names: {}", names.join(", "));
}

#[test]
fn the_bare_codex_path_drops_windowsapps_and_notify_keeps_the_store_pwsh() {
    let t = TempDir::new("codex-shell");
    let home = t.0.join("agent-home");
    let alias = r"C:\Users\testuser\AppData\Local\Microsoft\WindowsApps";
    let mut env_in = inherited();
    env_in[0].1 = format!(r"C:\Windows\system32;{alias};C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe;C:\Tools").into();
    // pwsh is found only while the alias folder is still on the Path it is given.
    let find = |env: &Env, name: &str| -> Option<PathBuf> {
        let on_path = std::env::split_paths(env.get("Path")?).any(|d| d == Path::new(alias));
        match name {
            "pwsh.exe" if on_path => Some(Path::new(alias).join(name)),
            "pwsh.exe" => None,
            _ => Some(PathBuf::from(r"X:\bin").join(name)),
        }
    };
    let launch = prepare_codex_with("bare", &crate::paths::root(), &home, env_in, &guard(), &CodexProbes { find: &find, codex: &codex_probes_ok }, &LaunchOpts::default()).unwrap();
    assert_eq!(launch.env.get("Path"), Some(std::ffi::OsStr::new(r"C:\Windows\system32;C:\Tools")));
    let doc = home::parse_toml_lite(&std::fs::read_to_string(home.join("codex-home").join("config.toml")).unwrap()).unwrap();
    let Some((_, home::Toml::Array(argv))) = doc.iter().find(|(k, _)| k == "notify") else { panic!("no notify") };
    assert_eq!(argv.first(), Some(&home::Toml::Str(format!(r"{alias}\pwsh.exe"))));
    let w = launch.warning.clone().expect("alias only: the 5.1 shell warns");
    assert!(w.contains("Windows PowerShell 5.1") && w.contains("MSI"), "{w}");
    assert_eq!(launch.manifest.binary.warning.as_deref(), Some(w.as_str()));
    drop(launch);

    // An unpackaged pwsh (MSI) on the Path survives the drop: it serves shell and notify, no warning.
    let t3 = TempDir::new("codex-msi-pwsh");
    let home3 = t3.0.join("agent-home");
    let msi = r"C:\Program Files\PowerShell\7";
    let mut env_msi = inherited();
    env_msi[0].1 = format!(r"C:\Windows\system32;{alias};{msi};C:\Tools").into();
    let find_msi = |env: &Env, name: &str| -> Option<PathBuf> {
        match name {
            "pwsh.exe" => std::env::split_paths(env.get("Path")?).find(|d| d == Path::new(alias) || d == Path::new(msi)).map(|d| d.join(name)),
            _ => Some(PathBuf::from(r"X:\bin").join(name)),
        }
    };
    let launch = prepare_codex_with("bare", &crate::paths::root(), &home3, env_msi, &guard(), &CodexProbes { find: &find_msi, codex: &codex_probes_ok }, &LaunchOpts::default()).unwrap();
    assert_eq!(launch.env.get("Path"), Some(std::ffi::OsStr::new(&format!(r"C:\Windows\system32;{msi};C:\Tools"))));
    let doc = home::parse_toml_lite(&std::fs::read_to_string(home3.join("codex-home").join("config.toml")).unwrap()).unwrap();
    let Some((_, home::Toml::Array(argv))) = doc.iter().find(|(k, _)| k == "notify") else { panic!("no notify") };
    assert_eq!(argv.first(), Some(&home::Toml::Str(format!(r"{msi}\pwsh.exe"))), "the unpackaged pwsh serves notify");
    assert_eq!(launch.warning, None);
    drop(launch);

    let t2 = TempDir::new("codex-no-pwsh");
    let none = |_: &Env, name: &str| (name != "pwsh.exe").then(|| PathBuf::from(r"X:\bin").join(name));
    let e = prepare_codex_with("bare", &crate::paths::root(), &t2.0.join("agent-home"), inherited(), &guard(), &CodexProbes { find: &none, codex: &codex_probes_ok }, &LaunchOpts::default()).err().unwrap();
    assert!(e.contains("pwsh.exe is not on the allowlisted Path"), "{e}");
}

#[test]
fn a_codex_version_mismatch_warns_and_a_missing_codex_refuses() {
    let t = TempDir::new("codex-version");
    let other = |_: &Env, _: &CodexBinary| Some((PathBuf::from(r"X:\c.js"), Some("0.170.0".into())));
    let launch = prepare_codex_with("bare", &crate::paths::root(), &t.0.join("agent-home"), inherited(), &guard(), &CodexProbes { find: &fake_find, codex: &other }, &LaunchOpts::default()).unwrap();
    let w = launch.warning.clone().unwrap();
    assert!(w.contains("0.170.0") && w.contains(&pinned("codex")), "{w}");
    assert_eq!(launch.manifest.binary.warning.as_deref(), Some(w.as_str()));
    drop(launch);

    let t2 = TempDir::new("codex-missing");
    let none = |_: &Env, _: &CodexBinary| None;
    let e = prepare_codex_with("bare", &crate::paths::root(), &t2.0.join("agent-home"), inherited(), &guard(), &CodexProbes { find: &fake_find, codex: &none }, &LaunchOpts::default()).err().unwrap();
    assert!(e.contains("shim on the allowlisted Path"), "{e}");
}

#[test]
fn the_codex_home_lookup_matches_the_live_spawn_and_never_creates_a_home() {
    let t = TempDir::new("codex-lookup");
    let root = crate::paths::root();
    let home = t.0.join("agent-home");
    let err = codex_home_for_profile_with("bare", &root, &home).unwrap_err();
    assert!(err.contains("does not exist"), "{err}");
    assert!(!home.exists(), "the lookup created the home");

    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let launch = prepare_codex_with("bare", &root, &home, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();
    assert_eq!(codex_home_for_profile_with("bare", &root, &home).unwrap(), launch.codex_home);
    drop(launch);
    assert!(codex_home_for_profile_with("nope", &root, &home).is_err());
}

#[test]
fn a_codex_profile_without_its_home_refuses_before_the_home_is_touched() {
    let t = TempDir::new("codex-nohome");
    let src = crate::paths::root().join("profiles").join("bare");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(src.join("codex.json")).unwrap()).unwrap();
    v["overlay"].as_object_mut().unwrap().remove("CODEX_HOME");
    let dir = t.0.join("root").join("profiles").join("bare");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("codex.json"), serde_json::to_string(&v).unwrap()).unwrap();
    let home = t.0.join("agent-home");
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let e = prepare_codex_with("bare", &t.0.join("root"), &home, inherited(), &guard(), &probes, &LaunchOpts::default()).err().unwrap();
    assert!(e.contains("CODEX_HOME"), "{e}");
    assert!(!home.exists(), "the home was touched before the refusal");
}

#[test]
fn a_bare_codex_cwd_at_or_above_the_user_profile_refuses() {
    let up = Some(r"C:\Users\testuser");
    for bad in [r"C:\Users\testuser", r"c:\users\TESTUSER\", r"C:\Users", r"C:\", r"\\?\C:\Users\testuser"] {
        let e = refuse_profile_cwd(bad, up).unwrap_err();
        assert!(e.contains("user profile"), "{bad}: {e}");
    }
    for ok in [r"C:\Users\testuser\repo", r"C:\Users\testuser2", r"D:\work", r"C:\Work\repo"] {
        assert!(refuse_profile_cwd(ok, up).is_ok(), "{ok} refused");
    }
    assert!(refuse_profile_cwd(r"C:\Users\testuser", None).is_ok());
}

#[test]
fn a_bare_codex_cwd_in_vidars_folder_refuses_except_worktrees() {
    let t = TempDir::new("vidar-cwd");
    let main = t.0.join("Main");
    let root = main.join("Vidar");
    // The runtime folder's name comes from the paths contract, as in the code under test.
    let rt = root.join(crate::paths::rel("bridge").parent().unwrap());
    std::fs::create_dir_all(rt.join("bridge")).unwrap();
    std::fs::create_dir_all(rt.join("worktrees").join("x")).unwrap();
    std::fs::create_dir_all(main.join("Other")).unwrap();
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let bad = [
        s(&root),
        s(&root).to_uppercase(),
        format!("{}\\", s(&root)).replace('\\', "/"),
        s(&main),
        s(&t.0),
        s(&rt),
        s(&rt.join("bridge")),
        s(&rt.join("worktrees")),
        s(&rt.join("worktrees").join("..").join("bridge")),
        s(&root.join("src").join("..")),
        s(&main.join("Other").join("..").join("Vidar")),
    ];
    for b in &bad {
        let e = refuse_vidar_cwd(b, &root).unwrap_err();
        assert!(e.contains("runtime\\worktrees"), "{b}: {e}");
    }
    let ok = [
        s(&rt.join("worktrees").join("x")),
        s(&rt.join("worktrees").join("x").join("src")),
        s(&rt.join("worktrees").join("new-lane")),
        s(&main.join("Other")),
        s(&root.join("src")),
        s(&rt.join("worktrees").join("x").join("..").join("y")),
    ];
    for o in &ok {
        assert!(refuse_vidar_cwd(o, &root).is_ok(), "{o} refused");
    }
    assert!(refuse_vidar_cwd(&s(&rt.join("worktrees").join("x").join("..").join("..").join("bridge")), &root).is_err());
    // A junction into the root or its runtime folder is judged by where it lands.
    let link = t.0.join("link");
    junction(&link, &root);
    assert!(refuse_vidar_cwd(&s(&link), &root).is_err(), "junction to the root passed");
    let link2 = t.0.join("link2");
    junction(&link2, &rt.join("bridge"));
    assert!(refuse_vidar_cwd(&s(&link2), &root).is_err(), "junction to runtime\\bridge passed");
}

// ---- Git identity (slice 2 Part B, identity.rs) ----

fn git_out(entries: &[(&str, Option<&str>)]) -> String {
    entries.iter().map(|(k, v)| v.map_or(format!("{k}\0"), |v| format!("{k}\n{v}\0"))).collect()
}

fn identity_with(tag: &str, out: Result<String, identity::Failure>) -> (TempDir, identity::GitIdentity, String) {
    let t = TempDir::new(tag);
    let lock = home::lock(&t.0, home::LOCK_WAIT).unwrap();
    let id = identity::write_with(&lock, &t.0, &guard(), || out);
    let text = std::fs::read_to_string(t.0.join("user-home").join(".gitconfig")).unwrap();
    (t, id, text)
}

/// Lines that configure git: neither blank nor a comment.
fn config_lines(text: &str) -> Vec<&str> {
    text.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#')).collect()
}

#[test]
fn identity_copies_only_allowlisted_keys() {
    let out = git_out(&[
        ("user.name", Some("Test \"T\" User")),
        ("user.email", Some("test@example.com")),
        ("user.signingkey", Some("ABC123")),
        ("credential.helper", Some("store")),
        ("credential.helper", Some(" manager ")),
        ("filter.lfs.clean", Some("git-lfs clean -- %f")),
        ("filter.lfs.required", None),
        ("filter.LFS.smudge", Some("other")),
        ("core.hookspath", Some("D:\\hooks")),
        ("include.path", Some("D:\\more.gitconfig")),
        ("alias.co", Some("checkout")),
    ]);
    let (_t, id, text) = identity_with("identity-allow", Ok(out));
    assert!(id.warning.is_none());
    assert_eq!(id.keys, ["user.name", "user.email", "credential.helper", "filter.lfs.clean", "filter.lfs.required"]);
    assert_eq!(
        config_lines(&text),
        [
            "[user]",
            "\tname = \"Test \\\"T\\\" User\"",
            "\temail = \"test@example.com\"",
            "[credential]",
            "\thelper = \"manager\"",
            "[filter \"lfs\"]",
            "\tclean = \"git-lfs clean -- %f\"",
            "\trequired",
        ]
    );
    // Exit 1 (no match) reaches the writer as empty output: a header-only file, no warning.
    let (_t, id, text) = identity_with("identity-none", Ok(String::new()));
    assert!(id.keys.is_empty() && id.warning.is_none() && config_lines(&text).is_empty(), "{text}");
}

#[test]
fn identity_drops_values_naming_the_profile() {
    let out = git_out(&[
        ("user.name", Some("testuser")),
        ("user.email", Some("testuser@example.com")),
        ("filter.lfs.process", Some("C:/Users/TestUser/bin/git-lfs.exe filter-process")),
        ("filter.lfs.clean", Some("git-lfs clean -- %f")),
    ]);
    let (_t, id, text) = identity_with("identity-profile", Ok(out));
    // The account-name check is off: a user name may match the account; the profile path may not.
    assert_eq!(id.keys, ["user.name", "user.email", "filter.lfs.clean"]);
    assert!(!text.to_lowercase().contains(r"c:/users/testuser") && !text.to_lowercase().contains(r"c:\users\testuser"), "{text}");
}

#[test]
fn identity_failure_writes_an_empty_file_and_spawns() {
    let t = TempDir::new("identity-fail");
    let home = t.0.join("agent-home");
    let gitconfig = home.join("user-home").join(".gitconfig");
    let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
    // A first launch carries a name (and makes the home with its ACL); the failing one must clear it.
    identity::fake_git(Ok(git_out(&[("user.name", Some("Earlier"))])));
    drop(prepare_with("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap());
    assert!(std::fs::read_to_string(&gitconfig).unwrap().contains("Earlier"));
    identity::fake_git(Err(identity::Failure { reason: "timed out".into(), detail: Some("git config timed out after 2s".into()) }));
    let mut launch = prepare_with("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();
    let text = std::fs::read_to_string(&gitconfig).unwrap();
    assert!(config_lines(&text).is_empty(), "a failed identity left config lines: {text}");
    assert!(text.contains("timed out"), "{text}");
    assert!(launch.args[2].contains("[Vidar Bare: Git identity not carried"), "Raw printed no identity warning: {}", launch.args[2]);
    let m = launch.write_manifest("s1-id", ["Path"]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["gitKeys"], serde_json::json!([]));
    assert!(v["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("Git identity not carried")), "{v}");
    // Hosted and Codex launch through the same failure (the Raw launch's home lock released first).
    drop(launch);
    let hosted = prepare_hosted_with("bare", &crate::paths::root(), &home, &guard(), &LaunchOpts::default()).unwrap();
    assert!(hosted.manifest.warnings.iter().any(|w| w.contains("Git identity")));
    let codex = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let c = prepare_codex_with("bare", &crate::paths::root(), &t.0.join("codex-home"), inherited(), &guard(), &codex, &LaunchOpts::default()).unwrap();
    assert!(c.manifest.git_keys.is_empty() && c.manifest.warnings.iter().any(|w| w.contains("Git identity")));
}

/// A temp "normal" `.claude.json` holding one seen-counter, and its Bare counterpart's path in `home`.
fn seen_fixture(t: &TempDir, home: &Path) -> (PathBuf, PathBuf) {
    let normal = t.0.join("normal.claude.json");
    std::fs::write(&normal, r#"{"fooUpsellSeenCount":7}"#).unwrap();
    (normal, home.join("claude-config").join(".claude.json"))
}

#[test]
fn raw_prepare_raises_the_bare_seen_counters_from_the_passed_file() {
    let t = TempDir::new("seen-raw");
    let home = t.0.join("agent-home");
    let (normal, bare) = seen_fixture(&t, &home);
    let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
    let opts = LaunchOpts { claude_json: Some(&normal), ..Default::default() };
    drop(prepare_with("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &opts).unwrap());
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&bare).unwrap()).unwrap();
    assert_eq!(v["fooUpsellSeenCount"], 7);
    // No source path: the skip is a line in the home's logs, not stderr.
    let t2 = TempDir::new("seen-raw-none");
    let home2 = t2.0.join("agent-home");
    drop(prepare_with("bare", &crate::paths::root(), &home2, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap());
    let log = std::fs::read_to_string(home2.join("logs").join("claude-seen-mirror.log")).unwrap();
    assert!(log.contains("mirror skipped: no normal .claude.json"), "{log}");
}

#[test]
fn hosted_prepare_raises_the_bare_seen_counters_from_the_passed_file() {
    let t = TempDir::new("seen-hosted");
    let home = t.0.join("agent-home");
    let (normal, bare) = seen_fixture(&t, &home);
    let opts = LaunchOpts { claude_json: Some(&normal), ..Default::default() };
    prepare_hosted_with("bare", &crate::paths::root(), &home, &guard(), &opts).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&bare).unwrap()).unwrap();
    assert_eq!(v["fooUpsellSeenCount"], 7);
}

#[test]
fn a_codex_launch_writes_the_trust_table_for_its_folder_and_validates() {
    let t = TempDir::new("codex-trust-e2e");
    let home = t.0.join("agent-home");
    let cwd = t.0.join("Work Folder");
    std::fs::create_dir_all(cwd.join(".codex")).unwrap(); // project settings: the warning's gate
    let cwd_s = cwd.to_string_lossy().into_owned();
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    // Untrusted in the user's own config: no table, a warning in the manifest.
    let untrusted = prepare_codex_in("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &LaunchOpts::default(), Some(&cwd_s)).unwrap();
    let bare_text = std::fs::read_to_string(home.join("codex-home").join("config.toml")).unwrap();
    assert!(!home::parse_toml_lite(&bare_text).unwrap().iter().any(|(k, _)| k.starts_with("projects.")), "{bare_text}");
    assert!(untrusted.manifest.payload.warnings.iter().any(|w| w == codex_hosted::UNTRUSTED_FOLDER_WARNING));
    drop(untrusted);
    // The launch record the Runes tab reads joins the binary's and the payload's warnings: once.
    let mut again = prepare_codex_in("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &LaunchOpts::default(), Some(&cwd_s)).unwrap();
    assert!(again.warning.as_deref().is_some_and(|w| w.contains(codex_hosted::UNTRUSTED_FOLDER_WARNING)), "the tab banner keeps it");
    again.write_manifest("t-trust", ["Path"]).unwrap();
    let rec = manifest::launch_in(&home.join("manifests"), "t-trust").unwrap().unwrap();
    assert_eq!(rec.warnings.iter().filter(|w| w.contains(codex_hosted::UNTRUSTED_FOLDER_WARNING)).count(), 1, "{:?}", rec.warnings);
    drop(again);
    codex_hosted::TEST_TRUST.with(|t| t.borrow_mut().push(cwd_s.to_uppercase().replace('\\', "/")));
    let launch = prepare_codex_in("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &LaunchOpts::default(), Some(&cwd_s)).unwrap();
    let text = std::fs::read_to_string(home.join("codex-home").join("config.toml")).unwrap();
    let key = home::trusted_project_key(&cwd_s).unwrap();
    assert!(text.contains(&home::trusted_project_table(&key)), "{text}");
    let doc = home::parse_toml_lite(&text).unwrap();
    assert!(doc.iter().any(|(k, v)| *k == format!("projects.{key}.trust_level") && *v == home::Toml::Str("trusted".into())));
    let tpl = home::parse_toml_lite(&std::fs::read_to_string(crate::paths::root().join("profiles").join("bare").join("codex.config.template.toml")).unwrap()).unwrap();
    let payload = doc.iter().find(|(k, _)| k == "developer_instructions").and_then(|(_, v)| if let home::Toml::Str(s) = v { Some(s.clone()) } else { None }).unwrap();
    let pwsh = fake_find(&Env::default(), "pwsh.exe").unwrap();
    home::validate_codex_for(&doc, &tpl, &crate::paths::root(), &home, &pwsh, &payload, &guard(), Some(&key), &[]).unwrap();
    drop(launch);
}

#[test]
fn a_codex_launch_leaves_the_trust_warning_to_the_card_and_registers_the_hosted_folder() {
    let t = TempDir::new("codex-trust-card");
    let home = t.0.join("agent-home");
    let cwd = t.0.join("Work Folder");
    std::fs::create_dir_all(cwd.join(".codex")).unwrap(); // project settings: the warning's gate
    let cwd_s = cwd.to_string_lossy().into_owned();
    let warning = codex_hosted::UNTRUSTED_FOLDER_WARNING;
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    // In-process: untrusted, the manifest keeps the warning, the notice list drops it.
    let launch = prepare_codex_in("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &LaunchOpts::default(), Some(&cwd_s)).unwrap();
    assert!(launch.is_untrusted());
    assert!(launch.manifest.payload.warnings.iter().any(|w| w == warning));
    assert!(!launch.bare_warnings().iter().any(|w| w == warning), "{:?}", launch.bare_warnings());
    drop(launch);
    // Hosted: the same, and the manifest write registers the folder for the card's offer.
    let hosted = || codex_hosted::prepare_codex_hosted_with("bare", &crate::paths::root(), &home, inherited(), &guard(), &fake_find, &LaunchOpts::default(), &cwd_s).unwrap();
    let mut h = hosted();
    assert!(!h.bare_warnings().iter().any(|w| w == warning));
    h.write_manifest("t-ctrust-card", "s-1", ["Path"]).unwrap();
    assert_eq!(codex_trust::codex_trust_offer("t-ctrust-card".into()).map(|o| o.folder), Some(cwd_s.clone()));
    drop(h);
    // Trusted by the user's config: no warning, and a reused tab id loses its offer.
    codex_hosted::TEST_TRUST.with(|t| t.borrow_mut().push(cwd_s.clone()));
    let mut again = hosted();
    again.write_manifest("t-ctrust-card", "s-2", ["Path"]).unwrap();
    assert!(codex_trust::codex_trust_offer("t-ctrust-card".into()).is_none());
    drop(again);
    let launch = prepare_codex_in("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &LaunchOpts::default(), Some(&cwd_s)).unwrap();
    assert!(!launch.is_untrusted());
}

#[test]
fn a_folder_without_codex_settings_gets_no_trust_warning_or_offer() {
    let t = TempDir::new("codex-trust-none");
    let home = t.0.join("agent-home");
    let cwd = t.0.join("Plain Folder");
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_s = cwd.to_string_lossy().into_owned();
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let launch = prepare_codex_in("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &LaunchOpts::default(), Some(&cwd_s)).unwrap();
    assert!(!launch.is_untrusted());
    drop(launch);
    let mut h = codex_hosted::prepare_codex_hosted_with("bare", &crate::paths::root(), &home, inherited(), &guard(), &fake_find, &LaunchOpts::default(), &cwd_s).unwrap();
    h.write_manifest("t-ctrust-none", "s-1", ["Path"]).unwrap();
    assert!(codex_trust::codex_trust_offer("t-ctrust-none".into()).is_none());
}

#[test]
fn codex_settings_are_looked_for_up_to_the_git_root_only() {
    let t = TempDir::new("codex-settings");
    let mk = |p: &std::path::Path| std::fs::create_dir_all(p).unwrap();
    // launch folder itself
    let alone = t.0.join("alone");
    mk(&alone.join(".codex"));
    assert!(codex_hosted::has_codex_settings(&alone));
    // a .codex FILE is not settings
    let file = t.0.join("file");
    mk(&file);
    std::fs::write(file.join(".codex"), "x").unwrap();
    assert!(!codex_hosted::has_codex_settings(&file));
    // no git root: ancestors do not count
    let child = t.0.join("alone").join("sub");
    mk(&child);
    assert!(!codex_hosted::has_codex_settings(&child));
    // git root above: its .codex counts, one below the root counts, one above the root does not
    let repo = t.0.join("outer").join("repo");
    mk(&repo.join(".git"));
    mk(&repo.join("a").join("b"));
    mk(&t.0.join("outer").join(".codex"));
    assert!(!codex_hosted::has_codex_settings(&repo.join("a").join("b")), "a .codex above the git root is out of reach");
    mk(&repo.join(".codex"));
    assert!(codex_hosted::has_codex_settings(&repo.join("a").join("b")));
    assert!(codex_hosted::has_codex_settings(&repo));
}

/// A temp home and a temp global config holding `config` (never the user's own).
fn global_fixture(tag: &str, config: &str) -> (TempDir, PathBuf, PathBuf) {
    let t = TempDir::new(tag);
    let (home, cfg) = (t.0.join("agent-home"), t.0.join("global.gitconfig"));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(&cfg, config).unwrap();
    (t, home, cfg)
}

#[test]
fn identity_reads_the_global_config_through_git() {
    let config = "[user]\n\tname = Temp User\n\temail = temp@example.com\n\tsigningkey = ABC\n[alias]\n\tco = checkout\n[core]\n\thooksPath = D:/hooks\n";
    let (_t, home, cfg) = global_fixture("identity-git", config);
    let raw = identity::global_entries(&home, Some(&cfg)).unwrap();
    let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
    let id = identity::write_with(&lock, &home, &guard(), || Ok(raw));
    assert_eq!(id.keys, ["user.name", "user.email"]);
    let text = std::fs::read_to_string(home.join("user-home").join(".gitconfig")).unwrap();
    assert!(text.contains("Temp User") && !text.contains("ABC") && !text.contains("checkout") && !text.contains("hooks"), "{text}");
    // Anything in the probe folder (a planted `.git`) stops the read.
    let (_t2, home2, cfg2) = global_fixture("identity-git-planted", "[user]\n\tname = Other\n");
    std::fs::create_dir_all(home2.join("git-probe").join(".git")).unwrap();
    assert_eq!(identity::global_entries(&home2, Some(&cfg2)).unwrap_err().reason, "git probe folder not empty");
}

#[test]
fn a_bad_global_config_writes_a_fixed_reason_and_no_path() {
    let (t, home, cfg) = global_fixture("identity-bad", "[user\n\tname = Broken\n");
    let failure = identity::global_entries(&home, Some(&cfg)).unwrap_err();
    assert!(failure.reason.starts_with("git config exited "), "{failure:?}");
    let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
    // The temp folder stands in for the profile: git's message names the config's path under it.
    let g = home::Guard { user_profile: Some(t.0.to_string_lossy().into_owned()), username: None };
    let id = identity::write_with(&lock, &home, &g, || Err(failure));
    let text = std::fs::read_to_string(home.join("user-home").join(".gitconfig")).unwrap();
    assert!(config_lines(&text).is_empty() && text.contains("git config exited "), "{text}");
    let low = text.to_lowercase().replace('\\', "/");
    assert!(!low.contains("global.gitconfig") && !low.contains(&t.0.to_string_lossy().to_lowercase().replace('\\', "/")), "{text}");
    let w = id.warning.unwrap();
    assert!(!w.to_lowercase().replace('\\', "/").contains(&t.0.to_string_lossy().to_lowercase().replace('\\', "/")), "{w}");
    // A failure is not cached: the fixed config reads on the next call.
    std::fs::write(&cfg, "[user]\n\tname = Fixed\n").unwrap();
    assert!(identity::global_entries(&home, Some(&cfg)).unwrap().contains("Fixed"));
}

#[test]
fn the_profile_guard_reads_msys_drive_paths() {
    let g = guard();
    assert!(home::guard_strings(&["fatal: bad config line 1 in file /c/Users/TestUser/.gitconfig"], "", "", &g, "t").is_err());
    assert!(home::guard_strings(&["/c/Users/testuser/bin"], "", "", &g, "t").is_err());
    assert!(home::guard_strings(&["a/c/Users/testuser", "/d/work/repo"], "", "", &home::Guard { username: None, ..guard() }, "t").is_ok());
}

#[test]
fn the_codex_payload_marker_matches_its_text() {
    let text = std::fs::read_to_string(crate::paths::root().join("profiles").join("bare").join("codex.payload.md")).unwrap();
    let (marker, expected) = payload_marker(&text).unwrap();
    assert_eq!(marker, expected, "codex.payload.md edited: set its last line to {expected}");
}

// ---- Shared login (login_link.rs, slice 2 Part A): temp LOCALAPPDATA trees only ----

const CRED: &str = "claude-config/.credentials.json";
const CAP_SID: &str = "S-1-5-21-1875670979-1622257873-1171250118-3363616505";

fn login_entries() -> Vec<login_link::SharedLogin> {
    vec![login_link::SharedLogin { agent: "claude".into(), file: CRED.into() }]
}

fn login_dirs() -> Vec<String> {
    vec!["claude-config".into(), "logs".into()]
}

/// `<t>\lad\Vidar\homes\<key>`, prepared private, with its lock.
fn login_home(t: &TempDir, key: &str) -> (PathBuf, home::HomeLock) {
    let h = t.0.join("lad").join("Vidar").join("homes").join(key);
    home::prepare_dirs(&h, &login_dirs()).unwrap();
    let lock = home::lock(&h, home::LOCK_WAIT).unwrap();
    (h, lock)
}

fn link_sync(h: &Path, lock: &home::HomeLock) -> Result<Vec<String>, String> {
    login_link::sync_profile(h, &login_entries(), &login_dirs(), lock)
}

fn cred(h: &Path) -> PathBuf {
    h.join("claude-config").join(".credentials.json")
}

fn store(t: &TempDir) -> PathBuf {
    t.0.join("lad").join("Vidar").join("homes").join("_shared").join("claude").join(".credentials.json")
}

fn id(p: &Path) -> (login_link::FileId, u32) {
    login_link::seen(p).unwrap().expect("name present")
}

/// What a CLI writing by temp file plus rename does: a new file under the same name.
fn rewrite_by_rename(p: &Path, text: &str) {
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, text).unwrap();
    std::fs::rename(&tmp, p).unwrap();
}

#[test]
fn adopted_login_links_a_second_home_to_one_file() {
    let t = TempDir::new("login-adopt");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(cred(&a), "TOKEN-A").unwrap();
    link_sync(&a, &la).unwrap();
    assert_eq!(id(&store(&t)), id(&cred(&a)));
    assert_eq!(id(&cred(&a)).1, 2);
    let (b, lb) = login_home(&t, "bbbbbbbbbbbbbbbb");
    link_sync(&b, &lb).unwrap();
    assert_eq!(id(&cred(&b)).0, id(&cred(&a)).0, "the second home got another file");
    assert_eq!(id(&cred(&b)).1, 3);
    link_sync(&b, &lb).unwrap();
    assert_eq!(id(&cred(&b)).1, 3, "a second sync changed the link set");
    assert!(b.join("logs").join("login-link.json").is_file());
}

#[test]
fn a_split_link_heals_newest_wins() {
    let t = TempDir::new("login-split");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(cred(&a), "SECRET-OLD").unwrap();
    link_sync(&a, &la).unwrap();
    let (b, lb) = login_home(&t, "bbbbbbbbbbbbbbbb");
    link_sync(&b, &lb).unwrap();
    // B's CLI refreshes by rename: B's name splits off. B changed since its last sync, so it wins.
    rewrite_by_rename(&cred(&b), "SECRET-NEW");
    link_sync(&b, &lb).unwrap();
    assert_eq!(id(&store(&t)).0, id(&cred(&b)).0);
    assert!(!cred(&b).with_file_name(".credentials.json.split").exists(), "the shared loser was still linked from A");
    // A's old file is now a sole copy; the store changed since A's last sync, so it wins. A was
    // recorded, so the heal is routine: no launch warning.
    assert_eq!(link_sync(&a, &la).unwrap(), Vec::<String>::new());
    assert_eq!(id(&cred(&a)).0, id(&cred(&b)).0);
    let split = cred(&a).with_file_name(".credentials.json.split");
    assert_eq!(std::fs::read_to_string(&split).unwrap(), "SECRET-OLD");
    for h in [&a, &b] {
        let log = std::fs::read_to_string(h.join("logs").join("login-link.log")).unwrap();
        assert!(!log.contains("SECRET"), "file bytes reached the log: {log}");
        let state = std::fs::read_to_string(h.join("logs").join("login-link.json")).unwrap();
        assert!(!state.contains("SECRET"));
    }
}

#[test]
fn a_shared_folder_with_a_foreign_ace_refuses() {
    let t = TempDir::new("login-foreign");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    let everyone = home::acl::well_known(windows::Win32::Security::WinWorldSid).unwrap();
    home::acl::create_private_dir(&t.0.join("lad").join("Vidar").join("homes").join("_shared"), &[everyone]).unwrap();
    std::fs::write(cred(&a), "TOKEN").unwrap();
    let e = link_sync(&a, &la).unwrap_err();
    assert!(e.contains("other principal"), "{e}");
    assert_eq!(id(&cred(&a)).1, 1, "the login was linked into a wide store");
}

#[test]
fn a_home_outside_vidar_homes_gets_no_sharing_and_another_lad_gets_another_store() {
    let t = TempDir::new("login-outside");
    let outside = t.0.join("agent-home");
    assert_eq!(home_path::shared_for(&outside), None);
    assert_eq!(home_path::shared_for(&t.0.join("Vidar").join("other").join("k")), None);
    assert_eq!(home_path::shared_for(&t.0.join("Vidar").join("homes").join("_shared")), None);
    let in_lad = |lad: &str| home_path::shared_for(&t.0.join(lad).join("Vidar").join("homes").join("aaaaaaaaaaaaaaaa"));
    assert_eq!(in_lad("one"), Some(t.0.join("one").join("Vidar").join("homes").join("_shared")));
    assert_ne!(in_lad("one"), in_lad("two"));
    home::prepare_dirs(&outside, &login_dirs()).unwrap();
    let lock = home::lock(&outside, home::LOCK_WAIT).unwrap();
    std::fs::write(cred(&outside), "TOKEN").unwrap();
    link_sync(&outside, &lock).unwrap();
    assert_eq!(id(&cred(&outside)).1, 1);
    assert!(!t.0.join("_shared").exists() && !outside.join("logs").join("login-link.json").exists());
}

fn junction(link: &Path, target: &Path) {
    std::fs::create_dir_all(target).unwrap();
    let ok = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(ok.status.success(), "mklink /J failed");
}

#[test]
fn a_reparse_point_login_name_refuses() {
    let t = TempDir::new("login-reparse");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    junction(&cred(&a), &t.0.join("elsewhere"));
    let e = link_sync(&a, &la).unwrap_err();
    assert!(e.contains("reparse point"), "{e}");

    let t2 = TempDir::new("login-reparse-store");
    let (b, lb) = login_home(&t2, "bbbbbbbbbbbbbbbb");
    std::fs::write(cred(&b), "TOKEN").unwrap();
    let store_dir = store(&t2).parent().unwrap().to_path_buf();
    home::acl::create_private_dir(store_dir.parent().unwrap(), &[]).unwrap();
    home::acl::create_private_dir(&store_dir, &[]).unwrap();
    junction(&store(&t2), &t2.0.join("elsewhere"));
    let e = link_sync(&b, &lb).unwrap_err();
    assert!(e.contains("reparse point"), "{e}");
    assert_eq!(id(&cred(&b)).1, 1);
}

#[test]
fn a_shared_file_with_a_cap_sid_ace_refuses() {
    let t = TempDir::new("login-capsid");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(cred(&a), "TOKEN").unwrap();
    link_sync(&a, &la).unwrap();
    // The ACE goes on the file (all its names), not on any folder.
    let wide = t.0.join("wide-acl");
    home::acl::create_private_dir(&wide, &[home::acl::parse_sid(CAP_SID).unwrap()]).unwrap();
    login_link::take_dir_dacl(&store(&t), &wide).unwrap();
    home::acl::check_private(store(&t).parent().unwrap()).unwrap();
    let e = link_sync(&a, &la).unwrap_err();
    assert!(e.contains("Shared login file") && e.contains("other principal"), "{e}");
    let (b, lb) = login_home(&t, "bbbbbbbbbbbbbbbb");
    assert!(link_sync(&b, &lb).is_err());
    assert!(!cred(&b).exists(), "a home was linked to a file with a foreign ACE");
}

#[test]
fn a_side_changed_since_last_sync_wins_and_both_changed_keeps_each_file() {
    let t = TempDir::new("login-changed");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(cred(&a), "ONE").unwrap();
    link_sync(&a, &la).unwrap();
    let (b, lb) = login_home(&t, "bbbbbbbbbbbbbbbb");
    link_sync(&b, &lb).unwrap();
    // The store changed (another home won); A's old file is still B's, so A only loses its name.
    rewrite_by_rename(&store(&t), "TWO");
    link_sync(&a, &la).unwrap();
    assert_eq!(id(&cred(&a)).0, id(&store(&t)).0);
    assert!(!cred(&a).with_file_name(".credentials.json.split").exists());
    assert_eq!(id(&cred(&b)).1, 1, "B still holds the old file alone");
    // Both changed since A's last sync: skipped, nothing moved, the spawn goes on with a warning.
    rewrite_by_rename(&cred(&a), "THREE");
    rewrite_by_rename(&store(&t), "FOUR");
    let (ha, hs) = (id(&cred(&a)).0, id(&store(&t)).0);
    let warnings = link_sync(&a, &la).expect("both changed must not refuse the spawn");
    assert!(warnings.len() == 1 && warnings[0].contains("both changed"), "{warnings:?}");
    assert_eq!((id(&cred(&a)).0, id(&store(&t)).0), (ha, hs));
    assert_eq!(std::fs::read_to_string(cred(&a)).unwrap(), "THREE");
    assert_eq!(std::fs::read_to_string(store(&t)).unwrap(), "FOUR");
}

// ---- Shared Codex login (`login_link::sync_codex`): the same sync on `codex-home\auth.json` ----

fn codex_login_dirs() -> Vec<String> {
    vec!["codex-home".into(), "logs".into()]
}

fn codex_link_sync(h: &Path, lock: &home::HomeLock) -> Result<Vec<String>, String> {
    login_link::sync_codex(h, &h.join("codex-home"), &codex_login_dirs(), lock)
}

fn codex_auth(h: &Path) -> PathBuf {
    h.join("codex-home").join("auth.json")
}

fn codex_store(t: &TempDir) -> PathBuf {
    t.0.join("lad").join("Vidar").join("homes").join("_shared").join("codex").join("auth.json")
}

fn codex_login_home(t: &TempDir, key: &str) -> (PathBuf, home::HomeLock) {
    let h = t.0.join("lad").join("Vidar").join("homes").join(key);
    home::prepare_dirs(&h, &codex_login_dirs()).unwrap();
    let lock = home::lock(&h, home::LOCK_WAIT).unwrap();
    (h, lock)
}

#[test]
fn an_adopted_codex_login_links_a_second_home_to_one_file() {
    let t = TempDir::new("codex-login-adopt");
    let (a, la) = codex_login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(codex_auth(&a), "TOKEN-A").unwrap();
    codex_link_sync(&a, &la).unwrap();
    assert_eq!(id(&codex_store(&t)), id(&codex_auth(&a)));
    let (b, lb) = codex_login_home(&t, "bbbbbbbbbbbbbbbb");
    codex_link_sync(&b, &lb).unwrap();
    assert_eq!(id(&codex_auth(&b)).0, id(&codex_auth(&a)).0, "the second home got another file");
    assert_eq!(id(&codex_auth(&b)).1, 3);
    codex_link_sync(&b, &lb).unwrap();
    assert_eq!(id(&codex_auth(&b)).1, 3, "a second sync changed the link set");
    assert!(b.join("logs").join("login-link-codex.json").is_file());
    assert!(!b.join("logs").join("login-link.json").exists(), "Codex wrote Claude's record");
}

#[test]
fn a_split_codex_link_heals_newest_wins() {
    let t = TempDir::new("codex-login-split");
    let (a, la) = codex_login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(codex_auth(&a), "SECRET-OLD").unwrap();
    codex_link_sync(&a, &la).unwrap();
    let (b, lb) = codex_login_home(&t, "bbbbbbbbbbbbbbbb");
    codex_link_sync(&b, &lb).unwrap();
    rewrite_by_rename(&codex_auth(&b), "SECRET-NEW");
    codex_link_sync(&b, &lb).unwrap();
    assert_eq!(id(&codex_store(&t)).0, id(&codex_auth(&b)).0);
    assert_eq!(codex_link_sync(&a, &la).unwrap(), Vec::<String>::new());
    assert_eq!(id(&codex_auth(&a)).0, id(&codex_auth(&b)).0);
    assert_eq!(std::fs::read_to_string(codex_auth(&a).with_file_name("auth.json.split")).unwrap(), "SECRET-OLD");
    for h in [&a, &b] {
        let log = std::fs::read_to_string(h.join("logs").join("login-link.log")).unwrap();
        assert!(!log.contains("SECRET"), "file bytes reached the log: {log}");
        let state = std::fs::read_to_string(h.join("logs").join("login-link-codex.json")).unwrap();
        assert!(!state.contains("SECRET"));
    }
}

#[test]
fn a_codex_side_changed_since_last_sync_wins_and_both_changed_keeps_each_file() {
    let t = TempDir::new("codex-login-changed");
    let (a, la) = codex_login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(codex_auth(&a), "ONE").unwrap();
    codex_link_sync(&a, &la).unwrap();
    let (b, lb) = codex_login_home(&t, "bbbbbbbbbbbbbbbb");
    codex_link_sync(&b, &lb).unwrap();
    rewrite_by_rename(&codex_store(&t), "TWO");
    codex_link_sync(&a, &la).unwrap();
    assert_eq!(id(&codex_auth(&a)).0, id(&codex_store(&t)).0);
    assert_eq!(id(&codex_auth(&b)).1, 1, "B still holds the old file alone");
    rewrite_by_rename(&codex_auth(&a), "THREE");
    rewrite_by_rename(&codex_store(&t), "FOUR");
    let warnings = codex_link_sync(&a, &la).expect("both changed must not refuse the spawn");
    assert!(warnings.len() == 1 && warnings[0].starts_with("Shared Codex login ") && warnings[0].contains("both changed"), "{warnings:?}");
    assert_eq!(std::fs::read_to_string(codex_auth(&a)).unwrap(), "THREE");
    assert_eq!(std::fs::read_to_string(codex_store(&t)).unwrap(), "FOUR");
}

#[test]
fn a_codex_prepare_links_the_shared_login_into_a_fresh_home() {
    let t = TempDir::new("codex-login-prepare");
    let homes = t.0.join("lad").join("Vidar").join("homes");
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let (a, b) = (homes.join("aaaaaaaaaaaaaaaa"), homes.join("bbbbbbbbbbbbbbbb"));
    let root = crate::paths::root();
    drop(prepare_codex_with("bare", &root, &a, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap());
    std::fs::write(codex_auth(&a), "TOKEN").unwrap();
    let launch = prepare_codex_with("bare", &root, &b, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();
    assert_eq!(id(&codex_auth(&b)).0, id(&codex_auth(&a)).0, "the fresh home did not get the sibling's login");
    assert_eq!(id(&codex_store(&t)).0, id(&codex_auth(&a)).0);
    assert!(launch.warning.as_deref().is_none_or(|w| !w.contains("Shared Codex login")), "{:?}", launch.warning);
}

#[test]
fn the_profile_shared_login_field_is_read() {
    let p = load_profile(&crate::paths::root(), "bare").unwrap();
    assert_eq!(p.shared_login, login_entries());
    let t = TempDir::new("login-profile");
    let root = root_with_profile(&t, |v| {
        v.as_object_mut().unwrap().remove("sharedLogin");
    });
    assert!(load_profile(&root, "bare").unwrap().shared_login.is_empty(), "sharedLogin is not #[serde(default)]");
    let probes = Probes { find: &fake_find, version: &|_, _| None, remote_control: &|| false };
    for bad in ["../x/.credentials.json", "user-home2/.credentials.json", "claude-config", r"C:\x\.credentials.json"] {
        let t = TempDir::new("login-profile-bad");
        let root = root_with_profile(&t, |v| {
            v["sharedLogin"][0]["file"] = bad.into();
        });
        let e = prepare_with("bare", &root, &t.0.join("agent-home"), inherited(), &guard(), &probes, &LaunchOpts::default()).err().unwrap();
        assert!(e.contains("sharedLogin"), "{bad}: {e}");
    }
}

/// Fails the named login-link step on this test's thread until dropped.
struct Fault;
impl Fault {
    fn at(step: &'static str) -> Fault {
        login_link::FAULT.with(|f| f.set(step));
        Fault
    }
}
impl Drop for Fault {
    fn drop(&mut self) {
        login_link::FAULT.with(|f| f.set(""));
    }
}

#[test]
fn a_failed_link_restores_the_home_file_and_spawns() {
    let t = TempDir::new("login-failed-link");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(cred(&a), "TOKEN-A").unwrap();
    link_sync(&a, &la).unwrap();
    // B holds its own, unrecorded login: the store wins, but the link step fails.
    let b = t.0.join("lad").join("Vidar").join("homes").join("bbbbbbbbbbbbbbbb");
    home::prepare_dirs(&b, &login_dirs()).unwrap();
    std::fs::write(cred(&b), "TOKEN-B").unwrap();
    let before = id(&cred(&b));
    let probes = Probes { find: &fake_find, version: &|_, _| Some(pinned("claude")), remote_control: &|| false };
    let fault = Fault::at("link");
    let raw = prepare_with("bare", &crate::paths::root(), &b, inherited(), &guard(), &probes, &LaunchOpts::default()).unwrap();
    drop(fault);
    assert_eq!(id(&cred(&b)), before, "the home's own file was not put back");
    assert_eq!(std::fs::read_to_string(cred(&b)).unwrap(), "TOKEN-B");
    assert!(!cred(&b).with_file_name(".credentials.json.split").exists());
    assert!(raw.manifest.warnings.iter().any(|w| w.contains("not linked")), "{:?}", raw.manifest.warnings);
    assert!(raw.args[2].contains("not linked"), "{}", raw.args[2]);
    let log = std::fs::read_to_string(b.join("logs").join("login-link.log")).unwrap();
    assert!(log.contains("skipped claude/") && !log.contains("TOKEN"), "{log}");
}

#[test]
fn a_failed_adopt_keeps_the_store_file() {
    let t = TempDir::new("login-failed-adopt");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(cred(&a), "ONE").unwrap();
    link_sync(&a, &la).unwrap();
    let (b, lb) = login_home(&t, "bbbbbbbbbbbbbbbb");
    link_sync(&b, &lb).unwrap();
    // B refreshes by rename, so B wins, but the rename onto the store name fails.
    rewrite_by_rename(&cred(&b), "TWO");
    let (store_before, b_before) = (id(&store(&t)), id(&cred(&b)));
    let fault = Fault::at("adopt");
    let warnings = link_sync(&b, &lb).unwrap();
    drop(fault);
    assert!(warnings.iter().any(|w| w.contains("not linked")), "{warnings:?}");
    assert_eq!(id(&store(&t)), store_before, "the store name moved");
    assert_eq!(id(&cred(&b)), b_before);
    let dir = store(&t).parent().unwrap().to_path_buf();
    assert!(!dir.join(".credentials.json.vidar-adopt").exists() && !dir.join(".credentials.json.split").exists());
    // The fault cleared: B still changed since its last sync, so the next sync adopts it.
    link_sync(&b, &lb).unwrap();
    assert_eq!(id(&store(&t)).0, id(&cred(&b)).0);
}

#[test]
fn a_store_win_over_an_unrecorded_home_names_the_split() {
    let t = TempDir::new("login-split-warn");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(cred(&a), "A").unwrap();
    link_sync(&a, &la).unwrap();
    let (b, lb) = login_home(&t, "bbbbbbbbbbbbbbbb");
    std::fs::write(cred(&b), "B").unwrap();
    let warnings = link_sync(&b, &lb).unwrap();
    assert_eq!(id(&cred(&b)).0, id(&store(&t)).0);
    let split = cred(&b).with_file_name(".credentials.json.split");
    assert!(split.is_file());
    assert!(warnings.len() == 1 && warnings[0].contains(&split.display().to_string()), "{warnings:?}");
}

#[test]
fn a_junctioned_login_folder_or_store_folder_refuses() {
    let t = TempDir::new("login-junction-dir");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    let config = a.join("claude-config");
    std::fs::remove_dir(&config).unwrap();
    junction(&config, &t.0.join("synced"));
    std::fs::write(cred(&a), "TOKEN").unwrap();
    let e = link_sync(&a, &la).unwrap_err();
    assert!(e.contains("reparse point") && e.contains("claude-config"), "{e}");
    assert!(!store(&t).exists());

    // N3: a store folder junctioned elsewhere refuses before anything links.
    let t2 = TempDir::new("login-junction-store");
    let (b, lb) = login_home(&t2, "bbbbbbbbbbbbbbbb");
    std::fs::write(cred(&b), "TOKEN").unwrap();
    let shared = store(&t2).parent().unwrap().parent().unwrap().to_path_buf();
    home::acl::create_private_dir(&shared, &[]).unwrap();
    junction(&shared.join("claude"), &t2.0.join("synced"));
    let e = link_sync(&b, &lb).unwrap_err();
    assert!(e.contains("reparse point"), "{e}");
    assert_eq!(id(&cred(&b)).1, 1);
}

#[test]
fn unreadable_or_unwritable_bookkeeping_never_refuses() {
    let t = TempDir::new("login-bookkeeping");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    std::fs::write(a.join("logs").join("login-link.json"), "not json").unwrap();
    std::fs::create_dir(a.join("logs").join("login-link.log")).unwrap();
    std::fs::write(cred(&a), "TOKEN").unwrap();
    let warnings = link_sync(&a, &la).unwrap();
    assert_eq!(id(&store(&t)).0, id(&cred(&a)).0);
    assert!(warnings.iter().any(|w| w.contains("log not written")), "{warnings:?}");
}

#[test]
fn two_entries_of_one_agent_with_one_file_name_refuse() {
    let t = TempDir::new("login-dupe");
    let (a, la) = login_home(&t, "aaaaaaaaaaaaaaaa");
    let entries = vec![
        login_link::SharedLogin { agent: "claude".into(), file: CRED.into() },
        login_link::SharedLogin { agent: "Claude".into(), file: "logs/.Credentials.json".into() },
    ];
    let e = login_link::sync_profile(&a, &entries, &login_dirs(), &la).unwrap_err();
    assert!(e.contains("same file name"), "{e}");
}

#[test]
fn a_codex_profile_with_shared_login_refuses() {
    let t = TempDir::new("codex-shared-login");
    let src = crate::paths::root().join("profiles").join("bare");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(src.join("codex.json")).unwrap()).unwrap();
    v["sharedLogin"] = serde_json::json!([{ "agent": "codex", "file": "codex-home/auth.json" }]);
    let dir = t.0.join("root").join("profiles").join("bare");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("codex.json"), serde_json::to_string(&v).unwrap()).unwrap();
    let home = t.0.join("agent-home");
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let e = prepare_codex_with("bare", &t.0.join("root"), &home, inherited(), &guard(), &probes, &LaunchOpts::default()).err().unwrap();
    assert!(e.contains("sharedLogin is not wired for Codex yet"), "{e}");
    assert!(!home.exists(), "the home was touched before the refusal");
    v.as_object_mut().unwrap().remove("sharedLogin");
    std::fs::write(dir.join("codex.json"), serde_json::to_string(&v).unwrap()).unwrap();
    assert!(load_codex_profile(&t.0.join("root"), "bare").is_ok(), "an absent sharedLogin refused");
}

// ---- Codex Bare row sets and skills (run 2026-10-17-bare-runes-flow, C1) ----

impl RowFx {
    fn codex(&self, home: &Path, key: &str) -> Result<CodexLaunch, String> {
        let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
        prepare_codex_with("bare", &crate::paths::root(), home, inherited(), &guard(), &probes, &self.opts(key))
    }
    /// The Raw Codex Bare line (the TUI in a PTY) on `home`, launched in `cwd`.
    fn tui(&self, home: &Path, key: &str, cwd: Option<&str>) -> Result<CodexLaunch, String> {
        let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
        prepare_codex_for(Surface::Tui, "bare", &crate::paths::root(), home, inherited(), &guard(), &probes, &self.opts(key), cwd)
    }
    /// vidar.json with `rulesLibrary`, `agents` and any `extra` top-level keys.
    fn config_with(&self, agents: serde_json::Value, extra: serde_json::Value) {
        let mut v = serde_json::json!({ "rulesLibrary": self.lib.to_string_lossy(), "agents": agents });
        for (k, x) in extra.as_object().cloned().unwrap_or_default() {
            v[k] = x;
        }
        std::fs::write(&self.config, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    }
    /// A source skill folder `<temp>\src\<name>\` with a SKILL.md frontmatter.
    fn skill(&self, name: &str, description: &str) -> String {
        let d = self.t.0.join("src").join(name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("SKILL.md"), format!("---\nname: {name}\ndescription: {description}\n---\nDo the {name} thing.\n")).unwrap();
        d.to_string_lossy().into_owned()
    }
}

fn codex_config_bytes(home: &Path) -> Vec<u8> {
    std::fs::read(home.join("codex-home").join("config.toml")).unwrap()
}

/// The one built payload in `<home>\layer\` (ledgers aside), path and text.
fn codex_payload(home: &Path) -> (PathBuf, String) {
    let files: Vec<PathBuf> = layer_files(home).into_iter().filter(|p| p.extension().is_some_and(|e| e == "md")).collect();
    assert_eq!(files.len(), 1, "{files:?}");
    let text = std::fs::read_to_string(&files[0]).unwrap();
    (files[0].clone(), text)
}

#[test]
fn a_codex_row_with_sets_passes_the_built_payload_as_developer_instructions() {
    let fx = RowFx::new("codex-sets");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    fx.agents(serde_json::json!([{ "key": "codex-rendered-bare", "sets": [{ "set": "alpha" }] }]));
    let home = fx.home("cx");
    let plain = fx.codex(&home, "").unwrap();
    // The built-in vidar-control skill gives even a no-sets spawn a layer payload; no spawn puts it on the line.
    assert_eq!(plain.args.len(), 2, "{:?}", plain.args);
    drop(plain);
    let static_config = codex_config_bytes(&home);
    let (plain_path, plain_text) = codex_payload(&home);
    assert!(plain_text.contains("- $vidar-control: ") && !plain_text.contains("Alpha set text."), "{plain_text}");
    std::fs::remove_file(plain_path).unwrap();

    let mut launch = fx.codex(&home, "codex-rendered-bare").unwrap();
    assert_eq!(codex_config_bytes(&home), static_config, "config.toml differs from a no-sets spawn");
    let (path, text) = codex_payload(&home);
    assert!(text.starts_with("You are a Codex session in a Vidar Bare tab"), "{text}");
    assert!(text.contains("Alpha set text.") && !text.contains("{{"), "{text}");
    assert!(text.contains(&crate::paths::root().to_string_lossy().into_owned()), "{{root}} not filled: {text}");
    let (marker, expected) = payload_marker(&text).unwrap();
    assert_eq!(marker, expected);
    assert_eq!(&launch.args[1..], &["app-server".to_string()]);
    assert_eq!(launch.developer_instructions.as_deref(), Some(text.as_str()));

    let m = launch.write_manifest("s4-cx", ["Path"]).unwrap();
    let raw = std::fs::read_to_string(&m).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["payload"]["marker"], marker.as_str());
    assert_eq!(v["payload"]["sets"], serde_json::json!(["alpha"]));
    assert_eq!(v["payload"]["path"], path.to_string_lossy().as_ref());
    assert_eq!(v["args"].as_array().unwrap().last().unwrap(), "app-server");
    assert_eq!(v["homes"]["codexHome"], home.join("codex-home").to_string_lossy().as_ref());
    assert!(!raw.contains("Alpha set text."), "the encoded text reached the manifest");
}

#[test]
fn a_rendered_codex_payload_over_12000_spawns_and_rides_developer_instructions() {
    let fx = RowFx::new("codex-limit");
    fx.rune("sets", "huge", &format!("{}\nHUGE-TAIL-MARKER\n", "word ".repeat(2600)));
    fx.agents(serde_json::json!([{ "key": "codex-rendered-bare", "sets": [{ "set": "huge" }] }]));
    let home = fx.home("cx");
    let launch = fx.codex(&home, "codex-rendered-bare").unwrap();
    let (_, text) = codex_payload(&home);
    assert!(text.chars().count() > 12_000 && text.contains("HUGE-TAIL-MARKER"), "payload too small: {}", text.len());
    assert_eq!(launch.developer_instructions.as_deref(), Some(text.as_str()));
    assert_eq!(launch.args.len(), 2, "the payload reached the line: {:?}", launch.args);
    assert!(launch.args.iter().all(|a| a.len() < 200));
}

#[test]
fn a_codex_row_key_must_name_a_codex_bare_row() {
    let fx = RowFx::new("codex-admit");
    let cfg = Some(fx.config.as_path());
    // Blank is none, with or without a profile; a key without a profile refuses.
    for blank in [None, Some(String::new()), Some("  ".to_string())] {
        assert_eq!(admit_row_key(blank.clone(), None, cfg).unwrap(), None);
        assert_eq!(admit_row_key(blank, Some("bare"), cfg).unwrap(), None);
    }
    let e = admit_row_key(Some("codex-rendered-bare".into()), None, cfg).unwrap_err();
    assert_eq!(e, "A row key rides only a profiled spawn; spawn refused");
    // No vidar.json: the built-in row alone.
    assert_eq!(admit_row_key(Some(" codex-rendered-bare ".into()), Some("bare"), cfg).unwrap().as_deref(), Some("codex-rendered-bare"));

    fx.agents(serde_json::json!([
        { "key": "claude-bare-review", "id": "claude", "profile": "bare", "sets": [{ "set": "alpha" }] },
        { "key": "astra", "id": "codex", "sets": [{ "set": "alpha" }] },
        { "key": "codex-bare-review", "id": "codex", "profile": "bare" },
        { "key": "codex-rendered-bare", "label": "Mine", "profile": null, "sets": [{ "set": "alpha" }] }
    ]));
    let refused = |key: &str| {
        let e = admit_row_key(Some(key.into()), Some("bare"), cfg).unwrap_err();
        assert_eq!(e, format!("Row {key:?} is not a Codex Bare row; Bare spawn refused"));
    };
    for key in ["claude-bare-review", "claude-bare", "astra", "unknown-row"] {
        refused(key);
    }
    assert!(admit_row_key(Some("codex-bare-review".into()), Some("bare"), cfg).is_ok());
    assert!(admit_row_key(Some("codex-rendered-bare".into()), Some("bare"), cfg).is_ok(), "a label-only overlay refused");
    // A Codex Bare key on a spawn whose own profile is not `bare` refuses (review d13bc628).
    for key in ["codex-rendered-bare", "codex-bare-review"] {
        let e = admit_row_key(Some(key.into()), Some("lean"), cfg).unwrap_err();
        assert_eq!(e, format!("Row {key:?} is not a Codex Bare row; Bare spawn refused"));
    }

    // An overlay re-pointing the built-in key refuses: another id, another profile, or disabled.
    for over in [serde_json::json!({ "key": "codex-rendered-bare", "id": "claude" }), serde_json::json!({ "key": "codex-rendered-bare", "profile": "lean" }), serde_json::json!({ "key": "codex-rendered-bare", "disabled": true })] {
        fx.agents(serde_json::json!([over]));
        refused("codex-rendered-bare");
    }
}

#[test]
fn codex_skills_copy_into_codex_home_with_their_own_ledger_and_are_listed() {
    let fx = RowFx::new("codex-skills");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    let tidy = fx.skill("tidy", "Keep it tidy.");
    let agent = fx.t.0.join("src").join("reviewer.md");
    std::fs::write(&agent, "Review it.").unwrap();
    let home = fx.home("cx");
    // A plain spawn makes the home (prepare_dirs owns its ACL); then a user's own skill folder and
    // a Claude ledger, both there before Vidar copies anything.
    drop(fx.codex(&home, "").unwrap());
    std::fs::remove_file(codex_payload(&home).0).unwrap();
    let skills = home.join("codex-home").join("skills");
    std::fs::create_dir_all(skills.join("mine")).unwrap();
    std::fs::write(skills.join("mine").join("SKILL.md"), "---\nname: mine\n---\n").unwrap();
    std::fs::create_dir_all(home.join("layer")).unwrap();
    let claude_ledger = home.join("layer").join("copies.json");
    std::fs::write(&claude_ledger, "{\"skills\":{},\"agents\":{}}").unwrap();

    // Skills and no sets: built instructions holding the listing only.
    fx.config_with(serde_json::json!([]), serde_json::json!({ "bareSkills": [tidy], "bareAgents": [agent.to_string_lossy()] }));
    let launch = fx.codex(&home, "").unwrap();
    assert_eq!(std::fs::read_to_string(skills.join("tidy").join("SKILL.md")).unwrap(), "---\nname: tidy\ndescription: Keep it tidy.\n---\nDo the tidy thing.\n");
    assert!(home.join("layer").join("codex-copies.json").is_file());
    assert_eq!(std::fs::read_to_string(&claude_ledger).unwrap(), "{\"skills\":{},\"agents\":{}}", "the Claude ledger was touched");
    assert!(!home.join("codex-home").join("agents").exists(), "bareAgents reached the Codex home");
    let (path, text) = codex_payload(&home);
    assert!(text.contains("\nSkills Vidar copied in (call by $name):\n- $vidar-control: "), "{text}");
    assert!(text.find("- $vidar-control: ").unwrap() < text.find("- $tidy: Keep it tidy.\n").unwrap(), "{text}");
    assert!(!text.contains("$mine"), "a user's own skill was listed: {text}");
    let (marker, expected) = payload_marker(&text).unwrap();
    assert_eq!(marker, expected);
    assert_eq!(launch.developer_instructions.as_deref(), Some(text.as_str()));
    assert!(launch.manifest.payload.sets.is_empty());
    drop(launch);
    std::fs::remove_file(&path).unwrap();

    // Sets and skills: the sets first, then the listing, then the marker.
    fx.config_with(serde_json::json!([{ "key": "codex-rendered-bare", "sets": [{ "set": "alpha" }] }]), serde_json::json!({ "bareSkills": [tidy] }));
    let launch = fx.codex(&home, "codex-rendered-bare").unwrap();
    let (path, text) = codex_payload(&home);
    let (s, l, k) = (text.find("Alpha set text.").unwrap(), text.find("- $tidy: Keep it tidy.").unwrap(), text.find("VIDAR-PAYLOAD-").unwrap());
    assert!(s < l && l < k, "{text}");
    drop(launch);
    std::fs::remove_file(&path).unwrap();

    // bareSkills gone: Vidar's copy leaves, the user's folder stays, only the built-in skill is listed.
    fx.config_with(serde_json::json!([]), serde_json::json!({}));
    let launch = fx.codex(&home, "").unwrap();
    assert!(!skills.join("tidy").exists(), "Vidar's Codex copy survived its removal");
    assert!(skills.join("mine").join("SKILL.md").is_file(), "a user's own skill was removed");
    assert_eq!(launch.args.len(), 2, "{:?}", launch.args);
    let (_, text) = codex_payload(&home);
    assert!(text.contains("- $vidar-control: ") && !text.contains("$tidy"), "{text}");
}

#[test]
fn the_codex_sets_template_carries_the_payload_control_lines() {
    let dir = crate::paths::root().join("profiles").join("bare");
    let read = |n: &str| std::fs::read_to_string(dir.join(n)).unwrap().replace('\r', "");
    let (plain, sets) = (read("codex.payload.md"), read("codex.payload-sets.md"));
    let control: Vec<&str> = plain.lines().skip(3).take(2).collect();
    let lines: Vec<&str> = sets.lines().collect();
    assert_eq!(&lines[3..5], control.as_slice());
    assert_eq!(sets.matches("{{sets}}").count(), 1);
    let p = load_codex_profile(&crate::paths::root(), "bare").unwrap();
    assert_eq!(p.sets_payload.as_deref(), Some("profiles/bare/codex.payload-sets.md"));
}

fn accepted(entries: &[(&str, &str, bool)]) -> AcceptedMap {
    entries.iter().map(|(v, p, s)| (v.to_string(), Accepted { pinned: p.to_string(), same: *s })).collect()
}

#[test]
fn codex_warning_follows_the_pin_and_the_accepted_verdicts() {
    let none = AcceptedMap::new();
    assert_eq!(codex_warning(Some("0.162.1"), "0.162.1", &none), None);
    let differs = codex_warning(Some("0.163.0"), "0.162.1", &none).unwrap();
    assert_eq!(differs, "Codex 0.163.0 differs from the verified 0.162.1; launching anyway");
    assert_eq!(codex_warning(Some("0.163.0"), "0.162.1", &accepted(&[("0.163.0", "0.162.1", true)])), None);
    let changed = codex_warning(Some("0.163.0"), "0.162.1", &accepted(&[("0.163.0", "0.162.1", false)])).unwrap();
    assert_eq!(changed, "Codex 0.163.0 changed its protocol since the verified 0.162.1; launching anyway");
    // An entry recorded against an older pin never counts, whichever verdict it holds.
    for same in [true, false] {
        assert_eq!(codex_warning(Some("0.163.0"), "0.162.1", &accepted(&[("0.163.0", "0.161.0", same)])).unwrap(), differs);
    }
    assert_eq!(codex_warning(None, "0.162.1", &accepted(&[("0.163.0", "0.162.1", true)])).unwrap(), "Codex version unreadable (verified 0.162.1); launching anyway");
}

#[test]
fn read_accepted_skips_bad_entries_and_a_missing_file() {
    let t = TempDir::new("codex-accepted");
    assert!(read_accepted(&t.0.join("none.json")).is_empty());
    let f = t.0.join("a.json");
    std::fs::write(&f, r#"{"0.163.0":{"pinned":"0.162.1","same":true,"atMs":1},"0.164.0":{"pinned":1},"0.165.0":7}"#).unwrap();
    assert_eq!(read_accepted(&f), accepted(&[("0.163.0", "0.162.1", true)]));
    std::fs::write(&f, "not json").unwrap();
    assert!(read_accepted(&f).is_empty());
}

// ---- Codex Raw (the TUI in a PTY, pty.rs) ----

#[test]
fn the_raw_codex_line_runs_the_tui_with_raw_args_and_no_app_server() {
    let fx = RowFx::new("codex-tui");
    let home = fx.home("cx");
    let mut launch = fx.tui(&home, "", None).unwrap();
    assert_eq!(launch.program, PathBuf::from(r"X:\bin\node.exe"));
    assert_eq!(
        launch.args[..3],
        [r"X:\npm\node_modules\@openai\codex\bin\codex.js".to_string(), "--no-daemon".into(), "--no-alt-screen".into()]
    );
    assert!(!launch.args.iter().any(|a| a == "app-server"), "{:?}", launch.args);
    // No sets: the built-in vidar-control skill still adds `--profile` and a built payload.
    let (payload, text) = codex_payload(&home);
    assert!(text.contains("- $vidar-control: "), "{text}");
    let name = assert_raw_profile(&launch, &home, &text);
    assert_eq!(launch.codex_home, home.join("codex-home"));
    let m = launch.write_manifest("raw-cx", ["Path"]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["payload"]["path"], payload.to_string_lossy().as_ref());
    assert_eq!(v["args"].as_array().unwrap().last().unwrap(), &serde_json::json!(name));
}

/// A Raw line's `--profile vidar-<hash12>` tail and its file: `<codex-home>\<name>.config.toml`
/// holding `developer_instructions` = `text` only. Returns the profile name.
fn assert_raw_profile(launch: &CodexLaunch, home: &Path, text: &str) -> String {
    assert_eq!(launch.args.len(), 5, "{:?}", launch.args);
    assert_eq!(launch.args[3], "--profile");
    let name = launch.args[4].clone();
    assert_eq!(name, format!("vidar-{}", crate::rules::build::hash12(text.as_bytes())));
    assert!(!launch.args.iter().any(|a| a == "-c" || a.starts_with("developer_instructions")), "{:?}", launch.args);
    let file = home.join("codex-home").join(format!("{name}.config.toml"));
    let doc = home::parse_toml_lite(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(doc, vec![("developer_instructions".to_string(), home::Toml::Str(text.to_string()))]);
    name
}

#[test]
fn a_raw_codex_line_gets_a_profile_with_sets_or_a_skills_listing_and_records_the_payload_path() {
    let fx = RowFx::new("codex-tui-c");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    let tidy = fx.skill("tidy", "Keep it tidy.");
    let home = fx.home("cx");
    drop(fx.tui(&home, "", None).unwrap());
    std::fs::remove_file(codex_payload(&home).0).unwrap();
    let static_config = codex_config_bytes(&home);

    // Sets on the Raw row's own key.
    fx.agents(serde_json::json!([{ "key": "codex-bare", "sets": [{ "set": "alpha" }] }]));
    let mut launch = fx.tui(&home, "codex-bare", None).unwrap();
    let (path, text) = codex_payload(&home);
    assert!(text.contains("Alpha set text."), "{text}");
    assert_eq!(&launch.args[1..3], &["--no-daemon".to_string(), "--no-alt-screen".into()]);
    let name = assert_raw_profile(&launch, &home, &text);
    assert_eq!(codex_config_bytes(&home), static_config, "config.toml differs from a no-sets spawn");
    let m = launch.write_manifest("raw-cx-sets", ["Path"]).unwrap();
    let raw = std::fs::read_to_string(&m).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["payload"]["path"], path.to_string_lossy().as_ref());
    assert_eq!(v["args"].as_array().unwrap().last().unwrap(), &serde_json::json!(name));
    assert!(!raw.contains("Alpha set text."), "the encoded text reached the manifest");
    drop(launch);
    std::fs::remove_file(&path).unwrap();

    // A skills listing alone, no sets, gets its own profile; the sets row's file stays as it was.
    fx.config_with(serde_json::json!([]), serde_json::json!({ "bareSkills": [tidy] }));
    let launch = fx.tui(&home, "", None).unwrap();
    let (_, listing) = codex_payload(&home);
    assert!(listing.contains("- $tidy: Keep it tidy."), "{listing}");
    assert_ne!(assert_raw_profile(&launch, &home, &listing), name);
    let sets_file = home.join("codex-home").join(format!("{name}.config.toml"));
    let doc = home::parse_toml_lite(&std::fs::read_to_string(sets_file).unwrap()).unwrap();
    assert_eq!(doc, vec![("developer_instructions".to_string(), home::Toml::Str(text))]);
    drop(launch);
}

/// A launch folder `<temp>\proj` whose `.codex\config.toml` holds `config` (None = no file).
fn project_with_codex_config(fx: &RowFx, config: Option<&str>) -> String {
    let proj = fx.t.0.join("proj");
    std::fs::create_dir_all(proj.join(".codex")).unwrap();
    if let Some(c) = config {
        std::fs::write(proj.join(".codex").join("config.toml"), c).unwrap();
    }
    proj.to_string_lossy().into_owned()
}

#[test]
fn a_raw_codex_tab_warns_when_the_folders_config_sets_developer_instructions() {
    let fx = RowFx::new("codex-tui-override");
    let home = fx.home("cx");
    let cwd = project_with_codex_config(&fx, Some("model = \"x\"\ndeveloper_instructions = \"mine\"\n"));
    let launch = fx.tui(&home, "", Some(&cwd)).unwrap();
    let w = launch.warning.clone().unwrap_or_default();
    assert!(w.contains(codex_hosted::PROJECT_OVERRIDE_WARNING), "{w}");
    assert_eq!(codex_hosted::PROJECT_OVERRIDE_WARNING, "This Folder's Codex Config Replaces Your Runes: .codex\\config.toml Sets developer_instructions");
    drop(launch);
}

#[test]
fn a_raw_codex_tab_stays_silent_without_a_top_level_override_or_on_a_parse_failure() {
    let fx = RowFx::new("codex-tui-override-silent");
    let home = fx.home("cx");
    let silent = |fx: &RowFx, cfg: Option<&str>| {
        let cwd = project_with_codex_config(fx, cfg);
        let launch = fx.tui(&home, "", Some(&cwd)).unwrap();
        let w = launch.warning.clone().unwrap_or_default();
        assert!(!w.contains("Replaces Your Runes"), "{cfg:?}: {w}");
    };
    silent(&fx, None);
    silent(&fx, Some("[profiles.x]\ndeveloper_instructions = \"mine\"\n"));
    silent(&fx, Some("model = \"x\"\n"));
    // Multi-line values and dotted keys are beyond the lite parser: cannot tell, so no warning.
    silent(&fx, Some("developer_instructions = \"\"\"\nmine\n\"\"\"\n"));
    silent(&fx, Some("developer_instructions = [unclosed\n"));
    // No folder at all.
    let launch = fx.tui(&home, "", None).unwrap();
    assert!(!launch.warning.clone().unwrap_or_default().contains("Replaces Your Runes"));
}

#[test]
fn a_rendered_codex_prepare_never_warns_about_the_folders_config() {
    let fx = RowFx::new("codex-rendered-override");
    let home = fx.home("cx");
    let cwd = project_with_codex_config(&fx, Some("developer_instructions = \"mine\"\n"));
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let launch = prepare_codex_in("bare", &crate::paths::root(), &home, inherited(), &guard(), &probes, &fx.opts(""), Some(&cwd)).unwrap();
    assert!(!launch.warning.clone().unwrap_or_default().contains("Replaces Your Runes"));
    // The helper alone sees the key; mod.rs gates it on the Raw profile file (every Raw row has one:
    // the built-in vidar-control skill always builds a payload).
    assert!(codex_hosted::project_override_warning(Some(&cwd)).is_some());
    assert!(codex_hosted::project_override_warning(Some(" ")).is_none());
}

#[test]
fn a_raw_codex_payload_over_the_inline_limit_spawns_through_its_profile_file() {
    let fx = RowFx::new("codex-tui-big");
    fx.rune("sets", "huge", &format!("{}\nHUGE-TAIL-MARKER\n", "word ".repeat(2600)));
    fx.agents(serde_json::json!([{ "key": "codex-bare", "sets": [{ "set": "huge" }] }]));
    let home = fx.home("cx");
    let launch = fx.tui(&home, "codex-bare", None).unwrap();
    let (_, text) = codex_payload(&home);
    assert!(crate::rules::codex::encode_toml_string(&text).chars().count() > crate::rules::codex::INLINE_LIMIT, "payload too small: {}", text.len());
    assert!(text.contains("HUGE-TAIL-MARKER"), "{text}");
    assert_raw_profile(&launch, &home, &text);
    assert!(launch.args.iter().all(|a| a.len() < 200), "the payload reached the line");
    drop(launch);
}

#[test]
fn the_raw_codex_bare_row_key_is_a_codex_bare_row() {
    let fx = RowFx::new("codex-tui-admit");
    let cfg = Some(fx.config.as_path());
    assert_eq!(admit_row_key(Some("codex-bare".into()), Some("bare"), cfg).unwrap().as_deref(), Some("codex-bare"));
    fx.agents(serde_json::json!([{ "key": "codex-bare", "disabled": true }]));
    assert!(admit_row_key(Some("codex-bare".into()), Some("bare"), cfg).is_err());
    for key in ["claude-bare", "codex"] {
        assert!(admit_row_key(Some(key.into()), Some("bare"), cfg).is_err(), "{key}");
    }
}

#[test]
fn a_raw_codex_tab_in_the_home_folder_is_refused_before_any_trust_is_written() {
    let fx = RowFx::new("codex-tui-home");
    let home = fx.home("cx");
    let user_home = crate::paths::home().expect("a resolved user profile");
    for refused in [Some(user_home.clone()), user_home.parent().map(Path::to_path_buf)] {
        let mut ran = false;
        let e = crate::pty::codex_bare_prepare(refused.clone(), |cwd| {
            ran = true;
            fx.tui(&home, "", Some(cwd))
        })
        .err()
        .unwrap();
        assert_eq!(e, crate::codex_cwd::HOME_CWD_REFUSED, "{refused:?}");
        assert!(!ran, "prepare ran on {refused:?}");
        assert!(!home.join("codex-home").join("config.toml").exists(), "config.toml written for {refused:?}");
    }
    // A project folder passes, and the prepare trusts that same folder.
    let work = fx.t.0.join("Work Folder");
    std::fs::create_dir_all(&work).unwrap();
    codex_hosted::TEST_TRUST.with(|t| t.borrow_mut().push(work.to_string_lossy().into_owned()));
    let (dir, launch) = crate::pty::codex_bare_prepare(Some(work.clone()), |cwd| fx.tui(&home, "", Some(cwd))).unwrap();
    assert_eq!(dir, work);
    let text = std::fs::read_to_string(home.join("codex-home").join("config.toml")).unwrap();
    let key = home::trusted_project_key(&work.to_string_lossy()).unwrap();
    assert!(text.contains(&home::trusted_project_table(&key)), "{text}");
    drop(launch);
}

#[test]
fn a_tui_prepare_on_a_profile_without_raw_args_refuses_before_the_home() {
    let t = TempDir::new("codex-no-raw");
    let src = crate::paths::root().join("profiles").join("bare");
    let dst = t.0.join("profiles").join("bare");
    std::fs::create_dir_all(&dst).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(src.join("codex.json")).unwrap()).unwrap();
    v.as_object_mut().unwrap().remove("rawArgs");
    std::fs::write(dst.join("codex.json"), serde_json::to_string(&v).unwrap()).unwrap();
    let home = t.0.join("agent-home");
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let e = prepare_codex_for(Surface::Tui, "bare", &t.0, &home, inherited(), &guard(), &probes, &LaunchOpts::default(), None).err().unwrap();
    assert!(e.contains("has no rawArgs"), "{e}");
    assert!(!home.exists(), "the home was touched");
}

#[test]
fn codex_env_for_profile_is_read_only_and_needs_the_home_and_its_login() {
    let t = TempDir::new("codex-flow-env");
    let root = crate::paths::root();
    let home = t.0.join("agent-home");
    let probes = CodexProbes { find: &fake_find, codex: &codex_probes_ok };
    let e = codex_env_for_profile_with("bare", &root, &home, inherited(), &probes).err().unwrap();
    assert_eq!(e, "Open a Bare tab once to create its home");
    assert!(!home.exists(), "a missing home was created");
    assert!(codex_env_for_profile_with("lean", &root, &home, inherited(), &probes).is_err());

    let codex_home = home.join("codex-home");
    std::fs::create_dir_all(&codex_home).unwrap();
    let e = codex_env_for_profile_with("bare", &root, &home, inherited(), &probes).err().unwrap();
    assert_eq!(e, "Sign in from a Bare tab");
    // A stand-in login file in the temp home (presence is all that is read).
    std::fs::write(codex_home.join("auth.json"), "{}").unwrap();
    let mut env_in = inherited();
    env_in[0].1 = r"C:\Windows\system32;C:\Users\testuser\AppData\Local\Microsoft\WindowsApps;C:\Tools".into();
    let got = codex_env_for_profile_with("bare", &root, &home, env_in, &probes).unwrap();
    assert_eq!(got.codex_home, codex_home);
    assert_eq!(got.node, PathBuf::from(r"X:\bin\node.exe"));
    assert_eq!(got.js, PathBuf::from(r"X:\npm\node_modules\@openai\codex\bin\codex.js"));
    assert_eq!(got.env.get("CODEX_HOME").map(|v| v.to_string_lossy().into_owned()), Some(codex_home.to_string_lossy().into_owned()));
    let path = got.env.get("Path").unwrap().to_string_lossy().into_owned();
    assert!(!path.contains("WindowsApps"), "{path}");
    for gone in ["ANTHROPIC_API_KEY", "VIDAR_CTL_TOKEN"] {
        assert!(!got.env.contains(gone), "{gone}");
    }
    // Nothing besides what the test made: no config.toml, manifests, lock or user-home.
    let mut made: Vec<String> = std::fs::read_dir(&home).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    made.sort();
    assert_eq!(made, vec!["codex-home".to_string()]);
    assert_eq!(std::fs::read_dir(&codex_home).unwrap().count(), 1);
}

// ---- Hosted Codex Bare (run 2026-10-19-codex-primary, F2a) ----

impl RowFx {
    /// A hosted Codex Bare prepare on `home` in `cwd`; `asked` collects every name `find` was asked for.
    fn codex_hosted(&self, home: &Path, key: &str, cwd: &Path, asked: &std::cell::RefCell<Vec<String>>) -> Result<CodexHostedLaunch, String> {
        let find = |env: &Env, name: &str| {
            asked.borrow_mut().push(name.to_string());
            fake_find(env, name)
        };
        codex_hosted::prepare_codex_hosted_with("bare", &crate::paths::root(), home, inherited(), &guard(), &find, &self.opts(key), &cwd.to_string_lossy())
    }
}

#[test]
fn prepare_codex_hosted_writes_config_and_payload_and_resolves_no_binary() {
    let fx = RowFx::new("codex-hosted");
    fx.rune("sets", "alpha", "Alpha set text.\n");
    fx.agents(serde_json::json!([{ "key": "codex-rendered-bare", "sets": [{ "set": "alpha" }] }]));
    let work = fx.t.0.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let asked = std::cell::RefCell::new(Vec::new());
    codex_hosted::TEST_TRUST.with(|t| t.borrow_mut().push(work.to_string_lossy().into_owned()));

    // No sets: config.toml as in-process writes it, a payload file holding the built-in skill, no binary lookup.
    let home = fx.home("plain");
    let plain = fx.codex_hosted(&home, "", &work, &asked).unwrap();
    let plain_file = plain.payload_file.clone().expect("the built-in skill makes a payload");
    assert!(codex_payload(&home).1.contains("- $vidar-control: "));
    assert_eq!(plain_file, codex_payload(&home).0);
    let hosted_config = codex_config_bytes(&home);
    let text = String::from_utf8(hosted_config.clone()).unwrap();
    let key = home::trusted_project_key(&work.to_string_lossy()).unwrap();
    assert!(text.contains(&home::trusted_project_table(&key)), "{text}");
    assert!(text.contains(r#"env_vars = ["VIDAR_CTL_TOKEN", "FALCON_SESSION", "VIDAR_CTL_SECRET"]"#), "{text}");
    assert_eq!(*asked.borrow(), vec!["pwsh.exe".to_string(), "pwsh.exe".into()], "only pwsh is probed: no node, no codex.js");
    drop(plain);
    // The in-process prepare on the same folder writes the same config.toml.
    let in_process = prepare_codex_for(Surface::AppServer, "bare", &crate::paths::root(), &home, inherited(), &guard(), &CodexProbes { find: &fake_find, codex: &codex_probes_ok }, &fx.opts(""), Some(&work.to_string_lossy())).unwrap();
    assert_eq!(codex_config_bytes(&home), hosted_config, "hosted and in-process config.toml differ");
    drop(in_process);

    // With sets: the built payload under layer\, marked, admitted by the host's own rule.
    let home = fx.home("sets");
    let mut launch = fx.codex_hosted(&home, "codex-rendered-bare", &work, &asked).unwrap();
    let (path, text) = codex_payload(&home);
    assert_eq!(launch.payload_file.as_deref(), Some(path.as_path()));
    assert!(text.contains("Alpha set text."), "{text}");
    let (marker, expected) = payload_marker(&text).unwrap();
    assert_eq!(marker, expected);
    assert!(codex_payload::admit_and_read(&path.to_string_lossy(), &home).is_ok());
    assert!(home.join("codex-home").join("config.toml").is_file());

    // What the host ran fills the record: program falcon, its executable and version.
    let pin = pinned("codex");
    assert_eq!(launch.record_host_with(r"C:\npm\codex.exe", Some(&pin), Some(r"C:\pwsh\pwsh.exe"), &AcceptedMap::new()), None);
    assert_eq!(launch.bare_warnings(), Vec::<String>::new());
    let m = launch.write_manifest("t-hosted", "s-1", ["Path", "FALCON_SESSION"]).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&m).unwrap()).unwrap();
    assert_eq!(v["program"], "falcon");
    assert_eq!(v["binary"]["path"], r"C:\npm\codex.exe");
    assert_eq!(v["binary"]["version"], pin.as_str());
    assert_eq!(v["falconSession"], "s-1");
    assert_eq!(v["payload"]["path"], path.to_string_lossy().as_ref());
    assert_eq!(v["args"], serde_json::json!([]));
    assert!(!std::fs::read_to_string(&m).unwrap().contains("Alpha set text."), "the payload text reached the manifest");
}

#[test]
fn a_hosted_codex_record_warns_on_an_unverified_version_or_no_pwsh() {
    let fx = RowFx::new("codex-hosted-warn");
    let work = fx.t.0.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let asked = std::cell::RefCell::new(Vec::new());
    codex_hosted::TEST_TRUST.with(|t| t.borrow_mut().push(work.to_string_lossy().into_owned()));
    let mut launch = fx.codex_hosted(&fx.home("w"), "", &work, &asked).unwrap();
    let pin = pinned("codex");
    let shell = launch.record_host_with("codex.exe", Some(&pin), None, &AcceptedMap::new()).unwrap();
    assert_eq!(shell, SHELL_51_WARNING);
    let both = launch.record_host_with("codex.exe", Some("0.0.1"), None, &AcceptedMap::new()).unwrap();
    assert!(both.ends_with(&format!("; {SHELL_51_WARNING}")) && both.len() > SHELL_51_WARNING.len() + 2, "{both}");
    assert_eq!(launch.bare_warnings(), vec![both]);
}

#[test]
fn a_hosted_codex_prepare_refuses_an_unknown_profile_and_admits_an_over_12000_payload() {
    let fx = RowFx::new("codex-hosted-refuse");
    fx.rune("sets", "huge", &format!("{}\n", "word ".repeat(2600)));
    fx.agents(serde_json::json!([{ "key": "codex-rendered-bare", "sets": [{ "set": "huge" }] }]));
    let work = fx.t.0.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let home = fx.home("r");
    let e = codex_hosted::prepare_codex_hosted_with("lean", &crate::paths::root(), &home, inherited(), &guard(), &fake_find, &fx.opts(""), &work.to_string_lossy()).err().unwrap();
    assert!(e.contains("Unknown launch profile"), "{e}");
    assert!(!home.exists(), "the home was touched for an unknown profile");
    let launch = fx.codex_hosted(&home, "codex-rendered-bare", &work, &std::cell::RefCell::new(Vec::new())).unwrap();
    let (path, text) = codex_payload(&home);
    assert!(text.chars().count() > 12_000, "payload too small: {}", text.len());
    assert_eq!(launch.payload_file.as_deref(), Some(path.as_path()));
}

// ---- Codex guard hooks (run 2026-10-19-codex-primary, P1 W2) ----

type Seen = std::rc::Rc<std::cell::RefCell<Vec<(u32, Option<PathBuf>, PathBuf)>>>;

/// Codex's snake_case form of a hook event, as `hooks/list` keys carry it.
fn snake_event(e: &str) -> String {
    let mut s = String::new();
    for (i, c) in e.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            s.push('_');
        }
        s.push(c.to_ascii_lowercase());
    }
    s
}

/// The tests' `hooks/list`: one hook per handler in `<CODEX_HOME>\hooks.json`, keyed as Codex keys
/// them (`key_dir` replaces the hooks.json path in the key when set); `trusted` once config.toml
/// carries the key's table, unless `stay_untrusted`. `seen` collects (run, codex.js, listed cwd).
fn mock_list(stay_untrusted: bool, key_file: Option<PathBuf>, seen: Seen) {
    codex_hooks::LIST_MOCK.with(|m| {
        *m.borrow_mut() = Some(Box::new(move |ctx: &codex_hooks::ListCtx, call: u32| {
            seen.borrow_mut().push((call, ctx.js.clone(), ctx.cwd.to_path_buf()));
            let path = ctx.codex_home.join("hooks.json");
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?).unwrap();
            let config = std::fs::read_to_string(ctx.codex_home.join("config.toml")).unwrap_or_default();
            let mut out = Vec::new();
            for (event, groups) in v["hooks"].as_object().unwrap() {
                for (gi, g) in groups.as_array().unwrap().iter().enumerate() {
                    for hi in 0..g["hooks"].as_array().unwrap().len() {
                        let key = format!("{}:{}:{gi}:{hi}", key_file.as_ref().unwrap_or(&path).display(), snake_event(event));
                        let trusted = !stay_untrusted && config.contains(&format!("[hooks.state.\"{}\"]", key.replace('\\', "\\\\")));
                        out.push(codex_hooks::Listed {
                            key,
                            current_hash: format!("sha256:{}", "ab".repeat(32)),
                            trust_status: if trusted { "trusted" } else { "untrusted" }.into(),
                            source_path: path.to_string_lossy().into_owned(),
                        });
                    }
                }
            }
            Ok(out)
        }));
    });
}

impl RowFx {
    /// A guard script `<temp>\hooks\<name>`, its absolute path.
    fn guard_file(&self, name: &str) -> String {
        let d = self.t.0.join("hooks");
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join(name);
        std::fs::write(&f, "process.exit(0);\n").unwrap();
        f.to_string_lossy().into_owned()
    }
    /// vidar.json with a PreToolUse entry (fail-closed, guard-install, open guard-driver) and a Stop entry.
    fn codex_guards(&self) {
        let [fc, install, driver, stop] = ["fail-closed.mjs", "guard-install.mjs", "guard-driver.mjs", "stop-guard.mjs"].map(|n| self.guard_file(n));
        let guards = serde_json::json!([
            { "event": "PreToolUse", "matcher": "Bash|apply_patch", "run": [fc, install], "open": [driver] },
            { "event": "Stop", "run": [stop] }
        ]);
        self.config_with(serde_json::json!([]), serde_json::json!({ "bareCodexGuards": guards }));
    }
}

/// hooks.json holds the two groups with their exact lines, the copies sit in `layer\hooks\`, and
/// config.toml carries one trust table per handler.
fn assert_trusted_hooks(home: &Path) {
    let ch = home.join("codex-home");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(ch.join("hooks.json")).unwrap()).unwrap();
    let dir = home.join("layer").join("hooks");
    let q = |f: &str| format!("'{}'", dir.join(f).display());
    let pre = &v["hooks"]["PreToolUse"][0];
    assert_eq!(pre["matcher"], "Bash|apply_patch");
    let line = format!(
        r"& 'X:\bin\node.exe' {} {} --guard {} --open-guard {}; exit $LASTEXITCODE",
        q("fail-closed.mjs"),
        q("codex-shim.mjs"),
        q("guard-install.mjs"),
        q("guard-driver.mjs")
    );
    assert_eq!(pre["hooks"][0]["commandWindows"], line.as_str());
    assert_eq!(pre["hooks"][0]["command"], line.as_str());
    assert_eq!(pre["hooks"][0]["type"], "command");
    assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["commandWindows"], format!(r"& 'X:\bin\node.exe' {}; exit $LASTEXITCODE", q("stop-guard.mjs")).as_str());
    assert!(v["hooks"]["Stop"][0].get("matcher").is_none());
    for f in ["codex-shim.mjs", "fail-closed.mjs", "guard-driver.mjs", "guard-install.mjs", "stop-guard.mjs"] {
        assert!(dir.join(f).is_file(), "{f} not copied");
    }
    let config = std::fs::read_to_string(ch.join("config.toml")).unwrap();
    assert_eq!(config.matches(&format!("trusted_hash = \"sha256:{}\"", "ab".repeat(32))).count(), 2, "{config}");
    assert_eq!(config.matches("[hooks.state.\"").count(), 2, "{config}");
}

const COPIED: [&str; 5] = ["codex-shim.mjs", "fail-closed.mjs", "guard-driver.mjs", "guard-install.mjs", "stop-guard.mjs"];

#[test]
fn every_codex_prepare_path_writes_and_trusts_the_guard_hooks() {
    let fx = RowFx::new("codex-hooks");
    fx.codex_guards();
    let work = fx.t.0.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let seen: Seen = Default::default();
    mock_list(false, None, seen.clone());
    let js = Some(PathBuf::from(r"X:\npm\node_modules\@openai\codex\bin\codex.js"));

    // In-process Rendered (app-server), no launch folder: the home itself is listed.
    let home = fx.home("app");
    let mut launch = fx.codex(&home, "").unwrap();
    assert_trusted_hooks(&home);
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(launch.write_manifest("t-app", ["Path"]).unwrap()).unwrap()).unwrap();
    assert_eq!(v["guards"], serde_json::json!(COPIED));
    assert!(v.get("warnings").is_none(), "{v}");
    assert_eq!(*seen.borrow(), vec![(0, js.clone(), home.join("codex-home")), (1, js.clone(), home.join("codex-home"))]);
    // The carried guard files ride into the built payload.
    assert!(codex_payload(&home).1.contains("- $vidar-control: "));
    drop(launch);

    // Raw TUI in a launch folder.
    seen.borrow_mut().clear();
    let home = fx.home("tui");
    drop(fx.tui(&home, "", Some(&work.to_string_lossy())).unwrap());
    assert_trusted_hooks(&home);
    assert_eq!(*seen.borrow(), vec![(0, js.clone(), work.clone()), (1, js, work.clone())]);

    // Falcon-hosted: node is probed for the hook lines.
    seen.borrow_mut().clear();
    let home = fx.home("hosted");
    let asked = std::cell::RefCell::new(Vec::new());
    let mut hosted = fx.codex_hosted(&home, "", &work, &asked).unwrap();
    assert_trusted_hooks(&home);
    assert!(asked.borrow().iter().any(|n| n == "node.exe"), "{:?}", asked.borrow());
    assert_eq!(seen.borrow().len(), 2);
    assert!(seen.borrow().iter().all(|(_, _, cwd)| *cwd == work));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(hosted.write_manifest("t-h", "s-1", ["Path"]).unwrap()).unwrap()).unwrap();
    assert_eq!(v["guards"], serde_json::json!(COPIED));
}

#[test]
fn a_codex_guard_hook_codex_does_not_trust_refuses_the_spawn() {
    let fx = RowFx::new("codex-untrusted");
    fx.codex_guards();
    let work = fx.t.0.join("work");
    std::fs::create_dir_all(&work).unwrap();

    // Still untrusted after the trust write.
    let seen: Seen = Default::default();
    mock_list(true, None, seen.clone());
    let home = fx.home("u");
    let e = fx.codex(&home, "").err().unwrap();
    assert!(e.starts_with("Codex does not trust Vidar's guard hooks after the trust write (") && e.ends_with(" is untrusted); Bare spawn refused"), "{e}");
    assert_eq!(seen.borrow().len(), 2);
    assert_eq!(manifest_count(&home), 0);
    let asked = std::cell::RefCell::new(Vec::new());
    let e = fx.codex_hosted(&fx.home("uh"), "", &work, &asked).err().unwrap();
    assert!(e.starts_with("Codex does not trust Vidar's guard hooks after the trust write ("), "{e}");

    // A hook missing from the list: refused before any trust write.
    codex_hooks::LIST_MOCK.with(|m| *m.borrow_mut() = Some(Box::new(|_: &codex_hooks::ListCtx, _| Ok(Vec::new()))));
    let home = fx.home("m");
    let e = fx.codex(&home, "").err().unwrap();
    assert!(e.starts_with("Codex lists 0 of Vidar's 2 guard hooks in ") && e.ends_with("hooks.json; Bare spawn refused"), "{e}");
    assert!(!std::fs::read_to_string(home.join("codex-home").join("config.toml")).unwrap().contains("hooks.state"));

    // The list itself failing.
    codex_hooks::LIST_MOCK.with(|m| *m.borrow_mut() = Some(Box::new(|_: &codex_hooks::ListCtx, _| Err("boom".to_string()))));
    let e = fx.tui(&fx.home("f"), "", None).err().unwrap();
    assert_eq!(e, "Codex hooks/list failed (boom); guard hooks unverified, Bare spawn refused");

    // A key naming another hooks.json (a repo's) is never written as trust.
    mock_list(false, Some(work.join(".codex").join("hooks.json")), Default::default());
    let home = fx.home("r");
    let e = fx.codex(&home, "").err().unwrap();
    assert!(e.contains("does not name") && e.contains("hooks.json"), "{e}");
    assert!(!std::fs::read_to_string(home.join("codex-home").join("config.toml")).unwrap().contains("hooks.state"));
}

#[test]
fn no_bare_codex_guards_is_quiet_and_removes_a_stale_hooks_json() {
    let fx = RowFx::new("codex-noguards");
    fx.agents(serde_json::json!([]));
    let home = fx.home("n");
    drop(fx.codex(&home, "").unwrap());
    let stale = home.join("codex-home").join("hooks.json");
    std::fs::write(&stale, "{\"hooks\":{}}\n").unwrap();
    // No mock: a hooks/list here would fail the spawn.
    let mut launch = fx.codex(&home, "").unwrap();
    assert!(!stale.exists(), "a stale hooks.json survived");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(launch.write_manifest("t-n", ["Path"]).unwrap()).unwrap()).unwrap();
    assert_eq!(v["guards"], serde_json::json!([]));
    assert!(v["warnings"].as_array().is_none_or(Vec::is_empty), "{}", v["warnings"]);
    assert!(!std::fs::read_to_string(home.join("codex-home").join("config.toml")).unwrap().contains("hooks.state"));
}

#[test]
fn a_codex_guard_entry_on_a_non_codex_event_refuses() {
    let fx = RowFx::new("codex-events");
    let f = fx.guard_file("guard-install.mjs");
    let home = fx.home("ev");
    std::fs::create_dir_all(&home).unwrap();
    let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
    let shim = under(&crate::paths::root(), "tools/bare/codex-shim.mjs");
    let node = Path::new(r"X:\bin\node.exe");
    let entry = |event: &str, matcher: Option<&str>, open: Vec<String>| guards::BareCodexGuard { event: event.into(), matcher: matcher.map(Into::into), run: vec![f.clone()], open };
    for (event, ok) in [
        ("PreToolUse", true),
        ("PermissionRequest", true),
        ("PostToolUse", true),
        ("Stop", true),
        ("SessionEnd", true),
        ("Interrupt", true),
        ("Notification", false),
        ("pretooluse", false),
        ("PreToolUse ", false),
        ("", false),
    ] {
        let r = guards::copy_codex(&lock, &home, node, &shim, &[entry(event, None, Vec::new())]);
        match ok {
            true => assert!(r.is_ok(), "{event}: {r:?}"),
            false => {
                let e = r.unwrap_err();
                assert!(e.starts_with(&format!("Bare guard event {event:?} is not a Codex hook event (PreToolUse, ")) && e.ends_with("; Bare spawn refused"), "{e}");
            }
        }
    }
    // A matcher no Codex tool answers to drops its entry with a warning; nothing is grouped.
    let r = guards::copy_codex(&lock, &home, node, &shim, &[entry("PreToolUse", Some("Read|Grep"), Vec::new())]).unwrap();
    assert!(r.groups.is_empty() && r.files.is_empty(), "{r:?}");
    assert_eq!(r.warnings, vec![r#"bareCodexGuards entry for PreToolUse with matcher "Read|Grep" names no Codex tool (Bash, apply_patch, Edit, Write); entry dropped"#.to_string()]);
    assert_eq!(guards::copy_codex(&lock, &home, node, &shim, &[entry("PreToolUse", Some("Edit"), Vec::new())]).unwrap().groups.len(), 1);
    // `open` rides PreToolUse only; a user file named like the shim refuses.
    let e = guards::copy_codex(&lock, &home, node, &shim, &[entry("Stop", None, vec![f.clone()])]).unwrap_err();
    assert!(e.contains("has `open` guards"), "{e}");
    let own = fx.guard_file("codex-shim.mjs");
    let e = guards::copy_codex(&lock, &home, node, &shim, &[guards::BareCodexGuard { event: "Stop".into(), matcher: None, run: vec![own], open: Vec::new() }]).unwrap_err();
    assert!(e.contains("Vidar adds its own shim"), "{e}");
}

#[test]
fn a_codex_hook_line_calls_node_with_quoted_paths_and_keeps_the_exit_code() {
    let line = guards::codex_command(Path::new(r"C:\Program Files\nodejs\node.exe"), &[r"C:\h\it's.mjs".into(), "--guard".into(), r"C:\h\$x.mjs".into()]);
    assert_eq!(line, r"& 'C:\Program Files\nodejs\node.exe' 'C:\h\it''s.mjs' --guard 'C:\h\$x.mjs'; exit $LASTEXITCODE");
}

/// Pin probe (`node tools/bare/probe-pin.mjs` runs it): one real Raw Bare Claude turn through the real
/// `prepare`, in a temp cwd holding a canary CLAUDE.md, then the launch manifest with the final env names.
/// Writes into the real Bare home (manifest, transcript); needs VIDAR_PROBE_PROMPT. Never run by default.
#[test]
#[ignore]
fn probe_pin_runs_one_real_raw_bare_turn() {
    let prompt = std::env::var("VIDAR_PROBE_PROMPT").expect("VIDAR_PROBE_PROMPT");
    for e in std::fs::read_dir(std::env::temp_dir()).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with("vidar-pin-probe-") && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    let cwd = std::env::temp_dir().join(format!("vidar-pin-probe-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(cwd.join("CLAUDE.md"), "Canary: this file must not load in a Bare session.\n").unwrap();

    let opts = LaunchOpts { row_key: None, config: None, claude_json: None };
    let mut launch = prepare("bare", &opts).expect("prepare");
    // The Raw tab adds these on top of the built env (pty.rs); the probe adds the same names.
    let mut env: Vec<(OsString, OsString)> = launch.env.iter().map(|(k, v)| (k.to_os_string(), v.to_os_string())).collect();
    let root = crate::paths::root().to_string_lossy().into_owned();
    for (k, v) in [("TERM", "xterm-256color"), ("COLORTERM", "truecolor"), ("VIDAR_TAB", "pin-probe"), ("VIDAR_ROOT", root.as_str()), ("VIDAR_CTL_TOKEN", "pin-probe")] {
        env.retain(|(n, _)| !n.to_string_lossy().eq_ignore_ascii_case(k));
        env.push((k.into(), v.into()));
    }
    let names: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
    launch.write_manifest("pin-probe", names.iter().map(String::as_str)).expect("manifest");

    // Raw's host line, with -p appended; --remote-control is dropped (a one-shot print run).
    let mut args = launch.args.clone();
    let line = args.pop().unwrap().replace(" '--remote-control'", "");
    args.push(format!("{line} -p {}", ps_quote(&prompt)));
    let out = std::env::temp_dir().join(format!("vidar-pin-probe-{}.out", std::process::id()));
    let file = std::fs::File::create(&out).unwrap();
    let mut cmd = std::process::Command::new(&launch.program);
    cmd.args(&args)
        .current_dir(&cwd)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(file.try_clone().unwrap())
        .stderr(file);
    let mut child = cmd.spawn().expect("spawn host");
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if start.elapsed() > Duration::from_secs(120) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("probe timed out after 120 s");
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    let reply = std::fs::read_to_string(&out).unwrap_or_default();
    let _ = std::fs::remove_file(&out);
    println!("probe reply ({status}): {}", reply.trim());
    // The cwd stays: verify-pin's loads check reads its CLAUDE.md. The next probe clears it.
    assert!(status.success(), "claude -p exited {status}");
}

// ---- Claude plugin per rune set (run 2026-10-20-rune-sets, W2) ----

impl RowFx {
    /// A rule every set slots (so the payload builds), and `sets` rows' sidecars plus the key's config.
    fn plugin_row(&self, sets: &[&str], sidecars: &[(&str, serde_json::Value)], bare_guards: serde_json::Value) {
        self.rune("rules", "plain-x", "Plain text.\n");
        for s in sets {
            self.rune("sets", s, "<?rune plain-x?>\n");
        }
        for (set, v) in sidecars {
            std::fs::write(self.lib.join("sets").join(format!("{set}.layer.json")), v.to_string()).unwrap();
        }
        let refs: Vec<_> = sets.iter().map(|s| serde_json::json!({ "set": s })).collect();
        let cfg = serde_json::json!({ "rulesLibrary": self.lib.to_string_lossy(), "agents": [{ "key": "k", "sets": refs }], "bareGuards": bare_guards });
        std::fs::write(&self.config, cfg.to_string()).unwrap();
    }
    fn plugin_skill(&self, name: &str, body: &str) -> String {
        let d = self.t.0.join("skills").join(name);
        std::fs::create_dir_all(d.join("refs")).unwrap();
        std::fs::write(d.join("SKILL.md"), body).unwrap();
        std::fs::write(d.join("refs").join("note.md"), "note\n").unwrap();
        d.to_string_lossy().into_owned()
    }
}

fn built_plugins(fx: &RowFx, home: &Path, sets: &[&str]) -> set_plugin::SetPlugins {
    let row = layer::RowSets { sets: sets.iter().map(|s| layer::SetRef { library: None, set: s.to_string() }).collect(), rules_library: Some(fx.lib.to_string_lossy().into_owned()) };
    std::fs::create_dir_all(home).unwrap();
    let lock = home::lock(home, home::LOCK_WAIT).unwrap();
    set_plugin::build(&lock, &fx.t.0, home, Some(&row), None)
}

#[test]
fn a_set_plugin_holds_name_skills_agents_and_a_guard_wired_through_the_plugin_root() {
    let fx = RowFx::new("plugin-layout");
    let skill = fx.plugin_skill("tidy", "---\nname: tidy\n---\nTidy.\n");
    let agent = fx.script("agents", "helper.md", "---\nname: helper\n---\nHelp.\n");
    let guard = fx.script("hooks", "guard-x.mjs", "// guard x\n");
    fx.plugin_row(&["alpha"], &[("alpha", serde_json::json!({ "skills": [skill], "agents": [agent], "guards": [{ "event": "PreToolUse", "matcher": "Bash", "run": [guard] }] }))], serde_json::json!([]));
    let home = fx.home("layout");
    let b = built_plugins(&fx, &home, &["alpha"]);
    assert!(b.warnings.is_empty(), "{:?}", b.warnings);
    assert_eq!(b.plugins.len(), 1);
    let dir = &b.plugins[0].dir;
    assert!(dir.starts_with(home.join("layer").join("plugins")));
    let n = dir.file_name().unwrap().to_string_lossy().into_owned();
    assert!(n.starts_with("alpha-") && n.len() == "alpha-".len() + 12, "{n}");
    let pj: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".claude-plugin").join("plugin.json")).unwrap()).unwrap();
    assert_eq!(pj["name"], "alpha");
    assert!(dir.join("skills").join("tidy").join("SKILL.md").is_file());
    assert!(dir.join("skills").join("tidy").join("refs").join("note.md").is_file());
    assert!(dir.join("agents").join("helper.md").is_file());
    assert_eq!(std::fs::read_to_string(dir.join("scripts").join("guard-x.mjs")).unwrap(), "// guard x\n");
    let h: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("hooks").join("hooks.json")).unwrap()).unwrap();
    let group = &h["hooks"]["PreToolUse"][0];
    assert_eq!(group["matcher"], "Bash");
    assert_eq!(group["hooks"][0]["type"], "command");
    assert_eq!(group["hooks"][0]["command"], "node \"${CLAUDE_PLUGIN_ROOT}/scripts/guard-x.mjs\"");
    assert_eq!(b.guard_files, vec!["guard-x.mjs".to_string()]);
}

#[test]
fn identical_set_inputs_name_the_same_plugin_and_are_not_rewritten() {
    let fx = RowFx::new("plugin-hash");
    let skill = fx.plugin_skill("tidy", "v1\n");
    fx.plugin_row(&["alpha"], &[("alpha", serde_json::json!({ "skills": [skill] }))], serde_json::json!([]));
    let home = fx.home("hash");
    let first = built_plugins(&fx, &home, &["alpha"]);
    assert!(first.plugins[0].created);
    let marker = first.plugins[0].dir.join("kept.txt");
    std::fs::write(&marker, "x").unwrap();
    let again = built_plugins(&fx, &home, &["alpha"]);
    assert_eq!(again.plugins[0].dir, first.plugins[0].dir);
    assert!(!again.plugins[0].created && marker.is_file(), "same inputs: the folder is left as it is");
    std::fs::write(Path::new(&skill).join("SKILL.md"), "v2\n").unwrap();
    let changed = built_plugins(&fx, &home, &["alpha"]);
    assert_ne!(changed.plugins[0].dir, first.plugins[0].dir);
    assert!(first.plugins[0].dir.is_dir(), "the old folder is never pruned");
    assert!(std::fs::read_dir(home.join("layer").join("plugins")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with(".stage")));
}

#[test]
fn the_raw_launch_passes_one_plugin_dir_per_non_empty_set_and_set_guards_are_carried() {
    let fx = RowFx::new("plugin-raw");
    let skill = fx.plugin_skill("tidy", "T\n");
    let agent = fx.script("agents", "helper.md", "H\n");
    let guard = fx.script("hooks", "guard-x.mjs", "// guard x\n");
    fx.rune("rules", "hook-x", "Hook claim text.\n");
    // The claim: rewrite hook-x with enforced-by after the fixture writes the plain rule.
    fx.plugin_row(
        &["alpha", "beta", "gamma"],
        &[
            ("alpha", serde_json::json!({ "skills": [skill, "relative\\bad"] })),
            ("beta", serde_json::json!({ "agents": [agent], "guards": [{ "event": "PreToolUse", "run": [guard] }] })),
        ],
        serde_json::json!([]),
    );
    std::fs::write(fx.lib.join("rules").join("hook-x.md"), "---\nname: hook-x\nkind: rule\nscope: [global]\nactivate: always\nenforced-by: [guard-x.mjs]\n---\nHook claim text.\n").unwrap();
    std::fs::write(fx.lib.join("sets").join("beta.md"), "---\nname: beta\nkind: set\nscope: [global]\n---\n<?rune plain-x?>\n\n<?rune hook-x?>\n").unwrap();
    let home = fx.home("raw");
    let l = fx.raw(&home, "k").unwrap();
    let line = l.args.last().unwrap();
    assert_eq!(line.matches("--plugin-dir").count(), 3, "vidar-app plus alpha and beta, not the empty gamma: {line}");
    assert!(line.contains("layer\\plugins\\alpha-") && line.contains("layer\\plugins\\beta-") && !line.contains("gamma-"), "{line}");
    assert!(line.contains("relative") && line.contains("Vidar Bare"), "a bad path warns on the spawn line: {line}");
    let text = String::from_utf8(std::fs::read(&l.manifest.payload.path).unwrap()).unwrap();
    assert!(text.contains("Hook claim text."), "a set guard carries the enforced-by claim: {text}");
    assert!(l.manifest.plugins.iter().any(|p| p.starts_with("beta-")), "{:?}", l.manifest.plugins);
}

#[test]
fn the_hosted_launch_carries_one_plugin_dir_per_non_empty_set_and_set_guards_are_carried() {
    let fx = RowFx::new("plugin-hosted");
    let skill = fx.plugin_skill("tidy", "T\n");
    let agent = fx.script("agents", "helper.md", "H\n");
    let guard = fx.script("hooks", "guard-x.mjs", "// guard x\n");
    fx.rune("rules", "hook-x", "Hook claim text.\n");
    fx.plugin_row(
        &["alpha", "beta", "gamma"],
        &[
            ("alpha", serde_json::json!({ "skills": [skill, "relative\\bad"] })),
            ("beta", serde_json::json!({ "agents": [agent], "guards": [{ "event": "PreToolUse", "run": [guard] }] })),
        ],
        serde_json::json!([]),
    );
    std::fs::write(fx.lib.join("rules").join("hook-x.md"), "---\nname: hook-x\nkind: rule\nscope: [global]\nactivate: always\nenforced-by: [guard-x.mjs]\n---\nHook claim text.\n").unwrap();
    std::fs::write(fx.lib.join("sets").join("beta.md"), "---\nname: beta\nkind: set\nscope: [global]\n---\n<?rune plain-x?>\n\n<?rune hook-x?>\n").unwrap();
    let home = fx.home("hosted");
    let l = fx.hosted(&home, "k").unwrap();
    let plugins = home.join("layer").join("plugins");
    let names: Vec<String> = l.set_plugin_dirs.iter().map(|d| d.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(names.len(), 2, "alpha and beta, not the empty gamma: {names:?}");
    assert!(names[0].starts_with("alpha-") && names[1].starts_with("beta-"), "ref order: {names:?}");
    assert!(l.set_plugin_dirs.iter().all(|d| d.parent() == Some(plugins.as_path()) && d.join(".claude-plugin").join("plugin.json").is_file()));
    assert!(l.bare_warnings().iter().any(|w| w.contains("relative")), "a bad path warns on the hosted tab: {:?}", l.bare_warnings());
    let text = String::from_utf8(std::fs::read(l.payload_file.as_ref().unwrap()).unwrap()).unwrap();
    assert!(text.contains("Hook claim text."), "a set guard carries the enforced-by claim: {text}");
    assert_eq!(l.manifest.plugins[..2], ["vidar-app".to_string(), "gate".to_string()], "the rendered plugins first: {:?}", l.manifest.plugins);
    assert!(l.manifest.plugins[2..] == names[..], "{:?}", l.manifest.plugins);
}