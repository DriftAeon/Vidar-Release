//! Tests for `merge.rs`: collision renames, the merge call's input, the strict reply parse, the deterministic
//! apply (merge, budget drop, sections) and the unmerged fallback.

use super::*;

const A: &str = r"~\.claude\CLAUDE.md";
const B: &str = r"~\proj\AGENTS.md";

fn inputs() -> Vec<Input> {
    let text = |n: usize| (1..=n).map(|i| format!("- Rule {i}.\n")).collect::<String>();
    vec![Input { path: A.into(), text: text(10) }, Input { path: B.into(), text: text(10) }]
}

fn rune(id: &str, srcs: &[(&str, usize)]) -> RuneOut {
    RuneOut {
        id: id.into(),
        kind: "rule".into(),
        description: format!("About {id}"),
        body: format!("Body of {id}."),
        sources: srcs.iter().map(|(p, l)| Source { path: (*p).into(), line: *l }).collect(),
    }
}

fn section(heading: &str, ids: &[&str]) -> Section {
    Section { heading: heading.into(), ids: ids.iter().map(|s| (*s).into()).collect() }
}

fn env(runes: Vec<RuneOut>, sections: Vec<Section>) -> Envelope {
    Envelope { runes, sections, dropped: vec![] }
}

fn ids(e: &Envelope) -> Vec<&str> {
    e.runes.iter().map(|r| r.id.as_str()).collect()
}

/// Two runes citing the same rule from two files, one more in the first file.
fn pair() -> Envelope {
    env(
        vec![rune("a", &[(A, 1)]), rune("b", &[(B, 1)]), rune("c", &[(A, 3)])],
        vec![section("Git", &["a", "b"]), section("Tests", &["c"])],
    )
}

#[test]
fn rename_skips_taken_ids_and_sections_follow() {
    let mut envs = vec![
        env(vec![rune("a", &[(A, 1)])], vec![section("S", &["a"])]),
        env(vec![rune("a", &[(A, 2)]), rune("a-2", &[(A, 3)])], vec![section("S", &["a", "a-2"])]),
        env(vec![rune("a", &[(A, 4)])], vec![section("T", &["a"])]),
    ];
    rename_collisions(&mut envs);
    assert_eq!(ids(&envs[0]), ["a"]);
    assert_eq!(ids(&envs[1]), ["a-3", "a-2"]);
    assert_eq!(envs[1].sections[0].ids, ["a-3", "a-2"]);
    assert_eq!(ids(&envs[2]), ["a-4"]);
    assert_eq!(envs[2].sections[0].ids, ["a-4"]);
    assert_eq!(envs[0].sections[0].ids, ["a"]);
}

#[test]
fn input_text_lists_one_line_per_rune() {
    let mut e = pair();
    e.runes[0].sources.push(Source { path: A.into(), line: 2 });
    e.runes[0].sources.push(Source { path: B.into(), line: 2 });
    e.runes[1].body = "Line one.\nLine two.\r\nLine three.".into();
    let text = input_text(&e, "claude", None);
    assert_eq!(
        text,
        format!(
            "Target agent: claude\nBudget: none\n\na | rule | {A},{B} | Body of a.\nb | rule | {B} | Line one. Line two. Line three.\nc | rule | {A} | Body of c.\n"
        )
    );
    assert!(input_text(&e, "codex", Some(9000)).starts_with("Target agent: codex\nBudget: 9000 characters\n\n"));
}

fn reply_err(reply: &str) -> String {
    parse_reply(reply, &pair()).expect_err("expected a rejection")
}

