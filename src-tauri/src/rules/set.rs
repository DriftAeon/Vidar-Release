//! src-tauri\src\rules\set.rs — render a set template against the library (README slots and recall).
//! A slot line `<?rune id?>` (optionally behind `- `, `* ` or `N. `) becomes the member's body; a line
//! `<?recall?>` becomes one line per recalled rune. Sets do not nest, so there is no recursion.

use super::context::{tidy, RenderCtx};
use super::library::Library;
use super::rune::{Rune, State};

pub struct Rendered {
    pub text: String,
    pub warnings: Vec<String>,
}

/// Rollback switch for the Bare pointer read probe. Keep the resolver and renderer on the same setting.
pub(crate) const BARE_SKILL_DELIVERY: bool = true;

pub(crate) fn pointer(rune: &Rune) -> String {
    let paths = if rune.activate == "paths" && !rune.paths.is_empty() {
        format!(" when working on files matching {}", rune.paths.join(", "))
    } else {
        String::new()
    };
    format!("- {} — {}{paths}. Read {}.md in skill vidar-runes", title(&rune.id), rune.description, rune.id)
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
pub(crate) fn member_lines(body: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = body.lines().collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let skip = lines.iter().take_while(|l| l.trim().is_empty()).count();
    lines.split_off(skip)
}

fn recall_lines(lib: &Library, set: &Rune, ctx: &RenderCtx, skill_delivery: bool, warnings: &mut Vec<String>) -> Vec<String> {
    let (pool, skipped) = lib.recall_pool();
    warnings.extend(skipped);
    if ctx.bare {
        let mut pending: Vec<&(Rune, String)> = recall_candidates(&pool, set).filter(|(r, _)| !ctx.off.contains(&r.id)).collect();
        pending.sort_by(|a, b| a.0.id.cmp(&b.0.id));
        warnings.extend(pending.iter().filter_map(|(r, _)| ctx.drop_warning(r)));
    }
    let hits = recall_hits(&pool, set, ctx);
    let name = lib.folder_name();
    // Default-context links follow each file into its topic folder.
    hits.iter()
        .map(|(r, rel)| {
            if ctx.bare && skill_delivery { pointer(r) }
            else { format!("- [{}]({name}/{rel}) — {}", title(&r.id), r.description) }
        })
        .collect()
}

fn recall_candidates<'a, 'b>(pool: &'a [(Rune, String)], set: &'b Rune) -> impl Iterator<Item = &'a (Rune, String)> + use<'a, 'b> {
    pool.iter().filter(|(r, _)| r.state == State::Active && r.activate == "recall" && r.meets(&set.scope))
}

fn recall_hits<'a>(pool: &'a [(Rune, String)], set: &Rune, ctx: &RenderCtx) -> Vec<&'a (Rune, String)> {
    let mut hits: Vec<&(Rune, String)> = recall_candidates(pool, set).filter(|(r, _)| ctx.keeps(r) && !ctx.off.contains(&r.id)).collect();
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

/// The runes `set`'s `<?recall?>` lines render under `ctx` (the Bare context drops `!bare` and unheld
/// `enforced-by` runes), in render order, with the pool's skip warnings; none when the set has no
/// `<?recall?>` line. The resolver's on-demand list (`bare/set_loadout.rs`) reads it.
pub(crate) fn recall_members_in(lib: &Library, set: &Rune, ctx: &RenderCtx) -> (Vec<Rune>, Vec<String>) {
    if !set.body.lines().any(|l| l.trim_end_matches('\r') == "<?recall?>") {
        return (Vec::new(), Vec::new());
    }
    let (pool, warnings) = lib.recall_pool();
    let hits = recall_hits(&pool, set, ctx).into_iter().map(|(r, _)| r.clone()).collect();
    (hits, warnings)
}

/// Render `set`; every member problem is collected, so one build reports them all.
#[allow(dead_code)] // default-context wrapper; callers are tests until the per-tab path moves to `render_in`.
pub fn render(lib: &Library, set: &Rune) -> Result<Rendered, Vec<String>> {
    render_in(lib, set, &RenderCtx::default())
}

/// `render` in a caller's context; a Bare context drops members and tidies the result.
pub fn render_in(lib: &Library, set: &Rune, ctx: &RenderCtx) -> Result<Rendered, Vec<String>> {
    render_in_with_delivery(lib, set, ctx, BARE_SKILL_DELIVERY)
}

