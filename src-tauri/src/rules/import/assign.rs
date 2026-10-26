//! src-tauri\src\rules\import\assign.rs — legacy row assignments for import scan.
//! - Read side: `rows_by_brick` maps each brick id to the rows whose set holds it: the set files each row's
//!   refs name in this library, counting only rows vidar.json still points at it.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

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

/// The set names the row `key`'s effective refs pick from `library`, in order.
fn sets_of(agents: &[Value], key: &str, library: &str) -> Vec<String> {
    let sets = agents.iter().rev().find(|a| key_of(a) == Some(key) && a.get("sets").is_some()).and_then(|a| a.get("sets"));
    let refs = sets.and_then(Value::as_array).into_iter().flatten();
    refs.filter(|r| ref_library(r) == Some(library)).filter_map(|r| r.get("set").and_then(Value::as_str)).map(str::to_string).collect()
}

/// Brick id -> row keys holding it, from `<dir>\sets\<set>.md` for each set a row vidar.json still points at
/// this library names.
pub fn rows_by_brick(dir: &Path, library: &str, agents: &[Value]) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for key in rows_using(agents, library) {
        for set in sets_of(agents, &key, library).iter().filter(|s| crate::rules::rune::check_id(s).is_ok()) {
            let Ok(text) = crate::fsx::read_text(&dir.join("sets").join(format!("{set}.md"))) else { continue };
            for id in slot_ids(&text) {
                let rows = out.entry(id).or_default();
                if !rows.contains(&key) {
                    rows.push(key.clone());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_by_brick_reads_the_set_each_row_names() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("vidar-assign-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(dir.join("sets")).unwrap();
        std::fs::write(dir.join("sets").join("lib.md"), "<?rune a?>\n<?rune b?>\n").unwrap();
        let agents = vec![json!({ "key": "x", "sets": [{ "library": "lib", "set": "lib" }] }), json!({ "key": "y", "sets": [] })];
        let got = rows_by_brick(&dir, "lib", &agents);
        assert_eq!(got.get("a"), Some(&vec!["x".to_string()]));
        assert_eq!(got.get("b"), Some(&vec!["x".to_string()]));
        assert_eq!(got.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
