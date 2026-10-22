//! N-R tests (plan § Tests): every command against `transport::fake::Fake`, an in-memory store
//! and a fresh pacer on a fake clock. Nothing here reaches Notion or Credential Manager.

use super::*;
use crate::net::SendError;
use crate::notion::pace::testing::pacer;
use crate::notion::transport::fake::Fake;
use crate::notion::vault::memory::Memory;
use serde_json::json;

const TOKEN: &str = "ntn_FixtureTokenDoNotLog0000000000";
const ID: &str = "00000000-0000-0000-0000-000000000d01";

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!("../../../tests/fixtures/notion/", $name, ".json"))
    };
}

/// Each context gets its own generation (leaked; tests are short-lived), so parallel tests never
/// supersede each other's connects.
fn ctx<'a>(store: &'a Memory, p: &'a Pacer, net: &'a dyn Transport) -> Ctx<'a> {
    let generation: &'static AtomicU64 = Box::leak(Box::new(AtomicU64::new(0)));
    Ctx { store, pacer: p, net, generation, started: p.now() }
}

fn err<T: std::fmt::Debug>(r: Result<T, ApiError>) -> ApiError {
    r.expect_err("expected an error")
}

#[test]
fn request_host_is_fixed_and_version_pinned() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let net = Fake::new()
        .reply(200, fixture!("search-pages"))
        .reply(200, fixture!("source"))
        .reply(200, fixture!("query-last"))
        .reply(200, fixture!("page-all-props"))
        .reply(200, fixture!("blocks-nested"));
    let c = ctx(&store, &p, &net);
    search_with(&c, "page", None).unwrap();
    source_with(&c, ID).unwrap();
    query_with(&c, ID, None, &[]).unwrap();
    page_with(&c, "00000000000000000000000000000101").unwrap();
    blocks_with(&c, ID, Some("00000000-0000-0000-0000-0000000000e3")).unwrap();

    let sent = net.sent.borrow();
    assert_eq!(sent.len(), 5);
    let methods: Vec<_> = sent.iter().map(|s| s.req.method).collect();
    assert_eq!(methods, ["POST", "GET", "POST", "GET", "GET"]);
    for s in sent.iter() {
        assert_eq!(s.req.host, "api.notion.com");
        let lines: Vec<&str> = s.headers.split("\r\n").collect();
        assert_eq!(lines[0], format!("Authorization: Bearer {TOKEN}"));
        assert!(lines.contains(&"Notion-Version: 2026-03-11"));
        assert!(lines.contains(&"Accept: application/json"));
        assert_eq!(lines.contains(&"Content-Type: application/json"), s.req.method == "POST");
    }
    assert_eq!(sent[0].req.path, "/v1/search");
    assert_eq!(sent[0].cap, 2 * 1024 * 1024);
    let body: Value = serde_json::from_slice(sent[0].req.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["filter"], json!({ "property": "object", "value": "page" }));
    assert_eq!(body["sort"], json!({ "timestamp": "last_edited_time", "direction": "descending" }));
    assert_eq!(body["page_size"], 100);
    assert!(body.get("start_cursor").is_none());
    assert_eq!(sent[1].req.path, format!("/v1/data_sources/{ID}"));
    assert_eq!(sent[2].req.path, format!("/v1/data_sources/{ID}/query"));
    assert_eq!(sent[3].req.path, "/v1/pages/00000000-0000-0000-0000-000000000101");
    assert_eq!(sent[3].cap, 1024 * 1024);
    assert_eq!(sent[4].req.path, format!("/v1/blocks/{ID}/children?page_size=100&start_cursor=00000000-0000-0000-0000-0000000000e3"));
}

