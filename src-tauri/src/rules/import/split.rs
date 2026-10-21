//! src-tauri\src\rules\import\split.rs — split one rules file (a CLAUDE.md or AGENTS.md) into rune bricks
//! (docs/projects/bare/onboarding-plan.md D3, D4). Text in, `Split` out; no disk access.
//! - Normalise first (BOM, CRLF, trailing whitespace); the split and every hash run on that text.
//! - Front matter is skipped (with the blank lines after it). Headings, blank lines and HTML comments stay
//!   template text (`Part`), never bricks.
//! - A brick whose body holds the user-profile path (`profile`, compared as `lint-lib.mjs` does) is flagged
//!   `not_bare`, so its rune is scoped `!bare`, and the split carries a warning naming it.
//! - A brick is a top-level list item, a prose paragraph, a fenced block or a table. Fences and tables are
//!   their own bare-slot bricks; only a clean single bullet item takes the `- ` slot.
//! - A brick under 25 chars merges into the brick before it when both are list items or both prose, in the
//!   same section, with only blank lines between. Identical bodies share one brick.
//! - Rendering `parts` with every brick kept gives `text` back, `+ `/`* `/indented bullets as `- `.

use sha2::{Digest, Sha256};

/// A brick under this many chars merges into the one before it (D3).
const MERGE_UNDER: usize = 25;
/// Slug words and length cap for an id (D4).
const SLUG_WORDS: usize = 4;
const SLUG_MAX: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    List,
    Prose,
    Fence,
    Table,
}

