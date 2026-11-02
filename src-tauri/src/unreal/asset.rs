//! Asset card and Blueprint find for the Unreal tab, read through Rider's MCP tools.
//!
//! Read-only. `root` is the head's project root, never a fresh `find_uproject` on a cwd (which
//! flips between polls). Rider's replies are shaped from its cached output schemas
//! (`rider.json`), not seen live. `find_default_value_overrides` fails open: an empty reply is
//! the same for a typo and a genuine none, so Overrides Of always pairs it with
//! `get_class_hierarchy` and follows the table in the `bp-property-safety` skill.

use crate::gitrun::{git, GitOpts};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const CALL: Duration = Duration::from_secs(15);
const GIT_WAIT: Duration = Duration::from_secs(5);

pub(super) type Rider<'a> = &'a dyn Fn(&str, Value) -> Result<Value, String>;

// ---------- path resolution ----------

fn lower_components(p: &Path) -> Vec<String> {
    p.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect()
}

pub(super) fn inside(root: &Path, target: &Path) -> bool {
    let (r, t) = (lower_components(root), lower_components(target));
    t.len() > r.len() && t[..r.len()] == r[..]
}

/// Refuse input a path join would misread: `..`, a colon past the drive (ADS), a drive-relative form.
fn check_shape(input: &str) -> Result<(), String> {
    if input.trim().is_empty() {
        return Err("Enter an Asset Path".into());
    }
    let b = input.as_bytes();
    let skip = if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() { 2 } else { 0 };
    if input[skip..].contains(':') {
        return Err("Asset Path Refused: Stream Names Are Not Allowed".into());
    }
    let p = Path::new(input);
    if p.components().any(|c| c == Component::ParentDir) {
        return Err("Asset Path Refused: Parent Folders Are Not Allowed".into());
    }
    if matches!(p.components().next(), Some(Component::Prefix(_))) && !p.is_absolute() {
        return Err("Asset Path Refused: Drive-Relative Paths Are Not Allowed".into());
    }
    Ok(())
}

fn is_asset_file(p: &Path) -> bool {
    matches!(p.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref(), Some("uasset") | Some("umap"))
}

/// An absolute, project-relative or `/Game/...` asset to its canonical file inside `root`.
pub fn resolve_asset(root: &str, input: &str) -> Result<PathBuf, String> {
    let input = input.trim();
    check_shape(input)?;
    let canon_root = std::fs::canonicalize(root).map_err(|e| format!("Project Root Unreadable: {e}"))?;
    let normalized = input.replace('\\', "/");
    let candidates: Vec<PathBuf> = if normalized.starts_with("/Game/") || normalized == "/Game" {
        // `/Game/Maps/Foo.Foo` is an object path: drop the `.Obj` part, then try both extensions.
        let (dir, last) = normalized.rsplit_once('/').unwrap_or(("", &normalized));
        let stem = if is_asset_file(Path::new(last)) { last.to_string() } else { last.split('.').next().unwrap_or(last).to_string() };
        let rel = format!("Content/{}/{}", dir.trim_start_matches("/Game").trim_start_matches('/'), stem);
        let rel = rel.replace("//", "/");
        let base = canon_root.join(&rel);
        if is_asset_file(&base) {
            vec![base]
        } else {
            vec![PathBuf::from(format!("{}.uasset", base.display())), PathBuf::from(format!("{}.umap", base.display()))]
        }
    } else if Path::new(input).is_absolute() {
        vec![PathBuf::from(input)]
    } else {
        vec![canon_root.join(&normalized)]
    };
    let mut last_err = "Asset Not Found".to_string();
    for c in candidates {
        match std::fs::canonicalize(&c) {
            Ok(real) => {
                // canonicalize follows junctions and symlinks, so an escape shows in `real`.
                if !inside(&canon_root, &real) {
                    return Err("Asset Path Refused: Outside the Project".into());
                }
                if !is_asset_file(&real) {
                    return Err("Asset Path Refused: Not a uasset or umap File".into());
                }
                if !real.is_file() {
                    return Err("Asset Not Found".into());
                }
                return Ok(real);
            }
            Err(_) => last_err = "Asset Not Found".into(),
        }
    }
    Err(last_err)
}