#[test]
fn ids_and_cursors_refused_before_send() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let net = Fake::new();
    let c = ctx(&store, &p, &net);
    for bad in ["", "123", "../users/me", "00000000-0000-0000-0000-00000000zzzz", "00000000-0000-0000-0000-000000000d01?x=1"] {
        assert_eq!(err(source_with(&c, bad)).kind, ErrorKind::Endpoint, "{bad}");
        assert_eq!(err(page_with(&c, bad)).kind, ErrorKind::Endpoint, "{bad}");
        assert_eq!(err(blocks_with(&c, bad, None)).kind, ErrorKind::Endpoint, "{bad}");
        assert_eq!(err(query_with(&c, bad, None, &[])).kind, ErrorKind::Endpoint, "{bad}");
    }
    let long = "c".repeat(4097);
    for bad in ["", "tab\there", "line\nbreak", "caf\u{e9}", long.as_str()] {
        assert_eq!(err(search_with(&c, "page", Some(bad))).kind, ErrorKind::Endpoint);
        assert_eq!(err(blocks_with(&c, ID, Some(bad))).kind, ErrorKind::Endpoint);
        assert_eq!(err(query_with(&c, ID, Some(bad), &[])).kind, ErrorKind::Endpoint);
    }
    assert_eq!(err(search_with(&c, "database", None)).kind, ErrorKind::Endpoint);
    assert_eq!(err(query_with(&c, ID, None, &vec!["p".to_string(); 33])).kind, ErrorKind::Endpoint);
    assert_eq!(net.count(), 0, "nothing was sent");

    // An absent credential answers unset before any argument check or send.
    let empty = Memory::default();
    let c = ctx(&empty, &p, &net);
    assert_eq!(err(source_with(&c, "bad")).kind, ErrorKind::Unset);
    assert_eq!(err(search_with(&c, "page", None)).kind, ErrorKind::Unset);
    assert_eq!(err(query_with(&c, ID, None, &[])).kind, ErrorKind::Unset);
    assert_eq!(err(page_with(&c, ID)).kind, ErrorKind::Unset);
    assert_eq!(err(blocks_with(&c, ID, None)).kind, ErrorKind::Unset);
    let broken = Memory { fail_reads: true, ..Memory::default() };
    assert_eq!(err(search_with(&ctx(&broken, &p, &net), "page", None)).kind, ErrorKind::Unset);
    assert_eq!(net.count(), 0);
    assert!(!status_with(&empty).token_saved);
    assert!(!status_with(&broken).token_saved);
}