#[derive(Clone, Debug)]
pub struct Brick {
    /// Slug of the first words plus `-<n>`, unique within the library.
    pub id: String,
    pub kind: Kind,
    /// `- ` for a clean single bullet item, else empty (bare slot, body verbatim).
    pub prefix: &'static str,
    /// The rune body: no leading or trailing blank line, no final newline.
    pub body: String,
    /// Heading texts above the brick, outermost first.
    pub section: Vec<String>,
    /// 1-based line of the brick's first line in the normalised text.
    pub line: usize,
    /// sha256 of `body`, lower-case hex.
    pub sha256: String,
    /// The body holds the user-profile path: the rune is scoped `!bare` (cook's lint fix, lint-lib.mjs:125).
    pub not_bare: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Part {
    /// Template text kept as is: a blank line, an HTML comment.
    Line(String),
    Heading { level: usize, raw: String },
    /// `brick` indexes `Split::bricks`; a duplicate body points at the first copy.
    Slot { brick: usize, prefix: &'static str },
}

#[derive(Clone, Debug)]
pub struct Split {
    /// The normalised source: what is hashed and what a full keep renders back to (bullet markers aside).
    pub text: String,
    pub sha256: String,
    pub bricks: Vec<Brick>,
    pub parts: Vec<Part>,
    /// One line per `not_bare` brick, naming its id and section.
    pub warnings: Vec<String>,
}

/// The spawn's own path norm (`bare::home::norm`): lower-cased, `/` to `\`, and an MSYS `/c/Users/...` read as
/// `c:\users\...`, so the importer flags exactly what a Bare spawn would refuse.
fn norm_path(s: &str) -> String {
    crate::bare::home::norm(s)
}

pub fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Strip a BOM, CRLF to LF, trailing whitespace off every line and trailing blank lines off the end; one final
/// newline when anything is left.
pub fn normalise(raw: &str) -> String {
    let raw = raw.strip_prefix('\u{FEFF}').unwrap_or(raw).replace("\r\n", "\n");
    let mut lines: Vec<&str> = raw.split('\n').map(str::trim_end).collect();
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn indent(l: &str) -> usize {
    l.len() - l.trim_start_matches(' ').len()
}

fn heading(l: &str) -> Option<usize> {
    if indent(l) > 3 {
        return None;
    }
    let t = l.trim_start();
    let level = t.bytes().take_while(|b| *b == b'#').count();
    let rest = &t[level..];
    ((1..=6).contains(&level) && (rest.is_empty() || rest.starts_with(' '))).then_some(level)
}

pub(super) fn heading_text(l: &str) -> String {
    let t = l.trim_start().trim_start_matches('#').trim();
    let closed = t.trim_end_matches('#');
    if closed.is_empty() || closed.ends_with(' ') {
        closed.trim_end().to_string()
    } else {
        t.to_string()
    }
}

/// A fence opener: the fence char and run length.
fn fence_open(l: &str) -> Option<(u8, usize)> {
    let t = l.trim_start().as_bytes();
    let ch = *t.first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let run = t.iter().take_while(|b| **b == ch).count();
    (run >= 3).then_some((ch, run))
}

fn fence_close(l: &str, (ch, run): (u8, usize)) -> bool {
    let t = l.trim();
    let n = t.bytes().take_while(|b| *b == ch).count();
    n >= run && n == t.len()
}

fn is_table(l: &str) -> bool {
    l.trim_start().starts_with('|')
}

fn is_comment(l: &str) -> bool {
    l.trim_start().starts_with("<!--")
}

/// `- `, `+ ` or `* ` behind at most three spaces: the marker's indent.
fn bullet(l: &str) -> Option<usize> {
    let ind = indent(l);
    let t = l[ind..].as_bytes();
    (ind <= 3 && t.len() > 2 && matches!(t[0], b'-' | b'+' | b'*') && t[1] == b' ').then_some(ind)
}

/// `1. ` or `1) ` behind at most three spaces: (indent, marker width).
fn ordered(l: &str) -> Option<(usize, usize)> {
    let ind = indent(l);
    let t = l[ind..].as_bytes();
    let digits = t.iter().take_while(|b| b.is_ascii_digit()).count();
    let ok = ind <= 3 && (1..=9).contains(&digits) && t.len() > digits + 2;
    (ok && matches!(t[digits], b'.' | b')') && t[digits + 1] == b' ').then_some((ind, digits + 2))
}

fn starts_block(l: &str) -> bool {
    heading(l).is_some() || fence_open(l).is_some() || is_table(l) || is_comment(l) || bullet(l).is_some() || ordered(l).is_some()
}

/// What rune lint refuses behind a `- ` slot (`tools/runes/lint-lib.mjs` HEADING, LIST).
fn lint_list_or_heading(first: &str, all: &[&str]) -> bool {
    let list = bullet(first).is_some_and(|i| i == 0) || ordered(first).is_some_and(|(i, _)| i == 0);
    list || first.starts_with(' ') || all.iter().any(|l| heading(l).is_some_and(|_| !l.starts_with(' ')))
}

struct Raw {
    kind: Kind,
    /// Normalised lines as they render.
    lines: Vec<String>,
    /// Body behind a `- ` slot, when the brick can take one.
    dash: Option<Vec<String>>,
    section: Vec<String>,
    section_at: usize,
    line: usize,
}

impl Raw {
    fn body(&self) -> String {
        self.dash.as_ref().unwrap_or(&self.lines).join("\n")
    }
}

struct Parser<'a> {
    lines: Vec<&'a str>,
    parts: Vec<Option<usize>>,
    literal: Vec<Part>,
    raws: Vec<Raw>,
    stack: Vec<(usize, String)>,
    section_at: usize,
}

impl<'a> Parser<'a> {
    fn literal(&mut self, p: Part) {
        self.parts.push(None);
        self.literal.push(p);
    }

    fn brick(&mut self, kind: Kind, lines: Vec<String>, dash: Option<Vec<String>>, line: usize) {
        let section = self.stack.iter().map(|(_, t)| t.clone()).collect();
        self.parts.push(Some(self.raws.len()));
        self.literal.push(Part::Line(String::new()));
        self.raws.push(Raw { kind, lines, dash, section, section_at: self.section_at, line: line + 1 });
    }

    /// One top-level list item from line `i`; returns the next line.
    fn item(&mut self, i: usize) -> usize {
        let l = self.lines[i];
        let (ind, width, is_bullet) = match bullet(l) {
            Some(ind) => (ind, 2, true),
            None => ordered(l).map(|(ind, w)| (ind, w, false)).unwrap_or((0, 0, false)),
        };
        let content = ind + width;
        let mut taken: Vec<&str> = vec![l];
        let mut lazy = false;
        let mut j = i + 1;
        while j < self.lines.len() {
            let m = self.lines[j];
            if m.is_empty() {
                let k = (j..self.lines.len()).find(|k| !self.lines[*k].is_empty());
                match k {
                    Some(k) if indent(self.lines[k]) >= content && fence_open(self.lines[k]).is_none() && !is_table(self.lines[k]) => {
                        taken.extend(&self.lines[j..k]);
                        j = k;
                        continue;
                    }
                    _ => break,
                }
            }
            if fence_open(m).is_some() || is_table(m) {
                break;
            }
            if indent(m) >= content {
                taken.push(m);
            } else if starts_block(m) {
                break;
            } else {
                lazy = true;
                taken.push(m);
            }
            j += 1;
        }
        let line = i;
        if !is_bullet {
            self.brick(Kind::List, taken.iter().map(|s| s.to_string()).collect(), None, line);
            return j;
        }
        // Normalised: the marker becomes `- ` at column 0; continuation lines shift left with it.
        let first = format!("- {}", &l[ind + 2..]);
        let shift = |s: &str| if indent(s) >= ind { s[ind..].to_string() } else { s.to_string() };
        let mut lines = vec![first];
        lines.extend(taken[1..].iter().map(|s| shift(s)));
        let mut dash: Vec<&str> = vec![&l[ind + 2..]];
        dash.extend(taken[1..].iter().map(|s| if indent(s) >= content { &s[content..] } else { *s }));
        let clean = !lazy && !lint_list_or_heading(dash[0], &dash[1..]);
        let dash = clean.then(|| dash.iter().map(|s| s.to_string()).collect());
        self.brick(Kind::List, lines, dash, line);
        j
    }

    fn run(&mut self) {
        let n = self.lines.len();
        let mut i = 0;
        if self.lines.first() == Some(&"---") {
            // D3: front matter is skipped, and the blank lines behind it with it.
            if let Some(end) = (1..n).find(|k| self.lines[*k] == "---") {
                i = (end + 1..n).find(|k| !self.lines[*k].is_empty()).unwrap_or(n);
            }
        }
        while i < n {
            let l = self.lines[i];
            if l.is_empty() {
                self.literal(Part::Line(String::new()));
                i += 1;
            } else if is_comment(l) {
                let end = (i..n).find(|k| self.lines[*k].contains("-->")).unwrap_or(n - 1);
                for k in i..=end {
                    self.literal(Part::Line(self.lines[k].to_string()));
                }
                i = end + 1;
            } else if let Some(level) = heading(l) {
                self.stack.retain(|(lv, _)| *lv < level);
                self.stack.push((level, heading_text(l)));
                self.section_at = i + 1;
                self.literal(Part::Heading { level, raw: l.to_string() });
                i += 1;
            } else if let Some(f) = fence_open(l) {
                let end = (i + 1..n).find(|k| fence_close(self.lines[*k], f)).unwrap_or(n - 1);
                let lines = self.lines[i..=end].iter().map(|s| s.to_string()).collect();
                self.brick(Kind::Fence, lines, None, i);
                i = end + 1;
            } else if is_table(l) {
                let end = (i..n).take_while(|k| is_table(self.lines[*k])).last().unwrap_or(i);
                let lines = self.lines[i..=end].iter().map(|s| s.to_string()).collect();
                self.brick(Kind::Table, lines, None, i);
                i = end + 1;
            } else if bullet(l).is_some() || ordered(l).is_some() {
                i = self.item(i);
            } else {
                let end = (i + 1..n).find(|k| self.lines[*k].is_empty() || starts_block(self.lines[*k])).unwrap_or(n);
                let lines = self.lines[i..end].iter().map(|s| s.to_string()).collect();
                self.brick(Kind::Prose, lines, None, i);
                i = end;
            }
        }
    }
}

/// `keep-build-output-in`: the first words that hold ASCII letters or digits, lower-cased, `-`-joined, capped
/// at 32 chars; `rule` when nothing is left.
pub fn slug(body: &str) -> String {
    let words: Vec<String> = body
        .split_whitespace()
        .map(|w| {
            let mapped: String = w.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
            mapped.split('-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-")
        })
        .filter(|w| !w.is_empty())
        .take(SLUG_WORDS)
        .collect();
    let mut s = words.join("-");
    s.truncate(SLUG_MAX);
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() { "rule".to_string() } else { s }
}

/// `slug-<n>` with the smallest `n` from 1 that neither `taken` nor `used` holds.
fn next_id(slug: &str, taken: &[String], used: &[String]) -> String {
    (1..)
        .map(|n| format!("{slug}-{n}"))
        .find(|id| !taken.contains(id) && !used.contains(id))
        .unwrap_or_default()
}

/// Split `raw` into bricks; ids already in `taken` (the library's other bricks) are never handed out.
/// `profile` is the user-profile path (empty: no check).
pub fn split(raw: &str, taken: &[String], profile: &str) -> Split {
    let profile = norm_path(profile);
    let text = normalise(raw);
    let lines: Vec<&str> = if text.is_empty() { Vec::new() } else { text.trim_end_matches('\n').split('\n').collect() };
    let mut p = Parser { lines, parts: Vec::new(), literal: Vec::new(), raws: Vec::new(), stack: Vec::new(), section_at: 0 };
    p.run();

    // Merge: a short brick into the previous brick of its kind and section, across blank lines only.
    let mut alive = vec![true; p.raws.len()];
    let mut drop_part = vec![false; p.parts.len()];
    let mut last: Option<(usize, usize)> = None; // (raw, part index)
    for k in 0..p.parts.len() {
        let Some(r) = p.parts[k] else { continue };
        let short = p.raws[r].body().trim().chars().count() < MERGE_UNDER;
        if let Some((prev, at)) = last {
            let gap_blank = (at + 1..k).all(|g| p.parts[g].is_none() && p.literal[g] == Part::Line(String::new()));
            let mergeable = matches!(p.raws[r].kind, Kind::List | Kind::Prose)
                && p.raws[prev].kind == p.raws[r].kind
                && p.raws[prev].section_at == p.raws[r].section_at;
            if short && gap_blank && mergeable {
                let gap = k - at - 1;
                let moved = std::mem::take(&mut p.raws[r].lines);
                let into = &mut p.raws[prev];
                into.lines.extend(std::iter::repeat_n(String::new(), gap));
                into.lines.extend(moved);
                into.dash = None;
                alive[r] = false;
                for g in at + 1..=k {
                    drop_part[g] = true;
                }
                continue;
            }
        }
        last = Some((r, k));
    }

    // Dedupe by body hash, then hand out ids in source order.
    let mut bricks: Vec<Brick> = Vec::new();
    let mut index_of = vec![usize::MAX; p.raws.len()];
    let mut used: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for (r, raw) in p.raws.iter().enumerate().filter(|(r, _)| alive[*r]) {
        let body = raw.body();
        let sha = sha256_hex(&body);
        if let Some(b) = bricks.iter().position(|b| b.sha256 == sha) {
            index_of[r] = b;
            continue;
        }
        let id = next_id(&slug(&body), taken, &used);
        used.push(id.clone());
        index_of[r] = bricks.len();
        let prefix = if raw.dash.is_some() { "- " } else { "" };
        let not_bare = !profile.is_empty() && norm_path(&body).contains(&profile);
        if not_bare {
            let section = raw.section.last().map_or("no section", String::as_str);
            warnings.push(format!("{id} ({section}): body holds the user-profile path; scoped \"!bare\""));
        }
        bricks.push(Brick { id, kind: raw.kind, prefix, body, section: raw.section.clone(), line: raw.line, sha256: sha, not_bare });
    }
    let parts = (0..p.parts.len())
        .filter(|k| !drop_part[*k])
        .map(|k| match p.parts[k] {
            Some(r) => Part::Slot { brick: index_of[r], prefix: if p.raws[r].dash.is_some() { "- " } else { "" } },
            None => p.literal[k].clone(),
        })
        .collect();
    let sha256 = sha256_hex(&text);
    Split { text, sha256, bricks, parts, warnings }
}
