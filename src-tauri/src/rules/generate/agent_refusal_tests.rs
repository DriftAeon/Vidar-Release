//! src-tauri\src\rules\generate\agent_refusal_tests.rs — M1 D3: an agent string that `agent_spec::parse` does not
//! take (`grok`, `Claude`, empty) is refused at the rune header parser, the generator request check and
//! `dir_name`; the `loaded` and `speak` reads are tested beside their code.

use super::*;

const BAD: [&str; 3] = ["grok", "Claude", ""];

#[test]
fn an_agent_the_spec_does_not_parse_is_refused_at_each_generator_boundary() {
    for bad in BAD {
        let rune = format!("---\nname: r\nkind: rule\nscope: [global]\nagent: {bad}\n---\nBody\n");
        // An empty value is an absent key to the header reader; the other two are named and refused.
        if !bad.is_empty() {
            let err = crate::rules::rune::parse(&rune).unwrap_err();
            assert!(err.starts_with("invalid agent"), "{bad}: {err}");
        }
        let req = Request {
            run_id: "0a1b2c3d".into(),
            agent: bad.into(),
            model: "sonnet".into(),
            effort: "medium".into(),
            merge_effort: None,
            paths: vec![],
            items: vec![],
        };
        let err = check_request(&req).unwrap_err();
        assert!(err.starts_with("invalid: agent"), "{bad}: {err}");
        let err = home::dir_name(bad).unwrap_err();
        assert!(err.starts_with("invalid: agent"), "{bad}: {err}");
        assert!(run::classify(bad, &run::Raw::default()).unwrap_err().starts_with("invalid: agent"), "{bad}");
        assert!(run::resolve_exe(bad, std::path::Path::new("."), &[]).unwrap_err().starts_with("invalid: agent"), "{bad}");
    }
    assert_eq!(home::dir_name("claude"), Ok("gen-claude"));
    assert_eq!(home::dir_name("codex"), Ok("gen-codex"));
}