#[test]
fn status_maps_to_kind() {
    let store = Memory::with_token(TOKEN);
    let cases: Vec<(u16, Option<u64>, &str, ErrorKind, Option<u64>)> = vec![
        (200, None, "not json", ErrorKind::Parse, None),
        (200, None, "[1]", ErrorKind::Parse, None),
        (401, None, r#"{"code":"unauthorized","message":"API token is invalid."}"#, ErrorKind::Auth, None),
        (403, None, fixture!("error-403"), ErrorKind::Forbidden, None),
        (404, None, r#"{"code":"object_not_found"}"#, ErrorKind::Missing, None),
        (429, Some(7), fixture!("error-429"), ErrorKind::Rate, Some(7)),
        (429, None, fixture!("error-429"), ErrorKind::Rate, Some(12)),
        (429, None, "{}", ErrorKind::Rate, Some(1)),
        (429, Some(5000), "{}", ErrorKind::Rate, Some(600)),
        (429, None, r#"{"code":"public_api_request_blocked","message":"blocked"}"#, ErrorKind::Endpoint, None),
        (400, None, r#"{"code":"validation_error","message":"bad\u0007 body"}"#, ErrorKind::Endpoint, None),
        (409, None, r#"{"code":"conflict_error"}"#, ErrorKind::Endpoint, None),
        (500, None, "{}", ErrorKind::Endpoint, None),
        (502, None, "<html>", ErrorKind::Endpoint, None),
        (503, Some(30), "{}", ErrorKind::Endpoint, Some(30)),
        (504, None, "{}", ErrorKind::Endpoint, None),
        (529, Some(9), r#"{"code":"service_overload"}"#, ErrorKind::Endpoint, Some(9)),
        (301, None, "", ErrorKind::Endpoint, None),
        (418, None, "", ErrorKind::Endpoint, None),
    ];
    for (status, after, body, kind, want_after) in cases {
        let (p, _) = pacer();
        let net = Fake::new().reply_after(status, after, body);
        let e = err(search_with(&ctx(&store, &p, &net), "source", None));
        assert_eq!((e.kind, e.retry_after), (kind, want_after), "status {status} body {body}");
        assert!(e.message.chars().count() <= 200 && !e.message.chars().any(char::is_control));
        assert_eq!(p.held(), status == 429 && kind == ErrorKind::Rate || status == 529, "hold after {status}");
    }
    let e = err(search_with(&ctx(&store, &pacer().0, &Fake::new().reply(301, "")), "page", None));
    assert_eq!(e.message, "redirect refused");
    let long = format!(r#"{{"code":"validation_error","message":"{}"}}"#, "m".repeat(500));
    let e = err(search_with(&ctx(&store, &pacer().0, &Fake::new().reply(400, &long)), "page", None));
    assert_eq!(e.message.len(), 200);

    let fails = [
        (SendError::OverCap, ErrorKind::Endpoint),
        (SendError::Timeout, ErrorKind::Network),
        (SendError::Connect("WinHttpSendRequest failed (12029)".into()), ErrorKind::Network),
        (SendError::Io("WinHttpReadData failed (12030)".into()), ErrorKind::Network),
    ];
    for (f, kind) in fails {
        let net = Fake::new().fail(f);
        assert_eq!(err(search_with(&ctx(&store, &pacer().0, &net), "page", None)).kind, kind);
    }
}

#[test]
fn rate_hold_refuses_without_send() {
    let store = Memory::with_token(TOKEN);
    let (p, clock) = pacer();
    let net = Fake::new().reply_after(429, Some(20), "{}").reply(200, fixture!("query-last"));
    let c = ctx(&store, &p, &net);
    assert_eq!(err(query_with(&c, ID, None, &[])).retry_after, Some(20));
    let e = err(page_with(&c, ID));
    assert_eq!((e.kind, e.retry_after), (ErrorKind::Rate, Some(20)));
    assert_eq!(net.count(), 1);
    clock.advance(Duration::from_secs(20));
    assert!(query_with(&c, ID, None, &[]).is_ok());
    assert_eq!(net.count(), 2);
}

#[test]
fn search_drops_database_rows() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let net = Fake::new().reply(200, fixture!("search-pages")).reply(200, fixture!("search-sources"));
    let c = ctx(&store, &p, &net);
    let pages = search_with(&c, "page", None).unwrap();
    let ids: Vec<_> = pages.hits.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(
        ids,
        ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000005"]
    );
    assert_eq!(pages.hits[0].title, "Example Home");
    assert_eq!(pages.hits[0].kind, "page");
    assert_eq!(pages.hits[0].last_edited, "2026-10-16T10:00:00.000Z");
    assert_eq!(pages.hits[1].url, "https://app.notion.com/p/00000000000000000000000000000002");
    assert_eq!(pages.hits[2].url, "https://www.notion.so/00000000000000000000000000000005");
    assert_eq!(pages.hits[2].title, "");
    assert_eq!(pages.next.as_deref(), Some("00000000-0000-0000-0000-0000000000e1"));

    let sources = search_with(&c, "source", Some("00000000-0000-0000-0000-0000000000e1")).unwrap();
    assert_eq!(sources.hits.len(), 2, "the invalid id is dropped");
    assert_eq!(sources.hits[0].kind, "source");
    assert_eq!(sources.hits[0].title, "Example Tasks");
    assert_eq!(sources.hits[1].url, "https://www.notion.so/00000000000000000000000000000d02");
    assert_eq!(sources.next, None);
    let body: Value = serde_json::from_slice(net.sent.borrow()[1].req.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["filter"]["value"], "data_source");
    assert_eq!(body["start_cursor"], "00000000-0000-0000-0000-0000000000e1");

    let wire = serde_json::to_value(Answer::from(Ok::<_, ApiError>(pages))).unwrap();
    assert!(wire["hits"][0].get("lastEdited").is_some());
}

#[test]
fn hits_and_rows_carry_emoji_icons_only() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let net = Fake::new().reply(200, fixture!("search-pages")).reply(200, fixture!("query-page-1"));
    let c = ctx(&store, &p, &net);
    let pages = search_with(&c, "page", None).unwrap();
    assert_eq!(pages.hits[0].icon, "\u{1F4D8}", "emoji kept");
    assert_eq!(pages.hits[1].icon, "", "external dropped");
    assert_eq!(pages.hits[2].icon, "", "absent reads empty");
    let rows = query_with(&c, ID, None, &[]).unwrap().rows;
    assert_eq!(rows[0].icon, "\u{1F41E}");
    assert_eq!(rows[1].icon, "", "file dropped");

    let long = json!({ "icon": { "type": "emoji", "emoji": "a".repeat(17) } });
    assert_eq!(parse::emoji_icon(&long), "", "over-long dropped");
    let ctrl = json!({ "icon": { "type": "emoji", "emoji": "a\u{7}" } });
    assert_eq!(parse::emoji_icon(&ctrl), "");
    let custom = json!({ "icon": { "type": "custom_emoji", "emoji": "x" } });
    assert_eq!(parse::emoji_icon(&custom), "");
}

#[test]
fn native_icons_keep_a_safe_name_and_colour() {
    let ok = json!({ "icon": { "type": "icon", "icon": { "name": "checklist", "color": "green" } } });
    assert_eq!(parse::native_icon(&ok), ("checklist".to_string(), "green".to_string()));
    assert_eq!(parse::emoji_icon(&ok), "", "not an emoji");
    let bad_color = json!({ "icon": { "type": "icon", "icon": { "name": "bug", "color": "Gr een" } } });
    assert_eq!(parse::native_icon(&bad_color), ("bug".to_string(), String::new()));
    let bad_name = json!({ "icon": { "type": "icon", "icon": { "name": "../x", "color": "red" } } });
    assert_eq!(parse::native_icon(&bad_name), (String::new(), String::new()));
    let long = json!({ "icon": { "type": "icon", "icon": { "name": "a".repeat(41), "color": "red" } } });
    assert_eq!(parse::native_icon(&long), (String::new(), String::new()));
    let emoji = json!({ "icon": { "type": "emoji", "emoji": "x" } });
    assert_eq!(parse::native_icon(&emoji), (String::new(), String::new()));
    assert_eq!(parse::native_icon(&json!({})), (String::new(), String::new()));
}

#[test]
fn schema_keeps_options_and_status_groups() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let net = Fake::new().reply(200, fixture!("source"));
    let out = source_with(&ctx(&store, &p, &net), "00000000000000000000000000000D01").unwrap();
    let s = out.source;
    assert_eq!(s.id, ID);
    assert_eq!(s.title, "Example Tasks");
    let names: Vec<_> = s.props.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["Name", "Status", "Type", "Tags", "Owner", "Done", "Due", "Points"]);
    let status = &s.props[1];
    assert_eq!((status.id.as_str(), status.kind.as_str()), ("st%3Aa", "status"));
    assert_eq!(status.options.len(), 4);
    assert_eq!(status.options[1], parse::Opt { name: "In progress".into(), color: "blue".into() });
    let groups: Vec<_> = status.groups.iter().map(|g| (g.name.as_str(), g.options.clone())).collect();
    assert_eq!(
        groups,
        [
            ("To-do", vec!["Not started".to_string()]),
            ("In progress", vec!["In progress".to_string(), "In review".to_string()]),
            ("Complete", vec!["Done".to_string()]),
        ]
    );
    assert_eq!(s.props[2].options.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["Bug", "Feature"]);
    assert!(s.props[2].groups.is_empty());
    assert_eq!(s.props[3].options.len(), 2);
    assert!(s.props[4].options.is_empty() && s.props[7].options.is_empty());
    let wire = serde_json::to_value(&s.props[1]).unwrap();
    assert_eq!(wire["type"], "status");
}

#[test]
fn query_rows_flatten_facet_values() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let net = Fake::new().reply(200, fixture!("query-page-1")).reply(200, fixture!("query-last"));
    let c = ctx(&store, &p, &net);
    let first = query_with(&c, ID, None, &["title".into(), "st%3Aa".into()]).unwrap();
    assert_eq!(first.rows.len(), 2, "the wiki data_source result is not a row");
    assert!(!first.props_refused);
    let row = &first.rows[0];
    assert_eq!(row.title, "Fix Login");
    assert_eq!(row.url, "https://www.notion.so/Fix-Login-00000000000000000000000000000101");
    assert_eq!(row.last_edited, "2026-10-16T09:00:00.000Z");
    assert_eq!(
        Value::Object(row.values.clone()),
        json!({
            "st%3Aa": ["In progress"],
            "ty~1": ["Bug"],
            "tg.2": ["ui", "rust"],
            "ow_3": ["Example Person", "Unknown"],
            "dn-4": ["Unchecked"],
        })
    );
    assert_eq!(
        Value::Object(first.rows[1].values.clone()),
        json!({ "st%3Aa": [], "ty~1": [], "tg.2": [], "ow_3": [], "dn-4": ["Checked"] })
    );
    assert_eq!(first.next.as_deref(), Some("00000000-0000-0000-0000-0000000000e2"));

    let last = query_with(&c, ID, first.next.as_deref(), &[]).unwrap();
    assert_eq!(last.rows.len(), 1);
    assert_eq!(last.next, None);
    let body: Value = serde_json::from_slice(net.sent.borrow()[1].req.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["start_cursor"], "00000000-0000-0000-0000-0000000000e2");
    assert_eq!(body["sorts"], json!([{ "timestamp": "last_edited_time", "direction": "descending" }]));
    assert_eq!(
        net.sent.borrow()[0].req.path,
        format!("/v1/data_sources/{ID}/query?filter_properties=title&filter_properties=st%3Aa")
    );
}

#[test]
fn page_fields_cover_every_property_type() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let net = Fake::new().reply(200, fixture!("page-all-props"));
    let page = page_with(&ctx(&store, &p, &net), "00000000-0000-0000-0000-000000000101").unwrap().page;
    assert_eq!(page.title, "Fix Login");
    assert_eq!(page.created, "2026-10-01T09:00:00.000Z");
    assert_eq!(page.last_edited, "2026-10-16T09:00:00.000Z");
    let got: Vec<(&str, &str)> = page.fields.iter().map(|f| (f.label.as_str(), f.value.as_str())).collect();
    assert_eq!(
        got,
        [
            ("Notes", "Seen on Example Workspace"),
            ("Points", "3"),
            ("Ratio", "0.25"),
            ("Type", "Bug"),
            ("Status", "In progress"),
            ("Tags", "ui, rust"),
            ("Due", "2026-10-20 – 2026-10-24"),
            ("Owner", "Example Person, Unknown"),
            ("Done", "Yes"),
            ("Link", "https://example.com/spec"),
            ("Mail", "person@example.com"),
            ("Phone", "+1 555 0100"),
            ("Score", "42"),
            ("Late", "No"),
            ("Blocks", "1 Page"),
            ("Parents", "2 Pages"),
            ("Total", "7"),
            ("Names", "Empty Row, Last Row"),
            ("Attachments", "spec.pdf"),
            ("Ticket", "TASK-12"),
            ("Seq", "5"),
            ("Created", "2026-10-01T09:00:00.000Z"),
            ("Edited", "2026-10-16T09:00:00.000Z"),
            ("Creator", "Example Person"),
            ("Editor", "Unknown"),
            ("Empty", ""),
        ]
    );
    let dims: Vec<_> = page.fields.iter().filter(|f| f.dim).map(|f| f.label.as_str()).collect();
    assert_eq!(dims, ["Empty"]);
    let wire = serde_json::to_value(&page.fields[0]).unwrap();
    assert!(wire.get("dim").is_none());
}

#[test]
fn blocks_pass_only_block_objects() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let net = Fake::new().reply(200, fixture!("blocks-hostile")).reply(200, fixture!("blocks-nested"));
    let c = ctx(&store, &p, &net);
    let hostile = blocks_with(&c, ID, None).unwrap();
    let ids: Vec<_> = hostile.blocks.iter().map(|b| b["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        [
            "00000000-0000-0000-0000-000000000301",
            "00000000-0000-0000-0000-000000000302",
            "00000000-0000-0000-0000-000000000303",
            "00000000-0000-0000-0000-000000000304",
            "00000000-0000-0000-0000-000000000305",
        ]
    );
    let src: Value = serde_json::from_str(fixture!("blocks-hostile")).unwrap();
    assert_eq!(hostile.blocks[0], src["results"][0], "passed through unchanged");
    assert_eq!(hostile.next, None);
    let nested = blocks_with(&c, ID, None).unwrap();
    assert_eq!(nested.blocks.len(), 6);
    assert_eq!(nested.next.as_deref(), Some("00000000-0000-0000-0000-0000000000e3"));
}

