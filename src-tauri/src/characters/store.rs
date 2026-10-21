//! src-tauri\src\characters\store.rs — the pack folders on disk and the `vidar.json`
//! `characters` key (`order`, `default`). One pack per folder under `paths::characters_dir()`;
//! folders starting with `_` or `.` are not packs (`_removed` holds retired ones). Order is
//! authoritative: listed ids first in that order, then any other folder by name.
//!
//! Targets (acb3df98 review): a valid pack is addressed by its id; any other row by
//! `folder:<folder name>`. Ids are lowercase slugs and never contain `:`, so the two cannot
//! meet, and a command on an invalid row only ever touches that row's folder.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;

use super::pack::{self, Invalid, Pack, MAX_PACK_JSON};

/// Serialises every pack write (add, re-pin, update, remove, default) in this process.
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// Takes the pack-write lock; a poisoned lock is recovered, since it guards no data.
pub fn lock() -> MutexGuard<'static, ()> {
    STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// The target prefix for a row addressed by its folder rather than an id.
pub const FOLDER_TARGET: &str = "folder:";

pub struct Found {
    /// The id this row holds: a valid pack's, or an invalid pack's whose id still parses.
    /// None when the pack is unreadable or an earlier row already holds the id.
    pub id: Option<String>,
    pub folder: String,
    pub dir: PathBuf,
    pub parsed: Result<Pack, Invalid>,
}

impl Found {
    /// How the webview addresses this row in `repin` / `update` / `remove`.
    pub fn target(&self) -> String {
        match (&self.parsed, &self.id) {
            (Ok(_), Some(id)) => id.clone(),
            _ => format!("{FOLDER_TARGET}{}", self.folder),
        }
    }
}

fn read_pack(dir: &Path) -> Result<Pack, Invalid> {
    let f = std::fs::File::open(dir.join("character.json")).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Invalid::bare("no character.json in the folder"),
        _ => Invalid::bare(format!("character.json: {e}")),
    })?;
    let mut buf = Vec::new();
    f.take(MAX_PACK_JSON as u64 + 1).read_to_end(&mut buf).map_err(|e| Invalid::bare(format!("character.json: {e}")))?;
    pack::parse(&buf)
}

fn scan_at(root: &Path) -> Vec<Found> {
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<Found> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let folder = e.file_name().to_string_lossy().into_owned();
            if folder.starts_with('_') || folder.starts_with('.') {
                return None;
            }
            let dir = e.path();
            let parsed = read_pack(&dir);
            let id = match &parsed {
                Ok(p) => Some(p.id.clone()),
                Err(inv) => inv.identity.as_ref().map(|i| i.id.clone()),
            };
            Some(Found { id, folder, dir, parsed })
        })
        .collect();
    out.sort_by(|a, b| a.folder.cmp(&b.folder));
    out
}

/// `order` first, then the rest by folder name, then rows holding no id. At one rank a valid
/// pack comes before an invalid one. A later row carrying an id already seen loses it (and a
/// valid one is marked invalid), so an id always names one row.
pub fn ordered(mut found: Vec<Found>, order: &[String]) -> Vec<Found> {
    let rank = |f: &Found| {
        let bucket = match f.id.as_ref().map(|id| order.iter().position(|o| o == id)) {
            Some(Some(i)) => (0, i),
            Some(None) => (1, 0),
            None => (2, 0),
        };
        (bucket, f.parsed.is_err())
    };
    found.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.folder.cmp(&b.folder)));
    let mut seen = std::collections::HashSet::new();
    for f in &mut found {
        let Some(id) = f.id.clone() else { continue };
        if seen.insert(id.clone()) {
            continue;
        }
        let dup = format!("id \"{id}\" is already used by another pack");
        f.id = None;
        match &mut f.parsed {
            Ok(_) => f.parsed = Err(Invalid::bare(dup)),
            Err(inv) => {
                inv.identity = None;
                inv.reason = format!("{}; {dup}", inv.reason);
            }
        }
    }
    found
}

pub struct CharactersCfg {
    pub order: Vec<String>,
    pub default: Option<String>,
}

impl CharactersCfg {
    /// Drops a retired row's id from order and default. A row holding no id touches neither.
    pub fn forget(&mut self, id: Option<&str>) {
        let Some(id) = id else { return };
        self.order.retain(|o| o != id);
        if self.default.as_deref() == Some(id) {
            self.default = None;
        }
    }
}