/// `/Game/...` form of a resolved file, when it sits under `<root>/Content`.
pub(super) fn game_path(root: &Path, file: &Path) -> Option<String> {
    let content = root.join("Content");
    let (c, f) = (lower_components(&content), lower_components(file));
    if f.len() <= c.len() || f[..c.len()] != c[..] {
        return None;
    }
    let rel: Vec<String> = file.components().skip(c.len()).map(|x| x.as_os_str().to_string_lossy().to_string()).collect();
    let mut s = format!("/Game/{}", rel.join("/"));
    if let Some(i) = s.rfind('.') {
        s.truncate(i);
    }
    Some(s)
}

// ---------- Rider reply parsing ----------

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_owned)
}

pub(super) fn rider_args(root: &str, mut args: Value) -> Value {
    args["rootFolder"] = json!(root);
    args
}

/// An asset path from Rider, reduced to a comparable key: forward slashes, lower case, no extension,
/// no `.Object` suffix.
fn asset_key(p: &str) -> String {
    let mut k = p.replace('\\', "/").to_lowercase();
    let slash = k.rfind('/').map_or(0, |i| i + 1);
    if let Some(dot) = k[slash..].find('.') {
        k.truncate(slash + dot);
    }
    k
}

fn same_asset(rider_path: &str, game: Option<&str>, file: &Path) -> bool {
    let k = asset_key(rider_path);
    if game.map_or(false, |g| k == g.to_lowercase()) {
        return true;
    }
    k == asset_key(&file.to_string_lossy())
}

// ---------- asset card ----------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssetProp {
    pub name: String,
    #[serde(rename = "typeName")]
    pub type_name: String,
    pub value: String,
}

