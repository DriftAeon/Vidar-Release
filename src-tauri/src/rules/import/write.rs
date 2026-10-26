//! src-tauri\src\rules\import\write.rs — turn a `Split` into an import library on disk
//! (docs/projects/bare/onboarding-plan.md D1, D2, D8): `rules\<id>.md` per brick, one set `sets\<name>.md`
//! named after the library and holding every brick some row takes (sets are keyed by set, not row), `import.json` (source, sha256, date, brick order with each body's hash). Every file goes
//! through `fsx::atomic_write`; nothing is deleted and nothing outside the library folder is written.

use std::path::{Path, PathBuf};

use super::split::{Brick, Part, Split};
use crate::rules::rune::{check_id, CONTEXTS};

/// Who the library is and where it came from.
pub struct Meta<'a> {
    /// The library name: the folder name and every brick's scope.
    pub name: &'a str,
    /// The source path in `~` form.
    pub source: &'a str,
    /// `YYYY-MM-DD`.
    pub date: &'a str,
}

/// A header scalar in the frozen subset's quoted form (`\"` and `\\` only). Generated runes reuse it.
pub(crate) fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// One brick's rune file: `state: active` when kept, `draft` when dropped.
pub fn rune_text(b: &Brick, meta: &Meta, kept: bool) -> String {
    rune_text_with(b, meta, kept, None, false)
}

fn rune_text_with(b: &Brick, meta: &Meta, kept: bool, paths: Option<&[String]>, memory: bool) -> String {
    let scope = if b.not_bare { format!("{}, \"!bare\"", meta.name) } else { meta.name.to_string() };
    let mut h = format!("---\nname: {}\nkind: rule\nscope: [{scope}]\n", b.id);
    h.push_str(if kept { "state: active\n" } else { "state: draft\n" });
    let activate = if paths.is_some() { "paths" } else if memory { "recall" } else { "always" };
    h.push_str(&format!("activate: {activate}\n"));
    if let Some(paths) = paths {
        h.push_str("paths:\n");
        for path in paths {
            h.push_str(&format!("  - {}\n", quote(path)));
        }
    }
    if let Some(head) = b.section.last() {
        h.push_str(&format!("description: {}\n", quote(head)));
    }
    h.push_str(&format!("origin: {}\n---\n\n{}\n", quote(&format!("{} {}:{}", meta.date, meta.source, b.line)), b.body));
    h
}

/// The template body for a row holding `ids`, in source order. With every brick kept it is the split's
/// normalised text with slots. A dropped slot takes the blank line it leaves doubled with it, and a heading
/// whose section had bricks but keeps none is dropped.
pub fn set_body(split: &Split, ids: &[String]) -> String {
    let kept = |b: usize| ids.contains(&split.bricks[b].id);
    let parts = &split.parts;
    // Bricks gone from the source have no slot: a kept one is emitted at the end of its section.
    let gone: Vec<usize> = (0..split.bricks.len())
        .filter(|b| !parts.iter().any(|p| matches!(p, Part::Slot { brick, .. } if brick == b)))
        .collect();
    // The heading path in force after each part.
    let mut stack: Vec<(usize, String)> = Vec::new();
    let paths: Vec<Vec<String>> = parts
        .iter()
        .map(|p| {
            if let Part::Heading { level, raw } = p {
                stack.retain(|(lv, _)| lv < level);
                stack.push((*level, super::split::heading_text(raw)));
            }
            stack.iter().map(|(_, t)| t.clone()).collect()
        })
        .collect();
    let drop_heading = |k: usize, level: usize| {
        let end = (k + 1..parts.len())
            .find(|j| matches!(parts[*j], Part::Heading { level: l, .. } if l <= level))
            .unwrap_or(parts.len());
        let mut members: Vec<usize> =
            parts[k + 1..end].iter().filter_map(|p| if let Part::Slot { brick, .. } = p { Some(*brick) } else { None }).collect();
        members.extend(gone.iter().copied().filter(|g| split.bricks[*g].section.starts_with(&paths[k])));
        !members.is_empty() && !members.iter().any(|b| kept(*b))
    };
    let mut out: Vec<String> = Vec::new();
    let mut removed = false;
    let mut emitted = vec![false; split.bricks.len()];
    let mut flush = |out: &mut Vec<String>, removed: &mut bool, path: Option<&Vec<String>>| {
        let mut tail = Vec::new();
        while out.last().is_some_and(|l| l.is_empty()) {
            tail.push(out.pop().unwrap_or_default());
        }
        for g in &gone {
            if !emitted[*g] && kept(*g) && path.is_none_or(|p| &split.bricks[*g].section == p) {
                emitted[*g] = true;
                out.push(format!("{}<?rune {}?>", split.bricks[*g].prefix, split.bricks[*g].id));
                *removed = false;
            }
        }
        out.extend(tail);
    };
    let mut cur: Vec<String> = Vec::new();
    for (k, p) in parts.iter().enumerate() {
        if matches!(p, Part::Heading { .. }) {
            flush(&mut out, &mut removed, Some(&cur));
            cur = paths[k].clone();
        }
        match p {
            Part::Slot { brick, prefix } if kept(*brick) => {
                out.push(format!("{prefix}<?rune {}?>", split.bricks[*brick].id));
                removed = false;
            }
            Part::Slot { .. } => removed = true,
            Part::Heading { level, .. } if drop_heading(k, *level) => removed = true,
            Part::Heading { raw, .. } => {
                out.push(raw.clone());
                removed = false;
            }
            Part::Line(s) if s.is_empty() && removed && out.last().is_none_or(|l| l.is_empty()) => {}
            Part::Line(s) => {
                out.push(s.clone());
                if !s.is_empty() {
                    removed = false;
                }
            }
        }
    }
    flush(&mut out, &mut removed, Some(&cur));
    flush(&mut out, &mut removed, None); // sections the new source no longer has
    if removed {
        while out.last().is_some_and(|l| l.is_empty()) {
            out.pop();
        }
    }
    if out.is_empty() {
        return String::new();
    }
    out.join("\n") + "\n"
}

