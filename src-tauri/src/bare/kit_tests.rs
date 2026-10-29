use super::*;

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Self {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("vidar-kit-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        Tmp(root)
    }
    fn imports(&self) -> PathBuf { crate::paths::rune_imports_dir_in(&self.0) }
    fn file(&self, rel: &str, body: &str) -> String {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path.to_string_lossy().into_owned()
    }
    fn skill(&self, rel: &str) -> String {
        fs::create_dir_all(self.0.join(rel)).unwrap();
        self.file(&format!("{rel}/SKILL.md"), "---\nname: sample\n---\nBody\n");
        self.0.join(rel).to_string_lossy().into_owned()
    }
}
impl Drop for Tmp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

fn item(dir: &Path, kind: &str, id: &str) -> rune::Rune {
    rune::parse(&fs::read_to_string(dir.join(format!("{kind}s/{id}.md"))).unwrap()).unwrap()
}

#[test]
fn kit_writes_item_runes_and_slots_without_a_sidecar() {
    let t = Tmp::new("create");
    let skill = t.skill("src/skills/one");
    let agent = t.file("src/agents/review.md", "---\nname: review\n---\nReview.\n");
    let codex = t.file("src/agents/planner.toml", "name = 'planner'\ndeveloper_instructions = 'Plan.'\n");
    let hook = t.file("src/hooks/check.mjs", "// check");
    let layer = SetLayerWrite {
        skills: Some(vec![skill.clone()]), agents: Some(vec![agent.clone()]),
        codex_agents: Some(vec![codex.clone()]),
        guards: Some(vec![serde_json::json!({"event":"PreToolUse", "run":[hook]})]),
        ..Default::default()
    };
    let result = create_at(&t.imports(), &layer, None).unwrap();
    assert!(result.created && result.dropped.is_empty(), "{:?}", result.dropped);
    let dir = t.imports().join("kit");
    let sets = |b: &str| fs::read_to_string(set_md(&dir, b)).unwrap();
    assert!(sets("").contains("<?rune one?>") && !sets("").contains("review"), "{}", sets(""));
    for id in ["review", "check"] { assert!(sets("claude").contains(&format!("<?rune {id}?>")), "{}", sets("claude")); }
    assert!(sets("codex").contains("<?rune planner?>") && !sets("codex").contains("review"));
    assert_eq!(item(&dir, "skill", "one").item.source.as_deref(), Some(skill.as_str()));
    assert_eq!(item(&dir, "agent", "planner").agent.as_deref(), Some("codex"));
    assert_eq!(item(&dir, "agent", "review").agent.as_deref(), Some("claude"));
    assert_eq!(item(&dir, "hook", "check").item.event.as_deref(), Some("PreToolUse"));
    assert!(!dir.join("sets/kit.layer.json").exists());
    let before = fs::read(set_md(&dir, "")).unwrap();
    assert!(!create_at(&t.imports(), &SetLayerWrite::default(), None).unwrap().created);
    assert_eq!(fs::read(set_md(&dir, "")).unwrap(), before);
}

#[test]
fn new_item_is_a_rune_and_starts_unticked() {
    let t = Tmp::new("new");
    create_at(&t.imports(), &SetLayerWrite::default(), None).unwrap();
    let before = fs::read(set_md(&t.imports().join("kit"), "")).unwrap();
    for (agent, kind, id) in [("claude", "skill", "my-skill"), ("codex", "agent", "planner"), ("codex", "hook", "my-hook")] {
        let row = item_create_at(&t.imports(), "kit", agent, kind, id, None).unwrap();
        assert!(row.path.ends_with(&format!("{id}.md")));
        assert_eq!(item(&t.imports().join("kit"), kind, id).agent.as_deref(), (agent == "codex" || kind == "agent").then_some(agent));
    }
    assert_eq!(fs::read(set_md(&t.imports().join("kit"), "")).unwrap(), before);
    assert!(!t.imports().join("kit/sets/kit.layer.json").exists());
    assert!(item_create_at(&t.imports(), "kit", "claude", "skill", "my-skill", None).unwrap_err().contains("already exists"));
    assert_eq!(files_at(&t.imports(), "kit").unwrap().len(), 3);
}

