//! src-tauri\src\rules\rune.rs — one rune file: the header subset (`tests/fixtures/rune-lib/README.md`),
//! the id grammar and the R2 defaults. Reads the fields used by rendering and the optional page keys;
//! validates `version` and leaves strict unknown-key validation to Node lint. Parsing only; no disk access.
//! Item kinds (skill, agent, hook, mcp, permission, plugin) keep their keys in `ItemKeys`, checked per kind
//! here and typed in `bare::rune_items`; a hook `command` is a `Secret`.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Draft,
    Active,
    Disabled,
}

#[derive(Clone, Debug)]
pub struct Rune {
    pub id: String,
    /// `rule`, `fact`, `procedure` or `set`.
    pub kind: String,
    pub scope: Vec<String>,
    pub state: State,
    pub activate: String,
    pub description: String,
    pub origin: Option<String>,
    pub closes_when: Option<String>,
    pub why: Option<String>,
    pub example: Option<String>,
    /// The `paths:` header list (path-scoped sets); empty when absent.
    pub paths: Vec<String>,
    /// The `enforced-by:` hook file names (a scalar reads as one item); not validated here.
    pub enforced_by: Vec<String>,
    /// Everything after the closing `---` line, LF-normalised, otherwise verbatim.
    pub body: String,
    /// `agent:` (`claude` or `codex`): the one agent that can run it; the other warns, never bars.
    pub agent: Option<String>,
    /// `required-by:` (only `vidar`): dropping the rune from a vault warns.
    pub required_by: Option<String>,
    /// The item-kind keys (skill, agent, hook, mcp, permission, plugin); all empty for the text kinds.
    pub item: ItemKeys,
}

/// A header value that must never reach IPC, discovery output or a log (a hook `command`).
/// Debug prints a placeholder; there is no Serialize. Read it with `expose`.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: String) -> Self {
        Secret(s)
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// The header keys of the item kinds, as written; typed per kind in `bare::rune_items`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ItemKeys {
    /// skill, agent, plugin: a `~`- or `{{root}}`-relative path.
    pub source: Option<String>,
    pub event: Option<String>,
    pub matcher: Option<String>,
    /// Hook `run:` and `open:` block lists.
    pub run: Vec<String>,
    pub open: Vec<String>,
    pub command: Option<Secret>,
    pub module: Option<String>,
    pub server: Option<String>,
    /// Permission `allow:` and `ask:` block lists and `mode`.
    pub allow: Vec<String>,
    pub ask: Vec<String>,
    pub mode: Option<String>,
    /// Claude output style, carried by an output-style rune.
    pub style: Option<String>,
    /// `env:` entries, each `NAME=value`.
    pub env: Vec<String>,
}

pub const KINDS: [(&str, &str); 11] = [
    ("rules", "rule"),
    ("facts", "fact"),
    ("procedures", "procedure"),
    ("sets", "set"),
    ("skills", "skill"),
    ("agents", "agent"),
    ("hooks", "hook"),
    ("mcp", "mcp"),
    ("permissions", "permission"),
    ("plugins", "plugin"),
    ("styles", "output-style"),
];

/// The kinds that are items a session carries beside its text (model R1: every kind is a rune).
/// Twin of `ITEM_KINDS` in `tools/runes/header.mjs`.
pub const ITEM_KINDS: [&str; 7] = ["skill", "agent", "hook", "mcp", "permission", "plugin", "output-style"];

pub fn is_item_kind(kind: &str) -> bool {
    ITEM_KINDS.contains(&kind)
}

/// Header keys that must be written as block lists (`key:` then `  - item` lines), never inline.
pub const BLOCK_KEYS: [&str; 4] = ["run", "open", "allow", "ask"];

/// The item keys each item kind may carry; `env`, `agent` and `required-by` are open to more kinds.
fn item_keys_of(kind: &str) -> &'static [&'static str] {
    match kind {
        "skill" | "agent" | "plugin" => &["source"],
        "hook" => &["event", "matcher", "run", "open", "command"],
        "mcp" => &["module", "server"],
        "permission" => &["allow", "ask", "mode"],
        "output-style" => &["style"],
        _ => &[],
    }
}

/// Keys only item kinds carry (each kind its own subset, plus `env`).
const ITEM_ONLY_KEYS: [&str; 13] =
    ["source", "event", "matcher", "run", "open", "command", "module", "server", "allow", "ask", "mode", "style", "env"];

