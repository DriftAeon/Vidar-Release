//! src-tauri\src\rules\generate\envelope.rs — the agent → Vidar envelope (`profiles/bare/rune-create/SKILL.md`
//! § Reply): one JSON object `{runes, sections, dropped}`, parsed strictly. Two passes, each collecting every
//! error in walk order (runes, sections, dropped) with stable wording: shape (unknown, missing and mistyped keys,
//! then the `deny_unknown_fields` serde parse) and meaning (id grammar, duplicate ids, kinds, one-line text,
//! citations inside the inputs, section membership). `warnings` adds the advisory coverage and modal lines.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Input, Span};
use crate::rules::rune::check_id;

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub runes: Vec<RuneOut>,
    pub sections: Vec<Section>,
    pub dropped: Vec<Dropped>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RuneOut {
    pub id: String,
    /// `rule` or `fact`.
    pub kind: String,
    pub description: String,
    pub body: String,
    pub sources: Vec<Source>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Source {
    /// An input's `~` path, exactly as its `=== FILE` header gives it.
    pub path: String,
    /// 1-based, the `L<n>` number.
    pub line: usize,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub heading: String,
    pub ids: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Dropped {
    pub path: String,
    pub line: usize,
    pub reason: String,
}

const TOP: [&str; 3] = ["runes", "sections", "dropped"];
const RUNE: [&str; 5] = ["id", "kind", "description", "body", "sources"];
const SOURCE: [&str; 2] = ["path", "line"];
const SECTION: [&str; 2] = ["heading", "ids"];
const DROPPED: [&str; 3] = ["path", "line", "reason"];

/// The reply text without one wrapping Markdown fence, if it has exactly that.
pub(super) fn unfence(reply: &str) -> &str {
    let t = reply.trim();
    if let Some(rest) = t.strip_prefix("```") {
        if let Some(nl) = rest.find('\n') {
            if let Some(inner) = rest[nl + 1..].trim_end().strip_suffix("```") {
                return inner;
            }
        }
    }
    t
}

fn object<'a>(v: &'a Value, at: &str, keys: &[&str], errs: &mut Vec<String>) -> Option<&'a Map<String, Value>> {
    let Some(m) = v.as_object() else {
        errs.push(format!("{at}: expected an object"));
        return None;
    };
    for k in m.keys().filter(|k| !keys.contains(&k.as_str())) {
        errs.push(format!("{at}: unknown key `{k}`"));
    }
    for k in keys.iter().filter(|k| !m.contains_key(**k)) {
        errs.push(format!("{at}: missing key `{k}`"));
    }
    Some(m)
}

fn want_string(m: &Map<String, Value>, key: &str, at: &str, errs: &mut Vec<String>) {
    if m.get(key).is_some_and(|v| !v.is_string()) {
        errs.push(format!("{at}.{key}: expected a string"));
    }
}

fn want_line(m: &Map<String, Value>, at: &str, errs: &mut Vec<String>) {
    if m.get("line").is_some_and(|v| v.as_u64().is_none()) {
        errs.push(format!("{at}.line: expected a whole number"));
    }
}

fn list<'a>(m: &'a Map<String, Value>, key: &str, at: &str, errs: &mut Vec<String>) -> &'a [Value] {
    match m.get(key) {
        Some(Value::Array(a)) => a,
        Some(_) => {
            errs.push(format!("{at}.{key}: expected a list"));
            &[]
        }
        None => &[],
    }
}