#[test]
fn connect_saves_only_after_users_me_ok() {
    let (p, _) = pacer();
    for (status, body) in [(401, r#"{"code":"unauthorized"}"#), (403, fixture!("error-403")), (500, "{}"), (200, "nope")] {
        let store = Memory::default();
        let net = Fake::new().reply(status, body);
        assert!(connect_with(&ctx(&store, &p, &net), Secret::new(TOKEN.into())).is_err(), "{status}");
        assert!(store.saved.borrow().is_none(), "nothing saved on {status}");
        p.clear();
    }
    let store = Memory::default();
    let net = Fake::new().fail(SendError::Timeout);
    assert_eq!(err(connect_with(&ctx(&store, &p, &net), Secret::new(TOKEN.into()))).kind, ErrorKind::Network);
    assert!(store.saved.borrow().is_none());

    for bad in ["", "has space", "tab\tin", "x".repeat(1025).as_str()] {
        let net = Fake::new();
        let e = err(connect_with(&ctx(&store, &p, &net), Secret::new(bad.to_string())));
        assert_eq!(e.kind, ErrorKind::Endpoint);
        assert!(bad.is_empty() || !e.message.contains(bad));
        assert_eq!(net.count(), 0, "bad token refused before send");
    }

    let net = Fake::new().reply(200, fixture!("users-me"));
    let me = connect_with(&ctx(&store, &p, &net), Secret::new(TOKEN.into())).unwrap();
    assert_eq!(me, parse::Me { workspace: Some("Example Workspace".into()), kind: "connection" });
    assert_eq!(net.sent.borrow()[0].req.path, "/v1/users/me");
    assert_eq!(net.sent.borrow()[0].req.method, "GET");
    assert_eq!(net.sent.borrow()[0].cap, 64 * 1024);
    assert_eq!(
        store.saved.borrow().clone(),
        Some(("connection".to_string(), "Example Workspace".to_string(), TOKEN.to_string()))
    );
    assert_eq!(
        status_with(&store),
        Status { token_saved: true, workspace: Some("Example Workspace".into()), kind: Some("connection") }
    );

    let personal = fixture!("users-me").replace(r#""type": "workspace""#, r#""type": "user""#);
    let store = Memory::default();
    let net = Fake::new().reply(200, &personal);
    assert_eq!(connect_with(&ctx(&store, &p, &net), Secret::new(TOKEN.into())).unwrap().kind, "personal");
    assert_eq!(status_with(&store).kind, Some("personal"));
}

#[test]
fn connect_and_disconnect_clear_the_hold() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    p.hold(300);
    let net = Fake::new().reply(200, fixture!("users-me"));
    connect_with(&ctx(&store, &p, &net), Secret::new(TOKEN.into())).unwrap();
    assert_eq!(net.count(), 1, "connect sent despite the old hold");
    assert!(!p.held());

    p.hold(300);
    assert!(p.held());
    let generation = AtomicU64::new(0);
    disconnect_with(&store, &p, &generation).unwrap();
    assert!(!p.held());
    assert!(store.saved.borrow().is_none());
    assert!(!status_with(&store).token_saved);
    disconnect_with(&store, &p, &generation).unwrap();
    assert_eq!(generation.load(Ordering::SeqCst), 2, "each disconnect bumps the generation");
}

/// A transport that runs `during` inside the send, then answers from `inner`.
struct During<F: Fn()> {
    inner: Fake,
    during: F,
}

impl<F: Fn()> Transport for During<F> {
    fn send(&self, req: &net::Request, headers: &Secret, limits: net::Limits) -> Result<net::Reply, SendError> {
        (self.during)();
        self.inner.send(req, headers, limits)
    }
}

#[test]
fn late_connect_does_not_save() {
    let (p, _) = pacer();
    let generation = AtomicU64::new(0);
    // A Disconnect lands while users/me is in flight.
    let store = Memory::default();
    let net = During {
        inner: Fake::new().reply(200, fixture!("users-me")),
        during: || disconnect_with(&store, &p, &generation).unwrap(),
    };
    let c = Ctx { store: &store, pacer: &p, net: &net, generation: &generation, started: p.now() };
    let e = err(connect_with(&c, Secret::new(TOKEN.into())));
    assert_eq!((e.kind, e.message.as_str()), (ErrorKind::Endpoint, "connect was superseded"));
    assert!(store.saved.borrow().is_none(), "nothing saved after the disconnect");

    // A newer connect starting meanwhile supersedes the older one too.
    let net = During {
        inner: Fake::new().reply(200, fixture!("users-me")),
        during: || {
            generation.fetch_add(1, Ordering::SeqCst);
        },
    };
    let c = Ctx { store: &store, pacer: &p, net: &net, generation: &generation, started: p.now() };
    assert_eq!(err(connect_with(&c, Secret::new(TOKEN.into()))).message, "connect was superseded");
    assert!(store.saved.borrow().is_none());
}

#[test]
fn full_pacer_queue_refuses_before_send() {
    let store = Memory::with_token(TOKEN);
    let (p, clock) = pacer();
    let net = Fake::new().reply(200, fixture!("page-all-props"));
    let c = ctx(&store, &p, &net);
    // 19.8 s of the budget spent and one send taken: the next slot, 350 ms out, does not fit.
    clock.advance(Duration::from_millis(19_800));
    assert!(page_with(&c, ID).is_ok());
    let e = err(page_with(&c, ID));
    assert_eq!((e.kind, e.retry_after), (ErrorKind::Rate, Some(1)));
    assert_eq!(net.count(), 1, "the refused call sent nothing");
    assert!(clock.sleeps().is_empty(), "and did not wait");
}

#[test]
fn hold_retry_after_is_the_clamped_hold() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let net = Fake::new().reply_after(529, Some(99_999), r#"{"code":"service_overload"}"#);
    let e = err(search_with(&ctx(&store, &p, &net), "page", None));
    assert_eq!((e.kind, e.retry_after), (ErrorKind::Endpoint, Some(600)));
    assert!(p.held());
}

#[test]
fn token_straddling_the_cap_is_redacted() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let message = format!("{}{TOKEN}{}", "m".repeat(190), "n".repeat(300 - 190 - TOKEN.len()));
    assert_eq!(message.chars().count(), 300);
    let body = serde_json::to_string(&json!({ "code": "validation_error", "message": message })).unwrap();
    let net = Fake::new()
        .reply(400, &body)
        .fail(SendError::Io(format!("{}{TOKEN}", "x".repeat(190))));
    let c = ctx(&store, &p, &net);
    for e in [err(search_with(&c, "page", None)), err(search_with(&c, "page", None))] {
        assert!(!e.message.contains(&TOKEN[..8]), "{}", e.message);
        assert!(e.message.contains("***"));
    }
}

