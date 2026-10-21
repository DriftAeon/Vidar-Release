use super::*;
use crate::rules::generate::{chunk_text, input_text};

fn input(path: &str, text: &str) -> Input {
    Input { path: path.into(), text: text.into() }
}

/// Rendered characters of the lines a chunk covers.
fn weight(inputs: &[Input], chunk: &[Span]) -> usize {
    chunk
        .iter()
        .map(|s| {
            let i = inputs.iter().find(|i| i.path == s.path).unwrap();
            (s.first..=s.last).map(|n| rendered_line(n, i.lines()[n - 1]).chars().count()).sum::<usize>()
        })
        .sum()
}

fn doc(sections: usize, lines_each: usize) -> String {
    let mut t = String::from("# Top\n\n");
    for s in 1..=sections {
        t.push_str(&format!("## Section {s}\n\n"));
        for l in 1..=lines_each {
            t.push_str(&format!("- Rule {s}.{l} is stated here.\n"));
        }
        t.push('\n');
    }
    t
}

fn span(path: &str, first: usize, last: usize, total: usize) -> Span {
    Span { path: path.into(), first, last, total }
}

#[test]
fn fitting_files_pack_at_file_boundaries() {
    let inputs = vec![input("~\\a.md", "# A\n- one\n"), input("~\\b.md", "# B\n- two\n"), input("~\\c.md", "# C\n- three\n")];
    assert_eq!(split(&inputs, 10_000).len(), 1, "everything fits one chunk");
    let one = weight(&inputs, &[Span::whole(&inputs[2])]); // the heaviest file
    let chunks = split(&inputs, one + 1);
    let paths: Vec<Vec<&str>> = chunks.iter().map(|c| c.iter().map(|s| s.path.as_str()).collect()).collect();
    assert_eq!(paths, vec![vec!["~\\a.md"], vec!["~\\b.md"], vec!["~\\c.md"]]);
    assert!(chunks.iter().all(|c| c.len() == 1 && c[0].first == 1 && c[0].last == c[0].total));
}

#[test]
fn every_chunk_is_within_the_limit_and_covers_each_line_once() {
    let inputs = vec![input("~\\a.md", &doc(6, 5)), input("~\\b.md", &doc(3, 4))];
    let limit = 300;
    let chunks = split(&inputs, limit);
    assert!(chunks.len() > 2);
    for c in &chunks {
        assert!(weight(&inputs, c) <= limit, "{c:?} weighs {}", weight(&inputs, c));
    }
    for i in &inputs {
        let mut seen = vec![0; i.lines().len()];
        for s in chunks.iter().flatten().filter(|s| s.path == i.path) {
            assert_eq!(s.total, i.lines().len());
            for n in s.first..=s.last {
                seen[n - 1] += 1;
            }
        }
        assert!(seen.iter().all(|c| *c == 1), "{}: {seen:?}", i.path);
    }
}

#[test]
fn splits_at_the_shallowest_heading_first() {
    let text = "# Title\n## One\n### Deep\n- a\n## Two\n- b\n";
    let inputs = vec![input("~\\a.md", text)];
    let limit = weight(&inputs, &[span("~\\a.md", 1, 4, 6)]);
    let chunks = split(&inputs, limit);
    // `# Title` shares the first `##` entry's chunk; the `###` does not start a part.
    assert_eq!(chunks, vec![vec![span("~\\a.md", 1, 4, 6)], vec![span("~\\a.md", 5, 6, 6)]]);
}

#[test]
fn memory_text_splits_at_its_entries() {
    let text = "## First\n\nBody one.\n\n#### Inner\n\nMore one.\n\n## Second\n\nBody two.\n\n## Third\n\nBody three.\n";
    let inputs = vec![input("~\\memory", text)];
    let limit = weight(&inputs, &[span("~\\memory", 1, 8, 15)]);
    let chunks = split(&inputs, limit);
    assert_eq!(
        chunks,
        vec![vec![span("~\\memory", 1, 8, 15)], vec![span("~\\memory", 9, 12, 15)], vec![span("~\\memory", 13, 15, 15)]]
    );
}

#[test]
fn falls_back_to_blank_lines_then_single_lines() {
    let blocks = "- aaaa\n- bbbb\n\n- cccc\n- dddd\n\n- eeee\n- ffff\n";
    let inputs = vec![input("~\\a.md", blocks)];
    let two_blocks = weight(&inputs, &[span("~\\a.md", 1, 6, 8)]);
    let chunks = split(&inputs, two_blocks);
    assert_eq!(chunks, vec![vec![span("~\\a.md", 1, 6, 8)], vec![span("~\\a.md", 7, 8, 8)]]);
    let tight = "- aaaa\n- bbbb\n- cccc\n- dddd\n";
    let inputs = vec![input("~\\a.md", tight)];
    let two = weight(&inputs, &[span("~\\a.md", 1, 2, 4)]);
    assert_eq!(split(&inputs, two), vec![vec![span("~\\a.md", 1, 2, 4)], vec![span("~\\a.md", 3, 4, 4)]]);
}