/// `NAME=value` with NAME `[A-Za-z_][A-Za-z0-9_]*`.
fn check_env(entry: &str) -> Result<(), String> {
    let name = entry.split_once('=').map(|(n, _)| n).unwrap_or("");
    let ok = name.bytes().next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if ok { Ok(()) } else { Err(format!("`env` entry `{}` is not NAME=value", name_only(entry))) }
}

/// The part of an env entry before `=`, so a value never lands in an error message.
fn name_only(entry: &str) -> &str {
    entry.split_once('=').map(|(n, _)| n).unwrap_or(entry)
}

/// Scope context names, which a scope may only hold as `!<name>`. Twin of `CONTEXTS` in
/// `tools/runes/header.mjs`; keep the two lists equal.
pub const CONTEXTS: [&str; 1] = ["bare"];

/// `^[a-z0-9]+(-[a-z0-9]+)*$`, minus the Windows reserved device names.
pub fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.split('-').all(|seg| !seg.is_empty() && seg.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9')));
    if !ok {
        return Err(format!("invalid id `{id}`"));
    }
    let reserved = matches!(id, "con" | "prn" | "aux" | "nul")
        || ((id.starts_with("com") || id.starts_with("lpt"))
            && id.len() == 4
            && id.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(format!("reserved id `{id}`"));
    }
    Ok(())
}

impl Rune {
    /// Member scope contains `global`, or shares a name with `other`.
    pub fn meets(&self, other: &[String]) -> bool {
        self.scope.iter().any(|s| s == "global" || other.contains(s))
    }

    /// `required-by: vidar`: dropping this rune from a vault warns.
    pub fn required_by_vidar(&self) -> bool {
        self.required_by.as_deref() == Some("vidar")
    }
}

enum Val {
    Scalar(String),
    List(Vec<String>),
}

/// `"..."` with only `\"` and `\\`, or a plain value taken as is.
fn unquote(s: &str) -> Result<String, String> {
    let Some(inner) = s.strip_prefix('"') else { return Ok(s.to_string()) };
    let mut out = String::new();
    let mut chars = inner.chars();
    loop {
        match chars.next() {
            None => return Err(format!("unterminated quoted value {s}")),
            Some('\\') => match chars.next() {
                Some(c @ ('"' | '\\')) => out.push(c),
                _ => return Err(format!("bad escape in {s}")),
            },
            Some('"') => {
                return if chars.next().is_none() { Ok(out) } else { Err(format!("text after closing quote in {s}")) };
            }
            Some(c) => out.push(c),
        }
    }
}

/// The header fields, plus the keys written as block lists (`key:` with nothing after it).
fn header_fields(lines: &[&str]) -> Result<(Vec<(String, Val)>, Vec<String>), String> {
    let mut out: Vec<(String, Val)> = Vec::new();
    let mut blocks: Vec<String> = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            return Err("blank line in header".into());
        }
        if line.trim_start().starts_with('#') {
            return Err(format!("comment line in header: {line}"));
        }
        if line.starts_with([' ', '\t']) {
            let item = line.trim_start().strip_prefix("- ").ok_or_else(|| format!("bad header line: {line}"))?;
            match out.last_mut() {
                Some((_, Val::List(items))) => items.push(unquote(item.trim())?),
                _ => return Err(format!("list item without a `key:` line: {line}")),
            }
            continue;
        }
        let (key, rest) = line.split_once(':').ok_or_else(|| format!("bad header line: {line}"))?;
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
            // The key's leading word only: the rest of the line may be a hook `command` holding a secret.
            let shown: String = key.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect();
            return Err(format!("bad header key `{shown}`"));
        }
        if out.iter().any(|(k, _)| k == key) {
            return Err(format!("duplicate key `{key}`"));
        }
        let value = rest.trim_start();
        let val = if value.is_empty() {
            blocks.push(key.to_string());
            Val::List(Vec::new())
        } else if value.starts_with('[') && value.trim_end().ends_with(']') {
            let inner = &value.trim_end()[1..value.trim_end().len() - 1];
            let items = inner
                .split(',')
                .map(str::trim)
                .filter(|i| !i.is_empty())
                .map(unquote)
                .collect::<Result<Vec<_>, _>>()?;
            Val::List(items)
        } else if value.starts_with('"') {
            Val::Scalar(unquote(value.trim_end())?)
        } else {
            Val::Scalar(value.trim_end().to_string())
        };
        out.push((key.to_string(), val));
    }
    Ok((out, blocks))
}

