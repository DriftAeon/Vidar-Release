//! src-tauri\src\bare\env.rs — the bare spawn env, BUILT from the allowlist in
//! `contracts/agent-env.json` plus the `=X:` drive entries, never Vidar's env minus a list.
//! Names match case-insensitively (Windows env semantics); the first spelling seen is kept.
//! The contract's `drop` list is never applied here: it is what the tests assert cannot survive.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct Contract {
    pub allow: Vec<String>,
    #[serde(rename = "driveEntries")]
    pub drive_entries: bool,
    /// Asserted by the tests, never applied (the env is built, not subtracted).
    #[cfg_attr(not(test), allow(dead_code))]
    pub drop: Vec<String>,
}

pub(crate) fn contract() -> &'static Contract {
    static C: OnceLock<Contract> = OnceLock::new();
    C.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/agent-env.json"))
            .expect("contracts/agent-env.json is valid")
    })
}

/// A spawn env keyed case-insensitively, in a stable (sorted) order.
#[derive(Default, Clone, Debug)]
pub struct Env {
    map: BTreeMap<String, (OsString, OsString)>,
}

fn key(name: &OsStr) -> String {
    name.to_string_lossy().to_lowercase()
}

impl Env {
    /// Sets or replaces `name`; a replacement keeps the earlier spelling of the name.
    pub fn set(&mut self, name: impl AsRef<OsStr>, value: impl Into<OsString>) {
        let name = name.as_ref();
        let value = value.into();
        self.map
            .entry(key(name))
            .and_modify(|e| e.1 = value.clone())
            .or_insert_with(|| (name.to_os_string(), value));
    }

    pub fn get(&self, name: &str) -> Option<&OsStr> {
        self.map.get(&key(OsStr::new(name))).map(|(_, v)| v.as_os_str())
    }

    pub fn contains(&self, name: &str) -> bool {
        self.map.contains_key(&key(OsStr::new(name)))
    }

    pub fn iter(&self) -> impl Iterator<Item = (&OsStr, &OsStr)> {
        self.map.values().map(|(k, v)| (k.as_os_str(), v.as_os_str()))
    }

    #[cfg(test)]
    pub fn names(&self) -> Vec<String> {
        self.map.values().map(|(k, _)| k.to_string_lossy().into_owned()).collect()
    }
}

/// `=C:`-style per-drive cwd entries: kept (Design 2), since cmd and some runtimes read them.
pub fn is_drive_entry(name: &OsStr) -> bool {
    let b = name.as_encoded_bytes();
    b.len() == 3 && b[0] == b'=' && b[1].is_ascii_alphabetic() && b[2] == b':'
}

/// The allowlisted part of `inherited` (normally `std::env::vars_os()`).
pub fn allowlisted(inherited: impl IntoIterator<Item = (OsString, OsString)>) -> Env {
    let c = contract();
    let allow: Vec<String> = c.allow.iter().map(|n| n.to_lowercase()).collect();
    let mut env = Env::default();
    for (name, value) in inherited {
        let keep = allow.contains(&key(&name)) || (c.drive_entries && is_drive_entry(&name));
        if keep && !env.contains(&name.to_string_lossy()) {
            env.set(&name, value);
        }
    }
    env
}

