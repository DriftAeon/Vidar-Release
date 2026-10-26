//! src-tauri\src\rules\context.rs — the render context a caller passes to `set::render_in` and `build::build_in`.
//! Default = not Bare: every rune is kept and nothing is tidied. Bare drops a rune whose scope holds `!bare`
//! or whose `enforced-by` hook file is not among the hooks the home carries, then tidies the rendered text.
//! Design: docs/projects/bare/rune-scope-plan.md § How `bare` Composes With Scopes.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use super::rune::Rune;

#[derive(Clone, Debug, Default)]
pub struct RenderCtx {
    pub bare: bool,
    /// Hook file names the Bare home carries (read only when `bare`).
    pub hooks: BTreeSet<String>,
    /// Slot ids `set::render_in` drops unread: a Bare row's earlier library already rendered them.
    pub skip: BTreeSet<String>,
    /// Rune ids `set::render_in` drops from its slots and its `<?recall?>` links alike. No spawn fills it
    /// since the row overrides were retired; a vault's Disabled runeset is skipped in `bare/vault/store.rs`.
    pub off: BTreeSet<String>,
    /// Folders of the other libraries a set's `<?rune lib/id?>` slots name (filled by the Bare builder,
    /// `bare/layer.rs` `build_sets`); a prefixed slot whose library is absent here fails the render.
    pub libraries: BTreeMap<String, PathBuf>,
}

impl RenderCtx {
    pub fn bare(hooks: BTreeSet<String>) -> Self {
        Self { bare: true, hooks, ..Self::default() }
    }

    /// The `enforced-by` files of `rune` this context does not carry (always empty when not Bare).
    pub fn unheld<'a>(&self, rune: &'a Rune) -> Vec<&'a str> {
        if !self.bare {
            return Vec::new();
        }
        rune.enforced_by.iter().map(String::as_str).filter(|h| !self.hooks.contains(*h)).collect()
    }

    pub fn excluded(&self, rune: &Rune) -> bool {
        self.bare && rune.scope.iter().any(|s| s == "!bare")
    }

    pub fn keeps(&self, rune: &Rune) -> bool {
        !self.bare || (!self.excluded(rune) && self.unheld(rune).is_empty())
    }

    /// One warning for a hook-claim drop; `None` when the rune is kept or was excluded silently.
    pub fn drop_warning(&self, rune: &Rune) -> Option<String> {
        if self.excluded(rune) {
            return None;
        }
        let missing = self.unheld(rune);
        (!missing.is_empty())
            .then(|| format!("`{}` is enforced by {}, which this home does not carry, and was skipped", rune.id, missing.join(", ")))
    }
}

fn heading_level(line: &str) -> Option<usize> {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&hashes) && line[hashes..].starts_with(' ') {
        Some(hashes)
    } else {
        None
    }
}

/// Bare context only: prune headings with no content, repeat until stable, collapse blank runs.
pub fn tidy(text: &str) -> String {
    // Fence flag per line: a fence marker line and the lines inside it are never headings.
    fn fenced_flags(lines: &[&str]) -> Vec<bool> {
        let mut fenced = false;
        lines
            .iter()
            .map(|l| {
                if l.trim_start().starts_with("```") {
                    fenced = !fenced;
                    true
                } else {
                    fenced
                }
            })
            .collect()
    }

    let mut lines: Vec<&str> = text.lines().collect();
    loop {
        let flags = fenced_flags(&lines);
        let mut drop = None;
        for i in 0..lines.len() {
            let Some(level) = (!flags[i]).then(|| heading_level(lines[i])).flatten() else { continue };
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim().is_empty() {
                j += 1;
            }
            let empty = j >= lines.len() || (!flags[j] && heading_level(lines[j]).is_some_and(|l| l <= level));
            if empty {
                drop = Some(i);
                break;
            }
        }
        match drop {
            Some(i) => {
                lines.remove(i);
            }
            None => break,
        }
    }
    let flags = fenced_flags(&lines);
    let mut out = String::new();
    let mut blank_run = false;
    for (i, l) in lines.iter().enumerate() {
        let blank = !flags[i] && l.trim().is_empty();
        if blank && blank_run {
            continue;
        }
        blank_run = blank;
        out.push_str(l);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{build, library::Library, set};
    use std::path::{Path, PathBuf};

    fn root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/rune-lib/runes")
    }

    /// The fixture library is not shipped (tests/fixtures/rune-lib is export-ignored): its tests return early.
    fn fixture_absent() -> bool {
        let absent = !root().exists();
        if absent {
            eprintln!("skipped: tests/fixtures/rune-lib is not in this tree (not shipped)");
        }
        absent
    }

    fn render_with(ctx: &RenderCtx) -> set::Rendered {
        let lib = Library::open(&root()).unwrap();
        let entry = lib.entry("bare-set").unwrap().expect("bare-set");
        set::render_in(&lib, &lib.load(&entry).unwrap(), ctx).unwrap()
    }

    #[test]
    fn a_bare_render_drops_excluded_members_unheld_hook_claims_and_empty_headings() {
        if fixture_absent() {
            return;
        }
        let none = render_with(&RenderCtx::bare(BTreeSet::new()));
        assert_eq!(none.text, "\n# Bare Set\n\n## Kept\n\n- Global fact — Global fact that every set recalls. Read global-fact.md in skill vidar-runes\n\n");
        assert_eq!(none.warnings.len(), 1, "{:?}", none.warnings);
        assert!(none.warnings[0].contains("`hook-rule`") && none.warnings[0].contains("guard-x.mjs"));

        let held = render_with(&RenderCtx::bare(BTreeSet::from(["guard-x.mjs".to_string()])));
        assert!(held.text.contains("## Hooked\n\n<!-- rune: hook-rule -->\n- Hook claim: guard-x.mjs"), "{}", held.text);
        assert!(!held.text.contains("Bare tabs never see") && !held.text.contains("## Outer"), "{}", held.text);
        assert!(!held.text.contains("### Inner") && !held.text.contains("\n\n\n"), "{}", held.text);
        assert!(held.warnings.is_empty(), "{:?}", held.warnings);
    }

    #[test]
    fn a_default_render_keeps_bare_tagged_members() {
        if fixture_absent() {
            return;
        }
        let r = render_with(&RenderCtx::default());
        assert!(r.text.contains("Bare tabs never see this rule."), "{}", r.text);
        assert!(r.text.contains("## Outer\n\n### Inner"), "{}", r.text);
        assert!(r.text.contains("Hook claim: guard-x.mjs"), "{}", r.text);
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    }

    #[test]
    fn a_bare_build_skips_the_path_check() {
        if fixture_absent() {
            return;
        }
        let lib = Library::open(&root()).unwrap();
        let ids = vec!["bare-set".to_string()];
        let ctx = RenderCtx::bare(BTreeSet::from(["guard-x.mjs".to_string()]));
        let bare = build::build_in(&lib, &ids, &ctx).ok().expect("bare build");
        assert!(bare.warnings.iter().all(|w| !w.contains("not on disk")), "{:?}", bare.warnings);
        let default = build::build(&lib, &ids).ok().expect("default build");
        assert!(default.warnings.iter().any(|w| w.contains("`refs\\missing-pointer.md`, which is not on disk")), "{:?}", default.warnings);
    }

    #[test]
    fn tidy_ignores_headings_inside_fences() {
        let text = "# A\n\n```\n# not a heading\n```\n\n\n## B\n";
        assert_eq!(tidy(text), "# A\n\n```\n# not a heading\n```\n\n");
    }
}
