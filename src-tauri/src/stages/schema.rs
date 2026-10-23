//! src-tauri\src\stages\schema.rs — the `stage.json` schema and its validation on read.
//! Pure: no filesystem here, so every refusal is testable without a folder on disk.
//!
//! A stage pack is data only: a background image and/or a `.glb` set inside the pack folder,
//! plus colour, fog and camera hints. Never code, never HDRI (cut from v1). Unknown keys are
//! refused, so a typo is a broken stage with a reason rather than a silent default.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_STAGE_JSON: usize = 16 * 1024;
const MAX_ID_CHARS: usize = 64;
const MAX_LABEL_CHARS: usize = 64;
const MAX_FILE_CHARS: usize = 128;
pub const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp"];
pub const GLB_EXT: &[&str] = &["glb"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Background {
    /// A png, jpg or webp file name in the pack folder, drawn behind everything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// A `.glb` file name in the pack folder: a self-contained GLB v2, drawn unlit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glb: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fog {
    pub near: f64,
    pub far: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Camera {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub far: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_distance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_distance: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stage {
    pub id: String,
    pub label: String,
    /// Checked by `modules::compat::check_pack_compat` before the typed parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<Value>,
    pub background: Background,
    /// `#rrggbb`: the clear colour when there is no image, and the fog colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colour: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fog: Option<Fog>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<Camera>,
}

/// A stage id is the config's `characterStage` value and names its folder: 1-64 of `[a-z0-9-]`,
/// not starting with `-`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
}

/// A plain file name inside the pack folder: no separators, no drive or stream colon, no
/// leading dot, no trailing dot or space, one of `exts`.
pub fn valid_file(name: &str, exts: &[&str]) -> Result<(), String> {
    let bad = name.is_empty()
        || name.chars().count() > MAX_FILE_CHARS
        || name.contains(['/', '\\', ':'])
        || name.starts_with('.')
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| c.is_control());
    if bad {
        return Err(format!("\"{name}\" must be a plain file name in the stage folder"));
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if !exts.contains(&ext.as_str()) {
        return Err(format!("\"{name}\" must be one of .{}", exts.join(", .")));
    }
    Ok(())
}

fn in_range(v: f64, lo: f64, hi: f64) -> bool {
    v.is_finite() && v >= lo && v <= hi
}

fn valid_colour(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Any key naming an HDRI, at the top level or under `background`, or an `.hdr`/`.exr` image.
fn mentions_hdri(raw: &Value) -> bool {
    let keyed = |v: &Value| v.as_object().is_some_and(|o| o.keys().any(|k| k.to_ascii_lowercase().contains("hdr")));
    let bg = raw.get("background");
    let hdr_file = bg
        .and_then(|b| b.get("image"))
        .and_then(Value::as_str)
        .is_some_and(|s| {
            let l = s.to_ascii_lowercase();
            l.ends_with(".hdr") || l.ends_with(".exr")
        });
    keyed(raw) || bg.is_some_and(keyed) || hdr_file
}

pub fn validate(stage: &Stage, folder: &str) -> Result<(), String> {
    if !valid_id(&stage.id) {
        return Err(format!("id \"{}\" must be 1-64 lowercase letters, digits or -", stage.id));
    }
    if stage.id != folder {
        return Err(format!("id \"{}\" does not match its folder \"{folder}\"", stage.id));
    }
    let label = stage.label.trim();
    if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS {
        return Err("label must be 1-64 characters".into());
    }
    if let Some(image) = &stage.background.image {
        valid_file(image, IMAGE_EXT).map_err(|e| format!("background.image {e}"))?;
    }
    if let Some(glb) = &stage.background.glb {
        valid_file(glb, GLB_EXT).map_err(|e| format!("background.glb {e}"))?;
    }
    if let Some(c) = &stage.colour {
        if !valid_colour(c) {
            return Err("colour must be #rrggbb".into());
        }
    }
    if let Some(f) = stage.fog {
        if !in_range(f.near, 0.0, 100_000.0) || !in_range(f.far, 0.0, 100_000.0) || f.far <= f.near {
            return Err("fog needs 0 <= near < far <= 100000".into());
        }
    }
    if let Some(c) = stage.camera {
        if c.far.is_some_and(|v| !in_range(v, 10.0, 100_000.0)) {
            return Err("camera.far must be 10 to 100000".into());
        }
        if c.min_distance.is_some_and(|v| !in_range(v, 0.0, 1000.0)) {
            return Err("camera.minDistance must be 0 to 1000".into());
        }
        if c.max_distance.is_some_and(|v| !in_range(v, 0.1, 10_000.0)) {
            return Err("camera.maxDistance must be 0.1 to 10000".into());
        }
        if let (Some(lo), Some(hi)) = (c.min_distance, c.max_distance) {
            if lo > hi {
                return Err("camera.minDistance is above camera.maxDistance".into());
            }
        }
        if let (Some(far), Some(hi)) = (c.far, c.max_distance) {
            if hi >= far {
                return Err("camera.maxDistance must be below camera.far".into());
            }
        }
    }
    Ok(())
}

/// Parse and validate the bytes of one `stage.json` from folder `folder`, against this core's
/// version and contract. The error is the reason the listing shows for a broken stage.
pub fn parse(bytes: &[u8], folder: &str, core_version: &str, core_contract: u64) -> Result<Stage, String> {
    if bytes.len() > MAX_STAGE_JSON {
        return Err(format!("stage.json is over {} KiB", MAX_STAGE_JSON / 1024));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "stage.json is not UTF-8".to_string())?;
    let text = crate::settings::store::strip_bom(text);
    let raw: Value = serde_json::from_str(text).map_err(|e| format!("stage.json: {e}"))?;
    if !raw.is_object() {
        return Err("stage.json must be an object".into());
    }
    if mentions_hdri(&raw) {
        return Err("HDRI backgrounds are not supported".into());
    }
    crate::modules::compat::check_pack_compat(&raw, core_version, core_contract)?;
    let stage: Stage = serde_json::from_value(raw).map_err(|e| format!("stage.json: {e}"))?;
    validate(&stage, folder)?;
    Ok(stage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_value(v: &Value, folder: &str) -> Result<Stage, String> {
        parse(v.to_string().as_bytes(), folder, "0.5.0", 1)
    }

    fn base() -> Value {
        json!({
            "id": "neon-yard",
            "label": "Neon Yard",
            "background": { "image": "sky.webp", "glb": "yard.glb" },
            "colour": "#0a1a38",
            "fog": { "near": 10, "far": 120 },
            "camera": { "far": 600, "minDistance": 1, "maxDistance": 20 }
        })
    }

    #[test]
    fn a_valid_stage_parses() {
        let s = parse_value(&base(), "neon-yard").expect("valid");
        assert_eq!(s.label, "Neon Yard");
        assert_eq!(s.background.glb.as_deref(), Some("yard.glb"));
        assert_eq!(s.camera.and_then(|c| c.max_distance), Some(20.0));
        // the smallest stage: id, label, an empty background
        assert!(parse_value(&json!({ "id": "plain", "label": "Plain", "background": {} }), "plain").is_ok());
    }

    #[test]
    fn a_bad_id_is_refused() {
        for id in ["Neon", "neon_yard", "-neon", "", "neon yard"] {
            let mut v = base();
            v["id"] = json!(id);
            assert!(parse_value(&v, id).is_err(), "{id:?} should be refused");
        }
        // a valid id in the wrong folder
        assert!(parse_value(&base(), "other").unwrap_err().contains("does not match its folder"));
    }

    #[test]
    fn an_unknown_key_is_refused() {
        let mut v = base();
        v["script"] = json!("main.js");
        assert!(parse_value(&v, "neon-yard").unwrap_err().contains("unknown field"));
        let mut v = base();
        v["camera"]["fov"] = json!(40);
        assert!(parse_value(&v, "neon-yard").unwrap_err().contains("unknown field"));
    }

    #[test]
    fn hdri_is_refused() {
        let mut v = base();
        v["background"]["hdri"] = json!("sky.hdr");
        assert_eq!(parse_value(&v, "neon-yard").unwrap_err(), "HDRI backgrounds are not supported");
        let mut v = base();
        v["background"]["image"] = json!("sky.exr");
        assert_eq!(parse_value(&v, "neon-yard").unwrap_err(), "HDRI backgrounds are not supported");
        let mut v = base();
        v["hdri"] = json!({});
        assert_eq!(parse_value(&v, "neon-yard").unwrap_err(), "HDRI backgrounds are not supported");
    }

    #[test]
    fn a_compat_refusal_is_the_reason() {
        let mut v = base();
        v["requires"] = json!({ "contract": 1, "minCore": "9.0.0" });
        assert_eq!(parse_value(&v, "neon-yard").unwrap_err(), "Needs Vidar 9.0.0 or Newer");
        let mut v = base();
        v["release"] = json!("not-a-version");
        assert_eq!(parse_value(&v, "neon-yard").unwrap_err(), "release Is Not A Version");
        let mut v = base();
        v["requires"] = json!({ "contract": 1, "minCore": "0.1.0" });
        v["release"] = json!("1.0.0");
        assert!(parse_value(&v, "neon-yard").is_ok());
    }

    #[test]
    fn file_names_and_ranges_are_bounded() {
        for bad in ["..\\x.glb", "a/b.glb", "C:x.glb", ".glb", "yard.gltf", "yard.glb.", "yard.js"] {
            let mut v = base();
            v["background"]["glb"] = json!(bad);
            assert!(parse_value(&v, "neon-yard").is_err(), "{bad:?} should be refused");
        }
        let mut v = base();
        v["background"]["image"] = json!("sky.gif");
        assert!(parse_value(&v, "neon-yard").is_err());
        let mut v = base();
        v["colour"] = json!("blue");
        assert!(parse_value(&v, "neon-yard").is_err());
        let mut v = base();
        v["fog"] = json!({ "near": 50, "far": 10 });
        assert!(parse_value(&v, "neon-yard").is_err());
        let mut v = base();
        v["camera"] = json!({ "minDistance": 30, "maxDistance": 20 });
        assert!(parse_value(&v, "neon-yard").is_err());
        let mut v = base();
        v["camera"] = json!({ "far": 1 });
        assert!(parse_value(&v, "neon-yard").is_err());
        let mut v = base();
        v["camera"] = json!({ "far": 100, "maxDistance": 100 });
        assert!(parse_value(&v, "neon-yard").unwrap_err().contains("below camera.far"));
        v["camera"] = json!({ "far": 100, "maxDistance": 50 });
        assert!(parse_value(&v, "neon-yard").is_ok());
        assert!(parse(&vec![b' '; MAX_STAGE_JSON + 1], "neon-yard", "0.5.0", 1).unwrap_err().contains("over"));
    }
}
