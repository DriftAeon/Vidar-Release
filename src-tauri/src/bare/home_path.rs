//! src-tauri\src\bare\home_path.rs — where a Vidar install's agent home lives (D2b), as a pure
//! function: `<local app data>\Vidar\homes\<install-root-key>`, the key being the Falcon host's
//! root suffix (`falcon/host_names.rs`). Mounted by `#[path]` in both crates: `bare/home.rs`
//! re-exports it for Vidar, and the Falcon shell (`src-falcon/src/main.rs`) places a hosted bare
//! session's home with it, so the two can never disagree (one resolver, one key scheme).

use std::path::{Path, PathBuf};

#[cfg(falcon_shell)]
use crate::falcon_client::host_names::root_suffix;
#[cfg(not(falcon_shell))]
use crate::falcon::host_names::root_suffix;

/// Folder under `%LOCALAPPDATA%` that holds the per-install homes (D2b).
pub const HOMES_REL: [&str; 2] = ["Vidar", "homes"];

/// `<local app data>\Vidar\homes\<install-root-key>`: one install root has one home and a moved
/// root starts a new one.
pub fn resolve_for(root: &Path, local_app_data: &Path) -> PathBuf {
    let mut p = local_app_data.to_path_buf();
    p.extend(HOMES_REL);
    p.join(root_suffix(root))
}

/// The shared login store's folder name beside the homes; a 16-hex root key never collides.
pub const SHARED: &str = "_shared";

/// `<local app data>\Vidar\homes\_shared`, the one login store for every home beside `home`
/// (Bare slice 2 A-D1, A-D5). `Some` only when `home`'s parent is a `…\Vidar\homes` folder, so a
/// test home anywhere else never shares, and a sandbox's own LOCALAPPDATA gets its own store.
#[cfg_attr(falcon_shell, allow(dead_code))]
pub fn shared_for(home: &Path) -> Option<PathBuf> {
    let parent = home.parent()?;
    let mut tail = parent.components().rev().map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase());
    let (homes, vidar) = (tail.next()?, tail.next()?);
    let own = home.file_name()?.to_string_lossy().to_ascii_lowercase();
    (homes == HOMES_REL[1] && vidar == HOMES_REL[0].to_ascii_lowercase() && own != SHARED).then(|| parent.join(SHARED))
}
