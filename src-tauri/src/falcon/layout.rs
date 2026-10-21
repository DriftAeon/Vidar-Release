//! Falcon's own path layout under the Vidar root: `<vidar>\runtime\bridge\…`.
//!
//! The Falcon shell compiles this file by `#[path]` (through `falcon.rs`), so it
//! cannot reach `crate::paths` or `include_str!` the contract: it carries its own
//! constants instead, pinned to `contracts/paths.json` by the test below.
//! The pre-09-29 `<vidar>\bridge\…` shape is gone. The shell takes the root from
//! its `--registry` path (`match_registry`).

// The shell build compiles this file too and uses only part of it (no store,
// pointer or bundles), so unused items there are expected.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// The directories under the Vidar root, relative to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shape {
    /// The bridge dir (`bridge` id in the contract).
    pub bridge: &'static str,
    /// `bridge\falcon` (`falcon` id).
    pub falcon: &'static str,
    /// The host's `--registry` path (`falconRegistry` id). Spelled out in full
    /// because `match_registry` walks it back segment by segment.
    pub registry: &'static str,
    /// Vidar's `vidar-state.json` (`uiState` id); the shell reads the theme pref from it.
    pub ui_state: &'static str,
}

pub const RUNTIME: Shape = Shape {
    bridge: "runtime\\bridge",
    falcon: "runtime\\bridge\\falcon",
    registry: "runtime\\bridge\\falcon\\runtime\\registry.json",
    ui_state: "runtime\\vidar-state.json",
};

// Under `Shape::falcon`.
/// `falcon-build.ps1`'s content-addressed store (`falconStore`).
pub const STORE: &str = "store";
/// Immutable bundles (`falconBundles`).
pub const BUNDLES: &str = "bundles";
/// The bundle pointer `falcon-refresh.ps1` writes (`falconPointer`).
pub const POINTER: &str = "current.json";
/// Staged Falcon-shell frontends (`falconFrontends`).
pub const FRONTENDS: &str = "frontend";
/// The staged-frontend pointer, under `FRONTENDS` (`falconFrontendPointer`).
pub const FRONTEND_POINTER: &str = "frontend\\current.json";
/// Jettison/dock handoff and dock-request files; not in the contract (Falcon-private).
pub const HANDOFF_JETTISON: &str = "handoff-jettison.json";
pub const HANDOFF_DOCK: &str = "handoff-dock.json";
pub const DOCK_REQUEST: &str = "dock-request.json";
pub const DOCK_REQUEST_CLAIMED: &str = "dock-request.json.claimed";
pub const DOCK_RESULT: &str = "dock-result.json";

// Under `Shape::bridge`.
/// The ask gate's open dir (`open`).
pub const OPEN: &str = "open";
/// Its dispatch queue (`openDispatch`).
pub const OPEN_DISPATCH: &str = "open\\dispatch";

/// The Vidar root and shape back from a host's `--registry` path: the host is
/// launched with cwd = its bundle dir and only `--registry`/`--store` name the
/// tree, so this is the one place the shell learns where it lives. `RUNTIME` is
/// matches `RUNTIME`; any other layout, or a relative path, is refused
/// rather than guessed.
pub fn match_registry(registry: &Path) -> Result<(PathBuf, Shape), String> {
    let shape = RUNTIME;
    let Some(root) = strip_registry(registry, shape) else {
        return Err(format!(
            "cannot find the Vidar folder from --registry {}: expected <vidar>\\{}",
            registry.display(),
            shape.registry
        ));
    };
    // `is_absolute` on Windows needs prefix + root, so `.\`, `..\`, `\` and
    // `C:` forms are refused too, not just a bare relative path.
    if !registry.is_absolute() {
        return Err(format!(
            "cannot find the Vidar folder from --registry {}: the path is relative, expected <vidar>\\{}",
            registry.display(),
            shape.registry
        ));
    }
    Ok((root.to_path_buf(), shape))
}

/// `registry` minus `shape.registry`, innermost segment first, compared
/// case-insensitively; `None` when any segment differs or the path runs out.
fn strip_registry(registry: &Path, shape: Shape) -> Option<&Path> {
    let mut root = registry;
    for expected in shape.registry.rsplit('\\') {
        let name = root.file_name().and_then(|name| name.to_str())?;
        let parent = root.parent()?;
        if !name.eq_ignore_ascii_case(expected) {
            return None;
        }
        root = parent;
    }
    Some(root)
}

#[cfg(all(test, not(falcon_shell)))]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Resolves a contract id to a root-relative path with `\` separators.
    fn resolve(ids: &Value, id: &str) -> String {
        let entry = &ids[id];
        assert!(entry.is_object(), "contracts/paths.json has no id {id}");
        let rel = entry["rel"].as_str().expect("rel").replace('/', "\\");
        match entry["under"].as_str().expect("under") {
            "root" => rel,
            parent => format!("{}\\{rel}", resolve(ids, parent)),
        }
    }

    /// Falcon cannot include the contract, so this pins its copy to it: every
    /// id it shares with `contracts/paths.json` resolves to the same path.
    #[test]
    fn layout_matches_the_paths_contract() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/paths.json");
        let text = std::fs::read_to_string(&path).expect("read contracts/paths.json");
        let contract: Value = serde_json::from_str(&text).expect("parse contracts/paths.json");
        let ids = &contract["ids"];
        for shape in [RUNTIME] {
            let expected = [
                ("bridge", shape.bridge.to_string()),
                ("falcon", shape.falcon.to_string()),
                ("falconRegistry", shape.registry.to_string()),
                ("falconStore", format!("{}\\{STORE}", shape.falcon)),
                ("falconBundles", format!("{}\\{BUNDLES}", shape.falcon)),
                ("falconPointer", format!("{}\\{POINTER}", shape.falcon)),
                ("falconFrontends", format!("{}\\{FRONTENDS}", shape.falcon)),
                ("falconFrontendPointer", format!("{}\\{FRONTEND_POINTER}", shape.falcon)),
                ("uiState", shape.ui_state.to_string()),
                ("open", format!("{}\\{OPEN}", shape.bridge)),
                ("openDispatch", format!("{}\\{OPEN_DISPATCH}", shape.bridge)),
            ];
            for (id, ours) in expected {
                assert_eq!(ours, resolve(ids, id), "id {id}");
            }
        }
    }

    /// The shell's `--registry` path alone gives the root.
    #[test]
    fn match_registry_returns_the_root_and_shape() {
        let root = PathBuf::from("D:\\Somewhere Else\\Vidar");
        let registry = root.join(RUNTIME.registry);
        assert_eq!(
            match_registry(&registry).expect("match"),
            (root.clone(), RUNTIME),
            "{}",
            registry.display()
        );
        let old = root.join("bridge\\falcon\\runtime\\registry.json");
        assert!(match_registry(&old).is_err(), "the pre-09-29 shape is refused");
    }
}