#[test]
fn raw_command_error_does_not_echo_secret() {
    let t = Tmp::new("secret");
    let secret = "sk-secret-1";
    let raw = serde_json::json!({"event":"Stop", "command": format!("pwsh -Command {secret}\nbad: value")});
    let layer = SetLayerWrite { codex_guards: Some(vec![raw]), ..Default::default() };
    let result = create_at(&t.imports(), &layer, None).unwrap();
    assert_eq!(result.dropped.len(), 1);
    let wire = serde_json::to_string(&result).unwrap();
    assert!(!wire.contains(secret), "secret leaked in IPC result: {wire}");
    let dir = t.imports().join("kit");
    assert_eq!(fs::read_to_string(set_md(&dir, "")).unwrap(), KIT_MD);
    assert!(!dir.join("hooks/stop.md").exists());
}

#[test]
fn mcp_rune_names_only_the_catalog_entry() {
    let text = mcp_text("kit", "slack-main", "slack", "slack", Some("codex")).unwrap();
    let parsed = rune::parse(&text).unwrap();
    assert_eq!(parsed.kind, "mcp");
    assert_eq!(parsed.item.module.as_deref(), Some("slack"));
    assert_eq!(parsed.item.server.as_deref(), Some("slack"));
    assert_eq!(parsed.agent.as_deref(), Some("codex"));
    assert!(!text.contains("url:") && !text.contains("token:"));
}

fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap().flatten() {
            if e.path().is_dir() { stack.push(e.path()); } else { out.push((e.path(), fs::read(e.path()).unwrap())); }
        }
    }
    out.sort();
    out
}

#[test]
fn a_second_create_with_new_items_changes_no_bytes() {
    let t = Tmp::new("again");
    let layer = SetLayerWrite { skills: Some(vec![t.skill("src/skills/one")]), ..Default::default() };
    assert!(create_at(&t.imports(), &layer, None).unwrap().created);
    let dir = t.imports().join("kit");
    let before = snapshot(&dir);
    let again = SetLayerWrite { skills: Some(vec![t.skill("src/skills/two")]), ..Default::default() };
    assert_eq!(create_at(&t.imports(), &again, None).unwrap(), KitCreated { created: false, dropped: vec![] });
    assert_eq!(snapshot(&dir), before, "an existing Kit is never written");
}

#[test]
fn two_add_kit_runs_reuse_an_existing_item_without_a_suffixed_id() {
    let t = Tmp::new("repeat-id");
    let layer = SetLayerWrite { skills: Some(vec![t.skill("src/skills/one")]), ..Default::default() };
    let dir = t.imports().join("kit");
    assert!(create_at(&t.imports(), &layer, None).unwrap().created);
    // A repairable empty base set sends the same source through id allocation again.
    fs::write(set_md(&dir, ""), KIT_MD).unwrap();
    assert!(create_at(&t.imports(), &layer, None).unwrap().created, "the emptied base is refilled");
    assert!(dir.join("skills/one.md").is_file());
    assert!(!dir.join("skills/one-2.md").exists());
    assert!(snapshot(&dir).iter().all(|(path, _)| !path.to_string_lossy().contains("-2.md")));
}

#[test]
fn an_emptied_base_set_is_refilled_with_the_existing_ids_and_no_item_is_rewritten() {
    let t = Tmp::new("repeat-refill");
    let layer = SetLayerWrite { skills: Some(vec![t.skill("src/skills/one")]), ..Default::default() };
    let dir = t.imports().join("kit");
    assert!(create_at(&t.imports(), &layer, None).unwrap().created);
    fs::write(set_md(&dir, ""), set_head("")).unwrap();
    let item_before = fs::read(dir.join("skills/one.md")).unwrap();
    let seen = std::cell::RefCell::new(Vec::<PathBuf>::new());
    let record = |path: &Path, text: &str| -> Result<(), String> { seen.borrow_mut().push(path.to_path_buf()); write_new(path, text) };
    assert!(create_with(&t.imports(), &layer, None, &record).unwrap().created);
    let set = fs::read_to_string(set_md(&dir, "")).unwrap();
    assert!(set.contains("<?rune one?>"), "{set}");
    assert!(!dir.join("skills/one-2.md").exists());
    assert!(seen.borrow().iter().all(|p| !p.starts_with(dir.join("skills"))), "{:?}", seen.borrow());
    assert_eq!(fs::read(dir.join("skills/one.md")).unwrap(), item_before);
}

