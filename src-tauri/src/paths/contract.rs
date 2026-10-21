//! src-tauri\src\paths\contract.rs — reader for `contracts/paths.json` (the layout contract).
//! std + serde_json only, no `crate::`. Src-tauri only: Falcon holds its own constants
//! (`falcon/layout.rs`, pinned to this file by a test) and never includes this module.
//!
//! `rel(id)` is the contract path under the root; `resolve(root, id)` is that rel joined onto the
//! root. One shape, no probing of the disk.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;

static CONTRACT: OnceLock<Value> = OnceLock::new();

fn contract() -> &'static Value {
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/paths.json"))
            .expect("contracts/paths.json is valid JSON")
    })
}

fn node(id: &str) -> &'static Value {
    let n = &contract()["ids"][id];
    assert!(!n.is_null(), "paths contract: unknown id \"{id}\"");
    n
}

fn push_rel(out: &mut PathBuf, rel: &str) {
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        out.push(seg);
    }
}

/// `{under, rel}` spec (an id node) composed down to the root.
fn compose(spec: &Value) -> PathBuf {
    let under = spec["under"].as_str().expect("paths contract: `under` is a string");
    let mut out = if under == "root" { PathBuf::new() } else { rel(under) };
    push_rel(&mut out, spec["rel"].as_str().expect("paths contract: `rel` is a string"));
    out
}

/// Path of `id` relative to the root.
pub fn rel(id: &str) -> PathBuf {
    compose(node(id))
}

/// Resolved absolute path of `id` under `root`.
pub fn resolve(root: &Path, id: &str) -> PathBuf {
    root.join(rel(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_is_the_contract_rel_under_the_root() {
        let t = std::env::temp_dir().join("vidar-contract-resolve");
        assert_eq!(resolve(&t, "windowState"), t.join("runtime").join("window-state.json"));
        assert_eq!(resolve(&t, "bridge"), t.join("runtime").join("bridge"));
        assert_eq!(resolve(&t, "display"), t.join("runtime").join("bridge").join("display"));
        assert_eq!(resolve(&t, "closeLock"), t.join("runtime").join("bridge").join("close-lock.json"));
        assert_eq!(resolve(&t, "config"), t.join("vidar.json"));
        assert_eq!(resolve(&t, "characters"), t.join("content").join("characters"));
    }
}
