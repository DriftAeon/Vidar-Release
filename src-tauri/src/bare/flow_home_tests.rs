//! Flow's own Codex home (W2-L2d): the spec names `flow-codex`, its config.toml holds the baseline
//! only, a second prepare rewrites nothing, and the legacy home is never touched.

use super::*;
use std::time::SystemTime;

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-flow-home-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        // Long form: the user-trust check canonicalizes, and a short (8.3) %TEMP% would differ in text.
        TempDir(PathBuf::from(std::fs::canonicalize(&p).unwrap().to_string_lossy().trim_start_matches(r"\\?\")))
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
        ("Path", r"C:\Windows\system32;C:\Users\testuser\AppData\Local\Microsoft\WindowsApps;C:\Tools"),
        ("SystemRoot", r"C:\Windows"),
        ("USERNAME", "testuser"),
        ("LOCALAPPDATA", r"C:\Users\testuser\AppData\Local"),
        ("ANTHROPIC_API_KEY", "sk-test"),
        ("CODEX_HOME", r"C:\inherited\codex"),
    ]
    .into_iter()
    .map(|(k, v)| (OsString::from(k), OsString::from(v)))
    .collect()
}

fn find(_: &crate::bare::Env, name: &str) -> Option<PathBuf> {
    Some(PathBuf::from(r"X:\bin").join(name))
}

fn codex(_: &crate::bare::Env, _: &crate::bare::CodexBinary) -> Option<(PathBuf, Option<String>)> {
    Some((PathBuf::from(r"X:\npm\node_modules\@openai\codex\bin\codex.js"), None))
}

/// Every file under `dir` with its bytes and modified time.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>, SystemTime)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push((p.clone(), std::fs::read(&p).unwrap(), std::fs::metadata(&p).unwrap().modified().unwrap()));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn a_missing_bare_home_fails_before_anything_is_written() {
    let t = TempDir::new("nohome");
    let home = t.0.join("agent-home");
    let probes = CodexProbes { find: &find, codex: &codex };
    let e = prepare("bare", &crate::paths::root(), &home, inherited(), &Ambient::default(), &guard(), &probes, None).err().unwrap();
    assert_eq!(e, "Open a Bare tab once to create its home");
    assert!(!home.exists(), "a missing home was created");
    assert!(prepare("lean", &crate::paths::root(), &home, inherited(), &Ambient::default(), &guard(), &probes, None).is_err());
}

