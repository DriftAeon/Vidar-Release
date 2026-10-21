//! src-tauri\src\bare\codex_verify.rs — the Codex version check behind a Bare Codex launch's banner:
//! `codex-accepted.json` verdicts, the warning text, and the background `verify.mjs` run on a new
//! version. Split from bare/mod.rs (module-size line); both Codex surfaces (Rendered, Raw) use it.

use std::collections::BTreeMap;
use std::path::Path;
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
    let Some(v) = version else {
        return Some(format!("Codex version unreadable (verified {pinned}); launching anyway"));
    };
    if v == pinned {
        return None;
    }
    match accepted.get(v) {
        Some(a) if a.pinned == pinned && a.same => None,
        Some(a) if a.pinned == pinned => Some(format!("Codex {v} changed its protocol since the verified {pinned}; launching anyway")),
        _ => Some(format!("Codex {v} differs from the verified {pinned}; launching anyway")),
    }
}

/// Versions already checked in this Vidar process, so a launch loop starts at most one check per version.
static CHECKED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// After a Codex launch on an unchecked version, runs `tools/codex-schema/verify.mjs` on a thread; the
/// verdict lands in the accepted file for the next launch. Never blocks or fails the launch; the result is only logged.
pub(super) fn verify_new_codex(launch: &CodexLaunch, root: &Path) {
    let b = &launch.manifest.binary;
    let Some(version) = b.version.clone() else { return };
    if version == b.verified_version {
        return;
    }
    let accepted_path = crate::paths::codex_accepted_path();
    if read_accepted(&accepted_path).get(&version).is_some_and(|a| a.pinned == b.verified_version) {
        return;
    }
    let Some(js) = launch.args.first().cloned() else { return };
    let script = root.join("tools/codex-schema/verify.mjs");
    if !script.is_file() {
        eprintln!("codex verify: {} is missing; {version} stays unchecked", script.display());
        return;
    }
    match CHECKED.lock() {
        Ok(mut c) if !c.contains(&version) => c.push(version.clone()),
        _ => return,
    }
    let (program, env) = (launch.program.clone(), launch.env.clone());
    std::thread::spawn(move || run_verify(&program, &script, &js, &accepted_path, &env, &version));
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
