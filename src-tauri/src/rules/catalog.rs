//! src-tauri\src\rules\catalog.rs — `runes_catalog`: the rune libraries (Global, then Vidar) as one
//! read-only payload for the Runes tab: sets with their target, tier and members in body order,
//! and every non-set rune with its header values and body. Reads through the same Rust reader the
//! builder uses; `targets.json` (set id -> file under the library's parent) is read here.
//! Every path leaves without the `\\?\` verbatim prefix (`paths.rs:1-4`).

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::library::Library;
use super::rune::{Rune, State};
use super::set;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: String,
    pub recall: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetRow {
    pub id: String,
    pub target: Option<String>,
    pub target_abs: Option<String>,
    pub activate: String,
    pub paths: Vec<String>,
    pub scope: Vec<String>,
    /// 1 = every session, 2 = path-scoped (`.claude/` target), 3 = recall pointers, 4 = not loaded,
    /// 5 = via plugin hook (`plugins/` target, load not traced).
    pub tier: u8,
    pub members: Vec<Member>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuneRow {
    pub id: String,
    pub kind: String,
    pub scope: Vec<String>,
    pub state: &'static str,
    pub activate: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closes_when: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
    pub path: String,
    pub body: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRow {
    pub key: &'static str,
    pub root: String,
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub sets: Vec<SetRow>,
    pub runes: Vec<RuneRow>,
}

#[derive(Serialize, Debug)]
pub struct Catalog {
    pub libraries: Vec<LibraryRow>,
}

/// `p` as a string without the `\\?\` verbatim prefix (`\\?\UNC\` becomes `\\`). Same body as
/// `bridge::display_sweep::plain_path`, which sits in a private module.
pub fn clean(p: &Path) -> String {
    plain(&p.to_string_lossy())
}

/// The verbatim-prefix strip on a string, for messages that embed a path.
fn plain(s: &str) -> String {
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => s.strip_prefix(r"\\?\").unwrap_or(s).to_string(),
    }
}

/// An error message with every embedded verbatim prefix removed.
fn clean_msg(s: &str) -> String {
    s.replace(r"\\?\UNC\", r"\\").replace(r"\\?\", "")
}

fn state_name(s: State) -> &'static str {
    match s {
        State::Draft => "draft",
        State::Active => "active",
        State::Disabled => "disabled",
    }
}

/// `targets.json`: set id -> path under the library's parent. Missing file = no targets.
fn read_targets(root: &Path) -> Result<Vec<(String, String)>, String> {
    let file = root.join("targets.json");
    if !file.exists() {
        return Ok(Vec::new());
    }
    let map: serde_json::Map<String, serde_json::Value> = crate::fsx::read_json(&file)?;
    Ok(map.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string()))).collect())
}

/// The target joined under `base`, or None when it is rooted, absolute or climbs out.
fn target_abs(base: &Path, target: &str) -> Option<String> {
    if target.starts_with(['/', '\\']) {
        return None;
    }
    let mut out = base.to_path_buf();
    for seg in target.split(['/', '\\']) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains(':') {
            return None;
        }
        out.push(seg);
    }
    Some(clean(&out))
}

fn tier_of(target: Option<&str>, has_recall: bool) -> u8 {
    match target {
        Some(t) if t.starts_with("plugins/") => 5,
        Some(t) if t.starts_with(".claude/") => 2,
        Some(_) => 1,
        None if has_recall => 3,
        None => 4,
    }
}

fn library_row(key: &'static str, dir: Option<&Path>) -> LibraryRow {
    let shown = dir.map(clean).unwrap_or_default();
    let mut row = LibraryRow { key, root: shown, present: false, error: None, sets: Vec::new(), runes: Vec::new() };
    let Some(dir) = dir.filter(|d| d.is_dir()) else { return row };
    row.present = true;
    let lib = match Library::open(dir) {
        Ok(l) => l,
        Err(e) => {
            row.error = Some(clean_msg(&e));
            return row;
        }
    };
    row.root = clean(&lib.root);
    let mut messages: Vec<String> = Vec::new();
    let targets = read_targets(&lib.root).unwrap_or_else(|e| {
        messages.push(e);
        Vec::new()
    });
    let base = lib.root.parent().map(Path::to_path_buf).unwrap_or_default();
    let (runes, errors) = lib.all_runes();
    messages.extend(errors);
    if !messages.is_empty() {
        row.error = Some(clean_msg(&messages.join("; ")));
    }
    let (pool, _) = lib.recall_pool();
    for (r, path) in &runes {
        if r.kind == "set" {
            let target = targets.iter().find(|(k, _)| *k == r.id).map(|(_, v)| v.clone());
            let members: Vec<Member> =
                set::members(&pool, r).into_iter().map(|(id, recall)| Member { id, recall }).collect();
            let tier = tier_of(target.as_deref(), members.iter().any(|m| m.recall));
            row.sets.push(SetRow {
                id: r.id.clone(),
                target_abs: target.as_deref().and_then(|t| target_abs(&base, t)),
                target,
                activate: r.activate.clone(),
                paths: r.paths.clone(),
                scope: r.scope.clone(),
                tier,
                members,
            });
        } else {
            row.runes.push(rune_row(r, path));
        }
    }
    row.sets.sort_by(|a, b| a.tier.cmp(&b.tier).then_with(|| a.id.cmp(&b.id)));
    row.runes.sort_by(|a, b| a.id.cmp(&b.id));
    row
}

