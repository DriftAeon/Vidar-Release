//! The pinned Codex app-server runtime and its readiness driver.
//!
//! Falcon speaks only enough of app-server here to establish a live thread.
//! Turns, approvals, and policy mutation deliberately remain unavailable until
//! later slices. The child still emits raw JSON to the ordinary session reader,
//! so later work can add semantic handling without changing process ownership.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

use serde::Deserialize;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;

use crate::{
    process::{plain_path, EnvBase, SpawnRequest},
    protocol::{CodexBareSpawn, SpawnParams},
    session::driver_props::sha256_file,
};

mod driver;
pub use driver::CodexDriver;
pub(crate) use driver::HistoryUpdate;

/// Launch profiles a hosted Codex spawn may carry (twin: `claude.rs` `PROFILES`).
pub const PROFILES: &[&str] = &["bare"];

/// The npm native package under the `@openai/codex` wrapper, and its app-server inside it
/// (`tools/release/falcon-build.ps1` pins the same package into the store).
const NATIVE_PACKAGE: &str = r"node_modules\@openai\codex-win32-x64";
const NATIVE_ENTRYPOINT: &str = r"vendor\x86_64-pc-windows-msvc\bin\codex.exe";
/// The installed fallback's defaults when no profile names them (`profiles/bare/codex.json`
/// `binary` carries the same).
const DEFAULT_SHIMS: &[&str] = &["codex.ps1", "codex.cmd"];
const DEFAULT_PACKAGE: &str = "node_modules/@openai/codex/package.json";

/// The Vidar root a profiled spawn reads `profiles\<id>\codex.json` from: this host's own
/// `--registry` folder (`main.rs` sets it once Codex resolves), never a client value.
static VIDAR_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn set_vidar_root(root: &Path) {
    let _ = VIDAR_ROOT.set(root.to_path_buf());
}

#[derive(Debug, Clone)]
pub struct CodexRuntime {
    /// What a plain hosted spawn runs: the pinned store entry, else the installed fallback.
    /// A Bare spawn runs the installed Codex first and this second.
    pub executable: PathBuf,
}

/// A Codex spawn request, plus what a Bare spawn reports back.
#[derive(Debug)]
pub struct CodexSpawn {
    pub request: SpawnRequest,
    pub bare: Option<BareSpawned>,
}

/// A profiled spawn's echoes: the admitted payload (plain canonical path) and the reply block.
#[derive(Debug)]
pub struct BareSpawned {
    pub payload_file: Option<String>,
    /// The admitted payload text: the driver sends it as `developerInstructions` on
    /// `thread/start` and `thread/resume` (never on the argv).
    pub developer_instructions: Option<String>,
    pub spawn: CodexBareSpawn,
}

/// A Codex found installed: the native app-server and the wrapper package's version.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Installed {
    executable: PathBuf,
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RuntimeManifest {
    /// Absent from a bundle built without Codex (schema 4 `runtimes`).
    #[serde(default)]
    codex: Option<CodexManifest>,
}

#[derive(Debug, Deserialize)]
struct CodexManifest {
    store_id: String,
    entrypoint: String,
    files: Vec<CodexFile>,
}

#[derive(Debug, Deserialize)]
struct CodexFile {
    path: String,
    sha256: String,
}

impl CodexRuntime {
    /// The only root a profiled (Bare) Codex spawn reads its profile from: this host's own
    /// `--registry` folder, never a client value.
    pub fn bind_root(&mut self, vidar_root: &Path) {
        set_vidar_root(vidar_root);
    }

    /// The bundle's pinned runtime ([`Self::resolve_pinned`]); when that is missing or fails
    /// its closure check (a release zip ships no store), the user's own installed Codex: the
    /// npm-global native package under `%APPDATA%\npm`, else beside a codex shim on PATH.
    /// Nothing is ever downloaded.
    pub fn resolve(bundle: &Path, store: &Path) -> Result<Self, String> {
        choose_codex(Self::resolve_pinned(bundle, store), || {
            installed_default(
                std::env::var_os("APPDATA").as_deref(),
                std::env::var_os("Path").as_deref(),
            )
        })
    }

    /// Resolve the exact native package declared by this bundle. The runtime
    /// lives in the content-addressed store; neither PATH nor the npm-global
    /// installation participates.
    fn resolve_pinned(bundle: &Path, store: &Path) -> Result<Self, String> {
        let manifest_path = bundle.join("runtime-manifest.json");
        let text = std::fs::read_to_string(&manifest_path)
            .map_err(|error| format!("read {}: {error}", manifest_path.display()))?;
        let manifest: RuntimeManifest = serde_json::from_str(&text).map_err(|error| {
            format!(
                "parse Codex runtime from {}: {error}",
                manifest_path.display()
            )
        })?;
        let pin = manifest
            .codex
            .ok_or("this Falcon bundle has no Codex runtime")?;

        if pin.store_id.len() != 64 || !pin.store_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Codex runtime store id is not a SHA-256 digest".into());
        }
        let root = store.join("codex").join(&pin.store_id);
        let declared = declared_files(&pin.files)?;
        let actual = files_under(&root)?;
        if actual != declared.keys().cloned().collect() {
            return Err(format!(
                "Codex runtime closure at {} differs from its manifest",
                root.display()
            ));
        }
        for (relative, expected) in &declared {
            let path = root.join(relative);
            let actual = sha256_file(&path)?;
            if actual != *expected {
                return Err(format!(
                    "Codex runtime file {} is {actual}, manifest says {expected}",
                    path.display()
                ));
            }
        }

