//! Codex version skew between hosted sessions and new tabs. A hosted Codex session runs the
//! native package `falcon-build.ps1` copied into Falcon's store (pinned by the bundle's
//! `runtime-manifest.json`, src-falcon/src/codex.rs `CodexRuntime::resolve`); a Rendered or Raw
//! tab runs the npm-global package (`agent::codex_js`). `update_cli` or `npm i -g` moves the
//! second only, so the two differ until a Falcon refresh builds a bundle on the new copy.
//! Both versions are read from package.json files: no process spawn.
use std::path::{Path, PathBuf};
use serde::Serialize;
use serde_json::Value;

/// The npm native package both sides carry (falcon-build.ps1 copies it whole, package.json included).
const NATIVE: &str = r"node_modules\@openai\codex-win32-x64";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CodexSkew {
    pub hosted: String,
    pub tabs: String,
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `version` of a Codex native package dir, only when its package.json names `@openai/codex`.
fn package_version(dir: &Path) -> Option<String> {
    let json = read_json(&dir.join("package.json"))?;
    if json["name"].as_str()? != "@openai/codex" { return None; }
    let version = json["version"].as_str()?;
    (!version.is_empty() && version.len() < 100).then(|| version.to_string())
}

fn plain_name(text: &str) -> bool {
    let mut parts = Path::new(text).components();
    matches!((parts.next(), parts.next()), (Some(std::path::Component::Normal(_)), None))
}

/// The Codex version the bundle `current.json` names runs: pointer → bundle manifest → store dir.
/// `None` when any link is missing (no Falcon built yet, a pre-Codex bundle).
pub(crate) fn hosted_version(pointer: &Path, bundles: &Path, store: &Path) -> Option<String> {
    let bundle_id = read_json(pointer)?["bundle_id"].as_str()?.to_string();
    if !plain_name(&bundle_id) { return None; }
    let manifest = read_json(&bundles.join(&bundle_id).join("runtime-manifest.json"))?;
    let store_id = manifest["codex"]["store_id"].as_str()?;
    if store_id.len() != 64 || !store_id.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    package_version(&store.join("codex").join(store_id))
}

/// The Codex version new tabs run: the native package under the npm-global `@openai/codex`
/// (the same dir falcon-build.ps1 copies from).
pub(crate) fn tabs_version(codex_package: &Path) -> Option<String> {
    package_version(&codex_package.join(NATIVE))
}

pub(crate) fn detect(pointer: &Path, bundles: &Path, store: &Path, codex_package: &Path) -> Option<CodexSkew> {
    let hosted = hosted_version(pointer, bundles, store)?;
    let tabs = tabs_version(codex_package)?;
    (hosted != tabs).then_some(CodexSkew { hosted, tabs })
}

/// A contract path under the root, when it exists on disk.
fn on_disk(root: &Path, id: &str) -> Option<PathBuf> {
    Some(root.join(crate::paths::rel(id))).filter(|p| p.exists())
}

fn check() -> Option<CodexSkew> {
    let root = crate::paths::root();
    let pointer = on_disk(&root, "falconPointer")?;
    let bundles = on_disk(&root, "falconBundles")?;
    let store = on_disk(&root, "falconStore")?;
    // codex.js sits at <package>\bin\codex.js.
    let package = crate::agent::codex_js().ok()?.parent()?.parent()?.to_path_buf();
    detect(&pointer, &bundles, &store, &package)
}

#[tauri::command]
pub async fn codex_skew() -> Result<Option<CodexSkew>, String> {
    tauri::async_runtime::spawn_blocking(check).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rig { dir: PathBuf }
    impl Drop for Rig { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); } }

    fn package(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("package.json"),
            serde_json::json!({ "name": "@openai/codex", "version": version }).to_string()).unwrap();
    }

    /// A Falcon tree whose current bundle pins `hosted`, and an npm package carrying `tabs`.
    fn rig(name: &str, hosted: &str, tabs: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("vidar-codex-skew-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store_id = "b".repeat(64);
        package(&dir.join(r"store\codex").join(&store_id), hosted);
        std::fs::create_dir_all(dir.join(r"bundles\0.1.0-abc")).unwrap();
        std::fs::write(dir.join(r"bundles\0.1.0-abc\runtime-manifest.json"),
            serde_json::json!({ "codex": { "store_id": store_id } }).to_string()).unwrap();
        std::fs::write(dir.join("current.json"), r#"{"bundle_id":"0.1.0-abc"}"#).unwrap();
        package(&dir.join("npm").join(NATIVE), tabs);
        Rig { dir }
    }

    fn run(rig: &Rig) -> Option<CodexSkew> {
        let d = &rig.dir;
        detect(&d.join("current.json"), &d.join("bundles"), &d.join("store"), &d.join("npm"))
    }

    #[test]
    fn codex_skew_reports_differing_hosted_and_tab_versions() {
        let r = rig("differ", "0.162.1-win32-x64", "0.163.0-win32-x64");
        assert_eq!(run(&r), Some(CodexSkew { hosted: "0.162.1-win32-x64".into(), tabs: "0.163.0-win32-x64".into() }));
    }

    #[test]
    fn codex_skew_is_none_when_versions_match() {
        let r = rig("same", "0.162.1-win32-x64", "0.162.1-win32-x64");
        assert_eq!(run(&r), None);
    }

    #[test]
    fn codex_skew_is_none_when_a_link_is_missing() {
        let r = rig("missing", "0.162.1-win32-x64", "0.163.0-win32-x64");
        std::fs::write(r.dir.join("current.json"), r#"{"bundle_id":"..\\escape"}"#).unwrap();
        assert_eq!(run(&r), None);
        std::fs::remove_file(r.dir.join("current.json")).unwrap();
        assert_eq!(run(&r), None);
        let r = rig("nonpm", "0.162.1-win32-x64", "0.163.0-win32-x64");
        std::fs::remove_dir_all(r.dir.join("npm")).unwrap();
        assert_eq!(run(&r), None);
    }
}
