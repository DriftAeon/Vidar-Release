//! src-tauri\src\bare\codex_verify.rs — the Codex version check behind a Bare Codex launch's banner:
//! `codex-accepted.json` verdicts, the warning text, and the background `verify.mjs` run on a new
//! version. Split from bare/mod.rs (module-size line); both Codex surfaces (Rendered, Raw) use it, the
//! Falcon-hosted Rendered spawn through `CodexHostedLaunch::record_host` on the executable Falcon ran.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use super::{CodexLaunch, Env};

/// One `codex-accepted.json` entry: the pin a Codex version was checked against and whether its protocol matched.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Accepted {
    pub pinned: String,
    pub same: bool,
}

pub(crate) type AcceptedMap = BTreeMap<String, Accepted>;

/// The accepted file, or an empty map when it is missing or unreadable; a malformed entry is skipped.
pub(crate) fn read_accepted(path: &Path) -> AcceptedMap {
    let Ok(v) = crate::fsx::read_json::<serde_json::Value>(path) else { return AcceptedMap::new() };
    let Some(obj) = v.as_object() else { return AcceptedMap::new() };
    obj.iter()
        .filter_map(|(k, e)| Some((k.clone(), Accepted { pinned: e.get("pinned")?.as_str()?.to_string(), same: e.get("same")?.as_bool()? })))
        .collect()
}

/// The banner for a Codex launch, `None` when quiet. An entry recorded against an older pin never counts.
pub(crate) fn codex_warning(version: Option<&str>, pinned: &str, accepted: &AcceptedMap) -> Option<String> {
    let name = super::codex_profile::AGENT.as_str();
    let name = format!("{}{}", name[..1].to_uppercase(), &name[1..]);
    let v = match version {
        Some(v) => v,
        None => return Some(format!("{name} Version Unreadable (Verified {pinned}) - Launching Anyway")),
    };
    let entry = accepted.get(v).filter(|a| a.pinned == pinned);
    let verdict = match (v == pinned, entry.map(|a| a.same)) {
        (true, _) => return None,
        (false, Some(true)) => return None,
        (false, Some(false)) => "Changed Its Protocol Since",
        (false, None) => "Differs from",
    };
    Some(format!("{name} {v} {verdict} the Verified {pinned} - Launching Anyway"))
}

/// Versions already checked in this Vidar process, so a launch loop starts at most one check per version.
static CHECKED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// One `verify.mjs` run: `program` (node) runs `script --codex <codex> --out <out>` in `env`.
#[derive(Debug)]
pub(super) struct VerifyJob {
    pub program: PathBuf,
    pub script: PathBuf,
    /// The Codex `verify.mjs` dumps: the npm `codex.js` (in-process) or the executable Falcon ran (hosted).
    pub codex: String,
    pub out: PathBuf,
    pub env: Env,
    pub version: String,
}

/// The verify a launch on `version` needs, `None` when it is the pin, already has a verdict against
/// this pin in `accepted_path`, or the script is missing (logged).
pub(super) fn verify_job(version: Option<&str>, pinned: &str, program: &Path, codex: &str, env: &Env, root: &Path, accepted_path: &Path) -> Option<VerifyJob> {
    let version = version?;
    if version == pinned {
        return None;
    }
    if read_accepted(accepted_path).get(version).is_some_and(|a| a.pinned == pinned) {
        return None;
    }
    let script = root.join("tools/codex-schema/verify.mjs");
    if !script.is_file() {
        eprintln!("codex verify: {} is missing; {version} stays unchecked", script.display());
        return None;
    }
    Some(VerifyJob { program: program.to_path_buf(), script, codex: codex.to_string(), out: accepted_path.to_path_buf(), env: env.clone(), version: version.to_string() })
}

/// Starts `job` on a thread, at most once per version in this Vidar process. Never blocks the launch.
pub(super) fn start_verify(job: VerifyJob) {
    let Ok(mut checked) = CHECKED.lock() else { return };
    if checked.contains(&job.version) {
        return;
    }
    checked.push(job.version.clone());
    drop(checked);
    std::thread::spawn(move || run_verify(&job.program, &job.script, &job.codex, &job.out, &job.env, &job.version));
}

/// After a Codex launch on an unchecked version, runs `tools/codex-schema/verify.mjs` on a thread; the
/// verdict lands in the accepted file for the next launch. Never blocks or fails the launch; the result is only logged.
pub(super) fn verify_new_codex(launch: &CodexLaunch, root: &Path) {
    let b = &launch.manifest.binary;
    let Some(js) = launch.args.first() else { return };
    if let Some(job) = verify_job(b.version.as_deref(), &b.verified_version, &launch.program, js, &launch.env, root, &crate::paths::codex_accepted_path()) {
        start_verify(job);
    }
}

fn run_verify(node: &Path, script: &Path, js: &str, out: &Path, env: &Env, version: &str) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(node);
    cmd.arg(script).arg("--codex").arg(js).arg("--out").arg(out);
    cmd.env_clear().stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    for (k, v) in env.iter() {
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return eprintln!("codex verify {version}: spawn failed: {e}"),
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return eprintln!("codex verify {version}: {s}"),
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return eprintln!("codex verify {version}: timed out after 120 s");
            }
            Err(e) => return eprintln!("codex verify {version}: {e}"),
        }
    }
}