fn shape(v: &Value, errs: &mut Vec<String>) {
    let Some(top) = object(v, "envelope", &TOP, errs) else { return };
    for (i, r) in list(top, "runes", "envelope", errs).iter().enumerate() {
        let at = format!("runes[{i}]");
        let Some(m) = object(r, &at, &RUNE, errs) else { continue };
        for k in ["id", "kind", "description", "body"] {
            want_string(m, k, &at, errs);
        }
        for (j, s) in list(m, "sources", &at, errs).iter().enumerate() {
            let at = format!("{at}.sources[{j}]");
            if let Some(m) = object(s, &at, &SOURCE, errs) {
                want_string(m, "path", &at, errs);
                want_line(m, &at, errs);
            }
        }
    }
    for (i, s) in list(top, "sections", "envelope", errs).iter().enumerate() {
        let at = format!("sections[{i}]");
        let Some(m) = object(s, &at, &SECTION, errs) else { continue };
        want_string(m, "heading", &at, errs);
        for (j, id) in list(m, "ids", &at, errs).iter().enumerate() {
            if !id.is_string() {
                errs.push(format!("{at}.ids[{j}]: expected a string"));
            }
        }
    }
    for (i, d) in list(top, "dropped", "envelope", errs).iter().enumerate() {
        let at = format!("dropped[{i}]");
        if let Some(m) = object(d, &at, &DROPPED, errs) {
            want_string(m, "path", &at, errs);
            want_string(m, "reason", &at, errs);
            want_line(m, &at, errs);
        }
    }
}

fn one_line(s: &str, at: &str, errs: &mut Vec<String>) {
    if s.trim().is_empty() {
        errs.push(format!("{at}: empty"));
    } else if s.contains(['\n', '\r']) {
        errs.push(format!("{at}: must be one line"));
    }
}

/// What a citation is checked against: the inputs, and for a chunk reply the spans that call was shown.
struct Scope<'a> {
    inputs: &'a [Input],
    spans: Option<&'a [Span]>,
    allow_empty: bool,
}

fn cite(path: &str, line: usize, at: &str, scope: &Scope, errs: &mut Vec<String>) {
    let Some(input) = scope.inputs.iter().find(|i| i.path == path) else {
        errs.push(format!("{at}: `{path}` is not an input path"));
        return;
    };
    let n = input.lines().len();
    if line == 0 || line > n {
        errs.push(format!("{at}: line {line} is outside `{path}` ({n} lines)"));
        return;
    }
    let Some(spans) = scope.spans else { return };
    let mine: Vec<&Span> = spans.iter().filter(|s| s.path == path).collect();
    if mine.is_empty() {
        errs.push(format!("{at}: `{path}` is not in the lines you were given"));
    } else if !mine.iter().any(|s| (s.first..=s.last).contains(&line)) {
        let shown: Vec<String> = mine.iter().map(|s| format!("{}-{}", s.first, s.last)).collect();
        errs.push(format!("{at}: line {line} is outside the lines you were given for `{path}` ({})", shown.join(", ")));
    }
}

fn meaning(env: &Envelope, scope: &Scope, errs: &mut Vec<String>) {
    if env.runes.is_empty() && !scope.allow_empty {
        errs.push("runes: empty; a reply needs at least one rune".into());
    }
    for (i, r) in env.runes.iter().enumerate() {
        let at = format!("runes[{i}]");
        if let Err(e) = check_id(&r.id) {
            errs.push(format!("{at}.id: {e}"));
        } else if r.id.starts_with("row-") {
            errs.push(format!("{at}.id: `{}` starts with `row-`, which names row sets", r.id));
        }
        if let Some(j) = env.runes[..i].iter().position(|o| o.id == r.id) {
            errs.push(format!("{at}.id: duplicate id `{}` (also runes[{j}])", r.id));
        }
        if r.kind != "rule" && r.kind != "fact" {
            errs.push(format!("{at}.kind: `{}` is not rule or fact", r.kind));
        }
        one_line(&r.description, &format!("{at}.description"), errs);
        if r.body.trim().is_empty() {
            errs.push(format!("{at}.body: empty"));
        }
        if r.sources.is_empty() {
            errs.push(format!("{at}.sources: empty; every rune cites at least one line"));
        }
        for (j, s) in r.sources.iter().enumerate() {
            cite(&s.path, s.line, &format!("{at}.sources[{j}]"), scope, errs);
        }
    }
    // Rune id -> the section that holds it.
    let mut placed: Vec<(&str, usize)> = Vec::new();
    for (i, s) in env.sections.iter().enumerate() {
        let at = format!("sections[{i}]");
        one_line(&s.heading, &format!("{at}.heading"), errs);
        if s.ids.is_empty() {
            errs.push(format!("{at}.ids: empty"));
        }
        for id in &s.ids {
            if !env.runes.iter().any(|r| &r.id == id) {
                errs.push(format!("{at}: `{id}` is not a rune id"));
            } else if let Some((_, k)) = placed.iter().find(|(p, _)| p == id) {
                errs.push(format!("{at}: `{id}` is already in sections[{k}]"));
            } else {
                placed.push((id, i));
            }
        }
    }
    for (i, r) in env.runes.iter().enumerate() {
        if !placed.iter().any(|(p, _)| *p == r.id) {
            errs.push(format!("runes[{i}]: `{}` is in no section", r.id));
        }
    }
    for (i, d) in env.dropped.iter().enumerate() {
        let at = format!("dropped[{i}]");
        cite(&d.path, d.line, &at, scope, errs);
        if d.reason.trim().is_empty() {
            errs.push(format!("{at}.reason: empty"));
        }
    }
}

