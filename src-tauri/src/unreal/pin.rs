//! Engine pin: which engine folder the user named for a project.
//!
//! the unrealPins file under runtime/bridge, keyed by the project root (lower-cased, forward
//! slashes). A pin is the user naming the engine, never a default; no pin means ask. The
//! `.uproject` engine association is never read. Choices offered for a new pin are past pins
//! only, never a disk scan.

use super::discover;
use crate::fsx;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginePin {
    pub root: String,
    pub uproject: String,
    pub engine: String,
    pub engine_version: String,
    pub pinned_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineChoice {
    pub engine: String,
    pub engine_version: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PinFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    projects: BTreeMap<String, EnginePin>,
    /// Every engine ever pinned, kept after a pin is cleared so Clear does not lose the choice.
    #[serde(default)]
    past: BTreeMap<String, EngineChoice>,
}

/// Case and slash normal form used for keys.
pub fn norm_key(p: &str) -> String {
    let s = p.replace('\\', "/").to_lowercase();
    let s = s.trim_end_matches('/');
    s.strip_prefix("//?/").unwrap_or(s).to_owned()
}

fn load(file: &Path) -> Result<PinFile, String> {
    match fsx::read_text(file) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("Pin file is not valid: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PinFile::default()),
        Err(e) => Err(format!("Pin file unreadable: {e}")),
    }
}

fn save(file: &Path, mut doc: PinFile) -> Result<(), String> {
    doc.version = 1;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let bytes = fsx::json_pretty_bytes(&doc, true)?;
    fsx::atomic_write(file, &bytes)
}

/// `5.8.2` from `<engine>/Engine/Build/Build.version`, or None when the folder is not an engine.
fn engine_version(engine: &Path) -> Option<String> {
    let text = fsx::read_text(&engine.join("Engine").join("Build").join("Build.version")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let n = |k: &str| v.get(k).and_then(serde_json::Value::as_u64);
    Some(format!("{}.{}.{}", n("MajorVersion")?, n("MinorVersion")?, n("PatchVersion").unwrap_or(0)))
}

pub fn pin_at(file: &Path, root: &str) -> Result<Option<EnginePin>, String> {
    Ok(load(file)?.projects.get(&norm_key(root)).cloned())
}

pub fn choices_at(file: &Path) -> Result<Vec<EngineChoice>, String> {
    Ok(load(file)?.past.into_values().collect())
}

/// `engine: None` clears the pin. A set refuses a root that is not itself a project root and
/// a folder without `Engine/Build/Build.version`.
pub fn pin_set_at(file: &Path, root: &str, engine: Option<&str>) -> Result<Option<EnginePin>, String> {
    let key = norm_key(root);
    let uproject = discover::find_uproject(Path::new(root)).ok_or("No project at this root")?;
    let parent = uproject.parent().map(|p| norm_key(&p.to_string_lossy())).unwrap_or_default();
    if parent != key {
        return Err("Not a project root: the .uproject lives elsewhere".into());
    }
    let mut doc = load(file)?;
    let Some(engine) = engine else {
        doc.projects.remove(&key);
        save(file, doc)?;
        return Ok(None);
    };
    let engine_path = PathBuf::from(engine);
    let version = engine_version(&engine_path).ok_or("Not an engine folder: Engine/Build/Build.version is missing")?;
    let pin = EnginePin {
        root: root.replace('/', "\\"),
        uproject: uproject.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        engine: engine.replace('/', "\\"),
        engine_version: version,
        pinned_at: fsx::now_ms(),
    };
    doc.past.insert(
        norm_key(engine),
        EngineChoice { engine: pin.engine.clone(), engine_version: pin.engine_version.clone() },
    );
    doc.projects.insert(key, pin.clone());
    save(file, doc)?;
    Ok(Some(pin))
}

#[tauri::command]
pub async fn unreal_engine_pin(root: String) -> Result<Option<EnginePin>, String> {
    super::blocking("unreal_engine_pin", move || pin_at(&crate::paths::unreal_pins_path(), &root)).await
}

#[tauri::command]
pub async fn unreal_engine_pin_set(root: String, engine: Option<String>) -> Result<Option<EnginePin>, String> {
    super::blocking("unreal_engine_pin_set", move || {
        pin_set_at(&crate::paths::unreal_pins_path(), &root, engine.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn unreal_engine_choices() -> Result<Vec<EngineChoice>, String> {
    super::blocking("unreal_engine_choices", || choices_at(&crate::paths::unreal_pins_path())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vidar-pin-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn project(base: &Path, name: &str) -> PathBuf {
        let p = base.join(name);
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join(format!("{name}.uproject")), "{}").unwrap();
        p
    }

    fn engine(base: &Path, name: &str) -> PathBuf {
        let e = base.join(name);
        let dir = e.join("Engine").join("Build");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Build.version"), r#"{"MajorVersion":5,"MinorVersion":8,"PatchVersion":2}"#).unwrap();
        e
    }

    #[test]
    fn pin_set_refuses_a_non_engine_and_a_non_project_root() {
        let d = scratch("refuse");
        let proj = project(&d, "Acme");
        let file = d.join("bridge").join("pins-test.json");
        let not_engine = d.join("Plain");
        fs::create_dir_all(&not_engine).unwrap();
        let err = pin_set_at(&file, &proj.to_string_lossy(), Some(&not_engine.to_string_lossy())).unwrap_err();
        assert!(err.contains("Not an engine folder"), "{err}");
        // the parent of a project is not a project root: find_uproject scans down and finds Acme
        let eng = engine(&d, "UE");
        let err = pin_set_at(&file, &d.to_string_lossy(), Some(&eng.to_string_lossy())).unwrap_err();
        assert!(err.contains("Not a project root"), "{err}");
        assert!(!file.exists(), "a refusal writes nothing");
    }

    #[test]
    fn pin_round_trips_normalises_keys_and_clear_keeps_the_choice() {
        let d = scratch("trip");
        let proj = project(&d, "Acme");
        let eng = engine(&d, "UE");
        let file = d.join("bridge").join("pins-test.json");
        let root = proj.to_string_lossy().to_string();
        let pin = pin_set_at(&file, &root, Some(&eng.to_string_lossy())).unwrap().unwrap();
        assert_eq!(pin.engine_version, "5.8.2");
        assert_eq!(pin.uproject, "Acme.uproject");
        // read back under a different case and slash form
        let alt = root.replace('\\', "/").to_uppercase();
        assert_eq!(pin_at(&file, &alt).unwrap(), Some(pin.clone()));
        assert_eq!(choices_at(&file).unwrap().len(), 1);
        assert_eq!(pin_set_at(&file, &root, None).unwrap(), None);
        assert_eq!(pin_at(&file, &root).unwrap(), None);
        assert_eq!(choices_at(&file).unwrap()[0].engine_version, "5.8.2");
    }

    #[test]
    fn choices_without_a_file_are_empty_and_never_scan_disk() {
        let d = scratch("empty");
        assert!(choices_at(&d.join("none.json")).unwrap().is_empty());
    }
}
