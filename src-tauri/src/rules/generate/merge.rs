//! src-tauri\src\rules\generate\merge.rs — the cross-chunk merge pass: the contract between the merge call
//! (`profiles/bare/rune-create/MERGE.md`, run by `commands.rs`) and the library, and the deterministic apply.
//! Chunk envelopes get colliding ids renamed, one `input_text` lists every rune for the model, and its reply
//! (`merge`, `drop`, `sections`) is parsed strictly, applied, then checked like any envelope. When the pass fails,
//! `unmerged` joins the chunk envelopes as they are.

use std::collections::HashSet;

use serde::Deserialize;

use super::envelope::{self, unfence, Dropped, Envelope, RuneOut, Section, Source};
use super::Input;

/// The heading of the section that takes runes the model left unplaced.
const UNSORTED: &str = "Unsorted";

#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub merge: Vec<Merge>,
    pub drop: Vec<Drop>,
    pub sections: Vec<ReplySection>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Merge {
    pub into: String,
    pub from: Vec<String>,
    pub body: String,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Drop {
    pub id: String,
    pub reason: String,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReplySection {
    pub heading: String,
    pub ids: Vec<String>,
}

/// Rename ids that more than one chunk envelope uses: the later chunk's rune becomes `<id>-2`, `-3`… (skipping
/// every id any envelope already holds), and that chunk's sections follow the rename.
pub fn rename_collisions(envs: &mut [Envelope]) {
    let mut taken: HashSet<String> = envs.iter().flat_map(|e| e.runes.iter().map(|r| r.id.clone())).collect();
    let mut seen: HashSet<String> = HashSet::new();
    for env in envs.iter_mut() {
        let mut renames: Vec<(String, String)> = Vec::new();
        for r in env.runes.iter_mut() {
            if seen.contains(&r.id) {
                let new = (2..).map(|n| format!("{}-{n}", r.id)).find(|c| !taken.contains(c) && !seen.contains(c)).unwrap();
                taken.insert(new.clone());
                renames.push((std::mem::replace(&mut r.id, new.clone()), new));
            }
            seen.insert(r.id.clone());
        }
        for s in env.sections.iter_mut() {
            for id in s.ids.iter_mut() {
                // A rune's old id is renamed only where this chunk's rune held it; other chunks' ids are untouched.
                if let Some((_, new)) = renames.iter().find(|(old, _)| old == id) {
                    *id = new.clone();
                }
            }
        }
    }
}

/// The user message of the merge call: target agent, budget, then one line per rune
/// `id | kind | <unique source paths joined ","> | body` (body newlines become spaces).
pub fn input_text(env: &Envelope, agent: &str, budget: Option<usize>) -> String {
    let budget = budget.map_or_else(|| "none".to_string(), |n| format!("{n} characters"));
    let mut out = format!("Target agent: {agent}\nBudget: {budget}\n\n");
    for r in &env.runes {
        let mut paths: Vec<&str> = Vec::new();
        for s in &r.sources {
            if !paths.contains(&s.path.as_str()) {
                paths.push(&s.path);
            }
        }
        let body = r.body.replace("\r\n", " ").replace(['\n', '\r'], " ");
        out.push_str(&format!("{} | {} | {} | {}\n", r.id, r.kind, paths.join(","), body));
    }
    out
}

/// Parse the model's reply against the envelope it was shown. Keys are exactly `merge`, `drop`, `sections`; every
/// id must exist, `into` may not be in its own `from`, and an id appears at most once across all `into`, `from`
/// and `drop`; a merged body may not be empty.
pub fn parse_reply(reply: &str, env: &Envelope) -> Result<Reply, String> {
    let parsed: Reply = serde_json::from_str(unfence(reply)).map_err(|e| format!("merge reply: {e}"))?;
    let known: HashSet<&str> = env.runes.iter().map(|r| r.id.as_str()).collect();
    let mut used: HashSet<String> = HashSet::new();
    let mut take = |id: &str, at: &str, errs: &mut Vec<String>| {
        if !known.contains(id) {
            errs.push(format!("{at}: `{id}` is not a rune id"));
        } else if !used.insert(id.to_string()) {
            errs.push(format!("{at}: `{id}` is used more than once across merge and drop"));
        }
    };
    let mut errs = Vec::new();
    for (i, m) in parsed.merge.iter().enumerate() {
        take(&m.into, &format!("merge[{i}].into"), &mut errs);
        if m.from.contains(&m.into) {
            errs.push(format!("merge[{i}]: `{}` is in its own from", m.into));
        }
        for (j, f) in m.from.iter().enumerate() {
            take(f, &format!("merge[{i}].from[{j}]"), &mut errs);
        }
        if m.body.trim().is_empty() {
            errs.push(format!("merge[{i}].body: empty"));
        }
    }
    for (i, d) in parsed.drop.iter().enumerate() {
        take(&d.id, &format!("drop[{i}].id"), &mut errs);
    }
    if errs.is_empty() {
        Ok(parsed)
    } else {
        Err(format!("merge reply: {}", errs.join("; ")))
    }
}

/// Apply a parsed reply: merges, budget drops, sections; then `envelope::check` against the full inputs, whose
/// errors are this function's error. Returns the envelope and any warnings.
pub fn apply(env: &Envelope, reply: &str, budget: Option<usize>, inputs: &[Input]) -> Result<(Envelope, Vec<String>), String> {
    let reply = parse_reply(reply, env)?;
    let mut warnings = Vec::new();
    let mut runes: Vec<RuneOut> = env.runes.clone();

    for m in &reply.merge {
        let involved: Vec<&RuneOut> = env.runes.iter().filter(|r| r.id == m.into || m.from.contains(&r.id)).collect();
        let mut sources: Vec<Source> = Vec::new();
        for s in involved.iter().flat_map(|r| r.sources.iter()) {
            if !sources.iter().any(|o| o.path == s.path && o.line == s.line) {
                sources.push(s.clone());
            }
        }
        runes.retain(|r| !m.from.contains(&r.id));
        if let Some(target) = runes.iter_mut().find(|r| r.id == m.into) {
            target.body = m.body.clone();
            target.sources = sources;
        }
    }

    let mut dropped = env.dropped.clone();
    if !reply.drop.is_empty() {
        if budget.is_none() {
            warnings.push("Merge pass proposed drops but there is no budget; they were ignored.".to_string());
        } else {
            let gone: Vec<&RuneOut> = runes.iter().filter(|r| reply.drop.iter().any(|d| d.id == r.id)).collect();
            let reasons: Vec<(&RuneOut, &str)> = gone
                .iter()
                .filter_map(|r| reply.drop.iter().find(|d| d.id == r.id).map(|d| (*r, d.reason.as_str())))
                .collect();
            let gone_ids: Vec<String> = reasons.iter().map(|(r, _)| r.id.clone()).collect();
            let survivors: Vec<RuneOut> = runes.iter().filter(|r| !gone_ids.contains(&r.id)).cloned().collect();
            for (r, reason) in reasons {
                for s in &r.sources {
                    let cited = survivors.iter().any(|o| o.sources.iter().any(|x| x.path == s.path && x.line == s.line));
                    let listed = dropped.iter().any(|d| d.path == s.path && d.line == s.line);
                    if !cited && !listed {
                        dropped.push(Dropped { path: s.path.clone(), line: s.line, reason: format!("budget: {reason}") });
                    }
                }
            }
            runes = survivors;
        }
    }

    let mut placed: HashSet<String> = HashSet::new();
    let mut sections: Vec<Section> = Vec::new();
    let mut unsorted: Vec<String> = Vec::new();
    for s in &reply.sections {
        let mut ids = Vec::new();
        for id in &s.ids {
            if runes.iter().any(|r| &r.id == id) && placed.insert(id.clone()) {
                ids.push(id.clone());
            }
        }
        if s.heading.trim().eq_ignore_ascii_case(UNSORTED) {
            unsorted.extend(ids);
        } else if !ids.is_empty() {
            match sections.iter_mut().find(|o| o.heading.trim().eq_ignore_ascii_case(s.heading.trim())) {
                Some(o) => o.ids.extend(ids),
                None => sections.push(Section { heading: s.heading.clone(), ids }),
            }
        }
    }
    unsorted.extend(runes.iter().filter(|r| !placed.contains(&r.id)).map(|r| r.id.clone()));
    if !unsorted.is_empty() {
        sections.push(Section { heading: UNSORTED.to_string(), ids: unsorted });
    }

    let applied = Envelope { runes, sections, dropped };
    envelope::check(&applied, inputs).map_err(|e| format!("merge result: {}", e.join("; ")))?;
    Ok((applied, warnings))
}

/// The chunk envelopes joined as they are (collisions already renamed): runes and dropped lines in order, sections
/// with the same heading (case-insensitive) joined at the first one's position. The warning names why.
pub fn unmerged(envs: &[Envelope], reason: &str) -> (Envelope, String) {
    let mut out = Envelope { runes: Vec::new(), sections: Vec::new(), dropped: Vec::new() };
    for e in envs {
        out.runes.extend(e.runes.iter().cloned());
        for s in &e.sections {
            match out.sections.iter_mut().find(|o| o.heading.trim().eq_ignore_ascii_case(s.heading.trim())) {
                Some(o) => o.ids.extend(s.ids.iter().cloned()),
                None => out.sections.push(s.clone()),
            }
        }
        for d in &e.dropped {
            if !out.dropped.iter().any(|o| o.path == d.path && o.line == d.line) {
                out.dropped.push(d.clone());
            }
        }
    }
    (out, format!("Merge pass failed ({reason}); runes from separate parts were not merged."))
}

#[cfg(test)]
#[path = "merge_tests.rs"]
mod tests;
