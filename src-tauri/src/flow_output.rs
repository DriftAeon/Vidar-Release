//! src-tauri\src\flow_output.rs — per-node full output files for Flow runs.
//!
//! `<flowStore>/runs/<run_id>/<node_id>.md`, UTF-8 without BOM, the full uncapped
//! final text of the latest attempt. Events carry a capped copy; this is the
//! uncapped one. Written by `flow::reap`, read by `flow_output_read`.

use std::fs;
use std::path::{Path, PathBuf};

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn file_in(root: &Path, run_id: &str, node_id: &str) -> Result<PathBuf, String> {
    if !valid_id(run_id) || !valid_id(node_id) {
        return Err("bad id".into());
    }
    Ok(root.join("runs").join(run_id).join(format!("{node_id}.md")))
}

/// The store root; tests (flow transport tests run the real `reap`) write under temp instead.
fn store_root() -> PathBuf {
    if cfg!(test) {
        std::env::temp_dir().join("vidar-flow-output-test")
    } else {
        crate::paths::flow_store_dir()
    }
}

/// The store path for a node's output file (ids validated).
pub(crate) fn output_path(run_id: &str, node_id: &str) -> Result<PathBuf, String> {
    file_in(&store_root(), run_id, node_id)
}

fn write_in(root: &Path, run_id: &str, node_id: &str, text: &str) -> Result<(), String> {
    let path = file_in(root, run_id, node_id)?;
    if text.is_empty() {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove output: {e}")),
        };
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create output dir: {e}"))?;
    }
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, text.as_bytes()).map_err(|e| format!("write output: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("replace output: {e}")
    })
}

fn read_in(root: &Path, run_id: &str, node_id: &str) -> Result<Option<String>, String> {
    let path = file_in(root, run_id, node_id)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read output: {e}")),
    }
}

pub(crate) fn write_output(run_id: &str, node_id: &str, text: &str) -> Result<(), String> {
    write_in(&store_root(), run_id, node_id, text)
}

#[tauri::command]
pub async fn flow_output_read(
    window: tauri::WebviewWindow,
    run_id: String,
    node_id: String,
) -> Result<Option<String>, String> {
    crate::flow_store::main_only(&window)?;
    if !valid_id(&run_id) || !valid_id(&node_id) {
        return Err("bad id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        read_in(&store_root(), &run_id, &node_id)
    })
    .await
    .map_err(|e| format!("read output join: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("vidar-flow-output-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn bad_ids_are_refused() {
        let root = temp_root("bad");
        let long = "a".repeat(65);
        for bad in ["..", "a/b", "a\\b", "", long.as_str()] {
            assert_eq!(write_in(&root, bad, "n", "x"), Err("bad id".to_string()), "run {bad:?}");
            assert_eq!(write_in(&root, "r", bad, "x"), Err("bad id".to_string()), "node {bad:?}");
            assert_eq!(read_in(&root, bad, "n"), Err("bad id".to_string()));
        }
        assert!(!root.exists());
    }

    #[test]
    fn write_then_read_round_trips() {
        let root = temp_root("rt");
        let text = "full output\nline two \u{2713}";
        write_in(&root, "run-1", "node_A", text).unwrap();
        assert_eq!(read_in(&root, "run-1", "node_A").unwrap().as_deref(), Some(text));
        write_in(&root, "run-1", "node_A", "second").unwrap();
        assert_eq!(read_in(&root, "run-1", "node_A").unwrap().as_deref(), Some("second"));
        let bytes = fs::read(file_in(&root, "run-1", "node_A").unwrap()).unwrap();
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_text_removes_the_file() {
        let root = temp_root("empty");
        write_in(&root, "r", "n", "something").unwrap();
        write_in(&root, "r", "n", "").unwrap();
        assert_eq!(read_in(&root, "r", "n").unwrap(), None);
        write_in(&root, "r", "n", "").unwrap(); // missing file is fine
        let _ = fs::remove_dir_all(&root);
    }
}
