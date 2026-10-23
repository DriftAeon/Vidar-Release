//! src-tauri\src\characters\pack.rs — the `character.json` schema, its validation on read,
//! and the one patch shape the webview may apply. Pure: no
//! filesystem here, so the limits are testable without a pack on disk.
//!
//! The model pin (`model.path/bytes/sha256`) is written only by Rust from a native pick
//! (`store.rs`); `apply_patch` never touches it or `id`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const MAX_PACK_JSON: usize = 64 * 1024;
pub const MAX_CLAIMS: usize = 64;
pub const MAX_KEY_CHARS: usize = 64;
const MAX_ID_CHARS: usize = 64;
const MAX_NAME_CHARS: usize = 64;
const MAX_PLAYRATES: usize = 64;
const MAX_MATERIAL_CHARS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimKind {
    Model,
    Role,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Claim {
    pub kind: ClaimKind,
    pub key: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelPin {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lighting {
    pub ambient: f64,
    pub key: f64,
    pub fill: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub id: String,
    pub name: String,
    pub model: ModelPin,
    /// A renderer id: `auto`, `standard`, or a webview renderer addon's id (`valid_material`).
    /// Whether it is installed is the webview's call; an unknown id renders Standard there.
    pub material: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lighting: Option<Lighting>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub playrate: BTreeMap<String, f64>,
    #[serde(default)]
    pub answers_to: Vec<Claim>,
    /// Keys this build does not model survive a Rust rewrite (update, re-pin).
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

/// An id keys `vidar.json` `characterViews` and `characters.order`: lowercase slug only.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && !id.starts_with(['-', '_'])
}

/// A file stem to an id candidate: lowercase, runs of anything else to one `-`.
pub fn slug(stem: &str) -> String {
    let mut out = String::new();
    for c in stem.chars().flat_map(|c| c.to_lowercase()) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let mut out: String = out.trim_matches('-').chars().take(48).collect();
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() { "character".into() } else { out }
}

/// `material`: `auto` or a renderer id, 1-32 of lowercase letters, digits and `-`.
pub fn valid_material(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_MATERIAL_CHARS
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn normalise_key(key: &str) -> String {
    key.trim().to_lowercase()
}

fn in_range(v: f64, lo: f64, hi: f64) -> bool {
    v.is_finite() && v >= lo && v <= hi
}

/// Every limit a pack must meet before it is listed as usable. The reason is shown in
/// Settings › Characters, so it names the field.
pub fn validate(pack: &Pack) -> Result<(), String> {
    if !valid_id(&pack.id) {
        return Err(format!("id \"{}\" must be 1-64 lowercase letters, digits, - or _", pack.id));
    }
    let name = pack.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err("name must be 1-64 characters".into());
    }
    if !valid_material(&pack.material) {
        return Err(format!("material \"{}\" must be auto or a renderer id: 1-32 lowercase letters, digits or -", pack.material));
    }
    if pack.model.path.trim().is_empty() {
        return Err("model.path is empty".into());
    }
    if pack.model.bytes == 0 || pack.model.bytes > crate::bridge::MAX_CHARACTER_GLB as u64 {
        return Err(format!("model.bytes must be 1 to {} MiB", crate::bridge::MAX_CHARACTER_GLB / 1024 / 1024));
    }
    let sha = &pack.model.sha256;
    if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("model.sha256 must be 64 lowercase hex digits".into());
    }
    if let Some(l) = pack.lighting {
        for (k, v) in [("ambient", l.ambient), ("key", l.key), ("fill", l.fill)] {
            if !in_range(v, 0.0, 2.0) {
                return Err(format!("lighting.{k} must be 0 to 2"));
            }
        }
    }
    if pack.playrate.len() > MAX_PLAYRATES {
        return Err(format!("playrate has more than {MAX_PLAYRATES} clips"));
    }
    for (clip, rate) in &pack.playrate {
        if clip.is_empty() || clip.chars().count() > MAX_KEY_CHARS {
            return Err("playrate clip names must be 1-64 characters".into());
        }
        if !in_range(*rate, 0.05, 4.0) {
            return Err(format!("playrate.{clip} must be 0.05 to 4"));
        }
    }
    if pack.answers_to.len() > MAX_CLAIMS {
        return Err(format!("answersTo has more than {MAX_CLAIMS} entries"));
    }
    for claim in &pack.answers_to {
        let key = claim.key.trim();
        if key.is_empty() || key.chars().count() > MAX_KEY_CHARS {
            return Err("answersTo keys must be 1-64 characters".into());
        }
    }
    Ok(())
}

/// What an unusable pack still says about itself: its id and claims, when those two parse and
/// meet their limits. It keeps the pack's claims reserved (the tab shows the placeholder rather
/// than falling through to the next claimant) and keeps its id out of anyone else's hands.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    #[serde(default)]
    pub answers_to: Vec<Claim>,
}

/// Why a pack is unusable, plus its identity when that part still parses.
#[derive(Clone, Debug, PartialEq)]
pub struct Invalid {
    pub reason: String,
    pub identity: Option<Identity>,
}

impl Invalid {
    pub fn bare(reason: impl Into<String>) -> Self {
        Invalid { reason: reason.into(), identity: None }
    }
}

fn identity(text: &str) -> Option<Identity> {
    let ident: Identity = serde_json::from_str(text).ok()?;
    let claims_ok = ident.answers_to.len() <= MAX_CLAIMS
        && ident.answers_to.iter().all(|c| {
            let key = c.key.trim();
            !key.is_empty() && key.chars().count() <= MAX_KEY_CHARS
        });
    (valid_id(&ident.id) && claims_ok).then_some(ident)
}

/// Parse and validate the bytes of one `character.json`. An invalid pack under the size cap
/// still reports its identity when the id and answersTo parse on their own.
pub fn parse(bytes: &[u8]) -> Result<Pack, Invalid> {
    if bytes.len() > MAX_PACK_JSON {
        return Err(Invalid::bare(format!("character.json is over {} KiB", MAX_PACK_JSON / 1024)));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Invalid::bare("character.json is not UTF-8"))?;
    let text = crate::settings::store::strip_bom(text);
    let invalid = |reason: String| Invalid { reason, identity: identity(text) };
    let pack: Pack = serde_json::from_str(text).map_err(|e| invalid(format!("character.json: {e}")))?;
    validate(&pack).map_err(invalid)?;
    Ok(pack)
}

/// The webview's edit: only `name`, `material`, `answersTo`, `lighting` and `playrate` are
/// read from `patch`; every other key (`id`, `model`, anything else) is ignored. `null`
/// clears `lighting` / `playrate`. Claim keys are stored normalised (trim + lowercase).
pub fn apply_patch(pack: &Pack, patch: &Value) -> Result<Pack, String> {
    let patch = patch.as_object().ok_or("a character patch must be an object")?;
    let mut tree = serde_json::to_value(pack).map_err(|e| e.to_string())?;
    let obj = tree.as_object_mut().ok_or("pack did not serialise to an object")?;
    for key in ["name", "material", "answersTo", "lighting", "playrate"] {
        match patch.get(key) {
            None => {}
            Some(Value::Null) if key == "lighting" || key == "playrate" => {
                obj.remove(key);
            }
            Some(v) => {
                obj.insert(key.to_string(), v.clone());
            }
        }
    }
    let mut next: Pack = serde_json::from_value(tree).map_err(|e| format!("invalid change: {e}"))?;
    next.id = pack.id.clone();
    next.model = pack.model.clone();
    next.name = next.name.trim().to_string();
    for claim in &mut next.answers_to {
        claim.key = normalise_key(&claim.key);
    }
    validate(&next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pack_json() -> Value {
        json!({
            "id": "sample",
            "name": "Sample",
            "model": { "path": "C:\\models\\sample.glb", "bytes": 1024, "sha256": "a".repeat(64) },
            "material": "cel",
            "lighting": { "ambient": 0.9, "key": 0.5, "fill": 0.1 },
            "playrate": { "bn01": 0.5 },
            "answersTo": [{ "kind": "model", "key": "opus" }]
        })
    }

    fn parse_value(v: &Value) -> Result<Pack, Invalid> {
        parse(serde_json::to_string(v).unwrap().as_bytes())
    }

    #[test]
    fn an_out_of_range_or_oversize_pack_is_invalid() {
        assert!(parse_value(&pack_json()).is_ok());
        let cases: [(&str, Value); 8] = [
            ("/lighting/ambient", json!(2.5)),
            ("/playrate/bn01", json!(0.01)),
            ("/playrate/bn01", json!(5)),
            ("/material", json!("Toon")),
            ("/material", json!("my toon")),
            ("/material", json!("x".repeat(33))),
            ("/model/bytes", json!(65 * 1024 * 1024)),
            ("/id", json!("../escape")),
        ];
        for (ptr, bad) in cases {
            let mut v = pack_json();
            *v.pointer_mut(ptr).unwrap() = bad;
            assert!(parse_value(&v).is_err(), "{ptr} should be invalid");
        }
        let mut many = pack_json();
        many["answersTo"] = Value::Array((0..65).map(|i| json!({ "kind": "agent", "key": format!("k{i}") })).collect());
        assert!(parse_value(&many).is_err(), "65 claims should be invalid");
        let mut long_key = pack_json();
        long_key["answersTo"] = json!([{ "kind": "model", "key": "x".repeat(65) }]);
        assert!(parse_value(&long_key).is_err(), "a 65-char key should be invalid");
        let mut big = pack_json();
        big["pad"] = json!("x".repeat(MAX_PACK_JSON));
        assert!(parse_value(&big).is_err(), "over 64 KiB should be invalid");
        // a render field out of range leaves the id and claims readable, so they stay reserved
        let mut dim = pack_json();
        dim["lighting"]["ambient"] = json!(2.5);
        let ident = parse_value(&dim).unwrap_err().identity.expect("identity survives");
        assert_eq!((ident.id.as_str(), ident.answers_to.len()), ("sample", 1));
    }

    #[test]
    fn material_is_a_renderer_id() {
        let longest = "x".repeat(32);
        for ok in ["auto", "cel", "standard", "toon", "my-toon-2", longest.as_str()] {
            let mut v = pack_json();
            v["material"] = json!(ok);
            assert_eq!(parse_value(&v).map(|p| p.material), Ok(ok.to_string()), "{ok} should be valid");
        }
        let pack = parse_value(&pack_json()).unwrap();
        assert_eq!(apply_patch(&pack, &json!({ "material": "toon" })).unwrap().material, "toon");
        assert!(apply_patch(&pack, &json!({ "material": "Toon Shader" })).is_err());
    }

    #[test]
    fn update_ignores_model_fields() {
        let pack = parse_value(&pack_json()).unwrap();
        let patch = json!({
            "id": "other",
            "model": { "path": "C:\\elsewhere\\evil.glb", "bytes": 1, "sha256": "b".repeat(64) },
            "name": "  Renamed ",
            "answersTo": [{ "kind": "agent", "key": " Codex " }],
            "lighting": null,
            "smuggled": { "path": "C:\\elsewhere\\evil.glb" }
        });
        let next = apply_patch(&pack, &patch).unwrap();
        assert!(!next.extra.contains_key("smuggled"), "an unknown incoming key is not added");
        assert_eq!(next.id, pack.id);
        assert_eq!(next.model, pack.model);
        assert_eq!(next.name, "Renamed");
        assert_eq!(next.answers_to, vec![Claim { kind: ClaimKind::Agent, key: "codex".into() }]);
        assert_eq!(next.lighting, None);
        assert_eq!(next.playrate, pack.playrate);
    }
}
