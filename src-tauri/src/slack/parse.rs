//! Search matches to inbox items, and the merge (docs/projects/slack/inbox-tab-plan.md § Rust, C8, C13,
//! C14, C16, C18). Remote text is decoded and capped here; ids are checked before they reach an item id
//! or a rebuilt permalink. Names come through a lookup closure (names.rs) so parsing never sends.

use std::cmp::Reverse;
use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value;

use super::api::{user_id_ok, Class};

pub const TEXT_CAP: usize = 2000;
pub const NAME_CAP: usize = 80;
pub const URL_CAP: usize = 2000;
/// Rows in the merged list, and the share reserved for direct mentions and DMs together.
pub const ROWS: usize = 50;
pub const RESERVED: usize = 25;

/// One inbox row: `{ id, kind, place, sender, channel, text, ts, url }`; `channel` is display-ready
/// (`#name`, `DM` or `Group DM`), `place` is `dm`, `group`, `channel` or `private`, `ts` is Slack's
/// `secs.micros` string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    pub id: String,
    pub kind: &'static str,
    pub place: &'static str,
    pub sender: String,
    pub channel: String,
    pub text: String,
    pub ts: String,
    pub url: String,
}

/// An item and its sender's user id (empty when the match carries none), kept for the own-message filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub item: Item,
    pub user: String,
}

/// `{ items, truncated }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Merged {
    pub items: Vec<Item>,
    pub truncated: bool,
}

pub type Names<'a> = &'a dyn Fn(&str) -> Option<String>;

/// `DM` for `channel.is_im`, `type == "im"` (P0) or a `D…` channel id, `Group DM` for `channel.is_mpim`
/// or `type == "mpim"` (which win over the id check), else none.
pub fn dm_label(m: &Value) -> Option<&'static str> {
    let flag = |k: &str| m.get("channel").and_then(|c| c.get(k)).and_then(Value::as_bool) == Some(true);
    if flag("is_im") || m.get("type").and_then(Value::as_str) == Some("im") {
        Some("DM")
    } else if flag("is_mpim") || m.get("type").and_then(Value::as_str) == Some("mpim") {
        Some("Group DM")
    } else if str_at(m, "/channel/id").is_some_and(|id| id.starts_with('D')) {
        Some("DM")
    } else {
        None
    }
}

/// Where a match lives: the match `type` first (`im` dm, `mpim` group, `group` private), then the DM
/// label, then `channel.is_private`; with no `type` the id prefix decides (D dm, G private), else channel.
/// `search.messages` channel objects carry no is_im/is_group, so the flags are only a second source.
pub fn place_of(m: &Value, channel_id: &str) -> &'static str {
    let ty = m.get("type").and_then(Value::as_str);
    match ty {
        Some("im") => return "dm",
        Some("mpim") => return "group",
        Some("group") => return "private",
        _ => {}
    }
    match dm_label(m) {
        Some("Group DM") => return "group",
        Some(_) => return "dm",
        None => {}
    }
    if m.pointer("/channel/is_private").and_then(Value::as_bool) == Some(true) {
        return "private";
    }
    if ty.is_none() {
        match channel_id.as_bytes().first() {
            Some(b'D') => return "dm",
            Some(b'G') => return "private",
            _ => {}
        }
    }
    "channel"
}

/// `C…`/`G…`/`D…` channel ids.
pub fn channel_id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    (3..=32).contains(&b.len())
        && matches!(b[0], b'C' | b'G' | b'D')
        && b.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// `^\d{1,12}\.\d{6}$`.
pub fn ts_ok(ts: &str) -> bool {
    let Some((secs, micros)) = ts.split_once('.') else { return false };
    (1..=12).contains(&secs.len())
        && micros.len() == 6
        && secs.bytes().chain(micros.bytes()).all(|b| b.is_ascii_digit())
}

