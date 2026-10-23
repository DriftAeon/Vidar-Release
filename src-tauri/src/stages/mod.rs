//! src-tauri\src\stages\mod.rs — stage packs for the Character window: `list_stages` and
//! `read_stage_asset`.
//!
//! One pack per folder under `paths::stages_dir()` (`content\stages\<id>\stage.json`,
//! gitignored, the user's own); folders starting with `_` or `.` are skipped, and the folder
//! name is the id. Every read is bounded and opens the file itself, never a link (a reparse
//! point at the leaf is refused); the pack folder must not be a link either. A stage that fails
//! any check is listed as broken with its reason, never dropped. The webview never names a
//! path: it asks for a stage id and a part, and the file name comes from the pack Rust read.
//! Schema: `schema.rs`.

mod schema;

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub use schema::{valid_id as valid_stage_id, Stage};

/// At most this many stage folders are read per listing.
const MAX_STAGES: usize = 64;
const MAX_STAGE_IMAGE: usize = 16 * 1024 * 1024;
const MAX_STAGE_GLB: usize = 64 * 1024 * 1024;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StageStatus {
    Ok,
    Broken,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageEntry {
    /// The folder name when it is a valid id; null otherwise.
    id: Option<String>,
    folder: String,
    status: StageStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// Present only when the stage is ok.
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<Stage>,
}

#[derive(Debug, Serialize)]
pub struct StageList {
    stages: Vec<StageEntry>,
}

/// Bounded read of one file, opened without following a leaf link. `Ok(None)` = not found.
fn read_bounded(p: &Path, cap: usize) -> Result<Option<Vec<u8>>, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let f = match std::fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(p) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let md = f.metadata().map_err(|e| e.to_string())?;
    if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("links are not followed".into());
    }
    if !md.is_file() {
        return Err("not a regular file".into());
    }
    if md.len() > cap as u64 {
        return Err(format!("over {} KiB", cap / 1024));
    }
    let mut buf = Vec::with_capacity(cap.min(md.len() as usize + 1));
    f.take(cap as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() > cap {
        return Err(format!("over {} KiB", cap / 1024));
    }
    Ok(Some(buf))
}

/// A real directory, not a junction or symlink to one.
fn plain_dir(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0)
}

fn read_entry(dir: &Path, folder: &str, core_version: &str, core_contract: u64) -> StageEntry {
    let id = schema::valid_id(folder).then(|| folder.to_string());
    let broken = |reason: String| StageEntry { id: id.clone(), folder: folder.to_string(), status: StageStatus::Broken, reason: Some(reason), stage: None };
    match std::fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return broken("no such stage".into()),
        _ if !plain_dir(dir) => return broken("the stage folder is a link".into()),
        _ => {}
    }
    let bytes = match read_bounded(&dir.join("stage.json"), schema::MAX_STAGE_JSON) {
        Ok(Some(b)) => b,
        Ok(None) => return broken("no stage.json in the folder".into()),
        Err(e) => return broken(format!("stage.json: {e}")),
    };
    match schema::parse(&bytes, folder, core_version, core_contract) {
        Ok(stage) => StageEntry { id: id.clone(), folder: folder.to_string(), status: StageStatus::Ok, reason: None, stage: Some(stage) },
        Err(reason) => broken(reason),
    }
}

fn scan_at(root: &Path, core_version: &str, core_contract: u64) -> Vec<StageEntry> {
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    let mut folders: Vec<(String, PathBuf)> = rd
        .filter_map(|e| e.ok())
        // DirEntry::file_type does not follow links: a junction is not listed as a folder.
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .filter(|(name, _)| !name.starts_with('_') && !name.starts_with('.'))
        .collect();
    folders.sort_by(|a, b| a.0.cmp(&b.0));
    let over = folders.len() > MAX_STAGES;
    folders.truncate(MAX_STAGES);
    let mut entries: Vec<StageEntry> = folders.iter().map(|(folder, dir)| read_entry(dir, folder, core_version, core_contract)).collect();
    if over {
        entries.push(StageEntry {
            id: None,
            folder: "Stages Over 64 Skipped".into(),
            status: StageStatus::Broken,
            reason: Some(format!("only the first {MAX_STAGES} stage folders are read")),
            stage: None,
        });
    }
    entries
}

fn list_at(root: &Path) -> StageList {
    StageList { stages: scan_at(root, env!("CARGO_PKG_VERSION"), crate::modules::compat::CORE_CONTRACT) }
}

