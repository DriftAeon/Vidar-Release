//! src-tauri\src\rules\set.rs — render a set template against the library (README slots and recall).
//! A slot line `<?rune id?>` (optionally behind `- `, `* ` or `N. `) becomes the member's body; a line
//! `<?recall?>` becomes one link line per recalled rune. Sets do not nest, so there is no recursion.

use super::context::{tidy, RenderCtx};
use super::library::Library;
use super::rune::{Rune, State};

pub struct Rendered {
    pub text: String,
    pub warnings: Vec<String>,
}

/// Split `- <?rune x?>` into (prefix, id); `None` when the line is not a slot.
fn slot(line: &str) -> Option<(&str, &str)> {
    let bullet = ["- ", "* "].iter().find(|p| line.starts_with(**p)).map(|p| p.len());
    let numbered = || {
        let digits = line.bytes().take_while(u8::is_ascii_digit).count();
        (digits > 0 && line[digits..].starts_with(". ")).then_some(digits + 2)
    };
    let width = bullet.or_else(numbered).unwrap_or(0);
    let (prefix, rest) = line.split_at(width);
    let id = rest.strip_prefix("<?rune ")?.strip_suffix("?>")?;
    (!id.is_empty() && !id.contains(|c: char| c.is_whitespace() || "?<>".contains(c))).then_some((prefix, id))
}

fn title(id: &str) -> String {
    let spaced = id.replace('-', " ");
    let mut chars = spaced.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

/// Body with leading and trailing blank lines removed, as lines.
fn member_lines(body: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = body.lines().collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let skip = lines.iter().take_while(|l| l.trim().is_empty()).count();
    lines.split_off(skip)
}

fn recall_lines(lib: &Library, set: &Rune, ctx: &RenderCtx, warnings: &mut Vec<String>) -> Vec<String> {
    let (pool, skipped) = lib.recall_pool();
    warnings.extend(skipped);
    if ctx.bare {
        let mut pending: Vec<&(Rune, String)> = recall_candidates(&pool, set).collect();
        pending.sort_by(|a, b| a.0.id.cmp(&b.0.id));
        warnings.extend(pending.iter().filter_map(|(r, _)| ctx.drop_warning(r)));
    }
    let hits = recall_hits(&pool, set, ctx);
    let name = lib.folder_name();
    // The link follows the file into its topic folder (`runes/rules/app/workbench/x.md`).
    hits.iter()
        .map(|(r, rel)| format!("- [{}]({name}/{rel}) — {}", title(&r.id), r.description))
        .collect()
}

fn recall_candidates<'a, 'b>(pool: &'a [(Rune, String)], set: &'b Rune) -> impl Iterator<Item = &'a (Rune, String)> + use<'a, 'b> {
    pool.iter().filter(|(r, _)| r.state == State::Active && r.activate == "recall" && r.meets(&set.scope))
}

fn recall_hits<'a>(pool: &'a [(Rune, String)], set: &Rune, ctx: &RenderCtx) -> Vec<&'a (Rune, String)> {
    let mut hits: Vec<&(Rune, String)> = recall_candidates(pool, set).filter(|(r, _)| ctx.keeps(r)).collect();
    hits.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    hits
}

/// Member ids of `set` in body order, each flagged when it came from the `<?recall?>` marker.
pub(super) fn members(pool: &[(Rune, String)], set: &Rune) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    for line in set.body.lines() {
        if line == "<?recall?>" {
            out.extend(recall_hits(pool, set, &RenderCtx::default()).iter().map(|(r, _)| (r.id.clone(), true)));
        } else if let Some((_, id)) = slot(line) {
            out.push((id.to_string(), false));
        }
    }
    out
}

/// Render `set`; every member problem is collected, so one build reports them all.
#[allow(dead_code)] // default-context wrapper; callers are tests until the per-tab path moves to `render_in`.
pub fn render(lib: &Library, set: &Rune) -> Result<Rendered, Vec<String>> {
    render_in(lib, set, &RenderCtx::default())
}

/// `render` in a caller's context; a Bare context drops members and tidies the result.
pub fn render_in(lib: &Library, set: &Rune, ctx: &RenderCtx) -> Result<Rendered, Vec<String>> {
    let (mut out, mut warnings, mut errors) = (String::new(), Vec::new(), Vec::new());
    for raw in set.body.split_inclusive('\n') {
        let line = raw.trim_end_matches('\n');
        if line == "<?recall?>" {
            for l in recall_lines(lib, set, ctx, &mut warnings) {
                out.push_str(&l);
                out.push('\n');
            }
            continue;
        }
        let Some((prefix, id)) = slot(line) else {
            out.push_str(raw);
            continue;
        };
        if ctx.skip.contains(id) {
            continue;
        }
        if let Some(note) = lib.tombstone(id) {
            let by = if note.is_empty() { String::new() } else { format!(": {note}") };
            errors.push(format!("`{id}` is tombstoned (retired){by}"));
            continue;
        }
        let member = match lib.entry(id) {
            Ok(Some(entry)) => lib.load(&entry),
            Ok(None) => Err(format!("`{id}` is not in the rules library")),
            Err(e) => Err(e),
        };
        let member = match member {
            Ok(m) => m,
            Err(e) => {
                errors.push(e);
                continue;
            }
        };
        match member.kind.as_str() {
            "procedure" => {
                errors.push(format!("`{id}` is a procedure (skill); skills are not injected as rules"));
                continue;
            }
            "set" => {
                errors.push(format!("`{id}` is a set; sets do not nest"));
                continue;
            }
            _ => {}
        }
        if !member.meets(&set.scope) {
            errors.push(format!("slot {id}: scope does not meet set scope"));
            continue;
        }
        match member.state {
            State::Draft => continue,
            State::Disabled => {
                warnings.push(format!("`{id}` is disabled and was skipped"));
                continue;
            }
            State::Active => {}
        }
        if !ctx.keeps(&member) {
            warnings.extend(ctx.drop_warning(&member));
            continue;
        }
        let pad = " ".repeat(prefix.len());
        for (i, l) in member_lines(&member.body).iter().enumerate() {
            let rendered = match (i, l.trim().is_empty()) {
                (0, _) => format!("{prefix}{l}"),
                (_, true) => String::new(),
                _ => format!("{pad}{l}"),
            };
            out.push_str(&rendered);
            out.push('\n');
        }
    }
    if errors.is_empty() {
        let text = if ctx.bare { tidy(&out) } else { out };
        Ok(Rendered { text, warnings })
    } else {
        Err(errors)
    }
}