fn render_in_with_delivery(lib: &Library, set: &Rune, ctx: &RenderCtx, skill_delivery: bool) -> Result<Rendered, Vec<String>> {
    let (mut out, mut warnings, mut errors) = (String::new(), Vec::new(), Vec::new());
    for raw in set.body.split_inclusive('\n') {
        let line = raw.trim_end_matches('\n');
        if line == "<?recall?>" {
            for l in recall_lines(lib, set, ctx, skill_delivery, &mut warnings) {
                out.push_str(&l);
                out.push('\n');
            }
            continue;
        }
        let Some((prefix, id)) = slot(line) else {
            out.push_str(raw);
            continue;
        };
        if ctx.skip.contains(id) || ctx.off.contains(id) {
            continue;
        }
        // `<?rune lib/id?>` names a rune stored in another library (model R6); a bare id is this set's own.
        let other;
        let (home, member_id) = match crate::bare::layer::split_slot(id) {
            Some((None, m)) => (lib, m),
            Some((Some(name), m)) => match ctx.libraries.get(name).map(|dir| Library::open(dir)) {
                Some(Ok(l)) => {
                    other = l;
                    (&other, m)
                }
                Some(Err(e)) => {
                    errors.push(format!("`{id}`: {e}"));
                    continue;
                }
                None => {
                    errors.push(format!("`{id}` names library {name:?}, which this build does not know"));
                    continue;
                }
            },
            None => {
                errors.push(format!("`{id}` is not a slot (`id` or `library/id`)"));
                continue;
            }
        };
        if let Some(note) = home.tombstone(member_id) {
            let by = if note.is_empty() { String::new() } else { format!(": {note}") };
            errors.push(format!("`{id}` is tombstoned (retired){by}"));
            continue;
        }
        let member = match home.entry(member_id) {
            Ok(Some(entry)) => home.load(&entry),
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
            // Item runes (skill, hook, mcp, ...) reach a session through the Bare mappers, never as text.
            k if super::rune::is_item_kind(k) => continue,
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
        if ctx.bare && skill_delivery && (member.activate == "recall" || member.activate == "paths") {
            out.push_str(&pointer(&member));
            out.push('\n');
            continue;
        }
        let lines = member_lines(&member.body);
        if ctx.bare && !lines.is_empty() {
            out.push_str(&format!("<!-- rune: {id} -->\n"));
        }
        let pad = " ".repeat(prefix.len());
        for (i, l) in lines.iter().enumerate() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// A library `lib` with three recall facts, one rule and a set slotting the rule above `<?recall?>`.
    fn lib(tag: &str) -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let t = Tmp(std::env::temp_dir().join(format!("vidar-set-{tag}-{}-{nanos}", std::process::id())));
        let dir = t.0.join("lib");
        for (id, d) in [("alpha", "Alpha"), ("beta", "Beta"), ("gamma", "Gamma")] {
            write(&dir.join(format!("facts/{id}.md")), &format!("---\nname: {id}\nkind: fact\nscope: [s]\ndescription: {d}\n---\n{d} body.\n"));
        }
        write(&dir.join("rules/one.md"), "---\nname: one\nkind: rule\nscope: [s]\n---\nRule one.\n");
        write(&dir.join("sets/tracked.md"),"---\nname: tracked\nkind: set\nscope: [s]\n---\n# Rules\n\n- <?rune one?>\n\n# Recall\n\n<?recall?>\n");
        t
    }

    fn render_off(t: &Tmp, bare: bool, off: &[&str]) -> String {
        let l = Library::open(&t.0.join("lib")).unwrap();
        let set = l.load(&l.entry("tracked").unwrap().unwrap()).unwrap();
        let mut ctx = if bare { RenderCtx::bare(BTreeSet::new()) } else { RenderCtx::default() };
        ctx.off = off.iter().map(|s| s.to_string()).collect();
        render_in(&l, &set, &ctx).unwrap().text
    }

    /// Layer A (fold W3 L3a step 1): a recall set minus one id renders the same link lines minus that one,
    /// in the default and the Bare context.
    #[test]
    fn a_recall_set_minus_one_id_renders_the_same_links_minus_that_one() {
        let t = lib("recall-off");
        for bare in [false, true] {
            let full = render_off(&t, bare, &[]);
            let links: Vec<&str> = full.lines().filter(|l| if bare { l.contains("in skill vidar-runes") } else { l.starts_with("- [") }).collect();
            assert_eq!(links.len(), 3, "{full}");
            let less = render_off(&t, bare, &["beta"]);
            let want: Vec<&str> = full.lines().filter(|l| !l.starts_with(if bare { "- Beta —" } else { "- [Beta]" })).collect();
            assert_eq!(less.lines().collect::<Vec<_>>(), want, "bare {bare}:\n{full}\n---\n{less}");
        }
    }

    #[test]
    fn an_off_slot_leaves_the_render_and_its_heading_goes_in_bare() {
        let t = lib("slot-off");
        let bare = render_off(&t, true, &["one"]);
        assert!(!bare.contains("Rule one.") && !bare.contains("# Rules"), "{bare}");
        assert!(bare.contains("- Alpha — Alpha. Read alpha.md in skill vidar-runes"), "{bare}");
        let plain = render_off(&t, false, &["one"]);
        assert!(!plain.contains("Rule one.") && plain.contains("# Rules"), "{plain}");
    }

    #[test]
    fn bare_recall_and_paths_are_pointers_and_the_rollback_is_inline() {
        let t = lib("delivery");
        let dir = t.0.join("lib");
        write(&dir.join("rules/path-rule.md"), "---\nname: path-rule\nkind: rule\nscope: [s]\nactivate: paths\npaths: [src/**/*.rs, tests/*.rs]\ndescription: Path rule\n---\nPath body.\n");
        write(&dir.join("rules/recall-rule.md"), "---\nname: recall-rule\nkind: rule\nscope: [s]\nactivate: recall\ndescription: Recall rule\n---\nRecall body.\n");
        write(&dir.join("sets/delivery.md"), "---\nname: delivery\nkind: set\nscope: [s]\n---\n- <?rune path-rule?>\n- <?rune recall-rule?>\n<?recall?>\n");
        let l = Library::open(&dir).unwrap();
        let set = l.load(&l.entry("delivery").unwrap().unwrap()).unwrap();
        let ctx = RenderCtx::bare(BTreeSet::new());
        let bare = render_in(&l, &set, &ctx).unwrap().text;
        assert!(bare.contains("- Path rule — Path rule when working on files matching src/**/*.rs, tests/*.rs. Read path-rule.md in skill vidar-runes"), "{bare}");
        assert!(bare.contains("- Recall rule — Recall rule. Read recall-rule.md in skill vidar-runes"), "{bare}");
        assert!(bare.contains("- Alpha — Alpha. Read alpha.md in skill vidar-runes"), "{bare}");
        assert!(!bare.contains("Path body.") && !bare.contains("Recall body."), "{bare}");
        let inline = render_in_with_delivery(&l, &set, &ctx, false).unwrap().text;
        assert!(inline.contains("<!-- rune: path-rule -->\n- Path body.") && inline.contains("<!-- rune: recall-rule -->\n- Recall body."), "{inline}");
        assert!(inline.contains("[Alpha](lib/facts/alpha.md)"), "{inline}");
        assert_eq!(bare.matches("<!-- rune:").count(), 0, "pointer lines have no markers: {bare}");
    }

    #[test]
    fn bare_marks_each_inlined_slot_at_column_zero() {
        let t = lib("markers");
        let dir = t.0.join("lib");
        write(&dir.join("rules/two.md"), "---\nname: two\nkind: rule\nscope: [s]\n---\nSecond rule.\n");
        write(&dir.join("sets/two-slots.md"), "---\nname: two-slots\nkind: set\nscope: [s]\n---\n- <?rune one?>\n1. <?rune two?>\n<?recall?>\n");
        let l = Library::open(&dir).unwrap();
        let set = l.load(&l.entry("two-slots").unwrap().unwrap()).unwrap();
        let text = render_in(&l, &set, &RenderCtx::bare(BTreeSet::new())).unwrap().text;
        assert!(text.contains("<!-- rune: one -->\n- Rule one."), "{text}");
        assert!(text.contains("<!-- rune: two -->\n1. Second rule."), "{text}");
        assert_eq!(text.matches("<!-- rune:").count(), 2, "{text}");
        assert!(!text.contains("<!-- rune: alpha -->"), "recall pointer must not be marked: {text}");
    }

    #[test]
    fn default_context_fixture_is_byte_identical_with_delivery_enabled() {
        let t = lib("default-bytes");
        let l = Library::open(&t.0.join("lib")).unwrap();
        let set = l.load(&l.entry("tracked").unwrap().unwrap()).unwrap();
        let expected = "# Rules\n\n- Rule one.\n\n# Recall\n\n- [Alpha](lib/facts/alpha.md) — Alpha\n- [Beta](lib/facts/beta.md) — Beta\n- [Gamma](lib/facts/gamma.md) — Gamma\n";
        assert_eq!(render_in(&l, &set, &RenderCtx::default()).unwrap().text, expected);
    }
}