/// `sets\<name>.md`, the library's one set.
pub fn set_text(split: &Split, meta: &Meta, ids: &[String]) -> String {
    format!("---\nname: {}\nkind: set\nscope: [{}]\n---\n{}", meta.name, meta.name, set_body(split, ids))
}

/// The ids any row in `rows` takes, each once, in first-seen order.
pub fn set_ids(rows: &[(String, Vec<String>)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in rows.iter().flat_map(|(_, ids)| ids) {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

pub fn import_json(split: &Split, meta: &Meta) -> String {
    let bricks: Vec<serde_json::Value> = split
        .bricks
        .iter()
        .map(|b| {
            let mut v = serde_json::json!({ "id": b.id, "sha256": b.sha256, "section": b.section, "line": b.line });
            // The list marker a gone brick's slot is rebuilt with (rune bodies are stored without it).
            if !b.prefix.is_empty() {
                v["prefix"] = serde_json::Value::from(b.prefix);
            }
            v
        })
        .collect();
    let v = serde_json::json!({ "source": meta.source, "sha256": split.sha256, "date": meta.date, "bricks": bricks });
    serde_json::to_string_pretty(&v).unwrap_or_default() + "\n"
}

/// Write the library into `dir` (the `runtime\runes\<name>` folder). `kept` ids are active, the rest draft;
/// `rows` is (rowKey, brick ids); the library's set holds every id some row takes, and none is written when no
/// row takes any. Every id is checked and every target compared before the first write: an existing file with
/// other content is refused unless `overwrite`, and one with the same content is left alone. Returns the files
/// written.
pub fn write_library(
    dir: &Path,
    split: &Split,
    meta: &Meta,
    kept: &[String],
    rows: &[(String, Vec<String>)],
    overwrite: bool,
) -> Result<Vec<PathBuf>, String> {
    if split.paths.as_ref().is_some_and(Vec::is_empty) {
        return Err("source paths: requires at least one glob".into());
    }
    check_id(meta.name).map_err(|e| format!("library name: {e}"))?;
    if meta.name == "stock" {
        return Err("library name `stock` is reserved".into());
    }
    if CONTEXTS.contains(&meta.name) {
        return Err(format!("library name: `{}` is a scope context name", meta.name));
    }
    for b in &split.bricks {
        check_id(&b.id).map_err(|e| format!("brick: {e}"))?;
    }
    for (key, ids) in rows {
        if let Some(id) = ids.iter().find(|id| !split.bricks.iter().any(|b| &b.id == *id)) {
            return Err(format!("row {key}: `{id}` is not a brick of this import"));
        }
    }
    let (rules, sets) = (dir.join("rules"), dir.join("sets"));
    let mut plan: Vec<(PathBuf, String)> = Vec::new();
    for b in &split.bricks {
        plan.push((rules.join(format!("{}.md", b.id)), rune_text_with(b, meta, kept.contains(&b.id), split.paths.as_deref(), split.memory)));
    }
    let ids = set_ids(rows);
    if !ids.is_empty() {
        plan.push((sets.join(format!("{}.md", meta.name)), set_text(split, meta, &ids)));
    }
    plan.push((dir.join("import.json"), import_json(split, meta)));
    let mut todo = Vec::new();
    for (path, text) in plan {
        match std::fs::read(&path) {
            Ok(old) if old == text.as_bytes() => continue,
            Ok(_) if !overwrite => return Err(format!("{}: exists with other content", path.display())),
            _ => todo.push((path, text)),
        }
    }
    let mut written = Vec::new();
    for (path, text) in todo {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        crate::fsx::atomic_write(&path, text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))?;
        written.push(path);
    }
    Ok(written)
}

#[cfg(test)]
mod reserved_name_tests {
    use super::*;

    #[test]
    fn stock_is_reserved_before_any_import_write() {
        let split = super::super::split::split("# Hello\nA rule.\n", &[], "");
        let tick = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("vidar-refuse-stock-{}-{tick}", std::process::id()));
        let meta = Meta { name: "stock", source: "test", date: "2026-10-25" };
        let error = write_library(&dir, &split, &meta, &[], &[], false).unwrap_err();
        assert!(error.contains("stock") && error.contains("reserved"), "{error}");
        assert!(!dir.exists());
    }
}
