//! 200 bodies to the § IPC reply shapes. Every remote object is untrusted: an entry without a
//! valid id is dropped, a missing field reads "", and urls go through `api::page_url`.

use serde::Serialize;
use serde_json::{Map, Value};

use super::api::{normalise_id, page_url};
use super::props;

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn owned(v: &Value, key: &str) -> String {
    s(v, key).unwrap_or_default().to_string()
}

fn results(body: &Value) -> &[Value] {
    body.get("results").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// The cursor for the next page: `next_cursor` while `has_more` is not false, else None.
pub fn next(body: &Value) -> Option<String> {
    if body.get("has_more").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    s(body, "next_cursor").filter(|c| !c.is_empty()).map(str::to_string)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Me {
    pub workspace: Option<String>,
    pub kind: &'static str,
}

/// `bot.workspace_name` and the kind from `bot.owner.type`.
pub fn me(body: &Value) -> Me {
    let bot = body.get("bot");
    let owner = bot.and_then(|b| b.get("owner")).and_then(|o| s(o, "type")).unwrap_or("");
    let workspace = bot
        .and_then(|b| s(b, "workspace_name"))
        .map(super::vault::clean_workspace)
        .filter(|w| !w.is_empty());
    Me { workspace, kind: super::vault::kind_from_owner(owner) }
}

/// The page's own emoji icon. Only `icon.type == "emoji"` counts (the CSP blocks every image
/// type); a missing, odd-typed, over-long or control-character value reads "".
pub(super) fn emoji_icon(v: &Value) -> String {
    let Some(icon) = v.get("icon").filter(|i| s(i, "type") == Some("emoji")) else { return String::new() };
    let emoji = s(icon, "emoji").unwrap_or_default();
    if emoji.chars().count() > 16 || emoji.chars().any(char::is_control) {
        return String::new();
    }
    emoji.to_string()
}

fn icon_token(v: &str) -> bool {
    !v.is_empty() && v.len() <= 40 && v.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
}

/// The page's built-in icon as `(name, color)`. Only `icon.type == "icon"` counts; a name or
/// colour outside `[a-z0-9_-]{1,40}` reads "" (colour alone may be empty).
pub(super) fn native_icon(v: &Value) -> (String, String) {
    let Some(icon) = v.get("icon").filter(|i| s(i, "type") == Some("icon")) else { return Default::default() };
    let inner = icon.get("icon").unwrap_or(icon);
    let name = s(inner, "name").or_else(|| s(icon, "name")).unwrap_or_default();
    if !icon_token(name) {
        return Default::default();
    }
    let color = s(inner, "color").or_else(|| s(icon, "color")).unwrap_or_default();
    (name.to_string(), if icon_token(color) { color.to_string() } else { String::new() })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    pub kind: &'static str,
    pub icon: String,
    pub icon_name: String,
    pub icon_color: String,
    pub title: String,
    pub url: String,
    pub last_edited: String,
}

/// Search hits of the asked object type. Pages whose parent is a data source or database are
/// database rows and are dropped.
pub fn hits(body: &Value, object: &str) -> Vec<Hit> {
    let kind = if object == "data_source" { "source" } else { "page" };
    results(body)
        .iter()
        .filter(|r| s(r, "object") == Some(object))
        .filter(|r| {
            let parent = r.get("parent").and_then(|p| s(p, "type"));
            !matches!(parent, Some("data_source_id" | "database_id")) || object == "data_source"
        })
        .filter_map(|r| {
            let id = normalise_id(s(r, "id")?)?;
            let (icon_name, icon_color) = native_icon(r);
            Some(Hit {
                url: page_url(s(r, "url"), &id),
                title: props::title_of(r),
                icon: emoji_icon(r),
                icon_name,
                icon_color,
                last_edited: owned(r, "last_edited_time"),
                kind,
                id,
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Opt {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Group {
    pub name: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Prop {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub options: Vec<Opt>,
    pub groups: Vec<Group>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Source {
    pub id: String,
    pub title: String,
    pub url: String,
    pub props: Vec<Prop>,
}

fn options(inner: Option<&Value>) -> Vec<Opt> {
    inner
        .and_then(|i| i.get("options"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|o| Some(Opt { name: s(o, "name")?.to_string(), color: owned(o, "color") }))
                .collect()
        })
        .unwrap_or_default()
}

/// Status groups with their option ids mapped to option names, in schema order.
fn groups(inner: Option<&Value>) -> Vec<Group> {
    let Some(inner) = inner else { return Vec::new() };
    let by_id: Map<String, Value> = inner
        .get("options")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|o| Some((s(o, "id")?.to_string(), Value::String(s(o, "name")?.to_string()))))
                .collect()
        })
        .unwrap_or_default();
    inner
        .get("groups")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|g| {
                    let ids = g.get("option_ids").and_then(Value::as_array)?;
                    let options = ids
                        .iter()
                        .filter_map(|i| by_id.get(i.as_str()?)?.as_str().map(str::to_string))
                        .collect();
                    Some(Group { name: s(g, "name")?.to_string(), options })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The schema, in the order Notion sent it. None without a valid id.
pub fn source(body: &Value) -> Option<Source> {
    let id = normalise_id(s(body, "id")?)?;
    let props = body
        .get("properties")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(key, p)| {
                    let kind = s(p, "type")?.to_string();
                    let inner = p.get(kind.as_str());
                    let opts = if matches!(kind.as_str(), "select" | "multi_select" | "status") { options(inner) } else { Vec::new() };
                    let grps = if kind == "status" { groups(inner) } else { Vec::new() };
                    Some(Prop {
                        id: s(p, "id")?.to_string(),
                        name: s(p, "name").unwrap_or(key).to_string(),
                        kind,
                        options: opts,
                        groups: grps,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Source { url: page_url(s(body, "url"), &id), title: props::title_of(body), id, props })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub icon: String,
    pub icon_name: String,
    pub icon_color: String,
    pub title: String,
    pub url: String,
    pub last_edited: String,
    pub values: Map<String, Value>,
}

/// Query results that are pages, each with its facet values keyed by property id.
pub fn rows(body: &Value) -> Vec<Row> {
    results(body)
        .iter()
        .filter(|r| s(r, "object") == Some("page"))
        .filter_map(|r| {
            let id = normalise_id(s(r, "id")?)?;
            let mut values = Map::new();
            if let Some(m) = r.get("properties").and_then(Value::as_object) {
                for p in m.values() {
                    let (Some(pid), Some(vals)) = (s(p, "id"), props::facet_values(p)) else { continue };
                    values.insert(pid.to_string(), Value::from(vals));
                }
            }
            let (icon_name, icon_color) = native_icon(r);
            Some(Row {
                url: page_url(s(r, "url"), &id),
                title: props::title_of(r),
                icon: emoji_icon(r),
                icon_name,
                icon_color,
                last_edited: owned(r, "last_edited_time"),
                id,
                values,
            })
        })
        .collect()
}

/// One card field (the shell's `Field`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Field {
    pub label: String,
    pub value: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dim: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub title: String,
    pub url: String,
    pub last_edited: String,
    pub created: String,
    pub fields: Vec<Field>,
}

/// The page with every shown property as text; an empty value is kept, dimmed.
pub fn page(body: &Value) -> Option<Page> {
    let id = normalise_id(s(body, "id")?)?;
    let fields = body
        .get("properties")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(key, p)| {
                    let value = props::text(p)?;
                    let dim = value.is_empty();
                    Some(Field { label: s(p, "name").unwrap_or(key).to_string(), value, dim })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Page {
        url: page_url(s(body, "url"), &id),
        title: props::title_of(body),
        last_edited: owned(body, "last_edited_time"),
        created: owned(body, "created_time"),
        id,
        fields,
    })
}

/// Block children passed through as sent, keeping only `object: "block"` entries with a valid
/// id (the TS renderer is the DOM trust boundary).
pub fn blocks(body: &Value) -> Vec<Value> {
    results(body)
        .iter()
        .filter(|b| s(b, "object") == Some("block") && s(b, "id").and_then(normalise_id).is_some())
        .cloned()
        .collect()
}
