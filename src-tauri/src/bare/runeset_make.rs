//! Library folder lookup under the rune imports dir.
use std::path::{Path, PathBuf};

use crate::rules::rune;

/// `library`'s folder under `imports` (not canonicalised), refused when its name or its real place is wrong.
pub(super) fn library_dir(imports: &Path, library: &str) -> Result<PathBuf, String> {
    rune::check_id(library).map_err(|_| format!("Library {library:?} is not a library name"))?;
    let outside = || format!("Library {library} has no folder under {}", imports.display());
    let base = imports.canonicalize().map_err(|_| outside())?;
    let dir = imports.join(library);
    let real = dir.canonicalize().map_err(|_| outside())?;
    if !real.is_dir() || !real.starts_with(&base) {
        return Err(outside());
    }
    Ok(dir)
}
