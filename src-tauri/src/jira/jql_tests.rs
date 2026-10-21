use super::*;

fn none() -> Filters {
    Filters { projects: vec![], types: vec![], categories: vec![], assignee: AssigneeFilter::Any, text: String::new() }
}

fn compose_ok(scope: Scope, saved: &str, f: &Filters) -> String {
    compose(scope, saved, Some(f)).unwrap()
}

#[test]
fn status_filter_replaces_default_status_clause() {
    let f = Filters { categories: vec![2, 4], ..none() };
    assert_eq!(compose_ok(Scope::Mine, "", &f), "assignee = currentUser() AND statusCategory in (2, 4) ORDER BY updated DESC");
    assert_eq!(compose_ok(Scope::All, "", &f), "statusCategory in (2, 4) ORDER BY updated DESC");
    let both = Filters { categories: vec![4], projects: vec!["DEMO".into()], ..none() };
    let jql = compose_ok(Scope::All, "", &both);
    assert!(!jql.contains("!= Done"), "{jql}");
    assert_eq!(jql, "statusCategory in (4) AND project in (\"DEMO\") ORDER BY updated DESC");
}

#[test]
fn saved_default_jql_counts_as_blank() {
    let f = Filters { categories: vec![3], ..none() };
    let reflowed = "assignee = currentUser()\n  AND statusCategory != Done\n\tORDER BY updated DESC ";
    assert_eq!(compose_ok(Scope::Mine, reflowed, &f), compose_ok(Scope::Mine, "", &f));
    assert_eq!(compose_ok(Scope::Mine, reflowed, &f), "assignee = currentUser() AND statusCategory in (3) ORDER BY updated DESC");
}

#[test]
fn done_filter_on_all_is_done_only() {
    let f = Filters { categories: vec![3], ..none() };
    assert_eq!(compose_ok(Scope::All, "", &f), "statusCategory in (3) ORDER BY updated DESC");
}

#[test]
fn blank_saved_jql_with_filters_keeps_mine_parts() {
    let f = Filters { types: vec!["Epic".into()], ..none() };
    for blank in ["", "   ", "\t\n"] {
        assert_eq!(
            compose_ok(Scope::Mine, blank, &f),
            "assignee = currentUser() AND statusCategory != Done AND issuetype in (\"Epic\") ORDER BY updated DESC",
            "{blank:?}"
        );
    }
    // Without a clause the parts compose to the default query.
    assert_eq!(compose_ok(Scope::Mine, "  ", &none()), api::DEFAULT_JQL);
}

#[test]
fn emptied_filters_send_no_clause() {
    let emptied = Filters {
        projects: vec!["bad key".into(), "lower".into()],
        types: vec!["  ".into()],
        categories: vec![9],
        assignee: AssigneeFilter::Any,
        text: " (+-) ".into(),
    };
    for (scope, saved) in [(Scope::Mine, ""), (Scope::Mine, "project = DEMO ORDER BY key"), (Scope::All, "")] {
        assert_eq!(compose_ok(scope, saved, &emptied), api::compose_jql(scope, saved));
        assert_eq!(compose(scope, saved, None).unwrap(), api::compose_jql(scope, saved));
    }
}

#[test]
fn compose_strips_and_restores_order_by() {
    let f = Filters { assignee: AssigneeFilter::None, ..none() };
    assert_eq!(
        compose_ok(Scope::Mine, "project = DEMO ORDER BY created ASC", &f),
        "(project = DEMO) AND assignee is EMPTY ORDER BY created ASC"
    );
    assert_eq!(compose_ok(Scope::Mine, "project = DEMO", &f), "(project = DEMO) AND assignee is EMPTY");
    let s = Filters { categories: vec![3], ..none() };
    assert_eq!(compose_ok(Scope::Mine, "project = DEMO", &s), "(project = DEMO) AND statusCategory in (3)");
}

#[test]
fn compose_order_by_with_any_whitespace() {
    let f = Filters { assignee: AssigneeFilter::Me, ..none() };
    assert_eq!(
        compose_ok(Scope::Mine, "project = DEMO oRdEr \t\n  bY key DESC", &f),
        "(project = DEMO) AND assignee = currentUser() oRdEr \t\n  bY key DESC"
    );
    // "reorder by" and "order byx" are not the clause.
    assert_eq!(order_by_start("reorder by x"), None);
    assert_eq!(order_by_start("a order byx"), None);
}