/// The bare Codex env: the allowlist plus the Codex profile's overlay (`profiles/bare/codex.json`,
/// placeholders already filled), `HOMEDRIVE`/`HOMEPATH` from its `USERPROFILE`. Nothing named
/// `CODEX_*` survives from `inherited` (none is allowlisted; the drop list asserts it), and the
/// overlay must set an absolute `CODEX_HOME`: Codex on Windows reportedly ignores `USERPROFILE`
/// (peers #25184, inferred), so only an explicit home keeps it off `~\.codex`. The tab variables
/// (`VIDAR_TAB`, `VIDAR_TAB_NAME`, `VIDAR_CTL_TOKEN`) are added by the spawn (agent.rs).
pub fn codex(inherited: impl IntoIterator<Item = (OsString, OsString)>, overlay: &BTreeMap<String, String>) -> Result<Env, String> {
    let home = overlay.get("CODEX_HOME").map(String::as_str).unwrap_or_default();
    if split_home(home).is_none() {
        return Err(format!("Bare Codex profile sets no absolute CODEX_HOME ({home:?}); spawn refused"));
    }
    let inherited: Vec<(OsString, OsString)> = inherited.into_iter().collect();
    let mut env = allowlisted(inherited.iter().cloned());
    for (k, v) in overlay {
        if v.contains(LOCALAPPDATA_PLACEHOLDER) {
            let real = real_local_app_data(&inherited, home)?;
            env.set(k, v.replace(LOCALAPPDATA_PLACEHOLDER, &real));
        } else {
            env.set(k, v);
        }
    }
    if let Some((drive, path)) = overlay.get("USERPROFILE").and_then(|p| split_home(p)) {
        env.set("HOMEDRIVE", drive);
        env.set("HOMEPATH", path);
    }
    Ok(env)
}

/// The overlay placeholder for the spawning process's own `LOCALAPPDATA`. A Bare Codex shell's
/// TEMP is built from the Codex process's LOCALAPPDATA; a redirected, never-created folder there
/// leaves pwsh in ConstrainedLanguage with unwritable temp.
/// Filled in `codex`, so every spawn path (Vidar's and Falcon's, via the mounted module) shares it.
pub const LOCALAPPDATA_PLACEHOLDER: &str = "{{localappdata}}";

/// The real `LOCALAPPDATA` from `inherited`: refused when unset, relative, or inside the Bare home
/// (the parent of `codex_home`; a Vidar running in a redirected Bare tab would pass that one on).
fn real_local_app_data(inherited: &[(OsString, OsString)], codex_home: &str) -> Result<String, String> {
    let value = inherited
        .iter()
        .find(|(k, _)| key(k) == "localappdata")
        .map(|(_, v)| std::path::PathBuf::from(v))
        .filter(|p| p.is_absolute())
        .ok_or("LOCALAPPDATA is unset or not absolute; the Bare Codex shell's temp cannot be placed; spawn refused")?;
    let lower = |p: &std::path::Path| -> Vec<String> { p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect() };
    let bare_home = std::path::Path::new(codex_home).parent().map(lower).unwrap_or_default();
    let got = lower(&value);
    if !bare_home.is_empty() && got.len() >= bare_home.len() && got[..bare_home.len()] == bare_home[..] {
        return Err(format!("LOCALAPPDATA {} is inside the Bare home; spawn refused", value.display()));
    }
    Ok(value.to_string_lossy().into_owned())
}

/// A `Path` folder with a `WindowsApps` component: the per-user app-alias folder
/// (`%LOCALAPPDATA%\Microsoft\WindowsApps`) or an MSIX package folder under
/// `C:\Program Files\WindowsApps` (pwsh's `$PSHOME` when PowerShell is the Store install).
pub fn is_app_alias_dir(dir: &std::path::Path) -> bool {
    dir.components().any(|c| c.as_os_str().eq_ignore_ascii_case("WindowsApps"))
}

/// Drops every `WindowsApps` folder from the env's `Path` (the name's spelling is kept). Codex picks
/// its shell by a `Path` lookup of `pwsh` before `powershell`; the Store pwsh there is an app alias
/// (and an ACL-locked package binary) that its Windows sandbox token cannot start (CreateProcessAsUserW
/// error 5 / 0xC0070005, observed 2026-10-14), so without them it uses an unpackaged pwsh 7 (MSI or zip)
/// still on `Path`, else falls back to `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, which
/// it can start. `prepare_codex_in` looks pwsh up again after this drop and warns when only 5.1 is left.
pub fn drop_app_alias_dirs(env: &mut Env) {
    let Some(path) = env.get("Path") else { return };
    let kept: Vec<std::path::PathBuf> = std::env::split_paths(path).filter(|d| !is_app_alias_dir(d)).collect();
    if let Ok(joined) = std::env::join_paths(kept) {
        env.set("Path", joined);
    }
}