/// Parse and check one reply against the inputs it was generated from. `Err` holds every error found in the
/// first pass that has any.
pub fn parse(reply: &str, inputs: &[Input]) -> Result<Envelope, Vec<String>> {
    parse_scoped(reply, &Scope { inputs, spans: None, allow_empty: false })
}

/// `parse` for one chunk's reply: citations must fall inside `spans`, and with `allow_empty` a part that holds no
/// rule may return zero runes.
pub fn parse_in(reply: &str, inputs: &[Input], spans: &[Span], allow_empty: bool) -> Result<Envelope, Vec<String>> {
    parse_scoped(reply, &Scope { inputs, spans: Some(spans), allow_empty })
}

/// The meaning pass alone, for an envelope already built (a merged one) against the full inputs.
pub fn check(env: &Envelope, inputs: &[Input]) -> Result<(), Vec<String>> {
    let mut errs = Vec::new();
    meaning(env, &Scope { inputs, spans: None, allow_empty: false }, &mut errs);
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs)
    }
}

fn parse_scoped(reply: &str, scope: &Scope) -> Result<Envelope, Vec<String>> {
    let v: Value = serde_json::from_str(unfence(reply)).map_err(|e| vec![format!("reply is not one JSON object: {e}")])?;
    let mut errs = Vec::new();
    shape(&v, &mut errs);
    if !errs.is_empty() {
        return Err(errs);
    }
    let env: Envelope = serde_json::from_value(v).map_err(|e| vec![format!("envelope: {e}")])?;
    meaning(&env, scope, &mut errs);
    if errs.is_empty() {
        Ok(env)
    } else {
        Err(errs)
    }
}