#[test]
fn a_lone_long_line_is_its_own_chunk() {
    let long = "x".repeat(500);
    let text = format!("- a\n- {long}\n- b\n");
    let inputs = vec![input("~\\a.md", &text)];
    let chunks = split(&inputs, 100);
    assert_eq!(chunks, vec![vec![span("~\\a.md", 1, 1, 3)], vec![span("~\\a.md", 2, 2, 3)], vec![span("~\\a.md", 3, 3, 3)]]);
    assert!(weight(&inputs, &chunks[1]) > 100);
}

#[test]
fn nothing_splits_inside_a_fence() {
    let body: String = (1..=30).map(|n| format!("echo line {n}\n")).collect();
    let text = format!("# Run\n\n```sh\n{body}```\n\n## After\n- x\n");
    let inputs = vec![input("~\\a.md", &text)];
    let chunks = split(&inputs, 200);
    let inside = 4..=34; // after the opening marker (line 3), through the closing one
    for s in chunks.iter().flatten() {
        assert!(!inside.contains(&s.first), "a part starts inside the fence: {s:?}");
    }
    assert!(chunks.len() > 1);
    // A `#` line inside the fence is not a heading either.
    let text = "# T\n```\n# not a heading\n```\n## Real\n- x\n";
    let inputs = vec![input("~\\a.md", text)];
    let limit = weight(&inputs, &[span("~\\a.md", 1, 4, 6)]);
    assert_eq!(split(&inputs, limit), vec![vec![span("~\\a.md", 1, 4, 6)], vec![span("~\\a.md", 5, 6, 6)]]);
}

#[test]
fn an_unclosed_fence_is_never_split() {
    let tail: String = (1..=20).map(|n| format!("- item {n}\n")).collect();
    let text = format!("# A\n\n```\nopen forever\n{tail}");
    let inputs = vec![input("~\\a.md", &text)];
    let chunks = split(&inputs, 120);
    let total = inputs[0].lines().len();
    assert!(chunks.iter().flatten().all(|s| s.first <= 3 || s.first > total), "{chunks:?}");
    let last = chunks.last().unwrap().last().unwrap();
    assert_eq!(last.last, total);
}

#[test]
fn parts_keep_source_line_numbers_header_and_context() {
    let text = "# Top\n## Git\n### Push\n- Never force-push.\n- Rebase first.\n## Test\n- Run tests.\n";
    let inputs = vec![input("~\\a.md", text)];
    // Part 4-5 starts under "Top > Git > Push".
    let part = chunk_text(&inputs, &[span("~\\a.md", 4, 5, 7)], "claude", None);
    assert_eq!(
        part,
        "Target agent: claude\nBudget: none\n\n=== FILE ~\\a.md (lines 4-5 of 7)\nContext: Top \u{203a} Git \u{203a} Push\n\
         L4: - Never force-push.\nL5: - Rebase first.\n=== END\n"
    );
    // A part opening on a heading is not under it, only under its parents.
    let part = chunk_text(&inputs, &[span("~\\a.md", 6, 7, 7)], "codex", Some(9000));
    assert!(part.contains("Budget: 9000 characters\n"));
    assert!(part.contains("=== FILE ~\\a.md (lines 6-7 of 7)\nContext: Top\nL6: ## Test\nL7: - Run tests.\n"), "{part}");
    // A part from the top has no Context line; a whole file renders as input_text does.
    let top = chunk_text(&inputs, &[span("~\\a.md", 1, 3, 7)], "claude", None);
    assert!(top.contains("(lines 1-3 of 7)\nL1: # Top\n"), "{top}");
    let whole = chunk_text(&inputs, &[Span::whole(&inputs[0])], "claude", None);
    assert_eq!(whole, input_text(&inputs, "claude", None));
    assert!(whole.contains("=== FILE ~\\a.md (7 lines)\nL1: # Top\n"));
}

#[test]
fn whole_file_text_is_unchanged() {
    let inputs = vec![input("~\\a.md", "# A\n\n- x  \n"), input("~\\b.md", "")];
    assert_eq!(
        input_text(&inputs, "claude", Some(500)),
        "Target agent: claude\nBudget: 500 characters\n\n=== FILE ~\\a.md (3 lines)\nL1: # A\nL2:\nL3: - x\n=== END\n\n=== FILE ~\\b.md (0 lines)\n=== END\n"
    );
}

#[test]
fn crlf_input_splits_and_renders_like_lf() {
    let lf = doc(4, 3);
    let crlf = lf.replace('\n', "\r\n");
    let a = vec![input("~\\a.md", &lf)];
    let b = vec![input("~\\a.md", &crlf)];
    let limit = 200;
    assert_eq!(split(&a, limit), split(&b, limit));
    let spans = &split(&b, limit)[1];
    let text = chunk_text(&b, spans, "claude", None);
    assert!(!text.contains('\r'));
    assert_eq!(text, chunk_text(&a, spans, "claude", None));
}