/// Does the contract's drop list name `name` (a trailing `*` is a prefix)?
#[cfg(test)]
pub fn in_drop_list(name: &str) -> bool {
    let n = name.to_lowercase();
    contract().drop.iter().any(|d| {
        let d = d.to_lowercase();
        match d.strip_suffix('*') {
            Some(prefix) => n.starts_with(prefix),
            None => n == d,
        }
    })
}

/// `HOMEDRIVE`/`HOMEPATH` from an absolute drive path: `X:\a\b` -> (`X:`, `\a\b`).
pub fn split_home(path: &str) -> Option<(String, String)> {
    let b = path.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        Some((path[..2].to_string(), path[2..].replace('/', "\\")))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    #[test]
    fn every_drop_list_name_is_dropped_when_inherited() {
        let mut inherited = os(&[("Path", r"C:\Windows"), ("SystemRoot", r"C:\Windows")]);
        for d in &contract().drop {
            let name = d.replace('*', "SESSION_ID");
            inherited.push((name.clone().into(), "inherited".into()));
            inherited.push((name.to_lowercase().into(), "inherited".into()));
        }
        let env = allowlisted(inherited);
        for d in &contract().drop {
            let name = d.replace('*', "SESSION_ID");
            assert!(!env.contains(&name), "{name} survived the allowlist");
        }
        assert!(env.contains("PATH") && env.contains("systemroot"));
    }

    #[test]
    fn named_overrides_and_codex_markers_are_dropped() {
        // Design 2 plus the peers' two credential vars (NOTES 18:26) and Vidar's own inherited ones.
        let named = [
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_SIMPLE",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_CUSTOM_HEADERS",
            "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_CI", "CODEX_SANDBOX_NETWORK_DISABLED",
        ];
        let env = allowlisted(named.iter().map(|n| (OsString::from(n), OsString::from("x"))));
        assert_eq!(env.names(), Vec::<String>::new());
        for n in named {
            assert!(in_drop_list(n), "{n} missing from contracts/agent-env.json drop");
        }
    }

    #[test]
    fn drive_entries_and_case_insensitive_names_are_kept() {
        let env = allowlisted(os(&[
            ("=C:", r"C:\Work"),
            ("=D:", r"D:\x"),
            ("=ExitCode", "00000000"),
            ("PATH", r"C:\bin"),
            ("path", r"C:\other"),
            ("WINDIR", r"C:\Windows"),
            ("pathext", ".EXE"),
        ]));
        assert_eq!(env.get("=C:"), Some(OsStr::new(r"C:\Work")));
        assert!(env.contains("=D:"));
        assert!(!env.contains("=ExitCode"), "only =X: drive entries are kept");
        assert_eq!(env.get("Path"), Some(OsStr::new(r"C:\bin")), "first spelling wins");
        assert!(env.contains("windir") && env.contains("PATHEXT"));
    }

    #[test]
    fn proxy_and_ca_variables_are_kept_with_their_values() {
        let env = allowlisted(os(&[
            ("HTTPS_PROXY", "http://proxy.invalid:8080"),
            ("http_proxy", "http://proxy.invalid:8080"),
            ("NO_PROXY", "localhost,127.0.0.1"),
            ("NODE_EXTRA_CA_CERTS", r"C:\certs\corp.pem"),
            ("SOME_OTHER", "x"),
        ]));
        assert_eq!(env.get("HTTPS_PROXY"), Some(OsStr::new("http://proxy.invalid:8080")));
        assert_eq!(env.get("HTTP_PROXY"), Some(OsStr::new("http://proxy.invalid:8080")));
        assert_eq!(env.get("NO_PROXY"), Some(OsStr::new("localhost,127.0.0.1")));
        assert_eq!(env.get("NODE_EXTRA_CA_CERTS"), Some(OsStr::new(r"C:\certs\corp.pem")));
        assert!(!env.contains("SOME_OTHER"));
    }

    #[test]
    fn allow_and_drop_never_overlap() {
        for a in &contract().allow {
            assert!(!in_drop_list(a), "{a} is both allowed and dropped");
        }
    }

    fn codex_overlay() -> BTreeMap<String, String> {
        [
            ("USERPROFILE", r"X:\h\user-home"),
            ("HOME", r"X:\h\user-home"),
            ("APPDATA", r"X:\h\user-home\AppData\Roaming"),
            ("TEMP", r"X:\h\user-home\AppData\Local\Temp"),
            ("CODEX_HOME", r"X:\h\codex-home"),
            ("VIDAR_AGENT_HOME", r"X:\h\codex-home"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[test]
    fn the_codex_env_drops_inherited_codex_and_credential_names_and_keeps_the_allowlist() {
        let env = codex(
            os(&[
                ("Path", r"C:\npm;C:\Windows"),
                ("SystemRoot", r"C:\Windows"),
                ("=C:", r"C:\Work"),
                ("USERPROFILE", r"C:\Users\testuser"),
                ("APPDATA", r"C:\Users\testuser\AppData\Roaming"),
                ("CODEX_HOME", r"C:\Users\testuser\.codex"),
                ("codex_ci", "1"),
                ("CODEX_SANDBOX_NETWORK_DISABLED", "1"),
                ("CODEX_THREAD_ID", "t"),
                ("OPENAI_API_KEY", "sk-test"),
                ("OPENAI_BASE_URL", "https://example.invalid"),
                ("ANTHROPIC_API_KEY", "sk-test"),
                ("CLAUDE_CONFIG_DIR", r"C:\Users\testuser\.claude"),
                ("VIDAR_CTL_TOKEN", "stale"),
                ("VIDAR_TAB", "stale"),
            ]),
            &codex_overlay(),
        )
        .unwrap();
        assert_eq!(env.get("CODEX_HOME"), Some(OsStr::new(r"X:\h\codex-home")), "the overlay's home, never the inherited one");
        assert_eq!(env.get("VIDAR_AGENT_HOME"), Some(OsStr::new(r"X:\h\codex-home")));
        assert_eq!(env.get("USERPROFILE"), Some(OsStr::new(r"X:\h\user-home")));
        assert_eq!(env.get("APPDATA"), Some(OsStr::new(r"X:\h\user-home\AppData\Roaming")));
        assert_eq!(env.get("HOMEDRIVE"), Some(OsStr::new("X:")));
        assert_eq!(env.get("HOMEPATH"), Some(OsStr::new(r"\h\user-home")));
        assert!(env.contains("Path") && env.contains("SystemRoot") && env.contains("=C:"));
        for gone in [
            "CODEX_CI", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "OPENAI_API_KEY", "OPENAI_BASE_URL",
            "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "VIDAR_CTL_TOKEN", "VIDAR_TAB",
        ] {
            assert!(!env.contains(gone), "{gone} inherited into a bare Codex env");
        }
        let codex_names: Vec<String> = env.names().into_iter().filter(|n| n.to_uppercase().starts_with("CODEX_")).collect();
        assert_eq!(codex_names, vec!["CODEX_HOME".to_string()]);
    }

    #[test]
    fn a_codex_overlay_without_an_absolute_home_refuses() {
        let mut o = codex_overlay();
        o.remove("CODEX_HOME");
        assert!(codex(os(&[("Path", r"C:\x")]), &o).unwrap_err().contains("CODEX_HOME"));
        o.insert("CODEX_HOME".into(), r"codex-home".into());
        assert!(codex(os(&[("Path", r"C:\x")]), &o).is_err());
    }

    #[test]
    fn the_localappdata_placeholder_is_the_real_one_and_refuses_unset_relative_or_inside_the_home() {
        let mut o = codex_overlay();
        o.insert("LOCALAPPDATA".into(), LOCALAPPDATA_PLACEHOLDER.into());
        let env = codex(os(&[("Path", r"C:\x"), ("LocalAppData", r"C:\Users\u\AppData\Local")]), &o).unwrap();
        assert_eq!(env.get("LOCALAPPDATA"), Some(OsStr::new(r"C:\Users\u\AppData\Local")));
        assert_eq!(env.get("TEMP"), Some(OsStr::new(r"X:\h\user-home\AppData\Local\Temp")), "TEMP stays in the home");
        for bad in [None, Some("AppData\\Local"), Some(r"X:\h\user-home\AppData\Local"), Some(r"x:\H\user-home")] {
            let mut inh = vec![("Path", r"C:\x")];
            if let Some(b) = bad {
                inh.push(("LOCALAPPDATA", b));
            }
            let e = codex(os(&inh), &o).unwrap_err();
            assert!(e.contains("LOCALAPPDATA") && e.contains("spawn refused"), "{bad:?}: {e}");
        }
    }

    #[test]
    fn app_alias_folders_leave_the_path_and_the_rest_keeps_its_order() {
        let mut env = allowlisted(os(&[(
            "PATH",
            r"C:\Program Files\nodejs;C:\Users\testuser\AppData\Local\Microsoft\WindowsApps;C:\Windows\System32\WindowsPowerShell\v1.0\;C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe;c:\users\testuser\appdata\local\microsoft\WINDOWSAPPS\;C:\WindowsAppsX;C:\npm",
        )]));
        drop_app_alias_dirs(&mut env);
        assert_eq!(
            env.get("Path"),
            Some(OsStr::new(r"C:\Program Files\nodejs;C:\Windows\System32\WindowsPowerShell\v1.0\;C:\WindowsAppsX;C:\npm"))
        );
        assert_eq!(env.names(), vec!["PATH".to_string()], "the inherited spelling is kept");
        let mut none = Env::default();
        drop_app_alias_dirs(&mut none);
        assert!(!none.contains("Path"), "no Path, nothing added");
    }

    #[test]
    fn home_splits_into_drive_and_path() {
        assert_eq!(split_home(r"X:\h\user-home"), Some(("X:".into(), r"\h\user-home".into())));
        assert_eq!(split_home(r"\\srv\share"), None);
    }

    /// Telemetry off in every Claude Bare row: the shipped profile's env builder (Raw spawn and
    /// login) carries `DISABLE_TELEMETRY=1`, and the hosted Rendered row, which Falcon builds from
    /// the same `overlay` plus `rendered.overlay`, cannot override it there. Vidar-only: Falcon
    /// mounts this file without `crate::bare`.
    #[cfg(not(falcon_shell))]
    #[test]
    fn every_claude_bare_row_sets_disable_telemetry() {
        let root = crate::paths::root();
        for id in crate::bare::PROFILES {
            let p = crate::bare::load_profile(&root, id).unwrap();
            let env = crate::bare::profile_env(&p, &root, std::path::Path::new(r"X:\homes\k"), os(&[("NO_COLOR", "1")]));
            assert_eq!(env.get("DISABLE_TELEMETRY").map(|v| v.to_string_lossy().into_owned()).as_deref(), Some("1"), "{id}");
            assert!(!env.contains("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"), "{id}: would also stop the feature-flag fetch");
            let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("profiles").join(id).join("claude.json")).unwrap()).unwrap();
            if let Some(o) = raw["rendered"]["overlay"].as_object() {
                assert!(!o.keys().any(|k| k.eq_ignore_ascii_case("DISABLE_TELEMETRY")), "{id}: rendered.overlay overrides DISABLE_TELEMETRY");
            }
        }
    }

    /// Codex Bare: `[analytics] enabled = false` in the shipped template (Codex 0.163 types the key
    /// as a boolean; a non-boolean fails its config load).
    #[cfg(not(falcon_shell))]
    #[test]
    fn the_codex_template_turns_analytics_off() {
        let path = crate::paths::root().join("profiles").join("bare").join("codex.config.template.toml");
        let doc = crate::bare::home::parse_toml_lite(&std::fs::read_to_string(path).unwrap()).unwrap();
        let v = doc.iter().find(|(k, _)| k == "analytics.enabled").map(|(_, v)| v);
        assert_eq!(v, Some(&crate::bare::home::Toml::Bool(false)));
    }
}