#[test]
fn a_failed_write_leaves_no_folder_and_a_foreign_folder_refuses() {
    let t = Tmp::new("refuse");
    let layer = SetLayerWrite { skills: Some(vec![t.skill("src/skills/one")]), ..Default::default() };
    // item runes are written, then the set write fails: everything this call made is removed
    let fail_set = |p: &Path, text: &str| -> Result<(), String> {
        if p.ends_with("kit.md") { Err("refused".into()) } else { write_new(p, text) }
    };
    assert_eq!(create_with(&t.imports(), &layer, None, &fail_set).unwrap_err(), "refused");
    assert!(t.imports().is_dir(), "the imports folder is kept");
    assert!(!t.imports().join("kit").exists(), "the folder this call made is gone");
    // a repair (empty sets folder left alive) that fails keeps no item rune behind
    fs::create_dir_all(t.imports().join("kit/sets")).unwrap();
    assert!(create_with(&t.imports(), &layer, None, &fail_set).is_err());
    assert!(!t.imports().join("kit/skills").exists());
    assert!(t.imports().join("kit").is_dir() && !set_md(&t.imports().join("kit"), "").exists());
    // a folder holding anything else refuses
    fs::create_dir_all(t.imports().join("kit/sets")).unwrap();
    fs::write(t.imports().join("kit/sets/other.md"), "# Other\n").unwrap();
    let e = create_at(&t.imports(), &layer, None).unwrap_err();
    assert!(e.contains("Add Kit refused"), "{e}");
    assert!(!set_md(&t.imports().join("kit"), "").exists());
}

#[test]
fn an_empty_kit_folder_is_repaired() {
    let t = Tmp::new("repair-empty");
    fs::create_dir_all(t.imports().join("kit").join("sets")).unwrap();
    let layer = SetLayerWrite { skills: Some(vec![t.skill("src/skills/one")]), ..Default::default() };
    assert!(create_at(&t.imports(), &layer, None).unwrap().created);
    assert!(fs::read_to_string(set_md(&t.imports().join("kit"), "")).unwrap().contains("<?rune one?>"));
}

#[test]
fn a_bad_item_is_dropped_and_reported_while_the_rest_is_written() {
    let t = Tmp::new("drop");
    let good = t.skill("src/skills/good");
    let twin = t.skill("other/skills/good");
    let empty = t.0.join("src/skills/empty");
    fs::create_dir_all(&empty).unwrap();
    let missing = t.0.join("src/skills/missing").to_string_lossy().into_owned();
    let bad_role = t.file("src/agents/bad.toml", "name = 'bad'\n");
    let role = t.file("src/agents/ok.toml", "name = 'ok'\ndeveloper_instructions = 'Do.'\n");
    let g1 = t.file("a/guard.mjs", "// a");
    let g2 = t.file("b/guard.mjs", "// b");
    let guard = |p: &str| serde_json::json!({ "event": "PreToolUse", "matcher": "Bash", "run": [p] });
    let layer = SetLayerWrite {
        skills: Some(vec![good.clone(), twin, empty.to_string_lossy().into_owned(), missing]),
        codex_agents: Some(vec![role.clone(), bad_role]),
        guards: Some(vec![guard(&g1), guard(&g2)]),
        ..Default::default()
    };
    let r = create_at(&t.imports(), &layer, None).unwrap();
    assert!(r.created);
    let got: Vec<(&str, &str)> = r.dropped.iter().map(|d| (d.id.as_str(), d.reason.as_str())).collect();
    assert_eq!(got, [
        ("skills/good", "Another item has this name"),
        ("skills/empty", "Invalid Kit item source"),
        ("skills/missing", "Invalid Kit item source"),
        ("guards/PreToolUse|Bash|guard.mjs", "Invalid Kit hook"),
        ("codexAgents/bad.toml", "Invalid Kit item source"),
    ]);
    let dir = t.imports().join("kit");
    let set: String = buckets().iter().filter_map(|b| fs::read_to_string(set_md(&dir, b)).ok()).collect();
    for id in ["good", "ok", "guard"] { assert!(set.contains(&format!("<?rune {id}?>")), "{set}"); }
    assert_eq!(set.matches("<?rune").count(), 3, "{set}");
    assert_eq!(item(&dir, "skill", "good").item.source.as_deref(), Some(good.as_str()));
    assert_eq!(item(&dir, "agent", "ok").item.source.as_deref(), Some(role.as_str()));
    assert_eq!(item(&dir, "hook", "guard").item.run, [g1]);
}

