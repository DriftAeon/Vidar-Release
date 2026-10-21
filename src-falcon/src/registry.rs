use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use windows::{
    core::PCWSTR,
    Win32::Storage::FileSystem::{
        CreateDirectoryW, MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    },
};

use crate::security::{reject_reparse, wide_path, UserSecurity};

// The record itself lives in a leaf file so Vidar's client can `#[path]` it in
// without this module's Win32 and security dependencies.
mod record;
pub use record::FalconRegistry;

pub fn prepare_registry_parent(path: &Path, security: &UserSecurity) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("registry has no parent: {}", path.display()))?;
    if parent.exists() {
        reject_reparse(parent)?;
    } else {
        let wide = wide_path(parent)?;
        unsafe {
            CreateDirectoryW(PCWSTR(wide.as_ptr()), Some(security.attributes()))
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
    }
    security.apply_to_path(parent)?;
    Ok(parent.to_path_buf())
}

pub fn publish(
    path: &Path,
    registry: &FalconRegistry,
    security: &UserSecurity,
) -> Result<(), String> {
    let parent = prepare_registry_parent(path, security)?;
    reject_reparse(&parent)?;
    if path.exists() {
        reject_reparse(path)?;
    }

    let temporary = parent.join(format!(".registry-{}.tmp", uuid::Uuid::new_v4().simple()));
    let payload = serde_json::to_vec_pretty(registry).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("create {}: {error}", temporary.display()))?;
    security.apply_to_path(&temporary)?;
    file.write_all(&payload)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("write {}: {error}", temporary.display()))?;
    drop(file);

    let from = wide_path(&temporary)?;
    let to = wide_path(path)?;
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| format!("publish {}: {error}", path.display()))?;
    }
    Ok(())
}

pub fn read(path: &Path) -> Result<FalconRegistry, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("registry has no parent: {}", path.display()))?;
    reject_reparse(parent)?;
    reject_reparse(path)?;
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("parse {}: {error}", path.display()))
}
