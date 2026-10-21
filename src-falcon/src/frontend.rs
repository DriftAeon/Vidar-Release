//! The Falcon shell's live frontend (plan 2c/§7, docs/runs/2026-10-04-rendered-cohesion).
//!
//! `tools/release/falcon-frontend-stage.ps1` copies the built shell frontend into
//! `<falcon>\frontend\<digest>\` with a `manifest.json` and points
//! `<falcon>\frontend\current.json` at it. This module verifies that set (reparse points,
//! per-file sha256 and size, the tree digest, `shell_key` against this bundle's
//! `runtime-manifest.json`), keeps it in memory, and serves it ahead of the embedded assets
//! through `Context::set_assets`. Any failure serves the embedded assets and records why.
//!
//! Trust: the manifest proves internal consistency, not origin; anything that can write the
//! falcon dir can stage a frontend that gets full shell IPC on the next Reload.
//!
//! Contract (frozen): pointer `{schema:1, digest}`; manifest `{schema:1, digest, shell_key,
//! files:[{path, sha256, bytes}]}`, forward-slash relative paths sorted ordinal; digest =
//! SHA-256 (lowercase hex) of `"<path>|<sha256>"` lines joined with `\n`, no trailing newline.

use std::{
    borrow::Cow,
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, RwLock},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager as _, utils::assets::AssetKey, utils::assets::AssetsIter, utils::assets::CspHash, Assets, Context, Runtime, State};

use crate::{layout, security};

const BUNDLE_MANIFEST: &str = "runtime-manifest.json";
const MANIFEST: &str = "manifest.json";

#[derive(Deserialize)]
struct Pointer {
    schema: u32,
    digest: String,
}

#[derive(Deserialize)]
struct FileEntry {
    path: String,
    sha256: String,
    bytes: u64,
}

#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    digest: String,
    shell_key: String,
    files: Vec<FileEntry>,
}

#[derive(Deserialize)]
struct BundleManifest {
    shell_key: Option<String>,
    frontend_digest: Option<String>,
}

/// What `falcon_frontend_status` / `falcon_frontend_reload` answer.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FrontendStatus {
    /// Digest being served: the loaded staged set, else the embedded build's `frontend_digest`.
    pub loaded: Option<String>,
    /// Digest the pointer names now (unverified beyond the manifest header check).
    pub staged: Option<String>,
    /// The staged set exists, names its own digest and carries this bundle's `shell_key`.
    pub compatible: bool,
    /// Why the staged set is not (or could not be) loaded.
    pub reason: Option<String>,
}

type Files = HashMap<String, Arc<Vec<u8>>>;

struct Inner {
    /// Digest of the staged set currently served; None = embedded.
    loaded_staged: Option<String>,
    /// The last digest that failed verification, with its reason.
    failed: Option<(String, String)>,
    /// Digest that was served and never acknowledged by the page (`falcon_frontend_booted`);
    /// not loaded again this host run, until the pointer names another digest.
    bad: Option<String>,
    /// The page served from the current staged set has called `falcon_frontend_booted`.
    booted: bool,
    /// Bumped on every serve, restore and fall-back; a watchdog only acts on the epoch it armed for.
    epoch: u64,
}

impl Inner {
    fn is_bad(&self, digest: &str) -> bool {
        self.bad.as_deref() == Some(digest)
    }

    /// The watchdog for `epoch` still has something to guard: the epoch is current, the page has
    /// not acknowledged, and a staged set is being served.
    fn watching(&self, epoch: u64) -> bool {
        self.epoch == epoch && !self.booted && self.loaded_staged.is_some()
    }

    /// Drops the served staged set, records why, and bars the digest for this run.
    /// None when the watchdog no longer applies.
    fn fall_back(&mut self, epoch: u64) -> Option<String> {
        if !self.watching(epoch) {
            return None;
        }
        let digest = self.loaded_staged.take()?;
        self.bad = Some(digest.clone());
        self.failed = Some((digest.clone(), BOOT_FAILURE.to_string()));
        self.epoch += 1;
        Some(digest)
    }
}

const BOOT_FAILURE: &str = "staged frontend did not boot";
/// How long a page served from a staged set has to call `falcon_frontend_booted`.
const BOOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

pub struct FrontendState {
    falcon_dir: PathBuf,
    host_shell_key: Option<String>,
    embedded_digest: Option<String>,
    files: Arc<RwLock<Files>>,
    inner: RwLock<Inner>,
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A manifest path is a forward-slash relative path with no empty, `.` or `..` segment and
/// no drive or backslash, so it can never leave the digest directory.
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':'])
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn tree_digest(files: &[FileEntry]) -> String {
    let lines: Vec<String> = files.iter().map(|f| format!("{}|{}", f.path, f.sha256)).collect();
    sha256_hex(lines.join("\n").as_bytes())
}

