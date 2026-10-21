//! src-tauri\src\rules\import\write.rs — turn a `Split` into an import library on disk
//! (docs/projects/bare/onboarding-plan.md D1, D2, D8): `rules\<id>.md` per brick, `sets\row-<rowKey>.md` per
//! row with bricks, `import.json` (source, sha256, date, brick order with each body's hash). Every file goes
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
    let scope = if b.not_bare { format!("{}, \"!bare\"", meta.name) } else { meta.name.to_string() };
    let mut h = format!("---\nname: {}\nkind: rule\nscope: [{scope}]\n", b.id);
    h.push_str(if kept { "state: active\n" } else { "state: draft\n" });
    h.push_str("activate: always\n");
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

/// The source path an `origin: "<date> <source>:<line>"` header names (date up to the first space and the
/// trailing `:<digits>` dropped).
pub fn origin_source(text: &str) -> Option<String> {
    let line = text.lines().find_map(|l| l.strip_prefix("origin:"))?.trim();
    let inner = line.strip_prefix('"')?.strip_suffix('"')?.replace("\\\\", "\\").replace("\\\"", "\"");
    let (_, rest) = inner.split_once(' ')?;
    let (src, digits) = rest.rsplit_once(':')?;
    (!digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit())).then(|| src.to_string())
}

/// True when some rule file already in `dir` names `source` as its origin (a first apply that stopped
/// part way left files without `import.json`).
pub fn library_names_source(dir: &Path, source: &str) -> bool {
    let Ok(rd) = std::fs::read_dir(dir.join("rules")) else { return false };
    rd.flatten().any(|e| {
        std::fs::read_to_string(e.path()).ok().and_then(|t| origin_source(&t)).is_some_and(|s| s.eq_ignore_ascii_case(source))
    })
}

/// `sets\row-<rowKey>.md`.
pub fn set_text(split: &Split, meta: &Meta, row_key: &str, ids: &[String]) -> String {
    format!("---\nname: row-{row_key}\nkind: set\nscope: [{}]\n---\n{}", meta.name, set_body(split, ids))
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
/// `rows` is (rowKey, brick ids) and a row with no ids gets no set. Every id is checked and every target
/// compared before the first write: an existing file with other content is refused unless `overwrite`, and
/// one with the same content is left alone. Returns the files written.
pub fn write_library(
    dir: &Path,
    split: &Split,
    meta: &Meta,
    kept: &[String],
    rows: &[(String, Vec<String>)],
    overwrite: bool,
) -> Result<Vec<PathBuf>, String> {
    check_id(meta.name).map_err(|e| format!("library name: {e}"))?;
    if CONTEXTS.contains(&meta.name) {
        return Err(format!("library name: `{}` is a scope context name", meta.name));
    }
    for b in &split.bricks {
        check_id(&b.id).map_err(|e| format!("brick: {e}"))?;
    }
    for (key, ids) in rows {
        // Only a row that writes a set needs a valid file name; an empty plate just clears its ref.
        if !ids.is_empty() {
            check_id(&format!("row-{key}")).map_err(|e| format!("row key: {e}"))?;
        }
        if let Some(id) = ids.iter().find(|id| !split.bricks.iter().any(|b| &b.id == *id)) {
            return Err(format!("row {key}: `{id}` is not a brick of this import"));
        }
    }
    let (rules, sets) = (dir.join("rules"), dir.join("sets"));
    let mut plan: Vec<(PathBuf, String)> = Vec::new();
    for b in &split.bricks {
        plan.push((rules.join(format!("{}.md", b.id)), rune_text(b, meta, kept.contains(&b.id))));
    }
    for (key, ids) in rows.iter().filter(|(_, ids)| !ids.is_empty()) {
        plan.push((sets.join(format!("row-{key}.md")), set_text(split, meta, key, ids)));
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