/// `w` in `hay` with no letter or digit on either side.
fn has_word(hay: &str, w: &str) -> bool {
    hay.match_indices(w).any(|(i, _)| {
        let before = hay[..i].chars().next_back();
        let after = hay[i + w.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

/// The modal words the skill forbids softening, each with the words a body may keep it as.
const MODALS: [(&str, &[&str]); 6] = [
    ("never", &["never"]),
    ("must", &["must"]),
    ("always", &["always"]),
    ("do not", &["do not", "don't", "don\u{2019}t", "never"]),
    ("don't", &["do not", "don't", "don\u{2019}t", "never"]),
    ("don\u{2019}t", &["do not", "don't", "don\u{2019}t", "never"]),
];

/// A line the coverage warning skips: blank, a heading, a fence, or no letter or digit at all.
fn structural_line(l: &str) -> bool {
    let t = l.trim_start();
    t.is_empty() || t.starts_with('#') || t.starts_with("```") || t.starts_with("~~~") || !t.chars().any(char::is_alphanumeric)
}

fn ranges(ns: &[usize]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut k = 0;
    while k < ns.len() {
        let start = ns[k];
        while k + 1 < ns.len() && ns[k + 1] == ns[k] + 1 {
            k += 1;
        }
        parts.push(if ns[k] == start { start.to_string() } else { format!("{start}-{}", ns[k]) });
        k += 1;
    }
    parts.join(", ")
}

fn words3(s: &str) -> std::collections::HashSet<&str> {
    s.split(|c: char| !c.is_alphabetic()).filter(|w| w.chars().count() >= 3).collect()
}

/// The clause of a cited line (split at `;` and sentence ends, bullet marker stripped) that shares the most
/// words with the rune body; ties go to the earliest. A one-clause line comes back whole.
fn matching_clause<'a>(line: &'a str, body: &str) -> &'a str {
    let t = line.trim_start();
    let t = t.strip_prefix("- ").unwrap_or(t);
    let mut clauses: Vec<&str> = Vec::new();
    let mut start = 0;
    let mut it = t.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let end = match c {
            ';' => true,
            '.' | '!' | '?' => it.peek().is_none_or(|(_, n)| n.is_whitespace()),
            _ => false,
        };
        if end {
            clauses.push(&t[start..i]);
            start = i + c.len_utf8();
        }
    }
    clauses.push(&t[start..]);
    clauses.retain(|c| !c.trim().is_empty());
    if clauses.len() < 2 {
        return line;
    }
    let body_words = words3(body);
    let mut best = (0, clauses[0]);
    for (k, c) in clauses.iter().enumerate() {
        let n = words3(c).intersection(&body_words).count();
        if k == 0 || n > best.0 {
            best = (n, c);
        }
    }
    best.1
}

/// Advisory lines for a parsed envelope: per input, the non-blank lines neither cited nor dropped; per rune,
/// a modal word in a cited line that its body lacks.
pub fn warnings(env: &Envelope, inputs: &[Input]) -> Vec<String> {
    let mut out = Vec::new();
    for input in inputs {
        let used = |n: usize| {
            env.runes.iter().flat_map(|r| &r.sources).any(|s| s.path == input.path && s.line == n)
                || env.dropped.iter().any(|d| d.path == input.path && d.line == n)
        };
        let missed: Vec<usize> = input
            .lines()
            .iter()
            .enumerate()
            .filter(|(k, l)| !structural_line(l) && !used(k + 1))
            .map(|(k, _)| k + 1)
            .collect();
        match missed.len() {
            0 => {}
            1 => out.push(format!("`{}`: line {} neither cited nor dropped", input.path, missed[0])),
            _ => out.push(format!("`{}`: lines {} neither cited nor dropped", input.path, ranges(&missed))),
        }
    }
    for r in &env.runes {
        let body = r.body.to_lowercase();
        let mut said: Vec<&str> = Vec::new();
        for s in &r.sources {
            let input = inputs.iter().find(|i| i.path == s.path);
            let Some(line) = input.and_then(|i| i.lines().get(s.line.wrapping_sub(1)).map(|l| l.to_lowercase())) else {
                continue;
            };
            let line = matching_clause(&line, &body);
            for (word, kept_as) in MODALS {
                if has_word(line, word) && !said.contains(&word) && !kept_as.iter().any(|k| has_word(&body, k)) {
                    said.push(word);
                    out.push(format!("`{}`: {}:{} says \"{word}\"; the rune body does not", r.id, s.path, s.line));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> Vec<Input> {
        vec![Input { path: r"~\.claude\CLAUDE.md".into(), text: "# A\n\n- Never push.\n- Always test.\n".into() }]
    }

    fn rune(id: &str, line: usize) -> Value {
        serde_json::json!({ "id": id, "kind": "rule", "description": "D", "body": "Never push.",
            "sources": [{ "path": r"~\.claude\CLAUDE.md", "line": line }] })
    }

    fn reply(runes: Vec<Value>, sections: Value) -> String {
        serde_json::json!({ "runes": runes, "sections": sections, "dropped": [] }).to_string()
    }

    fn errs(reply: &str) -> Vec<String> {
        parse(reply, &inputs()).expect_err("expected a rejection")
    }

    #[test]
    fn reject_table() {
        let one = |id: &str| serde_json::json!([{ "heading": "A", "ids": [id] }]);
        let mut unknown = rune("a", 3);
        unknown["scope"] = "x".into();
        let cases: Vec<(String, &str)> = vec![
            (reply(vec![unknown], one("a")), "runes[0]: unknown key `scope`"),
            (r#"{"runes":[],"sections":[],"dropped":[],"extra":1}"#.into(), "envelope: unknown key `extra`"),
            (r#"{"runes":[],"sections":[]}"#.into(), "envelope: missing key `dropped`"),
            (reply(vec![rune("Bad_Id", 3)], one("Bad_Id")), "runes[0].id: invalid id `Bad_Id`"),
            (reply(vec![rune("con", 3)], one("con")), "runes[0].id: reserved id `con`"),
            (
                reply(vec![rune("a", 3), rune("a", 4)], serde_json::json!([{ "heading": "A", "ids": ["a"] }])),
                "runes[1].id: duplicate id `a` (also runes[0])",
            ),
            (reply(vec![rune("a", 9)], one("a")), r"runes[0].sources[0]: line 9 is outside `~\.claude\CLAUDE.md` (4 lines)"),
            (reply(vec![rune("a", 0)], one("a")), r"runes[0].sources[0]: line 0 is outside `~\.claude\CLAUDE.md` (4 lines)"),
            (
                reply(
                    vec![serde_json::json!({ "id": "a", "kind": "rule", "description": "D", "body": "B",
                        "sources": [{ "path": "~\\other.md", "line": 1 }] })],
                    one("a"),
                ),
                r"runes[0].sources[0]: `~\other.md` is not an input path",
            ),
            (reply(vec![rune("a", 3), rune("b", 4)], one("a")), "runes[1]: `b` is in no section"),
            (
                reply(vec![rune("a", 3)], serde_json::json!([{ "heading": "A", "ids": ["a", "ghost"] }])),
                "sections[0]: `ghost` is not a rune id",
            ),
            (
                reply(vec![rune("a", 3)], serde_json::json!([{ "heading": "A", "ids": ["a"] }, { "heading": "B", "ids": ["a"] }])),
                "sections[1]: `a` is already in sections[0]",
            ),
            ("Here you go: {}".into(), "reply is not one JSON object"),
            (r#"{"runes":[{"id":1}],"sections":[],"dropped":[]}"#.into(), "runes[0].id: expected a string"),
        ];
        for (text, want) in cases {
            let got = errs(&text);
            assert!(got.iter().any(|e| e.starts_with(want)), "want `{want}` in {got:?}");
        }
        // A citation outside the lines a chunk was shown, though inside the file.
        let spans = [Span { path: inputs()[0].path.clone(), first: 1, last: 3, total: 4 }];
        let got = parse_in(&reply(vec![rune("a", 4)], one("a")), &inputs(), &spans, false).expect_err("line 4 is outside");
        let want = r"runes[0].sources[0]: line 4 is outside the lines you were given for `~\.claude\CLAUDE.md` (1-3)";
        assert!(got.iter().any(|e| e == want), "want `{want}` in {got:?}");
        assert!(parse_in(&reply(vec![rune("a", 3)], one("a")), &inputs(), &spans, false).is_ok());
    }

    #[test]
    fn allow_empty_accepts_zero_runes() {
        let empty = r#"{"runes":[],"sections":[],"dropped":[]}"#;
        let spans = [Span::whole(&inputs()[0])];
        assert!(parse_in(empty, &inputs(), &spans, false).is_err());
        let env = parse_in(empty, &inputs(), &spans, true).expect("zero runes allowed");
        assert!(env.runes.is_empty());
        assert!(parse(empty, &inputs()).is_err());
    }

    #[test]
    fn check_runs_the_meaning_pass_on_a_built_envelope() {
        let text = reply(vec![rune("a", 3)], serde_json::json!([{ "heading": "A", "ids": ["a"] }]));
        let mut env = parse(&text, &inputs()).unwrap();
        assert!(check(&env, &inputs()).is_ok());
        env.runes[0].sources[0].line = 9;
        assert!(check(&env, &inputs()).unwrap_err()[0].contains("line 9 is outside"));
    }

    #[test]
    fn errors_are_collected_not_first_only() {
        let mut a = rune("Bad", 9);
        a["extra"] = 1.into();
        let text = reply(vec![a, rune("b", 3)], serde_json::json!([{ "heading": "A", "ids": ["ghost"] }]));
        let got = errs(&text);
        assert_eq!(got, vec!["runes[0]: unknown key `extra`"], "shape pass reports alone");
        let text = reply(vec![rune("Bad", 9), rune("b", 3)], serde_json::json!([{ "heading": "A", "ids": ["ghost"] }]));
        let got = errs(&text);
        assert_eq!(
            got,
            vec![
                "runes[0].id: invalid id `Bad`",
                r"runes[0].sources[0]: line 9 is outside `~\.claude\CLAUDE.md` (4 lines)",
                "sections[0]: `ghost` is not a rune id",
                "runes[0]: `Bad` is in no section",
                "runes[1]: `b` is in no section",
            ]
        );
    }

    #[test]
    fn one_wrapping_fence_is_tolerated() {
        let text = reply(vec![rune("a", 3)], serde_json::json!([{ "heading": "A", "ids": ["a"] }]));
        assert!(parse(&format!("```json\n{text}\n```\n"), &inputs()).is_ok());
        assert!(parse(&format!("Sure.\n```json\n{text}\n```"), &inputs()).is_err());
    }

    #[test]
    fn coverage_and_modal_warnings() {
        let mut a = rune("a", 3);
        a["body"] = "Avoid pushing.".into();
        let env = parse(&reply(vec![a], serde_json::json!([{ "heading": "A", "ids": ["a"] }])), &inputs()).unwrap();
        let w = warnings(&env, &inputs());
        assert_eq!(
            w,
            vec![
                r"`~\.claude\CLAUDE.md`: line 4 neither cited nor dropped".to_string(),
                r#"`a`: ~\.claude\CLAUDE.md:3 says "never"; the rune body does not"#.to_string(),
            ]
        );
        assert_eq!(ranges(&[1, 3, 4, 5, 9]), "1, 3-5, 9");
        assert!(has_word("don't push", "don't") && !has_word("nevermind", "never"));
    }

    fn modal_warnings(text: &str, body: &str) -> Vec<String> {
        let inputs = vec![Input { path: "C.md".into(), text: text.into() }];
        let mut a = rune("a", 1);
        a["body"] = body.into();
        a["sources"] = serde_json::json!([{ "path": "C.md", "line": 1 }]);
        let env = parse(&reply(vec![a], serde_json::json!([{ "heading": "A", "ids": ["a"] }])), &inputs).unwrap();
        warnings(&env, &inputs).into_iter().filter(|w| w.contains("says")).collect()
    }

    #[test]
    fn modal_check_uses_the_matching_clause() {
        let line = "- Never merge mid-wave; push only on the user's ask.\n";
        assert!(modal_warnings(line, "Push only on the user's ask.").is_empty());
        let w = modal_warnings(line, "Merge mid-wave when ready.");
        assert_eq!(w, vec![r#"`a`: C.md:1 says "never"; the rune body does not"#.to_string()]);
        let one = "- Never push to origin.\n";
        assert_eq!(modal_warnings(one, "Push to origin.").len(), 1);
        assert!(modal_warnings(one, "Never push to origin.").is_empty());
    }
}