#[test]
fn raw_command_rune_keeps_its_command_and_mjs_rune_keeps_its_run() {
    let t = Tmp::new("raw-and-mjs");
    let script = t.file("hooks/old.mjs", "// existing");
    let command = "pwsh -NoProfile -Command '$token = \"sk-secret-1\"; exit 7'";
    let existing = serde_json::json!({ "event": "PreToolUse", "matcher": "Bash", "run": [script] });
    let raw = serde_json::json!({ "event": "Stop", "command": command });
    let layer = SetLayerWrite { guards: Some(vec![existing, raw.clone()]), codex_guards: Some(vec![raw]), ..Default::default() };
    let created = create_at(&t.imports(), &layer, None).unwrap();
    assert!(created.dropped.is_empty(), "{:?}", created.dropped);
    assert!(!serde_json::to_string(&created).unwrap().contains("sk-secret-1"));
    let dir = t.imports().join("kit");
    let old = item(&dir, "hook", "old");
    assert_eq!((old.item.run.clone(), old.item.command.is_none(), old.agent.as_deref()), (vec![script], true, Some("claude")));
    let stop = item(&dir, "hook", "stop");
    assert_eq!((stop.item.command.as_ref().map(|c| c.expose()), stop.item.run.is_empty(), stop.agent.as_deref()), (Some(command), true, Some("claude")));
    let codex = item(&dir, "hook", "stop-2");
    assert_eq!((codex.item.command.as_ref().map(|c| c.expose()), codex.agent.as_deref()), (Some(command), Some("codex")));
    // the library listing that reaches the Runes tab names the rune, never its command
    let rows = serde_json::to_string(&files_at(&t.imports(), "kit").unwrap()).unwrap();
    assert!(rows.contains("stop-2") && !rows.contains("sk-secret-1"), "{rows}");
}

#[test]
fn an_unsupported_codex_command_hook_is_dropped_without_echoing_it() {
    let t = Tmp::new("secret-unsupported");
    let raw = serde_json::json!({ "event": "Notification", "command": "node a.mjs --token=sk-secret-1" });
    let created = create_at(&t.imports(), &SetLayerWrite { codex_guards: Some(vec![raw]), ..Default::default() }, None).unwrap();
    assert_eq!(created.dropped.len(), 1, "{:?}", created.dropped);
    let wire = serde_json::to_string(&created).unwrap();
    assert!(!wire.contains("sk-secret-1") && !wire.contains("--token"), "{wire}");
    assert!(!t.imports().join("kit/hooks").exists());
}

#[test]
fn a_codex_hook_pick_resolves_server_side_before_the_rune_is_saved() {
    let t = Tmp::new("hook-pick");
    let profile = t.0.join("person");
    let codex = profile.join(".codex");
    fs::create_dir_all(&codex).unwrap();
    let command = "pwsh -NoProfile -Command '$token = \"sk-secret-1\"; exit 7'";
    fs::write(codex.join("hooks.json"), serde_json::json!({ "hooks": {
        "Stop": [{ "hooks": [{ "type": "command", "command": command }] }]
    }}).to_string()).unwrap();
    let config = t.0.join("config.json");
    let cwd = t.0.join("cwd");
    let env = crate::rules::import::local::LocalEnv {
        imports: &t.imports(), config: &config, home: Some(&profile), cwd: &cwd, primary: "",
        settings: None, codex_home: Some(&codex), homes: None, claude_json: None, catalog: None,
    };
    let row = crate::rules::import::codex_home::hooks(&env).pop().unwrap();
    assert!(!serde_json::to_string(&row).unwrap().contains("sk-secret-1"));
    let selection = serde_json::to_value(row.guard.unwrap()).unwrap();
    let layer = SetLayerWrite { codex_guards: Some(vec![selection]), ..Default::default() };
    let created = create_at(&t.imports(), &layer, Some(&profile)).unwrap();
    assert!(created.dropped.is_empty(), "{:?}", created.dropped);
    assert!(!serde_json::to_string(&created).unwrap().contains("sk-secret-1"));
    let stop = item(&t.imports().join("kit"), "hook", "stop");
    assert_eq!((stop.item.command.as_ref().map(|c| c.expose()), stop.agent.as_deref()), (Some(command), Some("codex")));
}