/// Checks a parsed manifest's shape and digest, then pulls every file through `read` and
/// verifies size and sha256. Pure so a test can drive it without a directory.
fn verify_manifest(
    manifest: &Manifest,
    read: &dyn Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<Files, String> {
    if manifest.schema != 1 {
        return Err(format!("unsupported manifest schema {}", manifest.schema));
    }
    if !is_digest(&manifest.digest) {
        return Err("manifest digest is not 64 lowercase hex".into());
    }
    if manifest.files.is_empty() || !manifest.files.iter().any(|f| f.path == "falcon.html") {
        return Err("manifest lists no falcon.html".into());
    }
    for pair in manifest.files.windows(2) {
        if pair[0].path.as_bytes() >= pair[1].path.as_bytes() {
            return Err(format!("manifest paths not in ordinal order at {}", pair[1].path));
        }
    }
    if tree_digest(&manifest.files) != manifest.digest {
        return Err("manifest digest does not match its file list".into());
    }
    let mut files = Files::new();
    for entry in &manifest.files {
        if !safe_relative(&entry.path) || !is_digest(&entry.sha256) {
            return Err(format!("bad manifest entry {}", entry.path));
        }
        let bytes = read(&entry.path)?;
        if bytes.len() as u64 != entry.bytes {
            return Err(format!("{} is {} bytes, manifest says {}", entry.path, bytes.len(), entry.bytes));
        }
        if sha256_hex(&bytes) != entry.sha256 {
            return Err(format!("{} does not match its sha256", entry.path));
        }
        files.insert(format!("/{}", entry.path), Arc::new(bytes));
    }
    Ok(files)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    security::reject_reparse(path)?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("parse {}: {e}", path.display()))
}

impl FrontendState {
    /// `registry_path` is the host's `--registry`; the falcon dir is two levels up
    /// (`<falcon>\runtime\registry.json`, both layouts), `bundle_dir` is the running bundle.
    pub fn new(registry_path: &Path, bundle_dir: &Path) -> Self {
        let falcon_dir = registry_path
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let bundle: Option<BundleManifest> = read_json(&bundle_dir.join(BUNDLE_MANIFEST)).ok();
        Self {
            falcon_dir,
            host_shell_key: bundle.as_ref().and_then(|b| b.shell_key.clone()),
            embedded_digest: bundle.and_then(|b| b.frontend_digest),
            files: Arc::new(RwLock::new(Files::new())),
            inner: RwLock::new(Inner { loaded_staged: None, failed: None, bad: None, booted: false, epoch: 0 }),
        }
    }

    fn frontends_dir(&self) -> PathBuf {
        self.falcon_dir.join(layout::FRONTENDS)
    }

    /// Ok(None): nothing staged. Err: the pointer is unusable.
    fn read_pointer(&self) -> Result<Option<String>, String> {
        let path = self.falcon_dir.join(layout::FRONTEND_POINTER);
        if !path.exists() {
            return Ok(None);
        }
        security::reject_reparse(&self.frontends_dir())?;
        let pointer: Pointer = read_json(&path)?;
        if pointer.schema != 1 || !is_digest(&pointer.digest) {
            return Err("frontend pointer is malformed".into());
        }
        Ok(Some(pointer.digest))
    }

    fn read_manifest(&self, digest: &str) -> Result<Manifest, String> {
        let dir = self.frontends_dir().join(digest);
        security::reject_reparse(&self.frontends_dir())?;
        security::reject_reparse(&dir)?;
        let manifest: Manifest = read_json(&dir.join(MANIFEST))?;
        if manifest.digest != digest {
            return Err("staged manifest names a different digest than its directory".into());
        }
        match (&self.host_shell_key, manifest.shell_key.as_str()) {
            (Some(host), staged) if host == staged => Ok(manifest),
            (Some(_), _) => Err("staged frontend was built for a different shell".into()),
            (None, _) => Err("this bundle records no shell_key".into()),
        }
    }