/// The keys an item kind needs: a `source`; a hook's `event` and one of `command` or `run`; an mcp's
/// `module` and `server`; a permission's `allow`, `ask` or `mode`.
fn check_item(kind: &str, k: &ItemKeys) -> Result<(), String> {
    let blank = |v: &Option<String>| v.as_deref().is_none_or(|s| s.trim().is_empty());
    match kind {
        "skill" | "agent" | "plugin" if blank(&k.source) => Err(format!("a {kind} rune needs `source`")),
        "hook" if blank(&k.event) => Err("a hook rune needs `event`".into()),
        "hook" => match (&k.command, k.run.is_empty(), k.open.is_empty()) {
            (Some(c), true, true) if !c.expose().trim().is_empty() => Ok(()),
            (Some(_), true, true) => Err("a hook rune's `command` is empty".into()),
            (Some(_), _, _) => Err("a hook rune has `command` or `run`/`open`, not both".into()),
            (None, true, _) => Err("a hook rune needs `command` or a `run` list".into()),
            (None, false, _) => Ok(()),
        },
        "mcp" if blank(&k.module) || blank(&k.server) => Err("an mcp rune needs `module` and `server`".into()),
        "permission" if k.allow.is_empty() && k.ask.is_empty() && blank(&k.mode) => {
            Err("a permission rune needs `allow`, `ask` or `mode`".into())
        }
        "output-style" if blank(&k.style) => Err("an output-style rune needs `style`".into()),
        _ => Ok(()),
    }
}