/// `^[a-z0-9][a-z0-9-]{0,62}\.slack\.com$`.
pub fn host_ok(host: &str) -> bool {
    let Some(sub) = host.strip_suffix(".slack.com") else { return false };
    let b = sub.as_bytes();
    (1..=63).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn ts_key(ts: &str) -> (u64, u32) {
    let (s, m) = ts.split_once('.').unwrap_or((ts, "0"));
    (s.parse().unwrap_or(0), m.parse().unwrap_or(0))
}

fn clean(s: &str, cap: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(cap).collect::<String>().trim().to_string()
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

fn label_of(inner: &str) -> (&str, Option<&str>) {
    match inner.split_once('|') {
        Some((a, b)) if !b.is_empty() => (a, Some(b)),
        Some((a, _)) => (a, None),
        None => (inner, None),
    }
}

fn decode_tag(inner: &str, names: Names) -> String {
    let (head, label) = label_of(inner);
    if let Some(id) = head.strip_prefix('@') {
        let name = if user_id_ok(id) { names(id) } else { None };
        return format!("@{}", name.as_deref().or(label).unwrap_or(id));
    }
    if let Some(id) = head.strip_prefix('#') {
        return format!("#{}", label.unwrap_or(id));
    }
    if let Some(cmd) = head.strip_prefix('!') {
        let word = cmd.split('^').next().unwrap_or(cmd);
        return match word {
            "here" | "channel" | "everyone" => format!("@{word}"),
            "subteam" => label.map(str::to_string).unwrap_or_else(|| format!("@{}", cmd.split('^').nth(1).unwrap_or(""))),
            "date" => label.unwrap_or("").to_string(),
            _ => label.map(str::to_string).unwrap_or_else(|| format!("@{word}")),
        };
    }
    label.unwrap_or(head).to_string()
}

/// Slack markup to plain text (C16): user, channel, special and link tags, then `&lt;`/`&gt;`/`&amp;`.
/// Unresolved users keep their label or raw id. Control characters other than newline and tab are
/// dropped; at most `TEXT_CAP` chars.
pub fn decode_text(text: &str, names: Names) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('>') {
            Some(close) => {
                out.push_str(&decode_tag(&after[..close], names));
                rest = &after[close + 1..];
            }
            None => {
                out.push_str(&rest[open..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    unescape(&out)
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(TEXT_CAP)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Kept only when it is `https://<host>/archives/…` in printable ASCII; otherwise rebuilt as
/// `https://{host}/archives/{channel}/p{ts without dot}` from checked ids (C14, C18). An invalid host
/// gives an empty url.
pub fn permalink(raw: Option<&str>, host: &str, channel: &str, ts: &str) -> String {
    if !host_ok(host) || !channel_id_ok(channel) || !ts_ok(ts) {
        return String::new();
    }
    let prefix = format!("https://{host}/archives/");
    if let Some(u) = raw {
        let printable = u.bytes().all(|b| (0x21..=0x7e).contains(&b) && !b"\\@<>\"'`".contains(&b));
        if u.len() <= URL_CAP && printable && u.starts_with(&prefix) && u.len() > prefix.len() {
            return u.to_string();
        }
    }
    format!("{prefix}{channel}/p{}", ts.replace('.', ""))
}

fn str_at<'a>(v: &'a Value, path: &str) -> Option<&'a str> {
    v.pointer(path).and_then(Value::as_str)
}

/// One match to an item; `None` for a bad channel id or ts, or a non-DM match from the DM source.
pub fn parse_match(m: &Value, class: Class, host: &str, names: Names) -> Option<Match> {
    let channel_id = str_at(m, "/channel/id").filter(|c| channel_id_ok(c))?;
    let ts = str_at(m, "/ts").filter(|t| ts_ok(t))?;
    let dm = dm_label(m);
    if class == Class::Dm && dm.is_none() {
        return None;
    }
    let kind = if dm.is_some() && class != Class::Broadcast { "dm" } else { "mention" };
    let channel = match dm {
        Some(label) => label.to_string(),
        None => {
            let name = clean(str_at(m, "/channel/name").unwrap_or(""), NAME_CAP);
            format!("#{}", if name.is_empty() { channel_id } else { &name })
        }
    };
    let user = str_at(m, "/user").filter(|u| user_id_ok(u)).unwrap_or("").to_string();
    let username = clean(str_at(m, "/username").unwrap_or(""), NAME_CAP);
    let resolved = if user.is_empty() { None } else { names(&user).map(|n| clean(&n, NAME_CAP)) };
    let sender = resolved
        .filter(|n| !n.is_empty())
        .or_else(|| (!username.is_empty()).then(|| username.clone()))
        .or_else(|| (!user.is_empty()).then(|| user.clone()))
        .unwrap_or_else(|| "Unknown".to_string());
    let item = Item {
        id: format!("{channel_id}:{ts}"),
        kind,
        place: place_of(m, channel_id),
        sender,
        channel,
        text: decode_text(str_at(m, "/text").unwrap_or(""), names),
        ts: ts.to_string(),
        url: permalink(str_at(m, "/permalink"), host, channel_id, ts),
    };
    Some(Match { item, user })
}

pub fn parse_matches(matches: &[Value], class: Class, host: &str, names: Names) -> Vec<Match> {
    matches.iter().filter_map(|m| parse_match(m, class, host, names)).collect()
}

/// Sender ids and `<@U…>` ids in text, deduped in first-seen order, for the name lookup.
pub fn user_ids(matches: &[Value]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut add = |id: &str| {
        if user_id_ok(id) && seen.insert(id.to_string()) {
            out.push(id.to_string());
        }
    };
    for m in matches {
        if let Some(u) = str_at(m, "/user") {
            add(u);
        }
        let mut rest = str_at(m, "/text").unwrap_or("");
        while let Some(i) = rest.find("<@") {
            rest = &rest[i + 2..];
            let end = rest.find(['>', '|']).unwrap_or(rest.len());
            add(&rest[..end]);
        }
    }
    out
}

fn newest_first(items: &mut [Item]) {
    items.sort_by_key(|i| Reverse(ts_key(&i.ts)));
}

/// Dedupe by id (first seen wins, `direct` before `broadcast`), drop `own`'s messages, keep up to
/// `RESERVED` direct mentions and DMs, fill to `ROWS` with broadcasts, newest first. `truncated` when a
/// source hit its cap (`capped`) or the merge dropped a row.
pub fn merge(direct: Vec<Match>, broadcast: Vec<Match>, own: &str, capped: bool) -> Merged {
    let mut seen = HashSet::new();
    let mut take = |list: Vec<Match>| -> Vec<Item> {
        list.into_iter()
            .filter(|m| m.user.is_empty() || m.user != own)
            .filter(|m| seen.insert(m.item.id.clone()))
            .map(|m| m.item)
            .collect()
    };
    let mut first = take(direct);
    let mut rest = take(broadcast);
    newest_first(&mut first);
    newest_first(&mut rest);
    let mut truncated = capped || first.len() > RESERVED;
    first.truncate(RESERVED);
    let room = ROWS - first.len();
    truncated |= rest.len() > room;
    rest.truncate(room);
    first.extend(rest);
    newest_first(&mut first);
    Merged { items: first, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slack::api::{self, MentionSource};
    use serde_json::json;

    const HOST: &str = "example.slack.com";
    const ME: &str = "U0FIXTURE1";
    const AUTH: &str = include_str!("../../../tests/fixtures/slack/auth-test.json");
    const MENTIONS: &str = include_str!("../../../tests/fixtures/slack/search-mentions.json");
    const DMS: &str = include_str!("../../../tests/fixtures/slack/search-dms.json");
    const ITEMS: &str = include_str!("../../../tests/fixtures/slack/items.json");

    fn fixture_names(id: &str) -> Option<String> {
        (id == "U0FIXTURE2").then(|| "Ada Example".to_string())
    }

    fn none(_: &str) -> Option<String> {
        None
    }

    fn found(src: &MentionSource, body: &'static str) -> Vec<Value> {
        let v: Value = serde_json::from_str(body).unwrap();
        api::search(src, |_, _| Ok(v.clone())).unwrap().matches
    }

    #[test]
    fn search_fixture_parses_to_item_shape() {
        let auth: Value = serde_json::from_str(AUTH).unwrap();
        assert_eq!(auth["user_id"], ME);
        assert_eq!(auth["url"], format!("https://{HOST}/"));
        let direct = MentionSource::Direct { user: ME.into() };
        let dms = MentionSource::Dms { after: "2026-10-11".into() };
        let mention_matches = found(&direct, MENTIONS);
        let dm_matches = found(&dms, DMS);
        assert_eq!(user_ids(&mention_matches), vec!["U0FIXTURE2", "U0FIXTURE1", "U0FIXTURE3"]);
        let mut first = parse_matches(&mention_matches, Class::Direct, HOST, &fixture_names);
        first.extend(parse_matches(&dm_matches, Class::Dm, HOST, &fixture_names));
        let merged = merge(first, Vec::new(), ME, false);
        let got = serde_json::to_value(&merged).unwrap();
        let want: Value = serde_json::from_str(ITEMS).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn dm_filter_keeps_im_and_mpim_only() {
        let dm_matches = found(&MentionSource::Dms { after: "2026-10-11".into() }, DMS);
        // The source already dropped the channel row.
        assert_eq!(dm_matches.len(), 2);
        let parsed = parse_matches(&dm_matches, Class::Dm, HOST, &none);
        let got: Vec<(&str, &str)> = parsed.iter().map(|m| (m.item.kind, m.item.channel.as_str())).collect();
        assert_eq!(got, vec![("dm", "DM"), ("dm", "Group DM")]);
        assert_eq!(dm_label(&json!({ "type": "im", "channel": { "id": "D0X" } })), Some("DM"));
        assert_eq!(dm_label(&json!({ "type": "message", "channel": { "is_im": true } })), Some("DM"));
        assert_eq!(dm_label(&json!({ "type": "message", "channel": { "is_mpim": true } })), Some("Group DM"));
        assert_eq!(dm_label(&json!({ "type": "message", "channel": { "is_im": false, "is_mpim": false } })), None);
        assert_eq!(dm_label(&json!({ "type": "message" })), None);
        // The same IM match from the direct source is kind `dm`; from a broadcast source, `mention`.
        let m = parse_match(&dm_matches[0], Class::Direct, HOST, &none).unwrap();
        assert_eq!((m.item.kind, m.item.channel.as_str()), ("dm", "DM"));
        let m = parse_match(&dm_matches[0], Class::Broadcast, HOST, &none).unwrap();
        assert_eq!((m.item.kind, m.item.channel.as_str()), ("mention", "DM"));
    }

    #[test]
    fn dm_label_accepts_d_channel_id() {
        assert_eq!(dm_label(&json!({ "type": "message", "channel": { "id": "D0FIXTURE9" } })), Some("DM"));
        assert_eq!(dm_label(&json!({ "type": "message", "channel": { "id": "D0FIXTURE9", "is_mpim": true } })), Some("Group DM"));
        assert_eq!(dm_label(&json!({ "type": "message", "channel": { "id": "C0FIXTURE9" } })), None);
    }

    #[test]
    fn flagless_mpim_match_survives_parse_as_a_group_dm() {
        let m = json!({
            "type": "mpim",
            "channel": { "id": "G0FIXTURE9" },
            "ts": "1760000000.000100",
            "user": "U0FIXTURE2",
            "text": "hello group"
        });
        assert_eq!(dm_label(&m), Some("Group DM"));
        let got = parse_match(&m, Class::Dm, HOST, &fixture_names).expect("kept by the DM source");
        assert_eq!(got.item.place, "group");
        assert_eq!(got.item.channel, "Group DM");
        assert_eq!(got.item.kind, "dm");
    }

    #[test]
    fn place_follows_type_then_flags_then_id() {
        let p = |v: Value, id: &str| place_of(&v, id);
        assert_eq!(p(json!({ "type": "im" }), "D0X"), "dm");
        assert_eq!(p(json!({ "type": "mpim" }), "G0X"), "group");
        assert_eq!(p(json!({ "type": "group" }), "G0X"), "private");
        assert_eq!(p(json!({ "type": "message", "channel": { "is_mpim": true } }), "G0X"), "group");
        assert_eq!(p(json!({ "type": "message", "channel": { "is_private": true } }), "C0X"), "private");
        assert_eq!(p(json!({ "type": "message", "channel": { "is_private": false } }), "C0X"), "channel");
        assert_eq!(p(json!({ "type": "message" }), "G0X"), "channel");
        assert_eq!(p(json!({}), "D0X"), "dm");
        assert_eq!(p(json!({}), "G0X"), "private");
        assert_eq!(p(json!({}), "C0X"), "channel");
    }

    #[test]
    fn permalink_off_the_credential_host_is_rebuilt() {
        let (c, ts) = ("C0FIXTURE1", "1792300000.000100");
        let rebuilt = "https://example.slack.com/archives/C0FIXTURE1/p1792300000000100";
        let kept = "https://example.slack.com/archives/C0FIXTURE1/p1792300000000100?thread_ts=1792299000.000200&cid=C0FIXTURE1";
        assert_eq!(permalink(Some(kept), HOST, c, ts), kept);
        for bad in [
            "https://other.slack.com/archives/C0FIXTURE1/p1",
            "https://example.slack.com.evil.example/archives/C0FIXTURE1/p1",
            "https://example.slack.com@evil.example/archives/x",
            "http://example.slack.com/archives/C0FIXTURE1/p1",
            "https://example.slack.com/other/C0FIXTURE1",
            "https://example.slack.com/archives/",
            "https://example.slack.com/archives/a b",
            "javascript:alert(1)",
        ] {
            assert_eq!(permalink(Some(bad), HOST, c, ts), rebuilt, "{bad}");
        }
        assert_eq!(permalink(None, HOST, c, ts), rebuilt);
        assert_eq!(permalink(None, "evil.example", c, ts), "");
        assert_eq!(permalink(None, HOST, "C0/../x", ts), "");
        assert_eq!(permalink(None, HOST, c, "1.2"), "");
    }

    #[test]
    fn text_markup_decodes() {
        let names = |id: &str| (id == "U0FIXTURE2").then(|| "Ada".to_string());
        let t = "hi <@U0FIXTURE2> <@U0FIXTURE9|bob> <@U0FIXTURE8> in <#C0FIXTURE1|general> <!here> \
                 <!subteam^S0FIXTURE1|@devs> <https://example.com|site> <https://example.com/x> a &lt;b&gt; &amp;amp; <open";
        assert_eq!(
            decode_text(t, &names),
            "hi @Ada @bob @U0FIXTURE8 in #general @here @devs site https://example.com/x a <b> &amp; <open"
        );
        assert_eq!(decode_text(&"x".repeat(5000), &none).chars().count(), TEXT_CAP);
        assert_eq!(decode_text("a\u{7}b\nc", &none), "ab\nc");
    }

    fn row(id: &str, ts: &str, user: &str, kind: &'static str) -> Match {
        let item = Item {
            id: id.to_string(),
            kind,
            place: "channel",
            sender: user.to_string(),
            channel: "#general".to_string(),
            text: String::new(),
            ts: ts.to_string(),
            url: String::new(),
        };
        Match { item, user: user.to_string() }
    }

    fn many(prefix: &str, n: usize, base: u64) -> Vec<Match> {
        (0..n).map(|i| row(&format!("{prefix}{i}"), &format!("{}.000000", base + i as u64), "U0OTHER1", "mention")).collect()
    }

    #[test]
    fn merge_reserves_direct_and_orders_newest_first() {
        // 30 direct (older) and 40 broadcasts (newer): 25 direct kept, 25 broadcasts fill to 50.
        let m = merge(many("d", 30, 1000), many("b", 40, 5000), ME, false);
        assert_eq!(m.items.len(), ROWS);
        assert!(m.truncated);
        assert_eq!(m.items.iter().filter(|i| i.id.starts_with('d')).count(), RESERVED);
        assert!(m.items.windows(2).all(|w| ts_key(&w[0].ts) >= ts_key(&w[1].ts)));
        assert_eq!(m.items[0].id, "b39");
        assert_eq!(m.items[49].id, "d5");
        // Few direct: broadcasts take the rest of the room.
        let m = merge(many("d", 3, 1000), many("b", 60, 5000), ME, false);
        assert_eq!((m.items.len(), m.truncated), (ROWS, true));
        assert_eq!(m.items.iter().filter(|i| i.id.starts_with('b')).count(), 47);
        // Dedupe keeps the direct copy; own messages drop; a capped source marks truncated.
        let direct = vec![row("x", "10.000000", "U0OTHER1", "mention"), row("own", "12.000000", ME, "dm")];
        let broadcast = vec![row("x", "10.000000", "U0OTHER1", "mention"), row("y", "11.000000", "", "mention")];
        let m = merge(direct, broadcast, ME, false);
        let ids: Vec<&str> = m.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!((ids, m.truncated), (vec!["y", "x"], false));
        assert!(merge(Vec::new(), Vec::new(), ME, true).truncated);
    }
}