#[test]
fn invalid_saved_blob_sends_nothing() {
    let (p, _) = pacer();
    let net = Fake::new().reply(200, fixture!("search-pages"));
    for blob in [format!("{TOKEN}\r\nX-Injected: 1"), "ntn_a\nb".to_string(), String::new()] {
        let store = Memory::with_token(&blob);
        let e = err(search_with(&ctx(&store, &p, &net), "page", None));
        assert_eq!((e.kind, e.message.as_str()), (ErrorKind::Unset, "saved Notion token is not valid; connect again"));
    }
    assert_eq!(net.count(), 0);
}

#[test]
fn query_retries_once_without_filter_properties() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let refused = r#"{"object":"error","status":400,"code":"validation_error","message":"bad filter_properties"}"#;
    let net = Fake::new().reply(400, refused).reply(200, fixture!("query-last"));
    let c = ctx(&store, &p, &net);
    let rows = query_with(&c, ID, Some("c1"), &["title".into(), "st%3Aa".into()]).unwrap();
    assert_eq!(rows.rows.len(), 1);
    let sent = net.sent.borrow();
    assert_eq!(sent.len(), 2);
    assert!(sent[0].req.path.ends_with("/query?filter_properties=title&filter_properties=st%3Aa"));
    assert_eq!(sent[1].req.path, format!("/v1/data_sources/{ID}/query"));
    assert_eq!(sent[0].req.body, sent[1].req.body, "same cursor and sort");
    drop(sent);

    // Only once: a second refusal is an error, not a third send.
    let net = Fake::new().reply(400, refused).reply(400, refused).reply(200, "{}");
    let e = err(query_with(&ctx(&store, &p, &net), ID, None, &["title".into()]));
    assert_eq!(e.kind, ErrorKind::Endpoint);
    assert_eq!(net.count(), 2);

    // No props, or another 400 code: no retry.
    let net = Fake::new().reply(400, refused).reply(200, fixture!("query-last"));
    assert!(query_with(&ctx(&store, &p, &net), ID, None, &[]).is_err());
    assert_eq!(net.count(), 1);
    let net = Fake::new().reply(400, r#"{"code":"invalid_json"}"#).reply(200, fixture!("query-last"));
    assert!(query_with(&ctx(&store, &p, &net), ID, None, &["title".into()]).is_err());
    assert_eq!(net.count(), 1);
    // Props that all fail the character check are dropped, so nothing is retried either.
    let net = Fake::new().reply(400, refused).reply(200, fixture!("query-last"));
    assert!(query_with(&ctx(&store, &p, &net), ID, None, &["a b".into()]).is_err());
    assert_eq!(net.count(), 1);
    assert_eq!(net.sent.borrow()[0].req.path, format!("/v1/data_sources/{ID}/query"));
}