    /// Full verification of the staged set the pointer names; nothing is swapped.
    fn load_staged(&self) -> Result<(String, Files), String> {
        let digest = self.read_pointer()?.ok_or_else(|| "no staged frontend".to_string())?;
        if self.inner.read().unwrap_or_else(|e| e.into_inner()).is_bad(&digest) {
            return Err(BOOT_FAILURE.to_string());
        }
        let manifest = self.read_manifest(&digest)?;
        let dir = self.frontends_dir().join(&digest);
        let files = verify_manifest(&manifest, &|relative| {
            let mut path = dir.clone();
            let parts: Vec<&str> = relative.split('/').collect();
            for part in &parts {
                path.push(part);
                // every directory on the way and the file itself
                security::reject_reparse(&path)?;
            }
            std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))
        })?;
        Ok((digest, files))
    }

    fn install(&self, digest: String, files: Files) {
        *self.files.write().unwrap_or_else(|e| e.into_inner()) = files;
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        inner.loaded_staged = Some(digest);
        inner.failed = None;
        inner.booted = false;
        inner.epoch += 1;
    }

    /// What is being served now, to put back if the page reload after `reload()` fails.
    fn snapshot(&self) -> (Files, Option<String>) {
        let files = self.files.read().unwrap_or_else(|e| e.into_inner()).clone();
        (files, self.inner.read().unwrap_or_else(|e| e.into_inner()).loaded_staged.clone())
    }

    /// Reverts to a `snapshot()`; the page it describes is the one still running, so it counts as
    /// booted and any watchdog armed since is cancelled.
    fn restore(&self, snapshot: (Files, Option<String>)) {
        *self.files.write().unwrap_or_else(|e| e.into_inner()) = snapshot.0;
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        inner.loaded_staged = snapshot.1;
        inner.booted = true;
        inner.epoch += 1;
    }

    fn mark_booted(&self) {
        self.inner.write().unwrap_or_else(|e| e.into_inner()).booted = true;
    }

    /// After a staged set is served: when no page acknowledges within `BOOT_TIMEOUT` (counted
    /// from when a window exists), drop to the embedded assets, bar the digest and reload every
    /// window. Page-independent: a broken staged page cannot run its own escape.
    pub fn arm_watchdog<R: Runtime>(self: &Arc<Self>, app: tauri::AppHandle<R>) {
        let epoch = {
            let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
            if inner.loaded_staged.is_none() {
                return;
            }
            inner.epoch
        };
        let state = Arc::clone(self);
        std::thread::spawn(move || {
            let mut since: Option<std::time::Instant> = None;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if !state.inner.read().unwrap_or_else(|e| e.into_inner()).watching(epoch) {
                    return;
                }
                if app.webview_windows().is_empty() {
                    since = None;
                    continue;
                }
                let started = *since.get_or_insert_with(std::time::Instant::now);
                if started.elapsed() < BOOT_TIMEOUT {
                    continue;
                }
                let fell = state.inner.write().unwrap_or_else(|e| e.into_inner()).fall_back(epoch).is_some();
                if fell {
                    state.files.write().unwrap_or_else(|e| e.into_inner()).clear();
                    for window in app.webview_windows().values() {
                        let _ = window.reload();
                    }
                }
                return;
            }
        });
    }

    /// Startup: serve the staged set when it verifies, else the embedded assets.
    pub fn load_at_startup(&self) {
        match self.load_staged() {
            Ok((digest, files)) => self.install(digest, files),
            Err(reason) => self.record_failure(reason),
        }
    }

    fn record_failure(&self, reason: String) {
        if reason == "no staged frontend" {
            return;
        }
        let digest = self.read_pointer().ok().flatten().unwrap_or_default();
        self.inner.write().unwrap_or_else(|e| e.into_inner()).failed = Some((digest, reason));
    }

    pub fn status(&self) -> FrontendStatus {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let loaded = inner.loaded_staged.clone().or_else(|| self.embedded_digest.clone());
        let failed = inner.failed.clone();
        drop(inner);
        let (staged, compatible, reason) = match self.read_pointer() {
            Ok(None) => (None, false, failed.map(|(_, r)| r)),
            Err(reason) => (None, false, Some(reason)),
            Ok(Some(digest)) => match failed {
                Some((bad, reason)) if bad == digest => (Some(digest), false, Some(reason)),
                _ => match self.read_manifest(&digest) {
                    Ok(_) => (Some(digest), true, None),
                    Err(reason) => (Some(digest), false, Some(reason)),
                },
            },
        };
        FrontendStatus { loaded, staged, compatible, reason }
    }

    /// Re-verify and swap the served set. Leaves the old set serving on any failure.
    pub fn reload(&self) -> Result<FrontendStatus, String> {
        match self.load_staged() {
            Ok((digest, files)) => {
                self.install(digest, files);
                Ok(self.status())
            }
            Err(reason) => {
                self.record_failure(reason.clone());
                Err(reason)
            }
        }
    }
}

/// Serves the verified in-memory set for manifest keys only; everything else, and every key
/// while no set is loaded, comes from the embedded assets `set_assets` handed back.
struct LiveAssets<R: Runtime> {
    fallback: Arc<OnceLock<Box<dyn Assets<R>>>>,
    files: Arc<RwLock<Files>>,
}

impl<R: Runtime> LiveAssets<R> {
    fn fallback(&self) -> &dyn Assets<R> {
        self.fallback.get().expect("fallback assets are set right after install").as_ref()
    }
}