#[test]
fn parse_rejects_each_strict_violation() {
    let sec = r#""sections":[]"#;
    let cases: Vec<(String, &str)> = vec![
        ("Here: {}".into(), "merge reply:"),
        (format!(r#"{{"merge":[],"drop":[],{sec},"extra":1}}"#), "unknown field `extra`"),
        (format!(r#"{{"merge":[],{sec}}}"#), "missing field `drop`"),
        (
            format!(r#"{{"merge":[{{"into":"ghost","from":["a"],"body":"X."}}],"drop":[],{sec}}}"#),
            "merge[0].into: `ghost` is not a rune id",
        ),
        (
            format!(r#"{{"merge":[{{"into":"a","from":["ghost"],"body":"X."}}],"drop":[],{sec}}}"#),
            "merge[0].from[0]: `ghost` is not a rune id",
        ),
        (
            format!(r#"{{"merge":[{{"into":"a","from":["a"],"body":"X."}}],"drop":[],{sec}}}"#),
            "merge[0]: `a` is in its own from",
        ),
        (
            format!(r#"{{"merge":[{{"into":"a","from":["b","b"],"body":"X."}}],"drop":[],{sec}}}"#),
            "merge[0].from[1]: `b` is used more than once",
        ),
        (
            format!(
                r#"{{"merge":[{{"into":"a","from":["b"],"body":"X."}},{{"into":"a","from":["c"],"body":"Y."}}],"drop":[],{sec}}}"#
            ),
            "merge[1].into: `a` is used more than once",
        ),
        (
            format!(
                r#"{{"merge":[{{"into":"a","from":["b"],"body":"X."}},{{"into":"c","from":["a"],"body":"Y."}}],"drop":[],{sec}}}"#
            ),
            "merge[1].from[0]: `a` is used more than once",
        ),
        (
            format!(r#"{{"merge":[{{"into":"a","from":["b"],"body":"X."}}],"drop":[{{"id":"b","reason":"r"}}],{sec}}}"#),
            "drop[0].id: `b` is used more than once",
        ),
        (
            format!(r#"{{"merge":[],"drop":[{{"id":"ghost","reason":"r"}}],{sec}}}"#),
            "drop[0].id: `ghost` is not a rune id",
        ),
        (
            format!(r#"{{"merge":[{{"into":"a","from":["b"],"body":"  "}}],"drop":[],{sec}}}"#),
            "merge[0].body: empty",
        ),
    ];
    for (text, want) in cases {
        let got = reply_err(&text);
        assert!(got.contains(want), "reply {text}\nwanted {want:?}\ngot {got}");
    }
}

#[test]
fn apply_unions_sources_removes_absorbed_and_keeps_sections() {
    let reply = r#"{"merge":[{"into":"a","from":["b"],"body":"Merged rule."}],"drop":[],
        "sections":[{"heading":"Git","ids":["a","b"]},{"heading":"Tests","ids":["c"]}]}"#;
    let (out, warns) = apply(&pair(), reply, None, &inputs()).unwrap();
    assert!(warns.is_empty());
    assert_eq!(ids(&out), ["a", "c"]);
    assert_eq!(out.runes[0].body, "Merged rule.");
    assert_eq!(out.runes[0].description, "About a");
    let srcs: Vec<(&str, usize)> = out.runes[0].sources.iter().map(|s| (s.path.as_str(), s.line)).collect();
    assert_eq!(srcs, [(A, 1), (B, 1)]);
    assert_eq!(out.sections, [section("Git", &["a"]), section("Tests", &["c"])]);
}

#[test]
fn apply_dedups_union_of_sources() {
    let e = env(vec![rune("a", &[(A, 1), (A, 2)]), rune("b", &[(A, 2), (B, 5)])], vec![section("S", &["a", "b"])]);
    let reply = r#"{"merge":[{"into":"b","from":["a"],"body":"M."}],"drop":[],"sections":[{"heading":"S","ids":["b"]}]}"#;
    let (out, _) = apply(&e, reply, None, &inputs()).unwrap();
    let srcs: Vec<(&str, usize)> = out.runes[0].sources.iter().map(|s| (s.path.as_str(), s.line)).collect();
    assert_eq!(srcs, [(A, 1), (A, 2), (B, 5)]);
}

#[test]
fn apply_puts_unplaced_runes_in_a_last_unsorted_section() {
    let reply = r#"{"merge":[],"drop":[],"sections":[{"heading":"Git","ids":["a","ghost"]}]}"#;
    let (out, _) = apply(&pair(), reply, None, &inputs()).unwrap();
    assert_eq!(out.sections, [section("Git", &["a"]), section("Unsorted", &["b", "c"])]);
}

#[test]
fn apply_joins_a_model_unsorted_section_to_the_fallback() {
    let reply = r#"{"merge":[],"drop":[],"sections":[{"heading":"unsorted","ids":["c"]},{"heading":"Git","ids":["a"]}]}"#;
    let (out, _) = apply(&pair(), reply, None, &inputs()).unwrap();
    assert_eq!(out.sections, [section("Git", &["a"]), section("Unsorted", &["c", "b"])]);
}

#[test]
fn apply_joins_sections_whose_headings_differ_only_in_case() {
    let reply = r#"{"merge":[],"drop":[],"sections":[{"heading":"Git","ids":["a"]},{"heading":"git","ids":["b"]},{"heading":"Tests","ids":["c"]}]}"#;
    let (out, _) = apply(&pair(), reply, None, &inputs()).unwrap();
    assert_eq!(out.sections, [section("Git", &["a", "b"]), section("Tests", &["c"])]);
}

#[test]
fn apply_first_placement_wins_and_skips_absorbed_ids_and_prunes_empties() {
    let reply = r#"{"merge":[{"into":"a","from":["b"],"body":"M."}],"drop":[],"sections":[
        {"heading":"Gone","ids":["b"]},{"heading":"Git","ids":["a"]},{"heading":"Again","ids":["a","c"]},{"heading":"Blank","ids":[]}]}"#;
    let (out, _) = apply(&pair(), reply, None, &inputs()).unwrap();
    assert_eq!(out.sections, [section("Git", &["a"]), section("Again", &["c"])]);
}

#[test]
fn apply_budget_drop_lists_uncited_lines_once() {
    let e = env(
        vec![rune("a", &[(A, 1)]), rune("b", &[(A, 2), (B, 1)]), rune("c", &[(A, 2)])],
        vec![section("S", &["a", "b", "c"])],
    );
    let reply = r#"{"merge":[],"drop":[{"id":"b","reason":"restated"},{"id":"c","reason":"minor"}],
        "sections":[{"heading":"S","ids":["a"]}]}"#;
    let (out, warns) = apply(&e, reply, Some(100), &inputs()).unwrap();
    assert!(warns.is_empty());
    assert_eq!(ids(&out), ["a"]);
    let got: Vec<(&str, usize, &str)> = out.dropped.iter().map(|d| (d.path.as_str(), d.line, d.reason.as_str())).collect();
    assert_eq!(got, [(A, 2, "budget: restated"), (B, 1, "budget: restated")]);
}

#[test]
fn apply_budget_drop_skips_lines_a_survivor_still_cites() {
    let e = env(vec![rune("a", &[(A, 1)]), rune("b", &[(A, 1)])], vec![section("S", &["a", "b"])]);
    let reply = r#"{"merge":[],"drop":[{"id":"b","reason":"dup"}],"sections":[{"heading":"S","ids":["a"]}]}"#;
    let (out, _) = apply(&e, reply, Some(100), &inputs()).unwrap();
    assert!(out.dropped.is_empty());
}

#[test]
fn apply_without_a_budget_ignores_drop_with_a_warning() {
    let reply = r#"{"merge":[],"drop":[{"id":"c","reason":"minor"}],"sections":[{"heading":"Git","ids":["a","b"]}]}"#;
    let (out, warns) = apply(&pair(), reply, None, &inputs()).unwrap();
    assert_eq!(ids(&out), ["a", "b", "c"]);
    assert!(out.dropped.is_empty());
    assert_eq!(out.sections, [section("Git", &["a", "b"]), section("Unsorted", &["c"])]);
    assert_eq!(warns.len(), 1, "{warns:?}");
}

#[test]
fn apply_output_passes_the_envelope_check_and_a_bad_apply_errors() {
    let reply = r#"{"merge":[{"into":"a","from":["b"],"body":"M."}],"drop":[],"sections":[{"heading":"G","ids":["a","c"]}]}"#;
    let (out, _) = apply(&pair(), reply, None, &inputs()).unwrap();
    assert!(envelope::check(&out, &inputs()).is_ok());
    // A heading that is not one line fails the check inside apply.
    let bad = r#"{"merge":[],"drop":[],"sections":[{"heading":"A\nB","ids":["a","b","c"]}]}"#;
    let err = apply(&pair(), bad, None, &inputs()).expect_err("check must fail");
    assert!(err.contains("must be one line"), "{err}");
    // A strict rejection comes through apply too.
    assert!(apply(&pair(), "nope", None, &inputs()).is_err());
}

#[test]
fn unmerged_joins_headings_case_insensitively_and_warns() {
    let one = env(vec![rune("a", &[(A, 1)]), rune("b", &[(A, 2)])], vec![section("Git", &["a"]), section("Tests", &["b"])]);
    let two = env(vec![rune("c", &[(B, 1)])], vec![section("git", &["c"])]);
    let (out, warn) = unmerged(&[one, two], "output: bad json");
    assert_eq!(ids(&out), ["a", "b", "c"]);
    assert_eq!(out.sections, [section("Git", &["a", "c"]), section("Tests", &["b"])]);
    assert_eq!(warn, "Merge pass failed (output: bad json); runes from separate parts were not merged.");
}
