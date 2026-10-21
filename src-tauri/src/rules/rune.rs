//! src-tauri\src\rules\rune.rs — one rune file: the header subset (`tests/fixtures/rune-lib/README.md`),
//! the id grammar and the R2 defaults. Reads `name kind scope state activate description paths enforced-by`,
//! validates `version`, and ignores the other keys, `origin` and `closes-when` among them (Node lint owns
//! strictness). Parsing only; no disk access.

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
    /// The `paths:` header list (path-scoped sets); empty when absent.
    pub paths: Vec<String>,
    /// The `enforced-by:` hook file names (a scalar reads as one item); not validated here.
    pub enforced_by: Vec<String>,
    /// Everything after the closing `---` line, LF-normalised, otherwise verbatim.
    pub body: String,
}

pub const KINDS: [(&str, &str); 4] =
    [("rules", "rule"), ("facts", "fact"), ("procedures", "procedure"), ("sets", "set")];

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

fn header_fields(lines: &[&str]) -> Result<Vec<(String, Val)>, String> {
    let mut out: Vec<(String, Val)> = Vec::new();
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
            return Err(format!("bad header key: {line}"));
        }
        if out.iter().any(|(k, _)| k == key) {
            return Err(format!("duplicate key `{key}`"));
        }
        let value = rest.trim_start();
        let val = if value.is_empty() {
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
    Ok(out)
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
    let fields = header_fields(&header)?;
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
    Ok(Rune {
        paths,
        enforced_by,
        id,
        kind,
        scope,
        state,
        activate,
        description: scalar("description").unwrap_or_default(),
        body: text[pos.min(text.len())..].to_string(),
    })
}

#[cfg(test)]
mod tests {
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
