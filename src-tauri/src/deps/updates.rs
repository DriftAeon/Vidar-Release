//! Startup CLI updates: every catalog or pack dep with an `update` rule (`deps::update_entries`);
//! reuse its exe probe, read npm manifests without launching interactive CLIs. Unknown
//! installation layouts are left alone.
mod process;
pub mod skew;

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::Serialize;
use serde_json::Value;

static CHECK: Mutex<Option<Vec<Offer>>> = Mutex::new(None);
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    id: String,
    label: String,
    installed: String,
    latest: String,
}

struct Installed { exe: PathBuf, package: String, version: String, npm: bool }

fn safe_version(text: &str) -> bool {
    !text.is_empty() && text.len() < 100 && text.starts_with(|c: char| c.is_ascii_digit())
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
        && text.split(['-', '+']).next().is_some_and(|v|
            v.split('.').count() == 3 && v.split('.').all(|n| n.parse::<u64>().is_ok()))
}

fn entry(id: &str) -> Option<super::UpdateEntry> {
    super::update_entries().into_iter().find(|e| e.id == id)
}

fn installed(id: &str, deadline: Instant) -> Option<Installed> {
    let entry = entry(id)?;
    let super::ExeHit::Usable(exe) = super::probe_exe(&entry.names, &entry.candidates, &[]) else { return None };
    let package = entry.rule.package().unwrap_or_default().to_string();
    if !package.is_empty() {
        let manifest = exe.parent()?.join("node_modules").join(&package).join("package.json");
        if let Ok(text) = std::fs::read_to_string(manifest) {
            let json: Value = serde_json::from_str(&text).ok()?;
            if json["name"].as_str()? != package { return None; }
            let version = json["version"].as_str()?.to_string();
            return safe_version(&version).then_some(Installed { exe, package, version, npm: true });
        }
    }
    // A `native` rule's .exe install uses the vendor's own updater, never npm over it.
    if !entry.rule.native() || exe.extension()?.to_str()? != "exe" { return None; }
    let mut command = Command::new(&exe);
    command.arg("--version").env("DISABLE_AUTOUPDATER", "1");
    let output = process::run(command, deadline.min(Instant::now() + Duration::from_secs(3)))?;
    let version = output.split_whitespace().next()?.to_string();
    safe_version(&version).then_some(Installed { exe, package, version, npm: false })
}

fn npm_command() -> Option<Command> {
    let npm = crate::which::find_on_path_exact("npm.cmd")?;
    let entry = npm.parent()?.join("node_modules/npm/bin/npm-cli.js");
    if !entry.is_file() { return None; }
    let node = crate::which::find_on_path_exact("node.exe")?;
    let mut cmd = Command::new(node);
    cmd.arg(entry);
    Some(cmd)
}

fn check_one(id: &str, deadline: Instant) -> Option<Offer> {
    let have = installed(id, deadline)?;
    let mut npm = npm_command()?;
    npm.args(["view", &have.package, "version", "--json", "--fetch-retries=0", "--fetch-timeout=5000",
        "--registry=https://registry.npmjs.org"]);
    let text = process::run(npm, deadline)?;
    let latest: String = serde_json::from_str(&text).ok()?;
    if !safe_version(&latest) { return None; }
    let label = entry(id)?.label;
    Some(Offer { id: id.into(), label, installed: have.version, latest })
}

fn compute() -> Vec<Offer> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let ids: Vec<String> = super::update_entries().into_iter().map(|e| e.id).collect();
    let handles: Vec<_> = ids.into_iter().map(|id|
        std::thread::spawn(move || check_one(&id, deadline))).collect();
    handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
}

/// The cached offers, computed once; `fresh` recomputes and replaces the cache, so `update`
/// validates against the newest check. The cache lock is held across the compute: concurrent
/// checks queue instead of racing.
fn check_with(fresh: bool, compute: impl FnOnce() -> Vec<Offer>) -> Vec<Offer> {
    let mut cache = CHECK.lock().unwrap_or_else(|e| e.into_inner());
    if fresh || cache.is_none() { *cache = Some(compute()); }
    cache.clone().unwrap_or_default()
}

fn cached_offers() -> Option<Vec<Offer>> {
    CHECK.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub async fn check_cli_updates(fresh: Option<bool>) -> Result<Vec<Offer>, String> {
    let fresh = fresh.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || check_with(fresh, compute)).await.map_err(|e| e.to_string())
}

/// `latest` is strictly newer than `installed` (no downgrade, no reinstall): a higher
/// major.minor.patch, or the same core where only `installed` is a prerelease. Unreadable
/// versions are never newer.
fn newer(latest: &str, installed: &str) -> bool {
    let pre = |v: &str| v.split('+').next().unwrap_or(v).contains('-');
    match (super::parse_semver(latest), super::parse_semver(installed)) {
        (Some(l), Some(i)) => l > i || (l == i && pre(installed) && !pre(latest)),
        _ => false,
    }
}