        let entrypoint = safe_relative(&pin.entrypoint)?;
        if !declared.contains_key(&entrypoint) {
            return Err("Codex runtime entrypoint is not part of its declared closure".into());
        }
        let executable = root.join(entrypoint);
        if !executable.is_file() {
            return Err(format!(
                "Codex app-server missing: {}",
                executable.display()
            ));
        }
        Ok(Self {
            executable: crate::process::plain_path(&executable),
        })
    }

    /// The app-server command line for a hosted Codex session. A plain spawn inherits Falcon's
    /// env (minus `SCRUBBED_ENV`); a profiled (`bare`) one runs on the Bare home's allowlisted env
    /// ([`Self::spawn_request_in`]).
    pub fn spawn_request(&self, params: &SpawnParams, session_id: &str) -> Result<CodexSpawn, String> {
        let lad = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        self.spawn_request_in(
            params,
            session_id,
            VIDAR_ROOT.get().map(PathBuf::as_path),
            lad.as_deref(),
            std::env::vars_os().collect(),
        )
    }

    /// `spawn_request` with the Vidar root, the `LOCALAPPDATA` that places the Bare home and the
    /// env the allowlist filters passed in, so tests use fixtures instead of the user's own.
    ///
    /// A Bare spawn: profile `bare` only, never with a rules file or gateway; the profile is
    /// `<root>\profiles\bare\codex.json`, the home Vidar's own placement (`bare_home`), which
    /// Vidar must already have prepared (its `CODEX_HOME\config.toml`). The env is
    /// `bare_env::codex` (allowlist plus the profile overlay, so no inherited `CODEX_*`) with
    /// the WindowsApps folders dropped from Path, then `FALCON_SESSION` and `VIDAR_CTL_SECRET`.
    /// A `payload_file` is admitted only under `<home>\layer\` (`codex_payload`), read once and
    /// passed as `-c developer_instructions=`. The executable is the installed Codex the Bare
    /// Path finds (the one Vidar runs in-process), else this runtime's own.
    fn spawn_request_in(
        &self,
        params: &SpawnParams,
        session_id: &str,
        root: Option<&Path>,
        local_app_data: Option<&Path>,
        inherited: Vec<(OsString, OsString)>,
    ) -> Result<CodexSpawn, String> {
        // Rules reach Codex through Vidar's own app-server argv, never through this host.
        if params.rules_file.is_some() {
            return Err("rules_file is not supported for Codex sessions".into());
        }
        if params.mcp_file.is_some() {
            return Err("mcp_file is not supported for Codex sessions".into());
        }
        let base = || -> Result<SpawnRequest, String> {
            let cwd = plain_path(&PathBuf::from(&params.cwd));
            if !cwd.is_dir() {
                return Err(format!("cwd is not a directory: {}", params.cwd));
            }
            Ok(SpawnRequest {
                program: self.executable.clone(),
                args: vec!["app-server".into(), "--listen".into(), "stdio://".into()],
                cwd,
                env: Vec::new(),
                env_base: EnvBase::Inherit,
            })
        };
        if params.claude_config_dir.is_some() {
            return Err("claude_config_dir is not supported for Codex sessions".into());
        }
        let Some(profile) = params.profile.as_deref() else {
            // A payload replaces a profile's static one: without a profile there is none to replace.
            if params.payload_file.is_some() {
                return Err("a payload file needs a launch profile".into());
            }
            if params.codex_home.is_some() {
                return Err("a Codex home needs a launch profile".into());
            }
            return Ok(CodexSpawn { request: base()?, bare: None });
        };
        if !PROFILES.contains(&profile) {
            return Err(format!("unknown launch profile {profile:?}"));
        }
        if params.gateway.is_some() {
            return Err(format!("a {profile:?} spawn carries no gateway"));
        }
        if let Some(secret) = params.ctl_secret.as_deref() {
            if secret.len() != 32
                || !secret.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("ctl secret is not 32 lowercase hex".into());
            }
        }
        let mut request = base()?;
        let root = root.ok_or("a profiled Codex spawn needs the Vidar root")?;
        let BareHome { home, mut env, shims, package, combo } =
            bare_codex(root, local_app_data, profile, params.codex_home.as_deref(), inherited)?;

        // Admitted and read once before anything runs; no length cap, because it rides the
        // `thread/start` and `thread/resume` params rather than the argv.
        let payload = params
            .payload_file
            .as_deref()
            .map(|raw| crate::codex_payload::admit_and_read(raw, &home))
            .transpose()?;

        // Codex picks its shell by a Path lookup of pwsh; the Store pwsh under WindowsApps is
        // one its sandbox token cannot start (`bare_env::drop_app_alias_dirs`). What this Path
        // finds after the drop is reported: Vidar probed in its own env, the child runs on this.
        crate::bare_env::drop_app_alias_dirs(&mut env);
        let pwsh = find_on_env_path(&env, "pwsh.exe");

        let (executable, source, version) = match installed_on_path(env.get("Path"), &shims, &package) {
            Some(found) => (found.executable, "installed", found.version),
            None => (self.executable.clone(), "bundle", version_near(&self.executable)),
        };
        let executable = plain_path(&executable);

        request.program = executable.clone();
        request.env = env
            .iter()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            .collect();
        // The hosted CLI must not believe it is a Vidar tab; the control tools key on both.
        request.env.push(("FALCON_SESSION".into(), session_id.to_string()));
        if let Some(secret) = params.ctl_secret.as_deref() {
            request.env.push(("VIDAR_CTL_SECRET".into(), secret.to_string()));
        }
        request.env_base = EnvBase::Allowlist;
        Ok(CodexSpawn {
            request,
            bare: Some(BareSpawned {
                payload_file: payload.as_ref().map(|p| plain_path(&p.path).to_string_lossy().into_owned()),
                developer_instructions: payload.map(|p| p.text),
                spawn: CodexBareSpawn {
                    executable: executable.to_string_lossy().into_owned(),
                    source: source.into(),
                    version,
                    pwsh: pwsh.map(|p| p.to_string_lossy().into_owned()),
                    codex_home: combo,
                },
            }),
        })
    }
}