impl<R: Runtime> Assets<R> for LiveAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.fallback().setup(app);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let live = self.files.read().unwrap_or_else(|e| e.into_inner()).get(key.as_ref()).cloned();
        match live {
            Some(bytes) => Some(Cow::Owned(bytes.as_ref().clone())),
            None => self.fallback().get(key),
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.fallback().iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.fallback().csp_hashes(html_path)
    }
}

/// Builds the state, loads a staged set when one verifies, and swaps `context`'s assets for
/// the live wrapper over the embedded ones. Call before `Builder::build`.
pub fn install<R: Runtime>(context: &mut Context<R>, registry_path: &Path, bundle_dir: &Path) -> Arc<FrontendState> {
    let state = Arc::new(FrontendState::new(registry_path, bundle_dir));
    state.load_at_startup();
    let cell: Arc<OnceLock<Box<dyn Assets<R>>>> = Arc::new(OnceLock::new());
    let live = LiveAssets { fallback: Arc::clone(&cell), files: Arc::clone(&state.files) };
    let original = context.set_assets(Box::new(live));
    let _ = cell.set(original);
    state
}

#[tauri::command]
pub fn falcon_frontend_status(state: State<'_, Arc<FrontendState>>) -> FrontendStatus {
    state.status()
}

/// Re-verify the staged set, swap it in, then reload the page so it is served. The caller
/// (src/falcon.ts) has already detached its body; nothing reloads unless the swap succeeded.
#[tauri::command]
pub async fn falcon_frontend_reload(
    state: State<'_, Arc<FrontendState>>,
    window: tauri::WebviewWindow,
) -> Result<FrontendStatus, String> {
    let previous = state.snapshot();
    let status = state.reload()?;
    if let Err(error) = window.reload() {
        // The swap happened but the page did not reload: put the old set back so `loaded` stays
        // truthful, the banner stays and Reload can retry.
        state.restore(previous);
        return Err(format!("reload: {error}"));
    }
    state.arm_watchdog(window.app_handle().clone());
    Ok(status)
}

/// The shell page calls this once its boot is complete (first session list answered); it
/// disarms the watchdog that would otherwise fall back to the embedded assets.
#[tauri::command]
pub fn falcon_frontend_booted(state: State<'_, Arc<FrontendState>>) {
    state.mark_booted();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Manifest {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/falcon-frontend-manifest.json");
        let text = std::fs::read_to_string(&path).expect("fixture");
        serde_json::from_str(&text).expect("fixture parses")
    }

    #[test]
    fn fixture_digest_recomputes() {
        let manifest = fixture();
        assert_eq!(tree_digest(&manifest.files), manifest.digest);
        assert!(is_digest(&manifest.digest) && is_digest(&manifest.shell_key));
    }

    #[test]
    fn verify_rejects_wrong_bytes_and_accepts_matching_ones() {
        let manifest = fixture();
        let wrong = verify_manifest(&manifest, &|_| Ok(b"not the file".to_vec()));
        assert!(wrong.is_err());
        // a one-file manifest built from known bytes verifies and keys with a leading slash
        let body = b"<html></html>".to_vec();
        let entries = vec![FileEntry { path: "falcon.html".into(), sha256: sha256_hex(&body), bytes: body.len() as u64 }];
        let built = Manifest { schema: 1, digest: tree_digest(&entries), shell_key: manifest.shell_key, files: entries };
        let files = verify_manifest(&built, &|_| Ok(body.clone())).expect("verifies");
        assert!(files.contains_key("/falcon.html"));
    }

    fn serving(digest: &str, epoch: u64) -> Inner {
        Inner { loaded_staged: Some(digest.into()), failed: None, bad: None, booted: false, epoch }
    }

    #[test]
    fn unacknowledged_set_falls_back_and_is_barred() {
        let mut inner = serving("aa", 3);
        assert!(inner.watching(3) && !inner.watching(2));
        assert_eq!(inner.fall_back(3).as_deref(), Some("aa"));
        assert!(inner.loaded_staged.is_none() && inner.is_bad("aa") && !inner.is_bad("bb"));
        assert_eq!(inner.failed.as_ref().map(|f| f.1.as_str()), Some(BOOT_FAILURE));
        // epoch moved on: the same watchdog cannot fire twice, and a stale one is ignored
        assert!(inner.fall_back(3).is_none());
    }

    #[test]
    fn acknowledged_or_stale_watchdog_does_nothing() {
        let mut inner = serving("aa", 1);
        inner.booted = true;
        assert!(inner.fall_back(1).is_none() && inner.loaded_staged.is_some() && inner.bad.is_none());
        let mut newer = serving("bb", 2);
        assert!(newer.fall_back(1).is_none());
    }

    #[test]
    fn manifest_paths_cannot_escape() {
        for bad in ["../x", "a/../b", "/abs", "a\\b", "c:/x", "a//b", ""] {
            assert!(!safe_relative(bad), "{bad}");
        }
        assert!(safe_relative("assets/a.js"));
    }
}