/// `properties` of a `get_asset_properties` reply.
pub(super) fn parse_props(v: &Value) -> Vec<AssetProp> {
    v.get("properties")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    Some(AssetProp {
                        name: s(p, "name")?,
                        type_name: p.get("typeName").and_then(Value::as_str).unwrap_or("").into(),
                        value: p.get("value").and_then(Value::as_str).unwrap_or("").into(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LastChange {
    pub sha: String,
    pub author: String,
    pub when: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCard {
    pub path: String,
    pub object_name: Option<String>,
    pub parent_class: Option<String>,
    pub asset_class: Option<String>,
    pub props: Vec<AssetProp>,
    pub last_change: Option<LastChange>,
    pub notes: Vec<String>,
}

fn last_change(file: &Path) -> Option<LastChange> {
    let dir = file.parent()?;
    let name = file.file_name()?.to_string_lossy().to_string();
    let out = git(dir, &["log", "-1", "--format=%h%x09%an%x09%ar", "--", &name], &GitOpts::read(GIT_WAIT, 4096)).ok()?;
    let line = out.text.lines().next()?.trim();
    let mut it = line.splitn(3, '\t');
    let (sha, author, when) = (it.next()?, it.next()?, it.next()?);
    if sha.is_empty() {
        return None;
    }
    Some(LastChange { sha: sha.into(), author: author.into(), when: when.into() })
}

pub fn card_with(root: &str, asset: &str, rider: Rider, with_git: bool) -> Result<AssetCard, String> {
    let file = resolve_asset(root, asset)?;
    let canon_root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let game = game_path(&canon_root, &file);
    let stem = file.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    let mut notes = Vec::new();
    let mut card = AssetCard {
        path: file.to_string_lossy().trim_start_matches(r"\\?\").to_string(),
        object_name: None,
        parent_class: None,
        asset_class: None,
        props: Vec::new(),
        last_change: None,
        notes: Vec::new(),
    };

    match rider("rider_get_asset_properties", rider_args(root, json!({"assetPath": card.path}))) {
        Ok(v) => {
            card.object_name = s(&v, "objectName");
            card.props = parse_props(&v);
            if card.props.is_empty() {
                notes.push("Rider Read No Properties".to_string());
            }
        }
        Err(e) => notes.push(format!("Rider Properties Failed: {e}")),
    }

    // Classes come from the cache search, matched on assetPath (file or /Game form).
    match rider("rider_search_assets", rider_args(root, json!({"query": stem, "source": "cache"}))) {
        Ok(v) => {
            let hit = v
                .get("assets")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|x| s(x, "assetPath").map_or(false, |p| same_asset(&p, game.as_deref(), &file))));
            match hit {
                Some(h) => {
                    card.parent_class = s(h, "baseClass");
                    card.asset_class = s(h, "assetClass");
                }
                None => notes.push("Classes Not Found in the Rider Cache".to_string()),
            }
        }
        Err(e) => notes.push(format!("Rider Class Search Failed: {e}")),
    }

    if with_git {
        card.last_change = last_change(&file);
    }
    if card.last_change.is_none() {
        notes.push("Last Change Unknown".to_string());
    }
    notes.push("References Are Not Listed".to_string());
    card.notes = notes;
    Ok(card)
}

// ---------- find ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindMode {
    AssetName,
    ChildBlueprintsOf,
    OverridesOf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FindStatus {
    /// Rows are matches.
    Matches,
    /// Nothing matched (asset name search only).
    NoMatches,
    /// Overrides Of: hierarchy had assets and overrides came back; rows are the overrides.
    Overrides,
    /// Overrides Of: hierarchy had assets and overrides are empty: verified none.
    VerifiedNone,
    /// The class hierarchy was empty, so the overrides call proves nothing.
    CheckDidntRun,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRow {
    pub asset_path: String,
    pub name: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FindResult {
    pub status: FindStatus,
    pub rows: Vec<FindRow>,
    pub message: Option<String>,
}

const CHECK_DIDNT_RUN: &str = "Check Didn't Run: The Class Name May Be Misspelled or Have No Blueprint Children";

/// Rider's overrides call wants the bare C++ name; the hierarchy call keeps the prefix.
fn strip_prefix(class: &str) -> &str {
    let b = class.as_bytes();
    if b.len() > 2 && matches!(b[0], b'U' | b'A' | b'F') && b[1].is_ascii_uppercase() {
        &class[1..]
    } else {
        class
    }
}

fn hierarchy(root: &str, class: &str, rider: Rider) -> Result<Vec<FindRow>, String> {
    let v = rider("rider_get_class_hierarchy", rider_args(root, json!({"baseClass": class})))?;
    Ok(v.get("classes")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| Some(FindRow { asset_path: s(c, "assetPath")?, name: s(c, "name").unwrap_or_default(), detail: None }))
                .collect()
        })
        .unwrap_or_default())
}

pub fn find_with(root: &str, mode: FindMode, query: &str, rider: Rider) -> Result<FindResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Enter a Query".into());
    }
    match mode {
        FindMode::AssetName => {
            let v = rider("rider_search_assets", rider_args(root, json!({"query": query, "source": "cache"})))?;
            let rows: Vec<FindRow> = v
                .get("assets")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| {
                            Some(FindRow {
                                asset_path: s(x, "assetPath")?,
                                name: s(x, "assetName").unwrap_or_default(),
                                detail: s(x, "assetClass").or_else(|| s(x, "baseClass")),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let status = if rows.is_empty() { FindStatus::NoMatches } else { FindStatus::Matches };
            Ok(FindResult { status, rows, message: None })
        }
        FindMode::ChildBlueprintsOf => {
            let rows = hierarchy(root, query, rider)?;
            if rows.is_empty() {
                return Ok(FindResult { status: FindStatus::CheckDidntRun, rows, message: Some(CHECK_DIDNT_RUN.into()) });
            }
            Ok(FindResult { status: FindStatus::Matches, rows, message: None })
        }
        FindMode::OverridesOf => {
            let (class, field) = query.split_once('.').ok_or("Enter Overrides Of as Class.Field")?;
            let (class, field) = (class.trim(), field.trim());
            if class.is_empty() || field.is_empty() {
                return Err("Enter Overrides Of as Class.Field".into());
            }
            let children = hierarchy(root, class, rider)?;
            let v = rider(
                "rider_find_default_value_overrides",
                rider_args(root, json!({"className": strip_prefix(class), "fieldName": field})),
            )?;
            let rows: Vec<FindRow> = v
                .get("overrides")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|o| {
                            let value = o.get("value").and_then(Value::as_str).unwrap_or("");
                            let ty = o.get("typeName").and_then(Value::as_str).unwrap_or("");
                            Some(FindRow {
                                asset_path: s(o, "assetPath")?,
                                name: s(o, "instanceName").unwrap_or_default(),
                                detail: Some(if ty.is_empty() { value.to_string() } else { format!("{ty}: {value}") }),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(match (children.is_empty(), rows.is_empty()) {
                (true, _) => FindResult { status: FindStatus::CheckDidntRun, rows, message: Some(CHECK_DIDNT_RUN.into()) },
                (false, true) => FindResult {
                    status: FindStatus::VerifiedNone,
                    rows,
                    message: Some(format!("No Overrides Found: Checked {} Blueprints", children.len())),
                },
                (false, false) => FindResult { status: FindStatus::Overrides, rows, message: None },
            })
        }
    }
}

// ---------- commands ----------

pub(super) fn live(url: String) -> impl Fn(&str, Value) -> Result<Value, String> {
    move |name, args| crate::mcp::call_tool_blocking(&url, name, args, CALL)
}

#[tauri::command]
pub async fn unreal_asset_card(root: String, asset: String) -> Result<AssetCard, String> {
    super::blocking("unreal_asset_card", move || {
        let call = live(super::proxy::proxy_url());
        card_with(&root, &asset, &call, true)
    })
    .await
}

#[tauri::command]
pub async fn unreal_find(root: String, mode: FindMode, query: String) -> Result<FindResult, String> {
    super::blocking("unreal_find", move || {
        let call = live(super::proxy::proxy_url());
        find_with(&root, mode, &query, &call)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vidar-asset-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn project(tag: &str) -> (PathBuf, PathBuf) {
        let d = scratch(tag);
        let root = d.join("Acme");
        fs::create_dir_all(root.join("Content").join("Maps")).unwrap();
        fs::write(root.join("Acme.uproject"), "{}").unwrap();
        fs::write(root.join("Content").join("BP_Door.uasset"), b"x").unwrap();
        fs::write(root.join("Content").join("Maps").join("Hub.umap"), b"x").unwrap();
        (d, root)
    }

    fn rs(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    // ----- resolve_asset -----

    #[test]
    fn resolve_takes_game_relative_and_absolute_forms() {
        let (_d, root) = project("forms");
        let r = rs(&root);
        let want = fs::canonicalize(root.join("Content").join("BP_Door.uasset")).unwrap();
        assert_eq!(resolve_asset(&r, "/Game/BP_Door").unwrap(), want);
        assert_eq!(resolve_asset(&r, "/Game/BP_Door.BP_Door").unwrap(), want, ".Obj suffix stripped");
        assert_eq!(resolve_asset(&r, r"Content\BP_Door.uasset").unwrap(), want);
        assert_eq!(resolve_asset(&r, &rs(&root.join("Content").join("BP_Door.uasset"))).unwrap(), want);
        let map = resolve_asset(&r, "/Game/Maps/Hub").unwrap();
        assert!(rs(&map).ends_with("Hub.umap"), "{map:?}");
    }

    #[test]
    fn resolve_refuses_outside_dotdot_streams_and_non_assets() {
        let (d, root) = project("refuse");
        let r = rs(&root);
        fs::write(d.join("Outside.uasset"), b"x").unwrap();
        let e = resolve_asset(&r, &rs(&d.join("Outside.uasset"))).unwrap_err();
        assert!(e.contains("Outside the Project"), "{e}");
        let e = resolve_asset(&r, "Content/../../Outside.uasset").unwrap_err();
        assert!(e.contains("Parent Folders"), "{e}");
        let e = resolve_asset(&r, "/Game/../Acme").unwrap_err();
        assert!(e.contains("Parent Folders"), "{e}");
        let e = resolve_asset(&r, "Content/BP_Door.uasset:stream").unwrap_err();
        assert!(e.contains("Stream"), "{e}");
        let abs = format!("{}:stream", rs(&root.join("Content").join("BP_Door.uasset")));
        assert!(resolve_asset(&r, &abs).unwrap_err().contains("Stream"));
        assert!(resolve_asset(&r, "C:Content/BP_Door.uasset").is_err());
        let e = resolve_asset(&r, "Acme.uproject").unwrap_err();
        assert!(e.contains("Not a uasset"), "{e}");
        assert_eq!(resolve_asset(&r, "/Game/Nope").unwrap_err(), "Asset Not Found");
    }

    #[test]
    fn resolve_compares_components_case_insensitively() {
        let (_d, root) = project("case");
        let want = fs::canonicalize(root.join("Content").join("BP_Door.uasset")).unwrap();
        let mixed = rs(&root.join("Content").join("BP_Door.uasset")).to_uppercase();
        assert_eq!(resolve_asset(&rs(&root), &mixed).unwrap(), want);
        let lower_root = rs(&root).to_lowercase();
        assert_eq!(resolve_asset(&lower_root, "/Game/BP_Door").unwrap(), want);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_refuses_a_junction_that_escapes_the_root() {
        let (d, root) = project("junction");
        let outside = d.join("Elsewhere");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("Leak.uasset"), b"x").unwrap();
        let link = root.join("Content").join("Linked");
        let st = std::process::Command::new("cmd").args(["/C", "mklink", "/J", &rs(&link), &rs(&outside)]).output().unwrap();
        assert!(st.status.success(), "mklink failed: {}", String::from_utf8_lossy(&st.stdout));
        let e = resolve_asset(&rs(&root), "/Game/Linked/Leak").unwrap_err();
        assert!(e.contains("Outside the Project"), "{e}");
        let e = resolve_asset(&rs(&root), "Content/Linked/Leak.uasset").unwrap_err();
        assert!(e.contains("Outside the Project"), "{e}");
        // a junction that stays inside is fine
        let inner = root.join("Content").join("Alias");
        let st = std::process::Command::new("cmd").args(["/C", "mklink", "/J", &rs(&inner), &rs(&root.join("Content").join("Maps"))]).output().unwrap();
        assert!(st.status.success());
        assert!(resolve_asset(&rs(&root), "Content/Alias/Hub.umap").is_ok());
        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir(&inner);
    }

    // ----- card -----

    fn card_rider(calls: &RefCell<Vec<(String, Value)>>, props: Value, assets: Value) -> impl Fn(&str, Value) -> Result<Value, String> + '_ {
        move |name, args| {
            calls.borrow_mut().push((name.to_string(), args));
            match name {
                "rider_get_asset_properties" => Ok(props.clone()),
                "rider_search_assets" => Ok(assets.clone()),
                other => Err(format!("unexpected {other}")),
            }
        }
    }

    #[test]
    fn card_reads_props_classes_and_passes_root_folder() {
        let (_d, root) = project("card");
        let r = rs(&root);
        let calls = RefCell::new(Vec::new());
        let props = json!({"objectName": "BP_Door_C", "properties": [{"name": "Speed", "typeName": "float", "value": "2.5"}]});
        let assets = json!({"assets": [
            {"assetPath": "/Game/Other/BP_Door", "assetName": "BP_Door", "baseClass": "AWrong", "assetClass": "Blueprint"},
            {"assetPath": "/Game/BP_Door.BP_Door", "assetName": "BP_Door", "baseClass": "ADoor", "assetClass": "Blueprint"}]});
        let rider = card_rider(&calls, props, assets);
        let card = card_with(&r, "/Game/BP_Door", &rider, false).unwrap();
        assert_eq!(card.object_name.as_deref(), Some("BP_Door_C"));
        assert_eq!(card.parent_class.as_deref(), Some("ADoor"));
        assert_eq!(card.asset_class.as_deref(), Some("Blueprint"));
        assert_eq!(card.props.len(), 1);
        assert!(!card.notes.iter().any(|n| n == "Rider Read No Properties"));
        assert!(card.notes.contains(&"Last Change Unknown".to_string()));
        assert!(card.notes.contains(&"References Are Not Listed".to_string()));
        let calls = calls.borrow();
        for (_, a) in calls.iter() {
            assert_eq!(a["rootFolder"], json!(r));
        }
        assert_eq!(calls[1].1["source"], json!("cache"));
        assert_eq!(calls[1].1["query"], json!("BP_Door"));
    }

    #[test]
    fn card_matches_the_file_form_of_assetpath_and_notes_empty_props() {
        let (_d, root) = project("cardfile");
        let file = rs(&fs::canonicalize(root.join("Content").join("BP_Door.uasset")).unwrap());
        let calls = RefCell::new(Vec::new());
        let assets = json!({"assets": [{"assetPath": file.to_uppercase(), "assetName": "BP_Door", "baseClass": "ADoor", "assetClass": null}]});
        let rider = card_rider(&calls, json!({"properties": []}), assets);
        let card = card_with(&rs(&root), "Content/BP_Door.uasset", &rider, false).unwrap();
        assert_eq!(card.parent_class.as_deref(), Some("ADoor"));
        assert_eq!(card.asset_class, None);
        assert!(card.notes.contains(&"Rider Read No Properties".to_string()));
        assert!(!card.notes.iter().any(|n| n.to_lowercase().contains("no defaults")));
    }

    #[test]
    fn card_refuses_an_outside_asset_before_calling_rider() {
        let (d, root) = project("cardout");
        fs::write(d.join("Out.uasset"), b"x").unwrap();
        let calls = RefCell::new(Vec::new());
        let rider = card_rider(&calls, json!({}), json!({}));
        assert!(card_with(&rs(&root), &rs(&d.join("Out.uasset")), &rider, false).is_err());
        assert!(calls.borrow().is_empty());
    }

    // ----- find -----

    /// Fixture rider for the Overrides Of table: records calls, answers hierarchy and overrides.
    fn table_rider<'a>(calls: &'a RefCell<Vec<(String, Value)>>, classes: Value, overrides: Value) -> impl Fn(&str, Value) -> Result<Value, String> + 'a {
        move |name, args| {
            calls.borrow_mut().push((name.to_string(), args));
            match name {
                "rider_get_class_hierarchy" => Ok(json!({"classes": classes})),
                "rider_find_default_value_overrides" => Ok(json!({"overrides": overrides})),
                other => Err(format!("unexpected {other}")),
            }
        }
    }

    fn bp(n: &str) -> Value {
        json!({"name": n, "assetPath": format!("/Game/{n}")})
    }
    fn ov() -> Value {
        json!([{"assetPath": "/Game/Overworld_Location_Base", "instanceName": "Default__X", "typeName": "float", "value": "0.25"}])
    }

    #[test]
    fn overrides_table_row_children_and_overrides_reports_values() {
        let calls = RefCell::new(Vec::new());
        let r = table_rider(&calls, json!([bp("A"), bp("B")]), ov());
        let res = find_with("C:/P", FindMode::OverridesOf, "AAuzoActor.IconScale", &r).unwrap();
        assert_eq!(res.status, FindStatus::Overrides);
        assert_eq!(res.rows.len(), 1);
        assert_eq!(res.rows[0].detail.as_deref(), Some("float: 0.25"));
        assert_eq!(res.message, None);
        let calls = calls.borrow();
        // prefix kept for the hierarchy, stripped for the overrides call
        assert_eq!(calls[0].0, "rider_get_class_hierarchy");
        assert_eq!(calls[0].1["baseClass"], json!("AAuzoActor"));
        assert_eq!(calls[1].0, "rider_find_default_value_overrides");
        assert_eq!(calls[1].1["className"], json!("AuzoActor"));
        assert_eq!(calls[1].1["fieldName"], json!("IconScale"));
        assert_eq!(calls[0].1["rootFolder"], json!("C:/P"));
        assert_eq!(calls[1].1["rootFolder"], json!("C:/P"));
    }

    #[test]
    fn overrides_table_row_children_and_no_overrides_is_verified_none() {
        let calls = RefCell::new(Vec::new());
        let r = table_rider(&calls, json!([bp("A")]), json!([]));
        let res = find_with("C:/P", FindMode::OverridesOf, "AFoo.Bar", &r).unwrap();
        assert_eq!(res.status, FindStatus::VerifiedNone);
        assert!(res.rows.is_empty());
        assert!(res.message.unwrap().starts_with("No Overrides Found"));
    }

    #[test]
    fn overrides_table_row_empty_hierarchy_means_check_didnt_run() {
        for overrides in [json!([]), ov()] {
            let calls = RefCell::new(Vec::new());
            let r = table_rider(&calls, json!([]), overrides);
            let res = find_with("C:/P", FindMode::OverridesOf, "AFoo.Bar", &r).unwrap();
            assert_eq!(res.status, FindStatus::CheckDidntRun);
            let m = res.message.unwrap();
            assert!(m.starts_with("Check Didn't Run"), "{m}");
            assert!(!m.contains("No Blueprints Derive From"));
        }
    }

    #[test]
    fn overrides_query_must_be_class_dot_field_and_bare_names_keep_their_letters() {
        let calls = RefCell::new(Vec::new());
        let r = table_rider(&calls, json!([bp("A")]), json!([]));
        assert!(find_with("C:/P", FindMode::OverridesOf, "AFoo", &r).is_err());
        assert!(find_with("C:/P", FindMode::OverridesOf, ".Bar", &r).is_err());
        assert!(calls.borrow().is_empty());
        assert_eq!(strip_prefix("Actor"), "Actor");
        assert_eq!(strip_prefix("AActor"), "Actor");
        assert_eq!(strip_prefix("UObject"), "Object");
        assert_eq!(strip_prefix("FVector"), "Vector");
        assert_eq!(strip_prefix("UI"), "UI");
    }

    #[test]
    fn child_blueprints_and_asset_name_modes() {
        let calls = RefCell::new(Vec::new());
        let r = table_rider(&calls, json!([bp("A")]), json!([]));
        let res = find_with("C:/P", FindMode::ChildBlueprintsOf, "AFoo", &r).unwrap();
        assert_eq!((res.status, res.rows.len()), (FindStatus::Matches, 1));
        let r = table_rider(&calls, json!([]), json!([]));
        let res = find_with("C:/P", FindMode::ChildBlueprintsOf, "AFoo", &r).unwrap();
        assert_eq!(res.status, FindStatus::CheckDidntRun);

        let seen = RefCell::new(Vec::new());
        let r = |name: &str, args: Value| -> Result<Value, String> {
            seen.borrow_mut().push((name.to_string(), args));
            Ok(json!({"assets": [{"assetPath": "/Game/BP_Door", "assetName": "BP_Door", "baseClass": "ADoor", "assetClass": "Blueprint"}]}))
        };
        let res = find_with("C:/P", FindMode::AssetName, "Door", &r).unwrap();
        assert_eq!(res.rows[0].detail.as_deref(), Some("Blueprint"));
        assert_eq!(seen.borrow()[0].1["source"], json!("cache"));
        let r = |_: &str, _: Value| -> Result<Value, String> { Ok(json!({"assets": []})) };
        assert_eq!(find_with("C:/P", FindMode::AssetName, "Zzz", &r).unwrap().status, FindStatus::NoMatches);
        assert!(find_with("C:/P", FindMode::AssetName, "  ", &r).is_err());
    }
}