/// What a Bare profile and its home give a spawn.
struct BareHome {
    home: PathBuf,
    env: crate::bare_env::Env,
    shims: Vec<String>,
    package: String,
    /// The admitted set-combination home the spawn asked for, as the child's `CODEX_HOME`.
    combo: Option<String>,
}

/// The Bare home and env from `<root>\profiles\<profile>\codex.json`: the home is Vidar's own
/// placement (`bare_home::resolve_for`), the env `bare_env::codex` over the profile's `overlay`
/// with `{{root}}`/`{{home}}` filled. A `codex_home` (`SpawnParams.codex_home`) is admitted under
/// that home by `codex_payload::admit_codex_home` and replaces the overlay's `CODEX_HOME` and
/// `VIDAR_AGENT_HOME`. Refuses a profile that is not the Codex one, carries a `sharedLogin`, sets
/// `CODEX_HOME` outside the home, or a home Vidar has not prepared (no `CODEX_HOME\config.toml`):
/// Codex would otherwise create the home itself.
fn bare_codex(
    root: &Path,
    local_app_data: Option<&Path>,
    profile: &str,
    codex_home: Option<&str>,
    inherited: Vec<(OsString, OsString)>,
) -> Result<BareHome, String> {
    let lad = local_app_data
        .filter(|p| p.is_absolute())
        .ok_or("LOCALAPPDATA is unset or not absolute; the bare home cannot be placed")?;
    let home = crate::bare_home::resolve_for(root, lad);
    let path = root.join("profiles").join(profile).join("codex.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("launch profile {}: {e}", path.display()))?;
    let doc: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("launch profile {}: {e}", path.display()))?;
    if doc.get("id").and_then(Value::as_str) != Some(profile) || doc.get("agent").and_then(Value::as_str) != Some("codex") {
        return Err(format!("launch profile {} is not the Codex {profile:?} profile", path.display()));
    }
    if doc.get("sharedLogin").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
        return Err(format!("launch profile {profile:?}: a Codex profile takes no sharedLogin entry (auth.json is shared outside the profile); spawn refused"));
    }
    let (root_s, home_s) = (root.to_string_lossy().into_owned(), home.to_string_lossy().into_owned());
    // `{{localappdata}}` is Falcon's own (the same `lad` that placed the home): the Codex process
    // runs on the real LOCALAPPDATA, never the redirected one (T5).
    let lad_s = lad.to_string_lossy().into_owned();
    let fill = |s: &str| s.replace("{{root}}", &root_s).replace("{{home}}", &home_s).replace(crate::bare_env::LOCALAPPDATA_PLACEHOLDER, &lad_s);
    let mut overlay = BTreeMap::new();
    if let Some(map) = doc.get("overlay").and_then(Value::as_object) {
        for (k, v) in map {
            let v = v.as_str().ok_or_else(|| format!("launch profile {profile:?}: overlay {k} is not a string"))?;
            overlay.insert(k.clone(), fill(v));
        }
    }
    let combo = match codex_home {
        Some(raw) => {
            let admitted = crate::codex_payload::admit_codex_home(raw, &home).map_err(|e| format!("{e}; spawn refused"))?;
            let s = plain_path(&admitted).to_string_lossy().into_owned();
            overlay.insert("CODEX_HOME".into(), s.clone());
            overlay.insert("VIDAR_AGENT_HOME".into(), s.clone());
            Some(s)
        }
        None => None,
    };
    let env = crate::bare_env::codex(inherited, &overlay)?;
    let codex_home = PathBuf::from(overlay.get("CODEX_HOME").cloned().unwrap_or_default());
    let parts = |p: &Path| -> Vec<String> {
        p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect()
    };
    // The overlay's own CODEX_HOME is spelled like the raw home; an admitted combination home is
    // canonical (long form, so it differs when the home is an 8.3 path). Either spelling must sit
    // strictly under the home in the same spelling; a home that does not exist keeps its raw path.
    let canonical_home = std::fs::canonicalize(&home).map(|c| plain_path(&c)).unwrap_or_else(|_| home.clone());
    let codex_parts = parts(&codex_home);
    let under = |base: &Path| {
        let b = parts(base);
        codex_parts.len() > b.len() && codex_parts[..b.len()] == b[..]
    };
    if !(under(&home) || under(&canonical_home)) || codex_parts.iter().any(|c| c == "..") {
        return Err(format!("launch profile {profile:?} sets CODEX_HOME outside the bare home; spawn refused"));
    }
    if !codex_home.join("config.toml").is_file() {
        return Err(format!("bare home {} is not prepared; spawn refused", codex_home.display()));
    }
    let binary = doc.get("binary").ok_or_else(|| format!("launch profile {profile:?} has no binary block"))?;
    let shims: Vec<String> = binary
        .get("shims")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let package = binary
        .get("package")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("launch profile {profile:?} binary block names no package"))?
        .to_string();
    Ok(BareHome { home, env, shims, package, combo })
}