#[test]
fn flow_gets_its_own_baseline_home_beside_the_legacy_one() {
    let t = TempDir::new("baseline");
    let root = crate::paths::root();
    // A per-install home inside a `…\Vidar\homes` folder, so the shared Codex login links.
    let home = t.0.join("lad").join("Vidar").join("homes").join("k1");
    let legacy = home.join("codex-home");
    home::prepare_dirs(&home, &["codex-home".into(), "logs".into()]).unwrap();
    std::fs::write(legacy.join("auth.json"), "{\"login\":1}").unwrap();
    {
        let lock = home::lock(&home, home::LOCK_WAIT).unwrap();
        login_link::sync_codex(&home, &legacy, &["codex-home".into(), "logs".into()], &lock).unwrap();
    }
    // The legacy home's loadout, which must never reach Flow (gap 10).
    std::fs::write(legacy.join("config.toml"), "[mcp_servers.kit]\nurl = \"https://kit.example\"\n").unwrap();
    std::fs::write(legacy.join("hooks.json"), "{}").unwrap();
    std::fs::create_dir_all(legacy.join("skills").join("kit-skill")).unwrap();
    std::fs::write(legacy.join("skills").join("kit-skill").join("SKILL.md"), "kit").unwrap();
    let before = snapshot(&legacy);

    let work = t.0.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let user_config = t.0.join("user").join("config.toml");
    std::fs::create_dir_all(user_config.parent().unwrap()).unwrap();
    std::fs::write(&user_config, format!("[projects.'{}']\ntrust_level = \"trusted\"\n", work.to_string_lossy())).unwrap();
    let ambient = Ambient { user_home: None, codex_config: Some(user_config) };
    let probes = CodexProbes { find: &find, codex: &codex };
    let cwd = work.to_string_lossy().into_owned();

    let got = prepare("bare", &root, &home, inherited(), &ambient, &guard(), &probes, Some(&cwd)).unwrap();
    let flow = home.join(DIR);
    assert_eq!(got.codex_home, flow);
    for k in ["CODEX_HOME", "VIDAR_AGENT_HOME"] {
        assert_eq!(got.env.get(k).map(|v| PathBuf::from(v.to_os_string())), Some(flow.clone()), "{k}");
    }
    let path = got.env.get("Path").unwrap().to_string_lossy().into_owned();
    assert!(!path.contains("WindowsApps"), "{path}");
    assert!(!got.env.contains("ANTHROPIC_API_KEY"));
    assert_eq!(got.node, PathBuf::from(r"X:\bin\node.exe"));

    // The baseline: vidar_drive, the template's sandbox pins and the cwd's trust; nothing of a set's.
    let text = std::fs::read_to_string(flow.join("config.toml")).unwrap();
    assert!(text.contains("[mcp_servers.vidar_drive]"), "{text}");
    assert!(!text.contains("kit"), "{text}");
    assert_eq!(text.matches("[mcp_servers.").count(), 1, "{text}");
    let key = home::trusted_project_key(&cwd).unwrap();
    assert!(text.contains(&home::trusted_project_table(&key)), "{text}");
    assert!(!text.contains("hooks.state"), "{text}");
    for pin in ["sandbox_mode = \"workspace-write\"", "sandbox = \"unelevated\"", "prefer_mxc = true", "cli_auth_credentials_store = \"file\""] {
        assert!(text.contains(pin), "{pin} missing:\n{text}");
    }
    assert!(flow.join("auth.json").is_file(), "the shared login was not linked");
    for gone in ["skills", "hooks.json", "agents", "rules"] {
        assert!(!flow.join(gone).exists(), "{gone} reached the Flow home");
    }

    // A second prepare rewrites nothing that is unchanged; the legacy home is untouched throughout.
    let first = snapshot(&flow);
    prepare("bare", &root, &home, inherited(), &ambient, &guard(), &probes, Some(&cwd)).unwrap();
    assert_eq!(snapshot(&flow), first, "a second prepare rewrote the Flow home");
    assert_eq!(snapshot(&legacy), before, "a Flow prepare touched the legacy home");

    // An untrusted folder gets no trust table.
    let other = t.0.join("other");
    std::fs::create_dir_all(&other).unwrap();
    let other = other.to_string_lossy().into_owned();
    prepare("bare", &root, &home, inherited(), &ambient, &guard(), &probes, Some(&other)).unwrap();
    let text = std::fs::read_to_string(flow.join("config.toml")).unwrap();
    assert!(!text.contains(&home::trusted_project_table(&home::trusted_project_key(&other).unwrap())), "{text}");
    assert!(!text.contains(&home::trusted_project_table(&key)), "{text}");
}

#[test]
fn no_shared_login_refuses_after_the_home_is_prepared() {
    let t = TempDir::new("nologin");
    // Outside a `…\Vidar\homes` folder nothing is shared, so the Flow home has no login.
    let home = t.0.join("agent-home");
    home::prepare_dirs(&home, &["codex-home".into()]).unwrap();
    std::fs::write(home.join("codex-home").join("auth.json"), "{}").unwrap();
    let probes = CodexProbes { find: &find, codex: &codex };
    let e = prepare("bare", &crate::paths::root(), &home, inherited(), &Ambient::default(), &guard(), &probes, None).err().unwrap();
    assert_eq!(e, "Sign in from a Bare tab");
    assert!(home.join(DIR).join("config.toml").is_file());
}
