//! The Claude sidecar command line: admission of every client-named path and the
//! assembly of the spawn arguments and child env from `SpawnParams`. `spawn_request`
//! is the one entry the spawn path calls.

use std::path::{Path, PathBuf};

use super::{bare_spawn, ClaudeRuntime, PROFILES};
use crate::{
    process::SpawnRequest,
    protocol::{SpawnParams, ALLOWED_MODES},
};

/// Twelve lowercase hex digits: a `hash12` (`rules/build.rs`) as it appears in a file name.
fn is_hash12(h: &str) -> bool {
    h.len() == 12 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A set plugin folder name, `^[A-Za-z0-9._-]+-[0-9a-f]{12}$` (Vidar `set_plugin.rs`
/// `<dir_safe(name)>-<hash12>`).
fn is_set_plugin_name(name: &str) -> bool {
    name.rsplit_once('-').is_some_and(|(set, hash)| {
        !set.is_empty()
            && set.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            && is_hash12(hash)
    })
}

/// A plugin rune's name as a vault sends it, `^[a-z0-9][a-z0-9-]{0,63}$`.
fn is_plugin_name(name: &str) -> bool {
    let b = name.as_bytes();
    (1..=64).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// The one admission rule for a client-named file the sidecar will read: no leading `-`,
/// absolute, no `..`, a name `name_ok` accepts, then — after canonicalizing, which resolves
/// symlinks and junctions — a regular file whose name `name_ok` still accepts and whose parent
/// is exactly `dir()` (already canonical). Returns the plain canonical path the sidecar gets.
fn admit_named_file(
    raw: &str,
    what: &str,
    name_ok: &dyn Fn(&Path) -> bool,
    name_rule: &str,
    dir: &dyn Fn() -> Result<PathBuf, String>,
    outside: &str,
) -> Result<PathBuf, String> {
    if raw.starts_with('-') {
        return Err(format!("{what} starts with '-'"));
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("{what} is not an absolute path"));
    }
    if path.components().any(|c| c == std::path::Component::ParentDir) {
        return Err(format!("{what} path contains '..'"));
    }
    if !name_ok(path) {
        return Err(format!("{what} name is not {name_rule}"));
    }
    let dir = dir()?;
    let file = std::fs::canonicalize(path).map_err(|error| format!("{what} unavailable: {error}"))?;
    if file.parent() != Some(dir.as_path()) || !name_ok(&file) || !file.is_file() {
        return Err(outside.into());
    }
    Ok(crate::process::plain_path(&file))
}

impl ClaudeRuntime {
    /// Admit a client's `rules_file`: absolute, no `..`, no leading `-`, file
    /// name `<12 lowercase hex>.md`, and — after canonicalizing both, which
    /// resolves symlinks and junctions — a direct child of `rules_built`.
    /// Returns the plain canonical path the sidecar gets.
    fn admit_rules_file(&self, raw: &str) -> Result<PathBuf, String> {
        let hash_name = |p: &Path| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".md"))
                .is_some_and(is_hash12)
        };
        let dir = || {
            let built = self
                .rules_built
                .as_deref()
                .ok_or("this host has no rules directory")?;
            std::fs::canonicalize(built).map_err(|error| format!("rules directory unavailable: {error}"))
        };
        admit_named_file(
            raw,
            "rules file",
            &hash_name,
            "<hash12>.md",
            &dir,
            "rules file is outside the built rules directory",
        )
    }

    /// Admit a profiled spawn's `payload_file` by the `admit_rules_file` rule: absolute, no `..`,
    /// no leading `-`, name `payload-<12 lowercase hex>.md` as sent and again on the canonical
    /// file, a regular file whose canonical parent is `canonicalize(home)` joined with `layer`.
    /// Never `canonicalize(layer)`: that would admit a junctioned `layer\` pointing elsewhere.
    fn admit_payload_file(raw: &str, home: &Path) -> Result<PathBuf, String> {
        let payload_name = |p: &Path| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("payload-"))
                .and_then(|n| n.strip_suffix(".md"))
                .is_some_and(is_hash12)
        };
        let dir = || {
            std::fs::canonicalize(home)
                .map(|home| home.join("layer"))
                .map_err(|error| format!("bare home unavailable: {error}"))
        };
        admit_named_file(
            raw,
            "payload file",
            &payload_name,
            "payload-<hash12>.md",
            &dir,
            "payload file is outside the bare home's layer directory",
        )
    }

    fn admit_mcp_file(raw: &str, home: &Path) -> Result<PathBuf, String> {
        let name = |p: &Path| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("mcp-"))
                .and_then(|n| n.strip_suffix(".json"))
                .is_some_and(is_hash12)
        };
        let dir = || {
            std::fs::canonicalize(home)
                .map(|home| home.join("layer"))
                .map_err(|error| format!("bare home unavailable: {error}"))
        };
        admit_named_file(raw, "MCP file", &name, "mcp-<hash12>.json", &dir,
            "MCP file is outside the bare home's layer directory")
    }

    /// Admit one of a profiled spawn's `set_plugin_dirs` (Vidar `bare/set_plugin.rs`): no leading
    /// `-`, absolute, no `..`, a folder name `<[A-Za-z0-9._-]+>-<12 lowercase hex>` as sent and
    /// again on the canonical folder, whose canonical parent is `canonicalize(home)` joined with
    /// `layer\plugins` (never `canonicalize` of those: a junctioned `layer\` or `plugins\` lands
    /// elsewhere and is refused). No reparse point from the home down: `layer`, `plugins`, the
    /// folder entry as named (a junction to a sibling would pass the parent test), `.claude-plugin`
    /// and its `plugin.json`, which must be a regular file. Returns the plain canonical folder.
    pub(super) fn admit_set_plugin_dir(raw: &str, home: &Path) -> Result<PathBuf, String> {
        if raw.starts_with('-') {
            return Err("set plugin folder starts with '-'".into());
        }
        let path = Path::new(raw);
        if !path.is_absolute() {
            return Err("set plugin folder is not an absolute path".into());
        }
        if path.components().any(|c| c == std::path::Component::ParentDir) {
            return Err("set plugin folder path contains '..'".into());
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| is_set_plugin_name(n))
            .ok_or("set plugin folder name is not <set>-<hash12>")?;
        let plugins = std::fs::canonicalize(home)
            .map(|home| home.join("layer").join("plugins"))
            .map_err(|error| format!("bare home unavailable: {error}"))?;
        let dir = std::fs::canonicalize(path).map_err(|error| format!("set plugin folder unavailable: {error}"))?;
        let canonical_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if dir.parent() != Some(plugins.as_path()) || !canonical_name.eq_ignore_ascii_case(name) || !dir.is_dir() {
            return Err("set plugin folder is outside the bare home's layer\\plugins directory".into());
        }
        let manifest_dir = dir.join(".claude-plugin");
        let manifest = manifest_dir.join("plugin.json");
        if !std::fs::symlink_metadata(&manifest).is_ok_and(|m| m.file_type().is_file()) {
            return Err("set plugin folder has no regular .claude-plugin\\plugin.json".into());
        }
        for p in [plugins.parent().unwrap_or(&plugins), &plugins, &dir, &manifest_dir, &manifest] {
            crate::security::reject_reparse(p)?;
        }
        Ok(crate::process::plain_path(&dir))
    }

    /// Admit one of a profiled spawn's `plugin_names` (a plugin rune from the session's vault):
    /// the name matches `^[a-z0-9][a-z0-9-]{0,63}$` (so no separator, `..`, drive or uppercase),
    /// and `<root>\plugins\<name>` exists, is a directory, and neither it nor `plugins\` is a
    /// reparse point; its canonical parent must then be `canonicalize(root)` joined with `plugins`.
    /// `root` is the host's own Vidar root, never a client path. Returns the plain canonical folder.
    pub(super) fn admit_plugin_name(name: &str, root: &Path) -> Result<PathBuf, String> {
        if !is_plugin_name(name) {
            return Err(format!("plugin name {name:?} is not [a-z0-9][a-z0-9-]{{0,63}}"));
        }
        let plugins = root.join("plugins");
        let dir = plugins.join(name);
        if std::fs::symlink_metadata(&dir).is_err() {
            return Err(format!("plugin {name:?} is missing from {}", plugins.display()));
        }
        for p in [&plugins, &dir] {
            crate::security::reject_reparse(p).map_err(|error| format!("plugin {name:?} refused: {error}"))?;
        }
        if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            return Err(format!("plugin {name:?} is not a directory"));
        }
        let expected = std::fs::canonicalize(root)
            .map(|root| root.join("plugins"))
            .map_err(|error| format!("Vidar root unavailable: {error}"))?;
        let canonical = std::fs::canonicalize(&dir).map_err(|error| format!("plugin {name:?} unavailable: {error}"))?;
        let canonical_name = canonical.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if canonical.parent() != Some(expected.as_path()) || !canonical_name.eq_ignore_ascii_case(name) {
            return Err(format!("plugin {name:?} is outside the Vidar root's plugins directory"));
        }
        Ok(crate::process::plain_path(&canonical))
    }

    /// The Vidar root this host serves, from its own `--registry` (via `rules_built`), never from
    /// a client.
    fn vidar_root(&self) -> Option<&Path> {
        self.rules_built.as_deref().and_then(|p| p.parent()).and_then(|p| p.parent()).and_then(|p| p.parent())
    }

    /// A spawn's launch profile: a known id, and never with `rules_file` or `gateway` (a profiled
    /// session's layer comes from the profile alone).
    fn admit_profile<'a>(params: &'a SpawnParams) -> Result<Option<&'a str>, String> {
        params.codex_home.as_ref().map_or(Ok(()), |_| Err("codex_home is not supported for Claude sessions".to_string()))?;
        let Some(profile) = params.profile.as_deref() else {
            // A payload replaces a profile's static one: without a profile there is none to replace.
            if params.payload_file.is_some() {
                return Err("a payload file needs a launch profile".into());
            }
            if params.mcp_file.is_some() {
                return Err("an MCP file needs a launch profile".into());
            }
            if params.claude_config_dir.is_some() {
                return Err("a Claude config dir needs a launch profile".into());
            }
            if !params.plugin_names.is_empty() {
                return Err("plugin names need a launch profile".into());
            }
            return Ok(None);
        };
        if !PROFILES.contains(&profile) {
            return Err(format!("unknown launch profile {profile:?}"));
        }
        if params.rules_file.is_some() {
            return Err(format!("a {profile:?} spawn carries no rules file"));
        }
        if params.gateway.is_some() {
            return Err(format!("a {profile:?} spawn carries no gateway"));
        }
        Ok(Some(profile))
    }

    /// Build the sidecar command line. The one place it is constructed, so the
    /// permission-mode allowlist and the resume-id shape are enforced before
    /// anything runs — the same containment `agent.rs::spawn_claude_sidecar`
    /// gives Vidar.
    pub fn spawn_request(
        &self,
        params: &SpawnParams,
        session_id: &str,
    ) -> Result<SpawnRequest, String> {
        let lad = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        self.spawn_request_in(params, session_id, lad.as_deref())
    }

    /// `spawn_request` with the `LOCALAPPDATA` that places a profiled spawn's home passed in,
    /// so tests place it under a fixture instead of the user's real one.
    pub(super) fn spawn_request_in(
        &self,
        params: &SpawnParams,
        session_id: &str,
        local_app_data: Option<&Path>,
    ) -> Result<SpawnRequest, String> {
        if !ALLOWED_MODES.contains(&params.permission_mode.as_str()) {
            return Err(format!(
                "permission mode not allowed: {}",
                params.permission_mode
            ));
        }
        if let Some(resume) = params.resume.as_deref() {
            if !crate::protocol::valid_conversation_id(resume) {
                return Err("resume id is not a UUID".into());
            }
        }
        if let Some(secret) = params.ctl_secret.as_deref() {
            if secret.len() != 32
                || !secret.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("ctl secret is not 32 lowercase hex".into());
            }
        }
        let profile = Self::admit_profile(params)?;
        let rules_file = match params.rules_file.as_deref() {
            Some(raw) => Some(self.admit_rules_file(raw)?),
            None => None,
        };
        let cwd = crate::process::plain_path(&PathBuf::from(&params.cwd));
        if !cwd.is_dir() {
            return Err(format!("cwd is not a directory: {}", params.cwd));
        }

        let mut args = vec![
            self.sidecar.to_string_lossy().into_owned(),
            "--falcon".into(),
            "--cwd".into(),
            params.cwd.clone(),
            "--permission-mode".into(),
            params.permission_mode.clone(),
            "--claude".into(),
            self.claude_exe.to_string_lossy().into_owned(),
        ];
        if let Some(model) = params
            .model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
        {
            // The sidecar takes the first `--model` match, so a value shaped like a flag could steer it.
            if model.starts_with('-') {
                return Err(format!("model must not start with '-': {model}"));
            }
            args.push("--model".into());
            args.push(model.to_string());
        }
        if let Some(effort) = params.effort.as_deref().map(str::trim) {
            if !crate::protocol::effort_levels().contains(&effort) {
                return Err(format!("effort level not allowed: {effort}"));
            }
            args.push("--effort".into());
            args.push(effort.to_string());
        }
        if let Some(resume) = params.resume.as_deref() {
            args.push("--resume".into());
            args.push(resume.to_string());
        }
        if let Some(rules_file) = rules_file {
            args.push("--rules-file".into());
            args.push(rules_file.to_string_lossy().into_owned());
        }

        if let Some(gateway) = params.gateway {
            // Resolve preparation from the trusted Vidar root, never a client-supplied path.
            let root = self.vidar_root().ok_or("gateway preparation needs the Vidar root")?;
            let prepare = root.join("tools/vendor/vendor-prepare.ps1");
            if !prepare.is_file() { return Err("gateway preparation helper is missing".into()); }
            let pwsh = self.pwsh.as_deref().ok_or("gateway preparation needs pwsh.exe on PATH")?;
            args.extend(["--gateway".into(), gateway.as_str().into(),
                "--vendor-preparer".into(), prepare.to_string_lossy().into_owned(),
                "--pwsh".into(), pwsh.to_string_lossy().into_owned()]);
        }

        // A profiled (bare) session: the env is built from the allowlist plus the profile's
        // overlay, never Falcon's own; the sidecar maps the profile to SDK options.
        let mut env: Vec<(String, String)> = Vec::new();
        let mut env_base = crate::process::EnvBase::Inherit;
        if let Some(profile) = profile {
            let root = self.vidar_root().ok_or("a profiled spawn needs the Vidar root")?;
            // A per-spawn config dir (a set combination's) replaces the overlay's once admitted.
            let bare = bare_spawn(root, local_app_data, profile, params.claude_config_dir.as_deref())?;
            args.extend([
                "--profile".into(), profile.into(),
                "--root".into(), root.to_string_lossy().into_owned(),
                "--home".into(), bare.home.to_string_lossy().into_owned(),
            ]);
            // A row's built payload, only from under this home's `layer\` (the sidecar checks
            // the same place and the file's hash again before reading it).
            if let Some(raw) = params.payload_file.as_deref() {
                let payload = Self::admit_payload_file(raw, &bare.home)?;
                args.extend(["--payload".into(), payload.to_string_lossy().into_owned()]);
            }
            if let Some(raw) = params.mcp_file.as_deref() {
                let mcp = Self::admit_mcp_file(raw, &bare.home)?;
                args.extend(["--mcp-file".into(), mcp.to_string_lossy().into_owned()]);
            }
            // The row's rune-set plugins, only from under this home's `layer\plugins\`. A folder
            // that fails is dropped with a warning: the tab still runs, without that set's plugin.
            for raw in &params.set_plugin_dirs {
                match Self::admit_set_plugin_dir(raw, &bare.home) {
                    Ok(dir) => args.extend(["--set-plugin".into(), dir.to_string_lossy().into_owned()]),
                    Err(error) => eprintln!("falcon: set plugin {raw:?} dropped: {error}"),
                }
            }
            // The vault's plugin runes, by name, only from `<root>\plugins\`. Any name that fails
            // refuses the spawn: a session never runs without a rune its vault holds.
            for name in &params.plugin_names {
                let dir = Self::admit_plugin_name(name, root)?;
                args.extend(["--set-plugin".into(), dir.to_string_lossy().into_owned()]);
            }
            env = bare.env;
            env_base = crate::process::EnvBase::Allowlist;
        } else if !params.set_plugin_dirs.is_empty() {
            eprintln!("falcon: set plugins dropped: they need a launch profile");
        }

        // The hosted CLI must not believe it is a Vidar tab.
        env.push(("FALCON_SESSION".into(), session_id.to_string()));
        // The bus identity proof (`control/policy.rs`). With None nothing is
        // added, and `process::SCRUBBED_ENV` drops any value Falcon inherited.
        if let Some(secret) = params.ctl_secret.as_deref() {
            env.push(("VIDAR_CTL_SECRET".into(), secret.to_string()));
        }
        // The tab's name, beside FALCON_SESSION: a hosted agent says who it is. Cosmetic, so a
        // blank or control-character name is left out rather than failing the spawn.
        if let Some(name) = params
            .tab_name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty() && !n.chars().any(char::is_control))
        {
            env.push(("VIDAR_TAB_NAME".into(), name.chars().take(128).collect()));
        }
        Ok(SpawnRequest {
            program: self.node.clone(),
            args,
            cwd,
            env,
            env_base,
        })
    }
}