/// The first folder on the env's Path holding `name`.
fn find_on_env_path(env: &crate::bare_env::Env, name: &str) -> Option<PathBuf> {
    std::env::split_paths(env.get("Path")?)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

/// The pinned runtime, else the installed one; an error names both misses.
fn choose_codex(
    pinned: Result<CodexRuntime, String>,
    installed: impl FnOnce() -> Option<Installed>,
) -> Result<CodexRuntime, String> {
    let error = match pinned {
        Ok(runtime) => return Ok(runtime),
        Err(error) => error,
    };
    match installed() {
        Some(found) => {
            eprintln!(
                "falcon: pinned Codex runtime unavailable ({error}); using the installed Codex: {}",
                found.executable.display()
            );
            Ok(CodexRuntime { executable: plain_path(&found.executable) })
        }
        None => Err(format!("{error}; no installed Codex found either")),
    }
}

/// An npm install folder's Codex: `package` (the wrapper's package.json, relative to `dir`),
/// its native app-server nested under the wrapper or hoisted beside it, the wrapper's version.
fn installed_in(dir: &Path, package: &str) -> Option<Installed> {
    let package_json = dir.join(safe_relative(package).ok()?);
    let wrapper = package_json.parent()?;
    let executable = [wrapper.join(NATIVE_PACKAGE), dir.join(NATIVE_PACKAGE)]
        .into_iter()
        .map(|p| p.join(NATIVE_ENTRYPOINT))
        .find(|p| p.is_file())?;
    Some(Installed { executable, version: package_version(&package_json) })
}

/// The first Path folder holding one of `shims` and an installed Codex beside it (the D7
/// resolver `bare::resolve_codex` uses, ending at the native app-server instead of codex.js).
fn installed_on_path(path: Option<&OsStr>, shims: &[String], package: &str) -> Option<Installed> {
    std::env::split_paths(path?)
        .filter(|d| !d.as_os_str().is_empty())
        .filter(|d| shims.iter().any(|s| d.join(s).is_file()))
        .find_map(|d| installed_in(&d, package))
}

/// The plain runtime's installed fallback: `%APPDATA%\npm` (where falcon-build pins from), then
/// a codex shim folder on PATH.
fn installed_default(appdata: Option<&OsStr>, path: Option<&OsStr>) -> Option<Installed> {
    appdata
        .map(|a| PathBuf::from(a).join("npm"))
        .and_then(|npm| installed_in(&npm, DEFAULT_PACKAGE))
        .or_else(|| {
            let shims: Vec<String> = DEFAULT_SHIMS.iter().map(|s| s.to_string()).collect();
            installed_on_path(path, &shims, DEFAULT_PACKAGE)
        })
}

fn package_version(package_json: &Path) -> Option<String> {
    let text = std::fs::read_to_string(package_json).ok()?;
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    v.get("version")?.as_str().map(str::to_string)
}

/// The version of the nearest package.json above an executable (a pinned native package keeps
/// its own at the store root), when one is readable.
fn version_near(executable: &Path) -> Option<String> {
    executable
        .ancestors()
        .skip(1)
        .take(6)
        .map(|d| d.join("package.json"))
        .find(|p| p.is_file())
        .and_then(|p| package_version(&p))
}

fn declared_files(files: &[CodexFile]) -> Result<BTreeMap<PathBuf, String>, String> {
    let mut declared = BTreeMap::new();
    for file in files {
        let relative = safe_relative(&file.path)?;
        let hash = file.sha256.to_ascii_lowercase();
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("Codex runtime hash is invalid for {}", file.path));
        }
        if declared.insert(relative, hash).is_some() {
            return Err(format!(
                "Codex runtime path is declared twice: {}",
                file.path
            ));
        }
    }
    if declared.is_empty() {
        return Err("Codex runtime closure is empty".into());
    }
    Ok(declared)
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.replace('/', "\\"));
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!(
            "Codex runtime path is not a safe relative path: {value}"
        ));
    }
    Ok(path)
}