pub fn read_cfg() -> CharactersCfg {
    let root = crate::fsx::read_json::<Value>(&crate::paths::config_path()).ok();
    let chars = root.as_ref().and_then(|r| r.get("characters"));
    let order = chars
        .and_then(|c| c.get("order"))
        .and_then(|o| o.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let default = chars.and_then(|c| c.get("default")).and_then(|d| d.as_str()).map(str::to_string);
    CharactersCfg { order, default }
}

/// Read-modify-write of `vidar.json` `characters`; other keys inside it survive.
pub fn write_cfg(edit: impl FnOnce(&mut CharactersCfg)) -> Result<(), String> {
    let mut cfg = read_cfg();
    edit(&mut cfg);
    crate::settings::store::with_config_root(|obj| {
        let chars = obj.entry("characters").or_insert_with(|| Value::Object(Default::default()));
        if !chars.is_object() {
            *chars = Value::Object(Default::default());
        }
        let chars = chars.as_object_mut().expect("object");
        chars.insert("order".into(), Value::from(cfg.order.clone()));
        chars.insert("default".into(), cfg.default.clone().map(Value::from).unwrap_or(Value::Null));
        Ok(())
    })
}

/// Every pack folder, in list order.
pub fn scan() -> Vec<Found> {
    ordered(scan_at(&crate::paths::characters_dir()), &read_cfg().order)
}

/// The row a target names: `folder:<name>` that folder, whatever its state; otherwise the
/// valid pack with that id. An id never reaches an invalid row.
fn find_in(found: Vec<Found>, target: &str) -> Result<Found, String> {
    let hit = match target.strip_prefix(FOLDER_TARGET) {
        Some(folder) => found.into_iter().find(|f| f.folder == folder),
        None => found.into_iter().find(|f| f.parsed.is_ok() && f.id.as_deref() == Some(target)),
    };
    hit.ok_or_else(|| format!("no character \"{target}\""))
}

pub fn find(target: &str) -> Result<Found, String> {
    find_in(scan(), target)
}

pub fn find_valid(target: &str) -> Result<(Found, Pack), String> {
    let found = find(target)?;
    match &found.parsed {
        Ok(p) => {
            let p = p.clone();
            Ok((found, p))
        }
        Err(e) => Err(format!("{target} is invalid: {}", e.reason)),
    }
}

/// Validates, serialises, and refuses anything the read side would reject as oversize,
/// before the atomic replace.
pub fn write_pack(dir: &Path, pack: &Pack) -> Result<(), String> {
    pack::validate(pack)?;
    let json = serde_json::to_string_pretty(pack).map_err(|e| e.to_string())?;
    if json.len() > MAX_PACK_JSON {
        return Err(format!(
            "character.json would be {} KiB, over the {} KiB limit; shorten it (extra keys count too)",
            json.len().div_ceil(1024),
            MAX_PACK_JSON / 1024
        ));
    }
    crate::fsx::atomic_write(&dir.join("character.json"), json.as_bytes())
}

/// A fresh id from a file stem: its slug, then `-2`, `-3`… past every id and folder name in
/// use. Never an existing id: the folder is created with `create_dir`, which fails if present.
pub fn allocate_id(stem: &str, found: &[Found]) -> String {
    let base = pack::slug(stem);
    let taken = |id: &str| found.iter().any(|f| f.id.as_deref() == Some(id) || f.folder.eq_ignore_ascii_case(id));
    if !taken(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}-{n}")).find(|id| !taken(id)).expect("unbounded")
}

pub fn create_pack(pack: &Pack) -> Result<PathBuf, String> {
    let root = crate::paths::characters_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let dir = root.join(&pack.id);
    std::fs::create_dir(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    if let Err(e) = write_pack(&dir, pack) {
        let _ = std::fs::remove_dir(&dir);
        return Err(e);
    }
    Ok(dir)
}

/// Moves the folder to `<root>\_removed\<folder>-<unix seconds>`; nothing is deleted.
fn retire_at(root: &Path, found: &Found) -> Result<PathBuf, String> {
    let removed = root.join("_removed");
    std::fs::create_dir_all(&removed).map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let target = removed.join(format!("{}-{secs}", found.folder));
    std::fs::rename(&found.dir, &target).map_err(|e| format!("could not move {}: {e}", found.dir.display()))?;
    Ok(target)
}

/// Retires the row a target names and forgets the id it held (if any) from `cfg`.
fn remove_at(root: &Path, order: &[String], target: &str, cfg: &mut CharactersCfg) -> Result<PathBuf, String> {
    let found = find_in(ordered(scan_at(root), order), target)?;
    let moved = retire_at(root, &found)?;
    cfg.forget(found.id.as_deref());
    Ok(moved)
}

/// `remove_character`: retire the folder, then drop its id from `vidar.json` `characters`.
pub fn remove(target: &str) -> Result<(), String> {
    let root = crate::paths::characters_dir();
    let mut cfg = read_cfg();
    let order = cfg.order.clone();
    remove_at(&root, &order, target, &mut cfg)?;
    write_cfg(|c| *c = cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_text(id: &str) -> String {
        serde_json::json!({
            "id": id,
            "name": id,
            "model": { "path": "C:\\m\\x.glb", "bytes": 1, "sha256": "a".repeat(64) },
            "material": "auto",
            "answersTo": []
        })
        .to_string()
    }

    #[test]
    fn removing_an_invalid_row_retires_only_its_folder() {
        let root = std::env::temp_dir().join(format!("vidar-characters-remove-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        std::fs::write(root.join("a").join("character.json"), pack_text("b")).unwrap();
        std::fs::write(root.join("b").join("character.json"), "{ not json").unwrap();
        let order = vec!["b".to_string()];

        let rows = ordered(scan_at(&root), &order);
        let targets: Vec<String> = rows.iter().map(Found::target).collect();
        assert_eq!(targets, ["b", "folder:b"], "the invalid folder `b` is not addressed as id `b`");
        assert_eq!(find_in(rows, "b").unwrap().folder, "a");

        let mut cfg = CharactersCfg { order: order.clone(), default: Some("b".into()) };
        let moved = remove_at(&root, &order, "folder:b", &mut cfg).unwrap();
        assert!(moved.starts_with(root.join("_removed")));
        assert!(!root.join("b").exists(), "folder b retired");
        assert!(root.join("a").join("character.json").exists(), "folder a untouched");
        assert_eq!((cfg.order.as_slice(), cfg.default.as_deref()), (order.as_slice(), Some("b")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