#[test]
fn compose_order_by_only() {
    let f = Filters { types: vec!["Bug".into()], ..none() };
    assert_eq!(compose_ok(Scope::Mine, "ORDER BY created DESC", &f), "issuetype in (\"Bug\") ORDER BY created DESC");
}

#[test]
fn compose_ignores_order_by_inside_either_quote() {
    let f = Filters { assignee: AssigneeFilter::Me, ..none() };
    let dq = "summary ~ \"order by me\"";
    assert_eq!(compose_ok(Scope::Mine, dq, &f), format!("({dq}) AND assignee = currentUser()"));
    let sq = "summary ~ 'order by me' ORDER BY key";
    assert_eq!(compose_ok(Scope::Mine, sq, &f), "(summary ~ 'order by me') AND assignee = currentUser() ORDER BY key");
    // A backslash escape outside a literal is skipped too.
    let bs = r"labels = O\'Brien ORDER BY key";
    assert_eq!(order_by_start(bs), Some(bs.find("ORDER").unwrap()));
    assert_eq!(compose_ok(Scope::Mine, bs, &f), r"(labels = O\'Brien) AND assignee = currentUser() ORDER BY key");
    // An escaped quote does not close the literal.
    let esc = r#"summary ~ "a \" order by b" ORDER BY key"#;
    assert_eq!(compose_ok(Scope::Mine, esc, &f), r#"(summary ~ "a \" order by b") AND assignee = currentUser() ORDER BY key"#);
}

#[test]
fn compose_escapes_quotes_and_backslashes() {
    let f = Filters { types: vec![r#"A "b" \c"#.into(), "x\ny".into()], ..none() };
    assert_eq!(
        compose_ok(Scope::All, "", &f),
        r#"statusCategory != Done AND issuetype in ("A \"b\" \\c", "x y") ORDER BY updated DESC"#
    );
    let t = Filters { text: r#"say "hi""#.into(), ..none() };
    assert_eq!(compose_ok(Scope::All, "", &t), r#"statusCategory != Done AND text ~ "say  hi" ORDER BY updated DESC"#);
}

#[test]
fn search_text_maps_lucene_specials_to_spaces() {
    assert_eq!(search_text("a+b-c&d|e!f(g)h{i}j[k]l^m~n*o?p:q\\r/s"), "a b c d e f g h i j k l m n o p q r s");
    assert_eq!(search_text("  \t(x)\u{7} "), "x");
    assert_eq!(search_text("6\" screen"), "6  screen");
    let t = Filters { text: "fix: login (v2)".into(), ..none() };
    assert_eq!(compose_ok(Scope::All, "", &t), "statusCategory != Done AND text ~ \"fix  login  v2\" ORDER BY updated DESC");
}

#[test]
fn bad_project_key_is_dropped() {
    for bad in ["", "demo", "1AB", "A-B", "ABCDEFGHIJK", "DE MO", "A\"B"] {
        assert!(!api::valid_project_key(bad), "{bad:?}");
    }
    for good in ["A", "DEMO", "D_1", "ABCDEFGHIJ"] {
        assert!(api::valid_project_key(good), "{good:?}");
    }
    let f = Filters { projects: vec!["DEMO".into(), "x) OR (1=1".into(), "OPS".into()], ..none() };
    assert_eq!(compose_ok(Scope::All, "", &f), "statusCategory != Done AND project in (\"DEMO\", \"OPS\") ORDER BY updated DESC");
}

#[test]
fn filter_caps_refuse_as_jql() {
    let many = |n: usize| (0..n).map(|i| format!("K{i}")).collect::<Vec<_>>();
    let over = [
        Filters { projects: many(21), ..none() },
        Filters { types: many(21), ..none() },
        Filters { categories: vec![2; 21], ..none() },
        Filters { text: "x".repeat(201), ..none() },
    ];
    for f in &over {
        let e = compose(Scope::All, "", Some(f)).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Jql, "{f:?}");
    }
    let at = Filters { projects: many(20), text: "x".repeat(200), ..none() };
    assert!(compose(Scope::All, "", Some(&at)).is_ok());
}
