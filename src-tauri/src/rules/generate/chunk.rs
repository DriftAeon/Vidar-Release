//! src-tauri\src\rules\generate\chunk.rs — splits the generator's inputs into the parts one call reads
//! (docs/runs/2026-10-18-rune-gen-per-source/plan.md § Input and chunks). A file whose rendered lines fit
//! `CHUNK_CHARS` is one unit; a larger one splits at its shallowest heading level, then the next level, then blank
//! lines, then single lines, never inside a fence (an unclosed fence runs to the end of the file). Units pack
//! greedily in input order; a unit over the limit (one long line, one long fence) is a chunk of its own.

use super::{rendered_line, Input, Span};

/// The most rendered characters of input lines a chunk holds, apart from a lone unit that cannot be split.
pub const CHUNK_CHARS: usize = 8_000;

/// Per-line facts of one input; line `i` here is line `i + 1` of the file.
struct Scan {
    /// Rendered size of each line.
    cost: Vec<usize>,
    /// Heading level (1-6) of a heading line outside a fence, else 0.
    level: Vec<usize>,
    blank: Vec<bool>,
    /// A fence is open before line `i`, so a part may not start there.
    open: Vec<bool>,
}

impl Scan {
    fn of(input: &Input) -> Scan {
        let lines = input.lines();
        let mut s = Scan { cost: Vec::new(), level: Vec::new(), blank: Vec::new(), open: Vec::new() };
        // The matching-marker rule of `import::memory::demote`: a fence closes only on its own marker.
        let mut fence: Option<&str> = None;
        for (i, line) in lines.iter().enumerate() {
            s.cost.push(rendered_line(i + 1, line).chars().count());
            s.blank.push(line.trim().is_empty());
            s.open.push(fence.is_some());
            let t = line.trim_start();
            let mark = if t.starts_with("```") {
                Some("```")
            } else if t.starts_with("~~~") {
                Some("~~~")
            } else {
                None
            };
            match (fence, mark) {
                (None, Some(m)) => fence = Some(m),
                (Some(f), Some(m)) if f == m => fence = None,
                _ => {}
            }
            let level = line.bytes().take_while(|b| *b == b'#').count();
            let heading = fence.is_none() && mark.is_none() && (1..=6).contains(&level) && line[level..].starts_with(' ');
            s.level.push(if heading { level } else { 0 });
        }
        s
    }

    fn sum(&self, a: usize, b: usize) -> usize {
        self.cost[a..b].iter().sum()
    }
}

/// Split `a..b` (0-based, end exclusive) into units that fit `limit`, or the pieces that cannot shrink further.
fn units(s: &Scan, a: usize, b: usize, limit: usize, out: &mut Vec<(usize, usize)>) {
    if s.sum(a, b) <= limit {
        out.push((a, b));
        return;
    }
    let ok = |i: &usize| !s.open[*i];
    let shallowest = (a + 1..b).filter(ok).filter(|&i| s.level[i] > 0).map(|i| s.level[i]).min();
    let cuts: Vec<usize> = if let Some(m) = shallowest {
        (a + 1..b).filter(ok).filter(|&i| s.level[i] == m).collect()
    } else {
        let blanks: Vec<usize> = (a + 1..b).filter(ok).filter(|&i| s.blank[i - 1]).collect();
        if blanks.is_empty() {
            (a + 1..b).filter(ok).collect()
        } else {
            blanks
        }
    };
    if cuts.is_empty() {
        out.push((a, b));
        return;
    }
    let mut from = a;
    for c in cuts.into_iter().chain([b]) {
        units(s, from, c, limit, out);
        from = c;
    }
}

/// The inputs as chunks of spans, each chunk within `limit` rendered characters except a lone unsplittable unit.
pub fn split(inputs: &[Input], limit: usize) -> Vec<Vec<Span>> {
    let mut chunks: Vec<Vec<Span>> = Vec::new();
    let mut cur: Vec<Span> = Vec::new();
    let mut used = 0;
    for input in inputs {
        let s = Scan::of(input);
        let total = s.cost.len();
        let mut parts = Vec::new();
        units(&s, 0, total, limit, &mut parts);
        for (a, b) in parts {
            let cost = s.sum(a, b);
            if !cur.is_empty() && used + cost > limit {
                chunks.push(std::mem::take(&mut cur));
                used = 0;
            }
            match cur.last_mut() {
                Some(last) if last.path == input.path && last.last + 1 == a + 1 && b > a => last.last = b,
                _ => cur.push(Span { path: input.path.clone(), first: a + 1, last: b, total }),
            }
            used += cost;
        }
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

/// The headings above line `first` (1-based) that a part starting there sits under, outermost first, as their
/// text without the `#` marks.
pub(super) fn context(input: &Input, first: usize) -> Vec<String> {
    let s = Scan::of(input);
    let lines = input.lines();
    let mut stack: Vec<(usize, String)> = Vec::new();
    for i in 0..first.min(lines.len() + 1) {
        let level = s.level.get(i).copied().unwrap_or(0);
        if level == 0 {
            continue;
        }
        // The part's own first line, when a heading, is not its ancestor: it only closes deeper-or-equal ones.
        while stack.last().is_some_and(|(l, _)| *l >= level) {
            stack.pop();
        }
        if i + 1 < first {
            stack.push((level, lines[i][level..].trim().to_string()));
        }
    }
    stack.into_iter().map(|(_, t)| t).collect()
}

#[cfg(test)]
#[path = "chunk_tests.rs"]
mod tests;