fn rune_row(r: &Rune, path: &PathBuf) -> RuneRow {
    RuneRow {
        id: r.id.clone(),
        kind: r.kind.clone(),
        scope: r.scope.clone(),
        state: state_name(r.state),
        activate: r.activate.clone(),
        description: r.description.clone(),
        origin: r.origin.clone(),
        closes_when: r.closes_when.clone(),
        why: r.why.clone(),
        example: r.example.clone(),
        path: clean(path),
        body: r.body.clone(),
    }
}

/// Global first, then Vidar; a missing library is `present: false` and never hides the other.
pub fn catalog_in(global: Option<&Path>, vidar: Option<&Path>) -> Catalog {
    Catalog { libraries: vec![library_row("global", global), library_row("vidar", vidar)] }
}

#[tauri::command]
pub async fn runes_catalog() -> Result<Catalog, String> {
    tauri::async_runtime::spawn_blocking(|| {
        catalog_in(crate::paths::global_runes_dir().as_deref(), Some(&crate::paths::runes_dir()))
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/runes-catalog")
    }

    /// Replaces the machine-specific parent of the fixture library with `<base>`, `/` separators.
    fn redact(v: &mut Value, base: &str) {
        match v {
            Value::String(s) => {
                assert!(!s.contains(r"\\?\"), "verbatim prefix leaked: {s}");
                *s = s.replace('\\', "/").replace(base, "<base>");
            }
            Value::Array(a) => a.iter_mut().for_each(|x| redact(x, base)),
            Value::Object(o) => o.values_mut().for_each(|x| redact(x, base)),
            _ => {}
        }
    }

    #[test]
    fn runes_catalog_matches_golden() {
        let lib = fixtures().join("lib");
        let missing = fixtures().join("no-such-library");
        let cat = catalog_in(Some(&missing), Some(&lib));
        let mut got = serde_json::to_value(&cat).unwrap();
        let base = clean(&lib.canonicalize().unwrap().parent().unwrap().to_path_buf()).replace('\\', "/");
        redact(&mut got, &base);
        // the missing library keeps its (redacted) path and reports present:false without an error
        assert_eq!(got["libraries"][0]["present"], false);
        got["libraries"][0]["root"] = Value::String("<missing>".into());
        let want: Value =
            serde_json::from_str(&std::fs::read_to_string(fixtures().join("golden.json")).unwrap()).unwrap();
        assert_eq!(got, want, "actual:\n{}", serde_json::to_string_pretty(&got).unwrap());
    }

    #[test]
    fn runes_catalog_serializes_present_page_keys() {
        let rune = super::super::rune::parse("---\nname: page\nkind: rule\nscope: [global]\norigin: Research\ncloses-when: Review ends\nwhy: Keep context\nexample: Open a file\n---\nBody\n").unwrap();
        let row = serde_json::to_value(rune_row(&rune, &PathBuf::from("page.md"))).unwrap();
        assert_eq!(row["origin"], "Research");
        assert_eq!(row["closesWhen"], "Review ends");
        assert_eq!(row["why"], "Keep context");
        assert_eq!(row["example"], "Open a file");
    }

    #[test]
    fn runes_catalog_tier_and_target_rules() {
        assert_eq!(tier_of(Some("plugins/x/CLAUDE.md"), false), 5);
        assert_eq!(tier_of(Some(".claude/rules/x.md"), false), 2);
        assert_eq!(tier_of(Some("CLAUDE.md"), false), 1);
        assert_eq!(tier_of(None, true), 3);
        assert_eq!(tier_of(None, false), 4);
        let base = Path::new("C:\\base");
        for rooted in ["/x/y", "\\x", "\\\\srv\\share", "C:/x", "../x"] {
            assert!(target_abs(base, rooted).is_none(), "{rooted}");
        }
        assert!(target_abs(base, "a/b.md").is_some());
    }

    #[test]
    fn runes_catalog_bad_targets_json_reports_error_without_verbatim_prefix() {
        let dir = std::env::temp_dir().join(format!("vidar-runes-badtargets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        struct Guard(PathBuf);
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = Guard(dir.clone());
        std::fs::write(dir.join("lib").join("targets.json"), "{ not json").unwrap();
        let cat = catalog_in(None, Some(&dir.join("lib")));
        let row = &cat.libraries[1];
        let err = row.error.as_deref().expect("error present");
        assert!(!err.contains(r"\\?\"), "leaked: {err}");
        assert!(!row.root.contains(r"\\?\"), "root leaked: {}", row.root);
    }
}
