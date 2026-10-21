//! src-tauri\src\rules\import\assign.rs — which rows an import library's sets sit on (onboarding plan D8).
//! - Write side: `set_row_refs` edits vidar.json's `agents` in one read-modify-write under `CONFIG_LOCK`
//!   (`settings::store::with_config_root_at`). A row with bricks gets `{ library, set: "row-<key>" }` on
//!   the last entry with its key (`{ key }` appended when none); a row without loses this library's ref.
//!   Other libraries' refs stay, in order, except that a row gaining a ref also loses its `gen-<key>-*`
//!   generated-library ref.
//! - Read side: `rows_by_brick` maps each brick id to the rows whose set holds it, counting only rows
//!   vidar.json still points at this library (a set file is never deleted, so a dropped row's file stays).

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Map, Value};

fn key_of(v: &Value) -> Option<&str> {
    v.get("key").and_then(Value::as_str).filter(|k| !k.is_empty())
}

fn ref_library(r: &Value) -> Option<&str> {
    r.get("library").and_then(Value::as_str)
}

/// The keys whose effective `sets` (the last entry with that key holding a `sets` field, as
/// `bare/layer.rs` `row_sets` reads them) name `library`.
pub fn rows_using(agents: &[Value], library: &str) -> Vec<String> {
    let mut keys: Vec<String> = agents.iter().filter_map(key_of).map(str::to_string).collect();
    keys.dedup();
    let mut out: Vec<String> = Vec::new();
    for k in keys {
        let sets = agents.iter().rev().find(|a| key_of(a) == Some(k.as_str()) && a.get("sets").is_some()).and_then(|a| a.get("sets"));
        let uses = sets.and_then(Value::as_array).is_some_and(|s| s.iter().any(|r| ref_library(r) == Some(library)));
        if uses && !out.contains(&k) {
            out.push(k);
        }
    }
    out
}

/// Edits the `agents` list in `obj`: every key in `rows` with ids gets this library's ref, every key in
/// `rows` without ids loses it, and a row not in `rows` is left alone. Returns the keys that hold a ref afterwards, in `rows` order.
pub fn set_row_refs_in(obj: &mut Map<String, Value>, library: &str, rows: &[(String, Vec<String>)]) -> Result<Vec<String>, String> {
    let wanted: Vec<&str> = rows.iter().filter(|(_, ids)| !ids.is_empty()).map(|(k, _)| k.as_str()).collect();
    if wanted.is_empty() && !obj.contains_key("agents") {
        return Ok(Vec::new());
    }
    let agents = obj.entry("agents").or_insert_with(|| Value::Array(Vec::new()));
    let list = agents.as_array_mut().ok_or("vidar.json `agents` is not a list")?;
    // Only the rows sent are touched (an empty one loses this library's ref); a row not sent keeps its refs.
    let mut touched: Vec<String> = Vec::new();
    for (k, _) in rows {
        if !touched.contains(k) {
            touched.push(k.clone());
        }
    }
    for key in &touched {
        let want = wanted.contains(&key.as_str());
        let effective: Vec<Value> = list
            .iter()
            .rev()
            .find(|a| key_of(a) == Some(key.as_str()) && a.get("sets").is_some())
            .and_then(|a| a.get("sets"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let had_sets = list.iter().any(|a| key_of(a) == Some(key.as_str()) && a.get("sets").is_some());
        let mine = json!({ "library": library, "set": format!("row-{key}") });
        let mut sets: Vec<Value> = Vec::new();
        let mut placed = false;
        for r in effective {
            // Import Raw on a row also drops its generated library's ref (rune generator D2): the row
            // revision changes, so a generation still running refuses to commit.
            if want && ref_library(&r).is_some_and(|l| l != library && crate::rules::generate::land::is_generation_of(l, key)) {
                continue;
            }
            if ref_library(&r) == Some(library) {
                if want && !placed {
                    sets.push(mine.clone());
                    placed = true;
                }
            } else {
                sets.push(r);
            }
        }
        if want && !placed {
            sets.push(mine);
        }
        let at = match list.iter().rposition(|a| key_of(a) == Some(key.as_str())) {
            Some(i) => i,
            None if want => {
                list.push(json!({ "key": key }));
                list.len() - 1
            }
            None => continue,
        };
        let entry = list[at].as_object_mut().ok_or_else(|| format!("vidar.json agents entry {key:?} is not an object"))?;
        if sets.is_empty() && !had_sets {
            entry.remove("sets");
        } else {
            entry.insert("sets".to_string(), Value::Array(sets));
        }
    }
    // The edit must still parse as the typed list `read_config` uses.
    serde_json::from_value::<Vec<crate::settings::schema::AgentCfg>>(Value::Array(list.clone())).map_err(|e| format!("agents: {e}"))?;
    Ok(wanted.into_iter().map(str::to_string).collect())
}

/// `set_row_refs_in` over vidar.json at `config`, read-modify-write inside one locked closure.
pub fn set_row_refs(config: &Path, library: &str, rows: &[(String, Vec<String>)]) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    crate::settings::store::with_config_root_at(config, |obj| {
        keys = set_row_refs_in(obj, library, rows)?;
        Ok(())
    })?;
    Ok(keys)
}

/// The `agents` list of vidar.json at `config`, read-only; a missing or unreadable file gives none.
pub fn read_agents(config: &Path) -> Vec<Value> {
    let Ok(text) = crate::fsx::read_text(config) else { return Vec::new() };
    let root: Value = serde_json::from_str(crate::fsx::strip_bom(&text)).unwrap_or(Value::Null);
    root.get("agents").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Rune ids named by `<?rune id?>` slots in `text`.
fn slot_ids(text: &str) -> Vec<String> {
    text.split("<?rune ").skip(1).filter_map(|t| t.split_once("?>")).map(|(id, _)| id.trim().to_string()).collect()
}

/// Brick id -> row keys holding it, from `<dir>\sets\row-<key>.md` for each row vidar.json still points at
/// this library.
pub fn rows_by_brick(dir: &Path, library: &str, agents: &[Value]) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for key in rows_using(agents, library) {
        let Ok(text) = crate::fsx::read_text(&dir.join("sets").join(format!("row-{key}.md"))) else { continue };
        for id in slot_ids(&text) {
            let rows = out.entry(id).or_default();
            if !rows.contains(&key) {
                rows.push(key.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn a_row_key_is_reported_and_matched_as_written() {
        let mut o = obj(json!({ "agents": [{ "key": " x" }] }));
        let keys = set_row_refs_in(&mut o, "lib", &[(" x".to_string(), vec!["a".to_string()])]).unwrap();
        assert_eq!(keys, vec![" x".to_string()]);
        assert_eq!(o["agents"].as_array().unwrap().len(), 1, "the entry was found, not appended");
        assert_eq!(o["agents"][0]["sets"], json!([{ "library": "lib", "set": "row- x" }]));
    }

    #[test]
    fn a_row_not_sent_keeps_its_ref() {
        let mine = json!({ "library": "lib", "set": "row-off" });
        let mut o = obj(json!({ "agents": [{ "key": "off", "disabled": true, "sets": [mine.clone()] }, { "key": "on", "sets": [mine.clone()] }] }));
        set_row_refs_in(&mut o, "lib", &[("on".to_string(), vec![])]).unwrap();
        assert_eq!(o["agents"][0]["sets"], json!([mine]));
        assert_eq!(o["agents"][1]["sets"], json!([]));
    }
}