/// Parse one rune file (CRLF tolerated).
pub fn parse(text: &str) -> Result<Rune, String> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text).replace("\r\n", "\n");
    let mut lines = text.split_inclusive('\n');
    let first = lines.next().unwrap_or_default();
    if first.trim_end() != "---" {
        return Err("missing header: the file must start with `---`".into());
    }
    let (mut header, mut pos, mut closed) = (Vec::new(), first.len(), false);
    for line in lines {
        pos += line.len();
        if line.trim_end_matches('\n') == "---" {
            closed = true;
            break;
        }
        header.push(line.trim_end_matches('\n'));
    }
    if !closed {
        return Err("header is not closed by a `---` line".into());
    }
    let (fields, blocks) = header_fields(&header)?;
    let scalar = |key: &str| -> Option<String> {
        fields.iter().find(|(k, _)| k == key).map(|(_, v)| match v {
            Val::Scalar(s) => s.clone(),
            Val::List(l) => l.join(", "),
        })
    };
    let id = scalar("name").ok_or("header has no `name`")?;
    check_id(&id)?;
    let kind = scalar("kind").ok_or("header has no `kind`")?;
    if !KINDS.iter().any(|(_, k)| *k == kind) {
        return Err(format!("invalid kind `{kind}`"));
    }
    let scope = match fields.iter().find(|(k, _)| k == "scope") {
        Some((_, Val::List(l))) => l.clone(),
        Some((_, Val::Scalar(s))) => vec![s.clone()],
        None => Vec::new(),
    };
    let state = match scalar("state").as_deref() {
        None | Some("active") => State::Active,
        Some("draft") => State::Draft,
        Some("disabled") => State::Disabled,
        Some(other) => return Err(format!("invalid state `{other}` (draft, active or disabled)")),
    };
    if let Some(v) = scalar("version") {
        if !v.parse::<u32>().is_ok_and(|n| n >= 1) {
            return Err(format!("invalid version `{v}` (a positive integer)"));
        }
    }
    if let Some(a) = scalar("activate") {
        if !["always", "paths", "recall", "invoke"].contains(&a.as_str()) {
            return Err(format!("invalid activate `{a}` (always, paths, recall or invoke)"));
        }
    }
    let activate = scalar("activate").unwrap_or_else(|| {
        match kind.as_str() {
            "rule" => "always",
            "fact" => "recall",
            "procedure" => "invoke",
            _ => "none",
        }
        .to_string()
    });
    let list = |key: &str| match fields.iter().find(|(k, _)| k == key) {
        Some((_, Val::List(l))) => l.clone(),
        Some((_, Val::Scalar(s))) => vec![s.clone()],
        None => Vec::new(),
    };
    let paths = list("paths");
    let enforced_by = list("enforced-by");
    let has = |key: &str| fields.iter().any(|(k, _)| k == key);
    for key in ITEM_ONLY_KEYS {
        if has(key) && !item_keys_of(&kind).contains(&key) && !(key == "env" && is_item_kind(&kind)) {
            return Err(format!("`{key}` does not apply to kind `{kind}`"));
        }
    }
    for key in BLOCK_KEYS {
        if has(key) && !blocks.iter().any(|b| b == key) {
            return Err(format!("`{key}` must be a block list (`{key}:` then `  - item` lines), not an inline value"));
        }
    }
    let agent = scalar("agent");
    if let Some(a) = agent.as_deref() {
        if a != "claude" && a != "codex" {
            return Err(format!("invalid agent `{a}` (claude or codex)"));
        }
    }
    let required_by = scalar("required-by");
    if let Some(r) = required_by.as_deref() {
        if r != "vidar" {
            return Err(format!("invalid required-by `{r}` (vidar)"));
        }
    }
    let env = list("env");
    for e in &env {
        check_env(e)?;
    }
    let item = ItemKeys {
        source: scalar("source"),
        event: scalar("event"),
        matcher: scalar("matcher"),
        run: list("run"),
        open: list("open"),
        command: match fields.iter().find(|(k, _)| k == "command") {
            Some((_, Val::Scalar(s))) => Some(Secret::new(s.clone())),
            Some((_, Val::List(_))) => return Err("`command` must be one command line, not a list".into()),
            None => None,
        },
        module: scalar("module"),
        server: scalar("server"),
        allow: list("allow"),
        ask: list("ask"),
        mode: scalar("mode"),
        style: scalar("style"),
        env,
    };
    check_item(&kind, &item)?;
    Ok(Rune {
        agent,
        required_by,
        item,
        paths,
        enforced_by,
        id,
        kind,
        scope,
        state,
        activate,
        description: scalar("description").unwrap_or_default(),
        origin: scalar("origin"),
        closes_when: scalar("closes-when"),
        why: scalar("why"),
        example: scalar("example"),
        body: text[pos.min(text.len())..].to_string(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn optional_page_keys_parse_and_are_absent_when_omitted() {
        let base = "---\nname: page\nkind: rule\nscope: [global]\n";
        let with_keys = format!("{base}origin: Research\ncloses-when: Review ends\nwhy: Keep context\nexample: Open a file\n---\nBody\n");
        let parsed = super::parse(&with_keys).unwrap();
        assert_eq!(parsed.origin.as_deref(), Some("Research"));
        assert_eq!(parsed.closes_when.as_deref(), Some("Review ends"));
        assert_eq!(parsed.why.as_deref(), Some("Keep context"));
        assert_eq!(parsed.example.as_deref(), Some("Open a file"));
        let absent = super::parse(&format!("{base}---\nBody\n")).unwrap();
        assert!(absent.origin.is_none() && absent.closes_when.is_none() && absent.why.is_none() && absent.example.is_none());
    }

    #[test]
    fn a_bad_header_key_names_the_key_and_never_the_value() {
        for line in ["Command: run sk-secret-1", "command sk-secret-1: x", "co mmand=sk-secret-1: x"] {
            let err = super::parse(&format!("---\nname: h\nkind: hook\nscope: [global]\n{line}\n---\n")).unwrap_err();
            assert!(err.contains("bad header key `"), "{err}");
            assert!(!err.contains("sk-secret-1"), "{err}");
        }
    }

    fn stock_fixture(rel: &str) -> String {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        std::fs::read_to_string(root.join("tests/fixtures/rune-vault/stock-runes").join(rel)).unwrap()
    }

    #[test]
    fn every_item_kind_fixture_parses_with_its_keys() {
        let hook = super::parse(&stock_fixture("hooks/gate-hook-run.md")).unwrap();
        assert_eq!((hook.kind.as_str(), hook.item.event.as_deref(), hook.item.matcher.as_deref()), ("hook", Some("PreToolUse"), Some("Bash")));
        assert_eq!(hook.item.run, ["{{root}}/tests/fixtures/rune-vault/sources/hooks/gate-hook-run.mjs"]);
        let cmd = super::parse(&stock_fixture("hooks/gate-hook-command.md")).unwrap();
        assert_eq!(cmd.agent.as_deref(), Some("codex"));
        assert!(cmd.item.command.as_ref().unwrap().expose().contains("sk-secret-1"));
        assert!(!format!("{cmd:?}").contains("sk-secret-1"), "a parsed rune's Debug prints the command");
        let perm = super::parse(&stock_fixture("permissions/gate-permission.md")).unwrap();
        assert_eq!((perm.item.allow.as_slice(), perm.item.ask.as_slice(), perm.item.mode.as_deref()), (&["mcp__plugin_vidar_drive".to_string()][..], &["mcp__gate_write".to_string()][..], Some("auto")));
        let mcp = super::parse(&stock_fixture("mcp/vidar-drive.md")).unwrap();
        assert_eq!((mcp.item.module.as_deref(), mcp.item.server.as_deref()), (Some("vidar-drive"), Some("vidar_drive")));
        for (rel, kind) in [("skills/gate-skill.md", "skill"), ("agents/gate-agent.md", "agent"), ("plugins/vidar-app.md", "plugin")] {
            let r = super::parse(&stock_fixture(rel)).unwrap();
            assert_eq!(r.kind, kind);
            assert!(r.item.source.as_deref().unwrap().starts_with("{{root}}/"), "{rel}");
            assert!(super::is_item_kind(kind) && r.activate == "none");
        }
        let id = super::parse(&stock_fixture("rules/bare-identity.md")).unwrap();
        assert!(id.required_by_vidar() && !super::is_item_kind(&id.kind));
    }

    #[test]
    fn allow_ask_run_and_open_must_be_block_lists() {
        for (kind, key, extra) in [("permission", "allow", ""), ("permission", "ask", ""), ("hook", "run", "event: Stop\n"), ("hook", "open", "event: Stop\nrun:\n  - a.mjs\n")] {
            for inline in [format!("{key}: Bash"), format!("{key}: [Bash]")] {
                let text = format!("---\nname: x\nkind: {kind}\nscope: [global]\n{extra}{inline}\n---\n");
                let e = super::parse(&text).unwrap_err();
                assert!(e.contains(&format!("`{key}` must be a block list")), "{kind} {inline}: {e}");
            }
        }
    }

    #[test]
    fn item_keys_are_checked_per_kind() {
        let bad = |head: &str| super::parse(&format!("---\nname: x\nscope: [global]\n{head}---\n")).unwrap_err();
        assert!(bad("kind: rule\nsource: a\n").contains("does not apply to kind `rule`"));
        assert!(bad("kind: skill\nevent: Stop\nsource: a\n").contains("does not apply"));
        assert!(bad("kind: skill\n").contains("needs `source`"));
        assert!(bad("kind: hook\nevent: Stop\n").contains("`command` or a `run` list"));
        assert!(bad("kind: hook\nevent: Stop\ncommand: a\nrun:\n  - b.mjs\n").contains("not both"));
        assert!(bad("kind: mcp\nmodule: m\n").contains("`module` and `server`"));
        assert!(bad("kind: permission\n").contains("`allow`, `ask` or `mode`"));
        assert!(bad("kind: rule\nagent: gemini\n").contains("claude or codex"));
        assert!(bad("kind: rule\nrequired-by: me\n").contains("(vidar)"));
        let e = bad("kind: plugin\nsource: a\nenv:\n  - 1BAD=sk-secret-1\n");
        assert!(e.contains("NAME=value") && !e.contains("sk-secret-1"), "{e}");
        let ok = super::parse("---\nname: x\nkind: plugin\nscope: [global]\nsource: a\nenv: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1\n---\n").unwrap();
        assert_eq!(ok.item.env, ["CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1"]);
    }

    #[test]
    fn device_names_com0_to_9_and_lpt0_to_9_are_reserved() {
        for id in ["com0", "com9", "lpt0", "lpt9", "con"] {
            assert!(super::check_id(id).unwrap_err().contains("reserved"), "{id}");
        }
        for id in ["com10", "lpt", "comx", "com-1"] {
            assert!(super::check_id(id).is_ok(), "{id}");
        }
    }
}
