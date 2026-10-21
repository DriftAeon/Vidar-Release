//! src-tauri\src\control\workbench.rs — `ctl.show`/`ctl.focus`. Path
//! confinement lives here; the actual open or focus is the
//! frontend's, through `src\control\registry.ts`, once the `ctl-show` /
//! `ctl-focus` event lands.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::policy::Requester;
use crate::bridge::display_child;

/// Resolved through `crate::paths::root()` (the runtime root resolved from the exe at
/// startup), rather than its own literal copy.
fn repo_root() -> PathBuf {
    crate::paths::root()
}

/// `.md`/`.txt` under the repo root (`bridge\` is already a child of it):
/// canonicalise, then a component prefix-check against the canonicalised
/// root. Canonicalising first means a junction resolves to its real target
/// before the check runs, so a junction that escapes the root is refused the
/// same as a plain `..`; UNC and alternate-data-stream forms are refused
/// before we ever touch the filesystem. `validate_drop_path` (`bridge/drop.rs`)
/// does none of this — it never rejects `..` or confines to the repo — so
/// this is new code, not a reuse.
fn confine_document(path: &str) -> Result<PathBuf, String> {
    confine_document_in(path, &repo_root())
}

/// UNC and device forms (`\\server`, `//server`, `/\`, `\\?\UNC\`, `\\.\`, NT `\??\`), with
/// either separator. Checked before any filesystem call: an `exists()` or
/// `canonicalize()` on `\\host\share` makes Windows authenticate to that host (NTLM leak).
fn is_unc_or_device(path: &str) -> bool {
    let p = path.replace('/', "\\");
    p.starts_with("\\\\") || p.starts_with("\\??\\")
}

fn confine_document_in(path: &str, root: &Path) -> Result<PathBuf, String> {
    if is_unc_or_device(path) {
        return Err("path refused: UNC".into());
    }
    if path.matches(':').count() > 1 {
        return Err("path refused: alternate data stream".into());
    }
    // Not-found and outside-the-repo collapse to the same message — a
    // distinct "not found" is an existence oracle for paths outside the repo.
    let canon = fs::canonicalize(path).map_err(|_| "path refused".to_string())?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("path refused".into());
    }
    Ok(canon)
}

pub fn show(app: &AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let path = payload.get("path").and_then(Value::as_str).ok_or_else(|| "show requires a path".to_string())?;
    let focus = payload.get("focus").and_then(Value::as_bool).unwrap_or(false);
    // Before the display branch's `exists()` and any other filesystem call.
    if is_unc_or_device(path) {
        return Err("path refused: UNC".into());
    }
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let (pane, out_path) = match ext.as_str() {
        "md" | "txt" => {
            let canon = confine_document(path)?;
            // canonicalize yields a verbatim `\\?\C:\...` path on Windows; the
            // webview's loader wants the plain form (same strip as editor.rs).
            ("document", canon.to_string_lossy().trim_start_matches("\\\\?\\").to_string())
        }
        "png" | "svg" | "html" => {
            // Names of files directly inside bridge\display only;
            // every other reason `display_child` might refuse collapses into
            // this one message on purpose — the caller gets the rule, not an
            // OS error string.
            // A bare name (the documented form) means a file in bridge\display.
            let full = if path.contains(['/', '\\']) {
                path.to_string()
            } else {
                crate::bridge::display_dir().join(path).display().to_string()
            };
            // Missing is the one refusal worth naming: the rule message misled
            // a caller whose name was right but whose file wasn't there.
            if !Path::new(&full).exists() {
                return Err(format!("display: not found: {path}"));
            }
            let (_, name) = display_child(&full).map_err(|_| "display: bridge\\display names only".to_string())?;
            // Document's Display group opens it by the path its catalog lists (display dir +
            // name, not the canonical `\\?\` form); the name came from the canonical path.
            ("display", crate::bridge::display_dir().join(&name).display().to_string())
        }
        _ => return Err("unsupported extension".into()),
    };
    app.emit(
        "ctl-show",
        json!({ "id": id, "pane": pane, "path": out_path, "focus": focus, "requester": requester.to_json() }),
    )
    .map_err(|e| e.to_string())
}

pub fn focus(app: &AppHandle, id: &str, requester: &Requester, payload: &Value) -> Result<(), String> {
    let target = payload.get("target").and_then(Value::as_str).ok_or_else(|| "focus requires a target".to_string())?;
    app.emit("ctl-focus", json!({ "id": id, "target": target, "requester": requester.to_json() }))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confine_is_component_prefixed() {
        let t = std::env::temp_dir().join(format!("vidar-confine-{}", std::process::id()));
        let _ = fs::remove_dir_all(&t);
        let root = t.join("Vidar");
        let sibling = t.join("Vidar2");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(root.join(r"docs\a.md"), b"").unwrap();
        fs::write(sibling.join("x.md"), b"").unwrap();

        let inside = root.join(r"docs\a.md");
        assert!(confine_document_in(&inside.display().to_string(), &root).is_ok());
        // Same string prefix, different component: outside.
        assert!(confine_document_in(&sibling.join("x.md").display().to_string(), &root).is_err());
        // `..` escape into the sibling.
        let escape = root.join(r"docs\..\..\Vidar2\x.md");
        assert!(confine_document_in(&escape.display().to_string(), &root).is_err());
        assert_eq!(
            confine_document_in(r"\\server\share\x.md", &root),
            Err("path refused: UNC".to_string())
        );

        fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn unc_and_device_forms_are_refused_by_string() {
        for p in [
            r"\\server\share\x.png",
            "//server/share/x.png",
            r"/\server\share\x.png",
            r"\/server\share\x.png",
            r"\\?\UNC\server\share\x.png",
            "//?/UNC/server/share/x.png",
            r"\\.\pipe\x.png",
            r"\??\UNC\server\share\x.png",
        ] {
            assert!(is_unc_or_device(p), "{p}");
        }
        for p in [r"D:\repo\x.png", "x.png", r"bridge\display\x.png", r"\repo\x.png"] {
            assert!(!is_unc_or_device(p), "{p}");
        }
    }
}