fn update(id: &str, version: &str) -> Result<(), String> {
    let _guard = UPDATE_LOCK.lock().map_err(|e| e.to_string())?;
    let offers = cached_offers();
    if !safe_version(version) || !offers.as_ref().is_some_and(|offers|
        offers.iter().any(|o| o.id == id && o.latest == version && newer(&o.latest, &o.installed))) {
        return Err("No Matching Startup Update Offer".into());
    }
    let deadline = Instant::now() + Duration::from_secs(300);
    let have = installed(id, deadline).ok_or("Installation Changed Or Unavailable")?;
    if have.version == version { return Ok(()); }
    if !offers.as_ref().is_some_and(|offers| offers.iter().any(|o| o.id == id && o.installed == have.version)) {
        return Err("Installation Changed Since Check: Reopen Vidar".into());
    }
    let command = if have.npm {
        let mut npm = npm_command().ok_or("Npm Unavailable")?;
        npm.args(["install", "-g", &format!("{}@{version}", have.package), "--no-fund", "--no-audit",
            "--fetch-retries=0", "--fetch-timeout=30000", "--registry=https://registry.npmjs.org"]);
        npm.arg("--prefix").arg(have.exe.parent().ok_or("Missing Install Folder")?);
        npm
    } else {
        let mut native = Command::new(&have.exe);
        native.arg("update").env("DISABLE_AUTOUPDATER", "1");
        native
    };
    process::run(command, deadline).ok_or("Update Failed Or Timed Out")?;
    let after = installed(id, deadline).ok_or("Updated Version Could Not Be Read")?;
    if after.version == have.version { return Err("Updater Did Not Change the Installed Version".into()); }
    if after.version != version && super::parse_semver(&after.version) <= super::parse_semver(version) {
        return Err("Updater Did Not Reach the Offered Version (Check Release Channel)".into());
    }
    if after.npm {
        // npm can exit 0 after dropping an optional platform dep, leaving a manifest that
        // reads fine but a CLI that cannot start; only a launch proves the install.
        let mut probe = Command::new(&after.exe);
        probe.arg("--version").env("DISABLE_AUTOUPDATER", "1");
        let ran = process::run(probe, deadline.min(Instant::now() + Duration::from_secs(10)));
        if !reports_version(ran.as_deref(), &after.version) {
            return Err("Updated CLI Does Not Start: Reinstall It".into());
        }
    }
    Ok(())
}

/// `--version` output proves the install when it ran at all and names the expected version as
/// a whole token (CLIs print either `1.2.3` or `name 1.2.3`).
fn reports_version(output: Option<&str>, expected: &str) -> bool {
    output.is_some_and(|text| text.split_whitespace().any(|token| token == expected))
}

#[tauri::command]
pub async fn update_cli(id: String, version: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || update(&id, &version)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_updates_rejects_unoffered_ids_versions_and_shell_text() {
        assert!(safe_version("1.2.3"));
        assert!(safe_version("1.2.3-beta.2"));
        for text in ["1.2", "latest", "1.2.3;whoami", "1.2.3 & calc", "1.2.3/other"] {
            assert!(!safe_version(text), "{text}");
        }
        assert!(update("not-a-cli", "1.2.3").is_err());
        assert!(update("codex", "1.2.3").is_err());
    }

    /// The catalog's npm CLIs carry an `update` rule; claude's lives in its pack (deps.rs test).
    #[test]
    fn cli_updates_cover_the_catalog_rules() {
        let catalog = crate::deps::parse_catalog(crate::deps::CATALOG_JSON).unwrap();
        let ids: Vec<&str> = catalog.deps.iter().filter(|e| e.update.is_some()).map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["gemini", "pi"]);
        assert!(catalog.deps.iter().filter_map(|e| e.update.as_ref()).all(|r| r.package().is_some() && !r.native()));
    }

    /// Plain checks reuse the cache; a fresh one recomputes and replaces what `update` validates against.
    #[test]
    fn cli_check_cache_is_replaced_only_by_a_fresh_check() {
        let offer = |latest: &str| vec![Offer { id: "cache-test".into(), label: "Cache Test".into(),
            installed: "1.0.0".into(), latest: latest.into() }];
        let first = check_with(true, || offer("1.1.0"));
        assert_eq!(first[0].latest, "1.1.0");
        let cached = check_with(false, || panic!("a plain check must reuse the cache"));
        assert_eq!(cached[0].latest, "1.1.0");
        let fresh = check_with(true, || offer("1.2.0"));
        assert_eq!(fresh[0].latest, "1.2.0");
        assert_eq!(cached_offers().unwrap()[0].latest, "1.2.0");
    }

    #[test]
    fn cli_update_proof_needs_the_expected_version_token() {
        assert!(reports_version(Some("0.164.0\n"), "0.164.0"));
        assert!(reports_version(Some("codex-cli 0.164.0\r\n"), "0.164.0"));
        assert!(!reports_version(None, "0.164.0"));
        assert!(!reports_version(Some(""), "0.164.0"));
        assert!(!reports_version(Some("codex-cli 0.163.0"), "0.164.0"));
        assert!(!reports_version(Some("0.164.01"), "0.164.0"));
    }

    #[test]
    fn cli_updates_only_move_forward() {
        assert!(newer("1.10.0", "1.9.9"));
        assert!(newer("1.2.3", "1.2.3-rc.2"));
        assert!(!newer("1.2.3", "1.2.3"));
        assert!(!newer("1.2.2", "1.2.3"));
        assert!(!newer("1.2.3-rc.1", "1.2.3"));
        assert!(!newer("1.2.3", "unknown"));
    }
}