#[test]
fn query_refused_props_reply_flags_it() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let refused = r#"{"code":"validation_error","message":"bad filter_properties"}"#;
    let net = Fake::new().reply(400, refused).reply(200, fixture!("query-page-1"));
    let rows = query_with(&ctx(&store, &p, &net), ID, None, &["title".into()]).unwrap();
    assert!(rows.props_refused);
    let wire = serde_json::to_value(Answer::from(Ok::<_, ApiError>(rows))).unwrap();
    assert_eq!(wire["propsRefused"], true);
    assert_eq!(wire["next"], "00000000-0000-0000-0000-0000000000e2");

    let net = Fake::new().reply(200, fixture!("query-last"));
    let rows = query_with(&ctx(&store, &p, &net), ID, None, &["title".into()]).unwrap();
    let wire = serde_json::to_value(Answer::from(Ok::<_, ApiError>(rows))).unwrap();
    assert_eq!(wire["propsRefused"], false);
    assert_eq!(wire["next"], Value::Null);
}

#[test]
fn token_never_reaches_errors_or_debug() {
    let store = Memory::with_token(TOKEN);
    let (p, _) = pacer();
    let echo = format!(r#"{{"code":"validation_error","message":"token {TOKEN} rejected"}}"#);
    let net = Fake::new()
        .reply(400, &echo)
        .fail(SendError::Io(format!("WinHttpSendRequest failed {TOKEN}")));
    let c = ctx(&store, &p, &net);
    for e in [err(search_with(&c, "page", None)), err(search_with(&c, "page", None))] {
        let wire = serde_json::to_string(&Answer::<()>::Error { error: e.clone() }).unwrap();
        assert!(!e.message.contains(TOKEN) && !wire.contains(TOKEN) && !format!("{e:?}").contains(TOKEN));
    }
    let token = token(&store).unwrap();
    assert_eq!(format!("{token:?}"), "Secret(***)");
    assert_eq!(format!("{:?}", api::headers(&token, "GET")), "Secret(***)");
    let saved = store.read().unwrap().unwrap();
    assert!(!format!("{saved:?}").contains(TOKEN));
}

#[test]
fn error_wire_shape_is_kind_message_retry_after() {
    let e = ApiError::new(ErrorKind::Rate, "slow down").after(Some(4));
    let wire = serde_json::to_value(Answer::<()>::Error { error: e }).unwrap();
    assert_eq!(wire, json!({ "error": { "kind": "rate", "message": "slow down", "retryAfter": 4 } }));
    let wire = serde_json::to_value(Answer::<()>::Error { error: ApiError::new(ErrorKind::Unset, "x") }).unwrap();
    assert_eq!(wire, json!({ "error": { "kind": "unset", "message": "x" } }));
}