#[test]
fn a_grok_tag_has_no_kit_set_and_the_known_tags_keep_theirs() {
    assert_eq!(buckets(), ["", "claude", "codex"]);
    assert_eq!((bucket_of(None), bucket_of(Some("claude")), bucket_of(Some("codex"))), (Some(""), Some("claude"), Some("codex")));
    assert_eq!(bucket_of(Some("grok")), None);
    let t = Tmp::new("grok-item");
    let imports = t.imports();
    create_at(&imports, &SetLayerWrite::default(), None).unwrap();
    let before = snapshot(&imports.join("kit"));
    assert!(item_create_at(&imports, "kit", "grok", "agent", "scout", None).is_err());
    assert_eq!(snapshot(&imports.join("kit")), before, "grok writes nothing");
}

#[test]
fn item_create_tags_per_agent_as_before() {
    let t = Tmp::new("item-tags");
    let imports = t.imports();
    create_at(&imports, &SetLayerWrite::default(), None).unwrap();
    let tag = |agent: &str, kind: &str, name: &str| item_create_at(&imports, "kit", agent, kind, name, None).unwrap().agent;
    assert_eq!(tag("claude", "skill", "a"), None);
    assert_eq!(tag("claude", "hook", "b"), None);
    assert_eq!(tag("claude", "agent", "c"), Some("claude".to_string()));
    assert_eq!(tag("codex", "skill", "d"), Some("codex".to_string()));
    assert_eq!(tag("codex", "agent", "e"), Some("codex".to_string()));
}

#[test]
fn item_create_refuses_reserved_bad_and_unknown_names_and_listing_stays_in_imports() {
    let t = Tmp::new("item-refuse");
    let imports = t.imports();
    create_at(&imports, &SetLayerWrite::default(), None).unwrap();
    let before = snapshot(&imports.join("kit"));
    for (agent, kind, name) in [("claude", "agent", "worker"), ("codex", "agent", "default"), ("claude", "skill", "Bad_Name"), ("claude", "mcp", "x"), ("gemini", "skill", "x")] {
        assert!(item_create_at(&imports, "kit", agent, kind, name, None).is_err(), "{agent} {kind} {name}");
    }
    assert_eq!(snapshot(&imports.join("kit")), before, "a refused create writes nothing");
    // one id per library: a name another kind holds refuses too
    item_create_at(&imports, "kit", "claude", "skill", "shared", None).unwrap();
    assert!(item_create_at(&imports, "kit", "claude", "hook", "shared", None).unwrap_err().contains("already exists"));
    let rows: Vec<(String, Option<String>, String)> = files_at(&imports, "kit").unwrap().into_iter().map(|f| (f.kind, f.agent, f.name)).collect();
    assert_eq!(rows, vec![("skill".into(), None, "shared".into())]);
    assert!(files_at(&imports, "../x").is_err());
}

#[test]
fn a_rune_carries_its_sources_description_flattened_to_one_line() {
    let t = Tmp::new("describe");
    let folded = t.0.join("src/skills/folded");
    fs::create_dir_all(&folded).unwrap();
    fs::write(folded.join("SKILL.md"), "---\nname: folded\ndescription: >\n  Reviews a change\n  and says \"why\".\n\n  Second paragraph.\nallowed-tools: Bash\n---\nBody\n").unwrap();
    let plain = t.0.join("src/skills/plain");
    fs::create_dir_all(&plain).unwrap();
    fs::write(plain.join("SKILL.md"), "---\nname: plain\ndescription: Does one thing.\n---\n").unwrap();
    let bare = t.skill("src/skills/bare");
    let agent = t.file("src/agents/rev.md", "---\nname: rev\ndescription: |\n  Line one\n  line two\n---\nBody\n");
    let layer = SetLayerWrite {
        skills: Some(vec![folded.to_string_lossy().into_owned(), plain.to_string_lossy().into_owned(), bare]),
        agents: Some(vec![agent]),
        ..Default::default()
    };
    let r = create_at(&t.imports(), &layer, None).unwrap();
    assert!(r.dropped.is_empty(), "{:?}", r.dropped);
    let dir = t.imports().join("kit");
    assert_eq!(item(&dir, "skill", "folded").description, "Reviews a change and says \"why\". Second paragraph.");
    assert_eq!(item(&dir, "skill", "plain").description, "Does one thing.");
    assert_eq!(item(&dir, "skill", "bare").description, "");
    assert_eq!(item(&dir, "agent", "rev").description, "Line one line two");
    assert!(!fs::read_to_string(dir.join("skills/folded.md")).unwrap().contains("moved from"));
}

