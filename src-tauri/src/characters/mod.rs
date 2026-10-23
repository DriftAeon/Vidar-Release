//! src-tauri\src\characters\mod.rs — the character pack commands.
//!
//! Trust on first use, owned by Rust: add and re-pin open the native `.glb` picker here and
//! pin what Rust read; the webview never supplies a model path or a digest. `update_character`
//! takes only name, material (a renderer id), answersTo, lighting and playrate (`pack::apply_patch`).
//! Split: `pack.rs` schema and limits, `store.rs` folders and `vidar.json` `characters`,
//! `pin.rs` hashing and status.

mod pack;
mod pin;
mod store;

use serde::Serialize;
use serde_json::Value;

pub use pack::ModelPin;
use pack::{Claim, Pack};
use pin::Status;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterEntry {
    /// The id this row holds; null for an unreadable folder or a duplicate id.
    id: Option<String>,
    /// What `repin` / `update` / `remove` take: the id of a valid pack, `folder:<name>`
    /// for anything else (`store.rs` header).
    target: String,
    folder: String,
    /// The pack folder, for Open Folder.
    dir: String,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// The model file's size today, when it could be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    current_bytes: Option<u64>,
    /// Absent when the pack is invalid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pack: Option<Pack>,
    /// An invalid pack's claims, when its id and answersTo still parse: they stay reserved.
    #[serde(skip_serializing_if = "Option::is_none")]
    answers_to: Option<Vec<Claim>>,
}

#[derive(Serialize)]
pub struct CharacterList {
    packs: Vec<CharacterEntry>,
    default: Option<String>,
}

fn list_blocking(fresh: bool) -> CharacterList {
    let cfg = store::read_cfg();
    let packs = store::scan()
        .into_iter()
        .map(|f| {
            let dir = f.dir.to_string_lossy().into_owned();
            let target = f.target();
            match f.parsed {
                Ok(pack) => {
                    let (status, reason, current_bytes) = pin::check(&pack, fresh);
                    CharacterEntry {
                        id: f.id, target, folder: f.folder, dir, status, reason, current_bytes, pack: Some(pack), answers_to: None,
                    }
                }
                Err(invalid) => CharacterEntry {
                    id: f.id,
                    target,
                    folder: f.folder,
                    dir,
                    status: Status::Invalid,
                    reason: Some(invalid.reason),
                    current_bytes: None,
                    pack: None,
                    answers_to: invalid.identity.map(|i| i.answers_to),
                },
            }
        })
        .collect();
    CharacterList { packs, default: cfg.default }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Every pack with its status (ok | missing | changed | invalid, with a reason), in order.
/// `refresh` (Settings › Characters opening) rehashes every model instead of trusting the
/// len+mtime cache.
#[tauri::command]
pub async fn list_characters(refresh: Option<bool>) -> Result<CharacterList, String> {
    let fresh = refresh.unwrap_or(false);
    blocking(move || list_blocking(fresh)).await
}

/// Picker → new pack. The id is a slug of the file stem, de-duplicated; it is appended to
/// `characters.order`. Ok(None) = cancelled.
#[tauri::command]
pub async fn add_character(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let Some(path) = crate::folder_pick::pick_glb(&window, "Add Character", None).await? else {
        return Ok(None);
    };
    blocking(move || {
        let pin = pin::take(&path)?;
        let _guard = store::lock();
        let found = store::scan();
        let stem = std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let id = store::allocate_id(&stem, &found);
        let name: String = stem.trim().chars().take(64).collect();
        let pack = Pack {
            id: id.clone(),
            name: if name.is_empty() { id.clone() } else { name },
            model: pin,
            material: "auto".into(),
            lighting: None,
            playrate: Default::default(),
            answers_to: Vec::new(),
            extra: Default::default(),
        };
        store::create_pack(&pack)?;
        store::write_cfg(|cfg| {
            if !cfg.order.contains(&id) {
                cfg.order.push(id.clone());
            }
        })?;
        Ok(Some(id))
    })
    .await?
}

/// `pick = false` re-hashes the pack's current path (Pin New File); `pick = true` opens the
/// picker at it (Browse). Ok(false) = the picker was cancelled. `target` is the entry's.
#[tauri::command]
pub async fn repin_character(window: tauri::WebviewWindow, target: String, pick: bool) -> Result<bool, String> {
    let (_, current) = blocking({
        let target = target.clone();
        move || store::find_valid(&target)
    })
    .await??;
    let path = if pick {
        match crate::folder_pick::pick_glb(&window, &format!("Model For {}", current.name), Some(current.model.path.clone())).await? {
            Some(p) => p,
            None => return Ok(false),
        }
    } else {
        current.model.path.clone()
    };
    blocking(move || {
        let pin = pin::take(&path)?;
        let _guard = store::lock();
        let (found, mut pack) = store::find_valid(&target)?;
        pack.model = pin;
        store::write_pack(&found.dir, &pack)?;
        Ok(true)
    })
    .await?
}

/// Name, material, answersTo, lighting, playrate only; model fields and id are ignored.
#[tauri::command]
pub async fn update_character(target: String, patch: Value) -> Result<(), String> {
    blocking(move || {
        let _guard = store::lock();
        let (found, pack) = store::find_valid(&target)?;
        let next = pack::apply_patch(&pack, &patch)?;
        store::write_pack(&found.dir, &next)
    })
    .await?
}

/// Moves the target's folder to `characters\_removed\<folder>-<unix>` and drops the id it
/// held (if any) from order and default. Nothing is deleted.
#[tauri::command]
pub async fn remove_character(target: String) -> Result<(), String> {
    blocking(move || {
        let _guard = store::lock();
        store::remove(&target)
    })
    .await?
}

/// `characters.default`: the pack for a tab nothing else matches; None = the placeholder.
/// Only a valid pack's id.
#[tauri::command]
pub async fn set_default_character(id: Option<String>) -> Result<(), String> {
    blocking(move || {
        let _guard = store::lock();
        if let Some(id) = &id {
            if id.starts_with(store::FOLDER_TARGET) {
                return Err(format!("{id} is not a character id"));
            }
            store::find_valid(id)?;
        }
        store::write_cfg(|cfg| cfg.default = id)
    })
    .await?
}

/// The pin `bridge::read_character_model` loads against. Only a valid pack has one.
pub(crate) fn model_pin(id: &str) -> Result<ModelPin, String> {
    if id.starts_with(store::FOLDER_TARGET) {
        return Err(format!("{id} is not a character id"));
    }
    store::find_valid(id).map(|(_, pack)| pack.model)
}