/// The one asset a stage names for `part` ("image" | "glb"), re-read and re-checked from its
/// stage.json. Image bytes must be png, jpg or webp; a glb must carry the GLB v2 header (the
/// webview then runs its own structure check before parsing).
fn read_asset_at(root: &Path, id: &str, part: &str) -> Result<Vec<u8>, String> {
    if !schema::valid_id(id) {
        return Err(format!("\"{id}\" is not a stage id"));
    }
    let entry = read_entry(&root.join(id), id, env!("CARGO_PKG_VERSION"), crate::modules::compat::CORE_CONTRACT);
    let Some(stage) = entry.stage else {
        return Err(format!("stage {id} is broken: {}", entry.reason.unwrap_or_default()));
    };
    let (name, cap) = match part {
        "image" => (stage.background.image, MAX_STAGE_IMAGE),
        "glb" => (stage.background.glb, MAX_STAGE_GLB),
        other => return Err(format!("\"{other}\" is not a stage part")),
    };
    let name = name.ok_or_else(|| format!("stage {id} has no background {part}"))?;
    let bytes = read_bounded(&root.join(id).join(&name), cap)
        .map_err(|e| format!("{name}: {e}"))?
        .ok_or_else(|| format!("{name} is missing"))?;
    let ok = match part {
        "image" => is_image(&bytes),
        _ => bytes.len() >= 12 && &bytes[..4] == b"glTF" && bytes[4..8] == 2u32.to_le_bytes(),
    };
    if !ok {
        return Err(format!("{name} is not a {} file", if part == "image" { "png, jpg or webp" } else { "GLB v2" }));
    }
    Ok(bytes)
}

fn is_image(b: &[u8]) -> bool {
    let png = b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let jpg = b.starts_with(&[0xff, 0xd8, 0xff]);
    let webp = b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP";
    png || jpg || webp
}

/// Every stage folder with its status (ok | broken, with a reason), by folder name.
#[tauri::command]
pub async fn list_stages() -> Result<StageList, String> {
    tauri::async_runtime::spawn_blocking(|| list_at(&crate::paths::stages_dir())).await.map_err(|e| e.to_string())
}

/// Raw bytes (ArrayBuffer in JS) of a stage's background `part`: "image" or "glb".
#[tauri::command]
pub async fn read_stage_asset(id: String, part: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || read_asset_at(&crate::paths::stages_dir(), &id, &part))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vidar-stages-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn put(root: &Path, folder: &str, file: &str, bytes: &[u8]) {
        std::fs::create_dir_all(root.join(folder)).unwrap();
        std::fs::write(root.join(folder).join(file), bytes).unwrap();
    }

    #[test]
    fn listing_marks_a_broken_stage_with_its_reason() {
        let root = temp_root("list");
        put(&root, "good", "stage.json", br##"{"id":"good","label":"Good","background":{"image":"sky.png"},"colour":"#102030"}"##);
        put(&root, "bad", "stage.json", br#"{"id":"bad","label":"Bad","background":{},"shader":"x.glsl"}"#);
        put(&root, "old", "stage.json", br#"{"id":"old","label":"Old","background":{},"requires":{"contract":1,"minCore":"99.0.0"}}"#);
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::create_dir_all(root.join("_removed")).unwrap();
        let list = scan_at(&root, "0.5.0", 1);
        let _ = std::fs::remove_dir_all(&root);
        let by = |f: &str| list.iter().find(|e| e.folder == f).unwrap_or_else(|| panic!("{f} listed"));
        assert_eq!(list.len(), 4, "_removed is skipped");
        assert_eq!(by("good").status, StageStatus::Ok);
        assert_eq!(by("good").stage.as_ref().map(|s| s.label.as_str()), Some("Good"));
        assert_eq!(by("bad").status, StageStatus::Broken);
        assert!(by("bad").reason.as_deref().unwrap().contains("unknown field"));
        assert_eq!(by("old").reason.as_deref(), Some("Needs Vidar 99.0.0 or Newer"));
        assert_eq!(by("empty").reason.as_deref(), Some("no stage.json in the folder"));
        assert_eq!(by("bad").id.as_deref(), Some("bad"));
    }

    #[test]
    fn an_asset_is_read_only_through_its_stage() {
        let root = temp_root("asset");
        put(&root, "sky", "stage.json", br#"{"id":"sky","label":"Sky","background":{"image":"sky.png","glb":"set.glb"}}"#);
        put(&root, "sky", "sky.png", &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
        put(&root, "sky", "set.glb", b"not a glb at all");
        let image = read_asset_at(&root, "sky", "image");
        let glb = read_asset_at(&root, "sky", "glb");
        let traversal = read_asset_at(&root, "..", "image");
        let part = read_asset_at(&root, "sky", "stage");
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(image.unwrap().len(), 10);
        assert!(glb.unwrap_err().contains("not a GLB v2"));
        assert!(traversal.unwrap_err().contains("not a stage id"));
        assert!(part.unwrap_err().contains("not a stage part"));
    }
}