#[test]
fn add_kit_for_the_second_agent_fills_its_own_set() {
    let t = Tmp::new("two-agents");
    let skill = t.skill("src/skills/one");
    let review = t.file("src/agents/review.md", "---\nname: review\n---\nR\n");
    let planner = t.file("src/agents/planner.toml", "name = 'planner'\ndescription = \"Plans work.\"\ndeveloper_instructions = 'Plan.'\n");
    let claude = SetLayerWrite { skills: Some(vec![skill.clone()]), agents: Some(vec![review]), ..Default::default() };
    let codex = SetLayerWrite { codex_agents: Some(vec![planner]), ..Default::default() };
    let dir = t.imports().join("kit");
    assert!(create_at(&t.imports(), &claude, None).unwrap().created);
    assert!(set_md(&dir, "claude").is_file() && !set_md(&dir, "codex").exists());
    let (base, claude_set) = (fs::read(set_md(&dir, "")).unwrap(), fs::read(set_md(&dir, "claude")).unwrap());
    assert!(create_at(&t.imports(), &codex, None).unwrap().created, "the second agent fills its own set");
    let codex_set = fs::read_to_string(set_md(&dir, "codex")).unwrap();
    assert!(codex_set.contains("name: kit-codex") && codex_set.contains("<?rune planner?>"), "{codex_set}");
    assert_eq!(item(&dir, "agent", "planner").description, "Plans work.");
    assert_eq!((fs::read(set_md(&dir, "")).unwrap(), fs::read(set_md(&dir, "claude")).unwrap()), (base, claude_set), "the first sets are untouched");
    assert!(!create_at(&t.imports(), &codex, None).unwrap().created, "a third click writes nothing");
}

#[test]
fn an_empty_kit_base_is_refilled_by_a_later_add_kit() {
    let t = Tmp::new("refill");
    create_at(&t.imports(), &SetLayerWrite::default(), None).unwrap();
    let dir = t.imports().join("kit");
    let layer = SetLayerWrite { skills: Some(vec![t.skill("src/skills/one")]), ..Default::default() };
    assert!(create_at(&t.imports(), &layer, None).unwrap().created);
    assert!(fs::read_to_string(set_md(&dir, "")).unwrap().contains("<?rune one?>"));
}

fn layer_files(dir: &Path) -> Vec<PathBuf> {
    snapshot(dir).into_iter().map(|(p, _)| p).filter(|p| p.to_string_lossy().ends_with(".layer.json")).collect()
}

#[test]
fn attach_and_kit_leave_no_layer_sidecar_in_the_library() {
    let t = Tmp::new("attach");
    let skill = t.skill("src/skills/one");
    let hook = t.file("src/hooks/check.mjs", "// check");
    let layer = SetLayerWrite {
        skills: Some(vec![skill.clone()]),
        guards: Some(vec![serde_json::json!({"event":"PreToolUse", "run":[hook]})]),
        ..Default::default()
    };
    create_at(&t.imports(), &layer, None).unwrap();
    let imp = crate::bare::item_import::import_at(&t.imports(), "kit", &layer, None).unwrap();
    assert!(imp.dropped.is_empty(), "{:?}", imp.dropped);
    let ids: Vec<(&str, &str)> = imp.runes.iter().map(|r| (r.kind.as_str(), r.id.as_str())).collect();
    assert_eq!(ids, vec![("skill", "one"), ("hook", "check")], "the kit already holds the same runes");
    let again = SetLayerWrite { skills: Some(vec![t.skill("other/skills/one")]), ..Default::default() };
    let second = crate::bare::item_import::import_at(&t.imports(), "kit", &again, None).unwrap();
    assert_eq!(second.runes[0].id, "one-2", "a different source under a taken id gets a new id");
    assert_eq!(item(&t.imports().join("kit"), "skill", "one-2").item.source.as_deref(), Some(again.skills.as_ref().unwrap()[0].as_str()));
    assert!(layer_files(&t.imports()).is_empty(), "{:?}", layer_files(&t.imports()));
    assert!(crate::bare::item_import::import_at(&t.imports(), "nowhere", &layer, None).is_err());
}