fn files_under(root: &Path) -> Result<BTreeSet<PathBuf>, String> {
    if !root.is_dir() {
        return Err(format!(
            "content-addressed Codex runtime missing: {}",
            root.display()
        ));
    }
    let mut found = BTreeSet::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| format!("read Codex runtime {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| format!("read Codex runtime entry: {error}"))?;
            let kind = entry
                .file_type()
                .map_err(|error| format!("inspect {}: {error}", entry.path().display()))?;
            if kind.is_symlink() {
                return Err(format!(
                    "Codex runtime contains a link: {}",
                    entry.path().display()
                ));
            }
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                found.insert(
                    entry
                        .path()
                        .strip_prefix(root)
                        .map_err(|error| error.to_string())?
                        .to_path_buf(),
                );
            } else {
                return Err(format!(
                    "Codex runtime contains a non-file: {}",
                    entry.path().display()
                ));
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Agent;

    /// The checkout root at test time (src-falcon's parent), not a machine path.
    fn test_cwd() -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR has a parent")
            .display()
            .to_string()
    }

    fn params(resume: Option<&str>) -> SpawnParams {
        SpawnParams {
            agent: Some(Agent::Codex),
            cwd: test_cwd(),
            model: Some("gpt-test".into()),
            effort: None,
            permission_mode: "default".into(),
            resume: resume.map(str::to_string),
            ctl_secret: None,
            rules_file: None,
            tab_name: None,
            gateway: None,
            profile: None,
            payload_file: None,
            mcp_file: None,
            row_key: None,
            sets: None,
            set_plugin_dirs: Vec::new(), codex_home: None, claude_config_dir: None, plugin_names: Vec::new(),
        }
    }

    #[test]
    fn rules_file_is_refused_for_codex() {
        let runtime = CodexRuntime {
            executable: PathBuf::from("codex"),
        };
        let mut p = params(None);
        let plain = runtime.spawn_request(&p, "s1").unwrap();
        assert!(plain.bare.is_none());
        assert_eq!(plain.request.env_base, EnvBase::Inherit);
        assert!(plain.request.env.is_empty());
        p.rules_file = Some(r"C:\v\runtime\rules\built\0123456789ab.md".into());
        let error = runtime.spawn_request(&p, "s1").unwrap_err();
        assert!(error.contains("not supported for Codex"), "{error}");
    }

    #[test]
    fn mcp_file_is_refused_for_codex() {
        let runtime = CodexRuntime { executable: PathBuf::from("codex") };
        let mut p = params(None);
        p.mcp_file = Some("mcp-0123456789ab.json".into());
        assert!(runtime.spawn_request_in(&p, "s1", None, None, Vec::new()).unwrap_err().contains("mcp_file is not supported"));
    }

    // ---- Bare (profiled) spawns ------------------------------------------------------------

    /// A fake Vidar root holding the shipped `profiles\bare\codex.json`, a prepared Bare home
    /// under `<root>\lad`, and a folder an installed Codex can be laid into.
    struct Bare {
        root: tempdir::Dir,
        lad: PathBuf,
        home: PathBuf,
        runtime: CodexRuntime,
    }

    fn bare_fixture() -> Bare {
        let root = tempdir::Dir::new();
        let profile_dir = root.path().join("profiles").join("bare");
        std::fs::create_dir_all(&profile_dir).unwrap();
        let shipped = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("profiles")
            .join("bare")
            .join("codex.json");
        std::fs::copy(shipped, profile_dir.join("codex.json")).unwrap();
        let lad = root.path().join("lad");
        let home = crate::bare_home::resolve_for(root.path(), &lad);
        std::fs::create_dir_all(home.join("codex-home")).unwrap();
        std::fs::write(home.join("codex-home").join("config.toml"), "").unwrap();
        let bundled = root.path().join("store").join("codex.exe");
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"pinned").unwrap();
        Bare { root, lad, home, runtime: CodexRuntime { executable: bundled } }
    }

    /// An npm-global-shaped install in `dir`: a shim, the wrapper's package.json and the
    /// nested native app-server.
    fn lay_install(dir: &Path, version: &str) -> PathBuf {
        let wrapper = dir.join(r"node_modules\@openai\codex");
        let exe = wrapper.join(NATIVE_PACKAGE).join(NATIVE_ENTRYPOINT);
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"installed").unwrap();
        std::fs::write(wrapper.join("package.json"), format!(r#"{{"version":"{version}"}}"#)).unwrap();
        std::fs::write(dir.join("codex.cmd"), b"@echo off").unwrap();
        exe
    }

    fn bare_params(payload: Option<&Path>) -> SpawnParams {
        let mut p = params(None);
        p.profile = Some("bare".into());
        p.payload_file = payload.map(|f| f.to_string_lossy().into_owned());
        p
    }

    fn inherited(path: &[&Path]) -> Vec<(OsString, OsString)> {
        vec![
            ("Path".into(), std::env::join_paths(path).unwrap()),
            ("SystemRoot".into(), r"C:\Windows".into()),
            ("CODEX_HOME".into(), r"C:\Users\someone\.codex".into()),
            ("CODEX_SANDBOX".into(), "seatbelt".into()),
            ("CODEX_INTERNAL_ORIGINATOR_OVERRIDE".into(), "x".into()),
            ("OPENAI_API_KEY".into(), "sk-test".into()),
            ("VIDAR_TAB".into(), "t-1".into()),
        ]
    }

    impl Bare {
        fn spawn(&self, p: &SpawnParams, path: &[&Path]) -> Result<CodexSpawn, String> {
            self.runtime.spawn_request_in(p, "s1", Some(self.root.path()), Some(&self.lad), inherited(path))
        }
    }

    fn env_of<'a>(request: &'a SpawnRequest, name: &str) -> Option<&'a str> {
        request
            .env
            .iter()
            .rev()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// A marked payload as `bare/layer.rs` `write_filled` writes it.
    fn write_payload(home: &Path, body: &str) -> PathBuf {
        let hash12 = |b: &[u8]| -> String {
            use sha2::{Digest, Sha256};
            Sha256::digest(b).iter().take(6).map(|x| format!("{x:02x}")).collect()
        };
        let body: String = body.lines().map(|l| format!("{l}\n")).collect();
        let text = format!("{body}VIDAR-PAYLOAD-{}\n", hash12(body.as_bytes()));
        let layer = home.join("layer");
        std::fs::create_dir_all(&layer).unwrap();
        let path = layer.join(format!("payload-{}.md", hash12(text.as_bytes())));
        std::fs::write(&path, &text).unwrap();
        path
    }

    #[test]
    fn a_profile_other_than_bare_is_refused() {
        let b = bare_fixture();
        let mut p = bare_params(None);
        for profile in ["work", "Bare", ""] {
            p.profile = Some(profile.into());
            let e = b.spawn(&p, &[]).unwrap_err();
            assert!(e.contains("unknown launch profile"), "{profile:?}: {e}");
        }
        // Without a profile there is no payload to replace.
        let mut p = params(None);
        p.payload_file = Some(r"C:\x\layer\payload-0123456789ab.md".into());
        assert!(b.spawn(&p, &[]).unwrap_err().contains("needs a launch profile"));
        // A Bare spawn carries no rules file and no gateway either.
        let mut p = bare_params(None);
        p.rules_file = Some(r"C:\v\runtime\rules\built\0123456789ab.md".into());
        assert!(b.spawn(&p, &[]).is_err());
    }

    #[test]
    fn a_bare_spawn_needs_a_prepared_home_and_a_host_root() {
        let b = bare_fixture();
        let p = bare_params(None);
        let e = b.runtime.spawn_request_in(&p, "s1", None, Some(&b.lad), inherited(&[])).unwrap_err();
        assert!(e.contains("needs the Vidar root"), "{e}");
        let e = b.runtime.spawn_request_in(&p, "s1", Some(b.root.path()), None, inherited(&[])).unwrap_err();
        assert!(e.contains("LOCALAPPDATA"), "{e}");
        std::fs::remove_file(b.home.join("codex-home").join("config.toml")).unwrap();
        assert!(b.spawn(&p, &[]).unwrap_err().contains("not prepared"));
    }

    #[test]
    fn a_bare_env_is_the_allowlist_plus_the_profile_with_no_inherited_codex_names() {
        let b = bare_fixture();
        let secret = "0123456789abcdef0123456789abcdef";
        let mut p = bare_params(None);
        p.ctl_secret = Some(secret.into());
        let spawn = b.spawn(&p, &[]).unwrap();
        let request = &spawn.request;
        assert_eq!(request.env_base, EnvBase::Allowlist);
        // The base the child gets is the allowlisted part of Falcon's env: no CODEX_* survives.
        let base = crate::bare_env::allowlisted(inherited(&[]));
        assert!(base.iter().all(|(k, _)| !k.to_string_lossy().to_uppercase().starts_with("CODEX_")));
        for name in ["CODEX_SANDBOX", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "OPENAI_API_KEY", "VIDAR_TAB"] {
            assert_eq!(env_of(request, name), None, "{name} leaked");
        }
        let codex_home = b.home.join("codex-home");
        assert_eq!(env_of(request, "CODEX_HOME"), Some(&*codex_home.to_string_lossy()));
        let user_home = b.home.join("user-home");
        assert_eq!(env_of(request, "USERPROFILE"), Some(&*user_home.to_string_lossy()));
        assert!(env_of(request, "HOMEPATH").is_some());
        // The Codex process runs on the real LOCALAPPDATA (the one that placed the home), not the redirect.
        assert_eq!(env_of(request, "LOCALAPPDATA"), Some(&*b.lad.to_string_lossy()));
        assert_eq!(env_of(request, "TEMP"), Some(&*user_home.join(r"AppData\Local\Temp").to_string_lossy()));
        assert_eq!(env_of(request, "FALCON_SESSION"), Some("s1"));
        assert_eq!(env_of(request, "VIDAR_CTL_SECRET"), Some(secret));
        // No secret given, none added; a malformed one refuses.
        let spawn = b.spawn(&bare_params(None), &[]).unwrap();
        assert_eq!(env_of(&spawn.request, "VIDAR_CTL_SECRET"), None);
        let mut p = bare_params(None);
        p.ctl_secret = Some("not-hex".into());
        assert!(b.spawn(&p, &[]).unwrap_err().contains("ctl secret"));
    }

    #[test]
    fn a_bare_spawn_runs_the_installed_codex_first_then_the_bundle() {
        let b = bare_fixture();
        let npm = b.root.path().join("npm");
        let installed = lay_install(&npm, "0.163.0");
        let spawn = b.spawn(&bare_params(None), &[&npm]).unwrap();
        assert_eq!(spawn.request.program, installed);
        assert_eq!(spawn.request.args, ["app-server", "--listen", "stdio://"]);
        let echo = spawn.bare.unwrap().spawn;
        assert_eq!(echo.source, "installed");
        assert_eq!(echo.version.as_deref(), Some("0.163.0"));
        assert_eq!(echo.executable, installed.to_string_lossy());
        // No install on the Bare Path: this runtime's own executable.
        let spawn = b.spawn(&bare_params(None), &[]).unwrap();
        assert_eq!(spawn.request.program, b.runtime.executable);
        assert_eq!(spawn.bare.unwrap().spawn.source, "bundle");
        // A wrapper with no shim beside it is not an install.
        std::fs::remove_file(npm.join("codex.cmd")).unwrap();
        assert_eq!(b.spawn(&bare_params(None), &[&npm]).unwrap().request.program, b.runtime.executable);
    }

    #[test]
    fn the_pwsh_found_after_the_windows_apps_drop_is_reported() {
        let b = bare_fixture();
        let store = b.root.path().join(r"Microsoft\WindowsApps");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("pwsh.exe"), b"alias").unwrap();
        let spawn = b.spawn(&bare_params(None), &[&store]).unwrap();
        assert_eq!(spawn.bare.unwrap().spawn.pwsh, None, "the Store alias is not Codex's shell");
        let path = env_of(&spawn.request, "Path").unwrap();
        assert!(!path.contains("WindowsApps"), "{path}");
        let msi = b.root.path().join("PowerShell");
        std::fs::create_dir_all(&msi).unwrap();
        std::fs::write(msi.join("pwsh.exe"), b"pwsh").unwrap();
        let spawn = b.spawn(&bare_params(None), &[&store, &msi]).unwrap();
        assert_eq!(spawn.bare.unwrap().spawn.pwsh.as_deref(), Some(&*msi.join("pwsh.exe").to_string_lossy()));
    }

    #[test]
    fn a_bare_payload_is_admitted_for_thread_start_and_echoes_its_path() {
        let b = bare_fixture();
        let payload = write_payload(&b.home, "Say \"hi\".");
        let spawn = b.spawn(&bare_params(Some(&payload)), &[]).unwrap();
        assert_eq!(spawn.request.args, ["app-server", "--listen", "stdio://"], "no payload on the argv");
        let bare = spawn.bare.unwrap();
        let text = bare.developer_instructions.unwrap();
        assert!(text.starts_with("Say \"hi\".\nVIDAR-PAYLOAD-"), "{text}");
        let echoed = bare.payload_file.unwrap();
        assert!(!echoed.starts_with(r"\\?\"), "{echoed}");
        assert_eq!(std::fs::canonicalize(&echoed).unwrap(), std::fs::canonicalize(&payload).unwrap());
    }

    #[test]
    fn a_payload_over_the_old_inline_limit_is_admitted_and_stays_off_the_argv() {
        let b = bare_fixture();
        let size = crate::codex_payload::INLINE_LIMIT + 4_000;
        let big = write_payload(&b.home, &"a".repeat(size));
        let spawn = b.spawn(&bare_params(Some(&big)), &[]).unwrap();
        assert_eq!(spawn.request.args, ["app-server", "--listen", "stdio://"]);
        let text = spawn.bare.unwrap().developer_instructions.unwrap();
        assert!(text.len() > size, "{}", text.len());
    }

    #[test]
    fn a_spawn_without_a_payload_carries_no_developer_instructions() {
        let b = bare_fixture();
        let spawn = b.spawn(&bare_params(None), &[]).unwrap();
        assert_eq!(spawn.request.args, ["app-server", "--listen", "stdio://"]);
        assert_eq!(spawn.bare.unwrap().developer_instructions, None);
    }

    #[test]
    fn a_bare_payload_outside_the_home_layer_is_refused() {
        let b = bare_fixture();
        let inside = write_payload(&b.home, "x");
        let name = inside.file_name().unwrap().to_owned();
        for dir in [b.home.clone(), b.root.path().to_path_buf()] {
            let outside = dir.join(&name);
            std::fs::copy(&inside, &outside).unwrap();
            let e = b.spawn(&bare_params(Some(&outside)), &[]).unwrap_err();
            assert!(e.contains("outside the bare home's layer directory"), "{e}");
        }
        // Another home's layer is outside this one's.
        let other = b.root.path().join("other-home");
        let foreign = write_payload(&other, "x");
        let e = b.spawn(&bare_params(Some(&foreign)), &[]).unwrap_err();
        assert!(e.contains("outside the bare home's layer directory"), "{e}");
        // Inside the layer but tampered: the name's hash no longer matches.
        std::fs::write(&inside, "y\n").unwrap();
        assert!(b.spawn(&bare_params(Some(&inside)), &[]).unwrap_err().contains("hash in its name"));
    }

    /// A prepared set-combination home, as `bare/agent_homes.rs` lays it out.
    fn combo_home(home: &Path, name: &str) -> PathBuf {
        let dir = home.join(crate::codex_payload::CODEX_HOMES_DIR).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.toml"), "").unwrap();
        dir
    }

    #[test]
    fn a_combination_codex_home_is_the_childs_codex_home_and_is_echoed() {
        let b = bare_fixture();
        let combo = combo_home(&b.home, "0123456789ab");
        let mut p = bare_params(None);
        p.codex_home = Some(combo.to_string_lossy().into_owned());
        let spawn = b.spawn(&p, &[]).unwrap();
        let canon = std::fs::canonicalize(&combo).unwrap();
        for name in ["CODEX_HOME", "VIDAR_AGENT_HOME"] {
            let v = env_of(&spawn.request, name).unwrap();
            assert!(!v.starts_with(r"\\?\"), "{v}");
            assert_eq!(std::fs::canonicalize(v).unwrap(), canon, "{name}");
        }
        let echoed = spawn.bare.unwrap().spawn.codex_home.unwrap();
        assert_eq!(std::fs::canonicalize(&echoed).unwrap(), canon);
        // None asked: the profile's own home, nothing echoed.
        let spawn = b.spawn(&bare_params(None), &[]).unwrap();
        assert_eq!(env_of(&spawn.request, "CODEX_HOME"), Some(&*b.home.join("codex-home").to_string_lossy()));
        assert_eq!(spawn.bare.unwrap().spawn.codex_home, None);
    }

    #[test]
    fn a_codex_home_outside_the_bare_home_or_unprepared_is_refused() {
        let b = bare_fixture();
        let other = crate::bare_home::resolve_for(&b.root.path().join("other-root"), &b.lad);
        let cases = [
            combo_home(&other, "0123456789ab"),
            combo_home(b.root.path(), "0123456789ab"),
            b.home.join("codex-home"),
            b.home.clone(),
            combo_home(&b.home, "NOT-A-HASH12"),
        ];
        for dir in cases {
            let mut p = bare_params(None);
            p.codex_home = Some(dir.to_string_lossy().into_owned());
            let e = b.spawn(&p, &[]).unwrap_err();
            assert!(e.contains("spawn refused"), "{}: {e}", dir.display());
        }
        let bare = combo_home(&b.home, "ba9876543210");
        std::fs::remove_file(bare.join("config.toml")).unwrap();
        let mut p = bare_params(None);
        p.codex_home = Some(bare.to_string_lossy().into_owned());
        assert!(b.spawn(&p, &[]).unwrap_err().contains("not prepared"));
        // Without a profile there is no home to replace.
        let mut p = params(None);
        p.codex_home = Some(combo_home(&b.home, "0123456789ab").to_string_lossy().into_owned());
        assert!(b.spawn(&p, &[]).unwrap_err().contains("needs a launch profile"));
    }

    // ---- Runtime resolution ---------------------------------------------------------------

    #[test]
    fn the_runtime_falls_back_to_the_installed_codex() {
        let pinned = CodexRuntime { executable: PathBuf::from(r"C:\store\codex.exe") };
        let chosen = choose_codex(Ok(pinned), || panic!("installed probed with a pin")).unwrap();
        assert_eq!(chosen.executable, PathBuf::from(r"C:\store\codex.exe"));
        let found = Installed { executable: PathBuf::from(r"C:\npm\codex.exe"), version: None };
        let chosen = choose_codex(Err("no pin".into()), || Some(found)).unwrap();
        assert_eq!(chosen.executable, PathBuf::from(r"C:\npm\codex.exe"));
        let e = choose_codex(Err("no pin".into()), || None).unwrap_err();
        assert!(e.contains("no pin") && e.contains("no installed Codex"), "{e}");
    }

    #[test]
    fn the_installed_fallback_reads_appdata_npm_then_a_shim_on_path() {
        let temp = tempdir::Dir::new();
        let appdata = temp.path().join("Roaming");
        let exe = lay_install(&appdata.join("npm"), "0.1.0");
        let found = installed_default(Some(appdata.as_os_str()), None).unwrap();
        assert_eq!((found.executable, found.version.as_deref()), (exe, Some("0.1.0")));
        let elsewhere = temp.path().join("elsewhere");
        let exe = lay_install(&elsewhere, "0.2.0");
        let path = std::env::join_paths([&elsewhere]).unwrap();
        let found = installed_default(Some(temp.path().join("none").as_os_str()), Some(&path)).unwrap();
        assert_eq!(found.executable, exe);
        assert!(installed_default(None, None).is_none());
        // A hoisted native package beside the wrapper counts too.
        let hoisted = temp.path().join("hoisted");
        let wrapper = hoisted.join(r"node_modules\@openai\codex");
        std::fs::create_dir_all(&wrapper).unwrap();
        std::fs::write(wrapper.join("package.json"), "{}").unwrap();
        let exe = hoisted.join(NATIVE_PACKAGE).join(NATIVE_ENTRYPOINT);
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"x").unwrap();
        assert_eq!(installed_in(&hoisted, DEFAULT_PACKAGE).unwrap().executable, exe);
    }

    #[test]
    fn a_bundle_without_a_codex_block_has_no_pinned_runtime() {
        let temp = tempdir::Dir::new();
        std::fs::write(temp.path().join("runtime-manifest.json"), br#"{"schema_version":4,"runtimes":["claude"]}"#).unwrap();
        let e = CodexRuntime::resolve_pinned(temp.path(), temp.path()).unwrap_err();
        assert!(e.contains("no Codex runtime"), "{e}");
    }

    fn runtime_fixture() -> (tempdir::Dir, PathBuf, PathBuf) {
        let temp = tempdir::Dir::new();
        let bundle = temp.path().join("bundle");
        let store = temp.path().join("store");
        let store_id = "a".repeat(64);
        let root = store.join("codex").join(&store_id);
        let relative = PathBuf::from(r"vendor\bin\codex.exe");
        std::fs::create_dir_all(root.join(r"vendor\bin")).unwrap();
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(root.join(&relative), b"fixture-app-server").unwrap();
        let hash = sha256_file(&root.join(&relative)).unwrap();
        std::fs::write(
            bundle.join("runtime-manifest.json"),
            serde_json::to_vec(&json!({
                "codex": {
                    "store_id": store_id,
                    "entrypoint": "vendor/bin/codex.exe",
                    "files": [{ "path": "vendor/bin/codex.exe", "sha256": hash }]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        (temp, bundle, store)
    }

    #[test]
    fn runtime_resolve_accepts_an_exact_declared_closure() {
        let (_temp, bundle, store) = runtime_fixture();
        assert!(CodexRuntime::resolve_pinned(&bundle, &store).is_ok());
    }

    #[test]
    fn runtime_resolve_refuses_changed_or_extra_files() {
        let (_temp, bundle, store) = runtime_fixture();
        let root = store.join("codex").join("a".repeat(64));
        std::fs::write(root.join(r"vendor\bin\codex.exe"), b"changed").unwrap();
        assert!(CodexRuntime::resolve_pinned(&bundle, &store)
            .unwrap_err()
            .contains("manifest says"));

        let (_temp, bundle, store) = runtime_fixture();
        let root = store.join("codex").join("a".repeat(64));
        std::fs::write(root.join("unexpected.dll"), b"extra").unwrap();
        assert!(CodexRuntime::resolve_pinned(&bundle, &store)
            .unwrap_err()
            .contains("differs"));
    }

    mod tempdir {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU64, Ordering};

        static COUNTER: AtomicU64 = AtomicU64::new(0);

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "falcon-codex-test-{}-{}",
                    std::process::id(),
                    COUNTER.fetch_add(1, Ordering::SeqCst)
                ));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
