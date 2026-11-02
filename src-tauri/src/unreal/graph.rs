//! Graph Text for the asset card: `BlueprintTools.read_graph_dsl` per graph, through the proxy's
//! `unreal_call_tool`. Only on the user's press, only while the Editor MCP is up.
//!
//! The tool and toolset names are hardcoded from the cached schemas
//! (`ue-mcp-toolset-conventions/reference/signatures.txt`), not seen live. The reply may come bare
//! or wrapped in `returnValue`; both are read. Reading a graph can dirty the asset's package, and
//! `read_graph_dsl` can silently truncate, so every result carries a note saying so.

use super::asset::{game_path, resolve_asset};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const CALL: Duration = Duration::from_secs(30);
const TOOLSET: &str = "editor_toolset.toolsets.blueprint.BlueprintTools";

type Call<'a> = &'a dyn Fn(&str, Value) -> Result<Value, String>;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GraphText {
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GraphTextResult {
    pub graphs: Vec<GraphText>,
    pub notes: Vec<String>,
}

fn editor_call(call: Call, tool: &str, arguments: Value) -> Result<Value, String> {
    let v = call("unreal_call_tool", json!({"tool_name": tool, "toolset_name": TOOLSET, "arguments": arguments}))?;
    Ok(v.get("returnValue").cloned().unwrap_or(v))
}

fn graph_name(ref_path: &str) -> String {
    ref_path.rsplit(|c| c == ':' || c == '.').next().unwrap_or(ref_path).to_string()
}

pub fn graph_text_with(root: &str, asset: &str, editor_up: bool, call: Call) -> Result<GraphTextResult, String> {
    if !editor_up {
        return Err("Editor MCP Is Down".into());
    }
    let file = resolve_asset(root, asset)?;
    let canon_root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let game = game_path(&canon_root, &file).ok_or("Asset Is Not Under Content")?;
    let stem = game.rsplit('/').next().unwrap_or(&game).to_string();
    let object = format!("{game}.{stem}");

    let listed = editor_call(call, "list_graphs", json!({"blueprint": {"refPath": object}}))?;
    let refs: Vec<String> = listed
        .as_array()
        .map(|a| a.iter().filter_map(|g| g.get("refPath").and_then(Value::as_str).map(str::to_owned)).collect())
        .unwrap_or_default();

    let mut out = GraphTextResult { graphs: Vec::new(), notes: vec!["Graph Text Can Be Incomplete".into()] };
    for r in refs {
        let name = graph_name(&r);
        match editor_call(call, "read_graph_dsl", json!({"graph": {"refPath": r}})) {
            Ok(v) => {
                let text = v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string());
                out.graphs.push(GraphText { name, text });
            }
            Err(e) => out.notes.push(format!("Graph Read Failed: {name}: {e}")),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn unreal_graph_text(root: String, asset: String) -> Result<GraphTextResult, String> {
    super::blocking("unreal_graph_text", move || {
        let url = super::proxy::proxy_url();
        let up = super::proxy::mcp_status_at(&url, None).editor_mcp.up;
        let call = move |name: &str, args: Value| crate::mcp::call_tool_blocking(&url, name, args, CALL);
        graph_text_with(&root, &asset, up, &call)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;

    fn project(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("vidar-graph-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("Content")).unwrap();
        fs::write(d.join("Acme.uproject"), "{}").unwrap();
        fs::write(d.join("Content").join("BP_Door.uasset"), b"x").unwrap();
        d.to_string_lossy().to_string()
    }

    fn fixture<'a>(fail: Option<&'static str>, seen: &'a RefCell<Vec<(String, Value)>>) -> impl Fn(&str, Value) -> Result<Value, String> + 'a {
        move |name, args| {
            assert_eq!(name, "unreal_call_tool");
            assert_eq!(args["toolset_name"], TOOLSET);
            let tool = args["tool_name"].as_str().unwrap().to_string();
            seen.borrow_mut().push((tool.clone(), args["arguments"].clone()));
            match tool.as_str() {
                "list_graphs" => Ok(json!({"returnValue": [
                    {"refPath": "/Game/BP_Door.BP_Door:EventGraph"},
                    {"refPath": "/Game/BP_Door.BP_Door:OnOpen"}]})),
                "read_graph_dsl" => {
                    let r = args["arguments"]["graph"]["refPath"].as_str().unwrap();
                    if fail.is_some_and(|f| r.ends_with(f)) {
                        Err("graph gone".into())
                    } else {
                        Ok(json!({"returnValue": format!("(fn {})", graph_name(r))}))
                    }
                }
                _ => Err("unexpected".into()),
            }
        }
    }

    #[test]
    fn refuses_when_the_editor_is_down() {
        let root = project("down");
        let seen = RefCell::new(Vec::new());
        let r = graph_text_with(&root, "/Game/BP_Door", false, &fixture(None, &seen));
        assert_eq!(r.unwrap_err(), "Editor MCP Is Down");
        assert!(seen.borrow().is_empty());
    }

    #[test]
    fn maps_two_graphs_with_the_truncation_note() {
        let root = project("two");
        let seen = RefCell::new(Vec::new());
        let r = graph_text_with(&root, "/Game/BP_Door", true, &fixture(None, &seen)).unwrap();
        assert_eq!(
            r.graphs,
            vec![
                GraphText { name: "EventGraph".into(), text: "(fn EventGraph)".into() },
                GraphText { name: "OnOpen".into(), text: "(fn OnOpen)".into() },
            ]
        );
        assert_eq!(r.notes, vec!["Graph Text Can Be Incomplete".to_string()]);
        assert_eq!(seen.borrow()[0].1, json!({"blueprint": {"refPath": "/Game/BP_Door.BP_Door"}}));
    }

    #[test]
    fn a_failed_graph_becomes_a_note() {
        let root = project("fail");
        let seen = RefCell::new(Vec::new());
        let r = graph_text_with(&root, "/Game/BP_Door", true, &fixture(Some(":OnOpen"), &seen)).unwrap();
        assert_eq!(r.graphs.len(), 1);
        assert_eq!(r.notes[1], "Graph Read Failed: OnOpen: graph gone");
    }
}
