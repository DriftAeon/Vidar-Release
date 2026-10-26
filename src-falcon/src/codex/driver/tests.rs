use super::*;
use crate::protocol::Agent;

pub(super) fn params(resume: Option<&str>) -> SpawnParams {
    SpawnParams {
        agent: Some(Agent::Codex),
        cwd: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .display()
            .to_string(),
        model: Some("gpt-requested".into()),
        effort: None,
        permission_mode: "default".into(),
        resume: resume.map(str::to_string),
        ctl_secret: None,
        rules_file: None,
        tab_name: None,
        gateway: None,
        profile: None,
        payload_file: None, mcp_file: None,
        row_key: None, sets: None,
        set_plugin_dirs: Vec::new(), codex_home: None, claude_config_dir: None, plugin_names: Vec::new(),
    }
}

fn launch(driver: &CodexDriver, initialize: Value, thread: Value) -> Result<(), String> {
    driver.start_with(|message| {
        match message["method"].as_str().unwrap() {
            "initialize" => {
                driver.observe(&initialize);
            }
            "thread/start" | "thread/resume" => {
                driver.observe(&thread);
            }
            "initialized" => {}
            method => panic!("unexpected startup method {method}"),
        }
        WriteStatus::Written
    })
}

#[test]
fn startup_waits_for_initialize_before_sending_thread() {
    let driver = CodexDriver::new(&params(None));
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            driver.start_with(|message| {
                sent.send(message["method"].as_str().unwrap().to_string())
                    .unwrap();
                WriteStatus::Written
            })
        });
        assert_eq!(
            received.recv_timeout(Duration::from_secs(1)).unwrap(),
            "initialize"
        );
        let premature = received.recv_timeout(Duration::from_millis(30));
        // Always release the worker, including when asserting a regression.
        driver.observe(&json!({"id": INITIALIZE_ID, "result": {}}));
        assert!(matches!(
            premature,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(
            received.recv_timeout(Duration::from_secs(1)).unwrap(),
            "initialized"
        );
        assert_eq!(
            received.recv_timeout(Duration::from_secs(1)).unwrap(),
            "thread/start"
        );
        worker.join().unwrap().unwrap();
    });
    driver
        .observe(&json!({"id": THREAD_ID, "result": {"thread": {"id": "new"}, "model": "actual"}}));
    assert_eq!(driver.wait_ready().unwrap(), "new");
    assert_eq!(driver.model().as_deref(), Some("actual"));
}

#[test]
fn new_and_resumed_threads_use_host_owned_identity_and_verified_model() {
    for resume in [None, Some("existing")] {
        let driver = CodexDriver::new(&params(resume));
        assert_eq!(driver.model(), None, "a requested model is not live state");
        let messages = driver.startup_messages().unwrap();
        assert_eq!(messages[2]["params"]["cwd"], params(resume).cwd);
        assert_eq!(messages[2]["params"]["model"], "gpt-requested");
        assert_eq!(
            messages[2]["method"],
            if resume.is_some() {
                "thread/resume"
            } else {
                "thread/start"
            }
        );
        if let Some(id) = resume {
            assert_eq!(messages[2]["params"]["threadId"], id);
            assert_eq!(messages[2]["params"]["excludeTurns"], true);
        }
        let id = resume.unwrap_or("new");
        launch(
            &driver,
            json!({"id": 0, "result": {}}),
            json!({"id": 1, "result": {"thread": {"id": id}, "model": "actual"}}),
        )
        .unwrap();
        assert_eq!(driver.wait_ready().unwrap(), id);
        assert_eq!(driver.model().as_deref(), Some("actual"));
    }
}

#[test]
fn a_payload_over_twelve_thousand_chars_lands_in_thread_start_params() {
    let text = "a".repeat(16_000);
    let driver = CodexDriver::new(&params(None)).with_developer_instructions(Some(text.clone()));
    let messages = driver.startup_messages().unwrap();
    assert_eq!(messages[2]["method"], "thread/start");
    assert_eq!(messages[2]["params"]["developerInstructions"], text.as_str());
}

#[test]
fn a_spawn_without_a_payload_sends_no_developer_instructions() {
    let driver = CodexDriver::new(&params(None)).with_developer_instructions(None);
    let messages = driver.startup_messages().unwrap();
    assert_eq!(messages[2]["method"], "thread/start");
    assert!(messages[2]["params"].get("developerInstructions").is_none());
}

#[test]
fn resume_params_never_carry_developer_instructions() {
    let driver = CodexDriver::new(&params(Some("existing")))
        .with_developer_instructions(Some("payload".into()));
    let messages = driver.startup_messages().unwrap();
    assert_eq!(messages[2]["method"], "thread/resume");
    assert!(messages[2]["params"].get("developerInstructions").is_none());
}

#[test]
fn the_reviewer_downgrade_retry_keeps_the_payload_on_its_thread_start() {
    let mut spawn = params(None);
    spawn.permission_mode = "auto".into();
    let driver = CodexDriver::new(&spawn).with_developer_instructions(Some("payload".into()));
    let sent = Mutex::new(Vec::<Value>::new());
    let _ = driver.start_with(|message| {
        sent.lock().unwrap().push(message.clone());
        match message["method"].as_str().unwrap() {
            "initialize" => {
                driver.observe(&json!({"id": 0, "result": {}}));
            }
            "thread/start" if sent.lock().unwrap().iter().filter(|m| m["method"] == "thread/start").count() == 1 => {
                driver.observe(&json!({"id": 1, "error": {"code": -1, "message": "approvals reviewer unavailable"}}));
            }
            "thread/start" => {
                driver.observe(&json!({"id": 1, "result": {"thread": {"id": "t"}, "model": "m"}}));
            }
            _ => {}
        }
        WriteStatus::Written
    });
    let starts: Vec<Value> = sent
        .into_inner()
        .unwrap()
        .into_iter()
        .filter(|m| m["method"] == "thread/start")
        .collect();
    assert_eq!(starts.len(), 2, "{starts:?}");
    for start in &starts {
        assert_eq!(start["params"]["developerInstructions"], "payload");
    }
}

#[test]
fn failed_or_malformed_initialize_never_sends_follow_up_requests() {
    for response in [
        json!({"id": 0, "error": {"code": -1, "message": "no auth"}}),
        json!({"id": 0, "result": null}),
        json!({"id": 0}),
    ] {
        let driver = CodexDriver::new(&params(None));
        let mut sent = Vec::new();
        assert!(driver
            .start_with(|message| {
                sent.push(message["method"].clone());
                driver.observe(&response);
                WriteStatus::Written
            })
            .is_err());
        assert_eq!(sent, vec![json!("initialize")]);
        assert!(driver.wait_ready().is_err());
        assert!(driver
            .start_with(|_| panic!("failed startup must not retry"))
            .is_err());
    }
}

#[test]
fn thread_errors_missing_identity_and_resume_mismatch_refuse_readiness() {
    for response in [
        json!({"id": 1, "error": {"message": "bad cwd"}}),
        json!({"id": 1, "result": {"thread": {"id": " "}}}),
        json!({"id": 1, "result": {"thread": {"id": "other"}}}),
    ] {
        let driver = CodexDriver::new(&params(Some("existing")));
        launch(&driver, json!({"id": 0, "result": {}}), response).unwrap();
        assert!(driver.wait_ready().is_err());
    }
}

#[test]
fn server_request_ids_do_not_collide_with_startup_responses() {
    let driver = CodexDriver::new(&params(None));
    for id in [INITIALIZE_ID, THREAD_ID] {
        assert!(matches!(
            driver
                .observe(&json!({"id": id, "method": "approval", "params": {}}))
                .0,
            Observed::Forward
        ));
    }
    assert!(matches!(lock(&driver.state).ready, ReadyState::Pending));
    driver.observe(&json!({"id": THREAD_ID, "result": {"thread": {"id": "unsolicited"}}}));
    assert!(driver
        .wait_ready()
        .unwrap_err()
        .contains("before its request"));
}

#[test]
fn failed_and_possibly_delivered_startup_writes_never_retry() {
    for stage in 0..3 {
        for uncertain in [false, true] {
            let driver = CodexDriver::new(&params(None));
            let mut count = 0;
            let error = driver
                .start_with(|message| {
                    let at = count;
                    count += 1;
                    if at == stage {
                        return if uncertain {
                            WriteStatus::PossiblyDelivered("broken pipe".into())
                        } else {
                            WriteStatus::NotWritten("broken pipe".into())
                        };
                    }
                    if message["method"] == "initialize" {
                        driver.observe(&json!({"id": 0, "result": {}}));
                    }
                    WriteStatus::Written
                })
                .unwrap_err();
            assert_eq!(count, stage + 1);
            assert_eq!(error.contains("delivery is unknown"), uncertain);
            assert!(driver.wait_ready().is_err());
            assert!(driver.start_with(|_| panic!("must not retry")).is_err());
        }
    }
}

#[test]
fn malformed_stdout_eof_and_exit_keep_the_first_failure() {
    for failure in ["malformed", "eof", "exit"] {
        let driver = CodexDriver::new(&params(None));
        assert!(driver
            .start_with(|_| {
                match failure {
                    "malformed" => driver.malformed("{not-json"),
                    "eof" => driver.stdout_closed(),
                    _ => {
                        driver.abandon("child exited");
                    }
                }
                WriteStatus::Written
            })
            .is_err());
        let original = driver.wait_ready().unwrap_err();
        driver.abandon("later exit");
        driver.observe(&json!({"id": 1, "result": {"thread": {"id": "late"}}}));
        assert_eq!(driver.wait_ready().unwrap_err(), original);
    }
}

#[test]
fn initialization_and_readiness_share_one_terminal_deadline() {
    let driver = CodexDriver::new(&params(None));
    launch(
        &driver,
        json!({"id": 0, "result": {}}),
        json!({"id": 99, "result": {}}),
    )
    .unwrap();
    lock(&driver.state).deadline = Instant::now();
    let error = driver.wait_ready().unwrap_err();
    assert!(error.contains("not ready"));
    driver.observe(&json!({"id": 1, "result": {"thread": {"id": "late"}}}));
    assert_eq!(driver.wait_ready().unwrap_err(), error);
}

#[test]
fn a_late_response_cannot_report_ready_before_the_waiter_runs() {
    let driver = CodexDriver::new(&params(None));
    launch(
        &driver,
        json!({"id": 0, "result": {}}),
        json!({"id": 99, "result": {}}),
    )
    .unwrap();
    lock(&driver.state).deadline = Instant::now();
    driver.observe(&json!({"id": 1, "result": {"thread": {"id": "late"}}}));
    assert!(driver
        .wait_ready()
        .unwrap_err()
        .contains("deadline expired"));
}

#[test]
fn duplicate_startup_responses_do_not_replace_ready_identity() {
    let driver = CodexDriver::new(&params(None));
    launch(
        &driver,
        json!({"id": 0, "result": {}}),
        json!({"id": 1, "result": {"thread": {"id": "new"}}}),
    )
    .unwrap();
    driver.observe(&json!({"id": 0, "error": {"message": "duplicate"}}));
    driver.observe(&json!({"id": 1, "result": {"thread": {"id": "other"}, "model": "other"}}));
    assert_eq!(driver.wait_ready().unwrap(), "new");
    assert_eq!(driver.model(), None);
}

#[test]
fn the_first_command_id_is_not_swallowed_as_a_startup_response() {
    let driver = CodexDriver::new(&params(None));
    launch(
        &driver,
        json!({"id": 0, "result": {}}),
        json!({"id": 1, "result": {"thread": {"id": "new"}}}),
    )
    .unwrap();
    let id = driver.reserve_command();
    assert!(id != INITIALIZE_ID && id != THREAD_ID);
    assert!(matches!(
        driver.observe(&json!({"id": id, "result": {}})).0,
        Observed::Forward
    ));
}

#[test]
fn thread_model_is_the_fallback_when_result_has_no_model() {
    let driver = CodexDriver::new(&params(None));
    launch(
        &driver,
        json!({"id": 0, "result": {}}),
        json!({"id": 1, "result": {"thread": {"id": "new", "model": "from-thread"}}}),
    )
    .unwrap();
    assert_eq!(driver.wait_ready().unwrap(), "new");
    assert_eq!(driver.model().as_deref(), Some("from-thread"));
}

/// Every startup line is JSON-RPC 2.0, initialize opts into the experimental
/// API as the in-process adapter does, and the thread request carries the
/// mode's policy from the shared contract, on start and on resume alike.
#[test]
fn startup_sends_jsonrpc_experimental_api_and_the_modes_policy() {
    for (mode, sandbox, reviewer) in [
        ("default", "workspace-write", "user"),
        ("plan", "read-only", "user"),
        ("auto", "workspace-write", "auto_review"),
    ] {
        for resume in [None, Some("existing")] {
            let mut spawn = params(resume);
            spawn.permission_mode = mode.into();
            let messages = CodexDriver::new(&spawn).startup_messages().unwrap();
            for message in &messages {
                assert_eq!(message["jsonrpc"], "2.0", "{message}");
            }
            assert_eq!(
                messages[0]["params"]["capabilities"]["experimentalApi"],
                true
            );
            let thread = &messages[2]["params"];
            assert_eq!(thread["approvalPolicy"], "on-request");
            assert_eq!(thread["approvalsReviewer"], reviewer, "{mode}");
            assert_eq!(thread["sandbox"], sandbox, "{mode}");
        }
    }
}

/// A mode the policy contract does not name fails startup before anything
/// is written: the child never runs on a guessed sandbox.
#[test]
fn an_unknown_mode_fails_startup_before_any_write() {
    let mut spawn = params(None);
    spawn.permission_mode = "bypassPermissions".into();
    let driver = CodexDriver::new(&spawn);
    let mut writes = 0;
    let error = driver
        .start_with(|_| {
            writes += 1;
            WriteStatus::Written
        })
        .unwrap_err();
    assert!(error.contains("no policy"), "{error}");
    assert_eq!(writes, 0);
    assert_eq!(driver.wait_ready().unwrap_err(), error);
}

/// Before the thread is ready a prompt is refused, never written, and
/// nothing ends a turn.
#[test]
fn prompts_wait_for_the_thread_and_nothing_ends_a_turn_before_it() {
    let driver = CodexDriver::new(&params(None));
    let error = driver.prompt_line("p1", &json!("hello")).unwrap_err();
    assert!(error.contains("not ready"), "{error}");
    assert!(driver.check_prompt(&json!("hello")).is_err());
    assert!(CodexDriver::RUNS_TURNS);
    assert!(!driver.ends_turn(&json!({"type": "result"})));
    assert!(!driver.ends_turn(&json!({"method": "turn/completed", "params": {}})));
}

/// A prompt whose `turn/start` line is over the child line cap could never be
/// written, so `check_prompt` (the gate `submit` runs before queueing or
/// journaling) refuses it, and a prompt exactly at the cap passes.
#[test]
fn a_prompt_over_the_line_cap_is_refused_before_anything_is_armed() {
    let driver = CodexDriver::new(&params(None));
    launch(
        &driver,
        json!({"id": INITIALIZE_ID, "result": {}}),
        json!({"id": THREAD_ID, "result": {"thread": {"id": "t-1"}}}),
    )
    .unwrap();
    let cap = crate::process::LINE_CAP;
    let probe = driver.prompt_line("probe", &json!("")).unwrap();
    // The check measures with the widest id (u64::MAX, 20 digits), so the
    // boundary sits `extra` bytes past what the next, narrower id writes.
    let id_width = probe["id"].to_string().len();
    let extra = u64::MAX.to_string().len() - id_width;
    let overhead = probe.to_string().len() + extra;
    let fits = "x".repeat(cap - overhead);
    driver.check_prompt(&json!(fits)).unwrap();
    let error = driver.check_prompt(&json!("x".repeat(cap - overhead + 1))).unwrap_err();
    assert!(error.contains("line limit"), "{error}");
    assert_eq!(
        driver.prompt_line("p1", &json!(fits)).unwrap().to_string().len(),
        cap - extra,
        "the check bounds the line the driver builds"
    );
}

/// A prompt becomes `turn/start` on the bound thread under the mode's turn
/// policy and the pinned model; a steer becomes `turn/steer` into the bound
/// turn, and only once that turn has an id.
#[test]
fn prompt_and_steer_lines_are_codex_turn_requests() {
    let driver = CodexDriver::new(&params(None));
    launch(
        &driver,
        json!({"id": INITIALIZE_ID, "result": {}}),
        json!({"id": THREAD_ID, "result": {"thread": {"id": "t-1"}}}),
    )
    .unwrap();
    assert_eq!(driver.wait_ready().unwrap(), "t-1");
    driver.check_prompt(&json!("hello")).unwrap();
    assert!(driver.check_prompt(&json!([{"type": "image"}])).is_err());

    let start = driver.prompt_line("p1", &json!("hello")).unwrap();
    assert_eq!(start["jsonrpc"], "2.0");
    assert_eq!(start["method"], "turn/start");
    assert_eq!(
        start["params"],
        json!({
            "threadId": "t-1",
            "input": [{"type": "text", "text": "hello"}],
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
            "sandboxPolicy": {"type": "workspaceWrite"},
            "model": "gpt-requested"
        })
    );
    let id = start["id"].as_u64().unwrap();
    assert!(id >= FIRST_COMMAND_ID);

    let early = driver.steer_line("p2", &json!("also")).unwrap_err();
    assert!(early.contains("stays queued"), "{early}");

    assert!(!driver.ends_turn(&json!({"id": id, "result": {"turn": {"id": "turn-9"}}})));
    let steer = driver.steer_line("p2", &json!("also")).unwrap();
    assert_eq!(steer["method"], "turn/steer");
    assert_eq!(
        steer["params"],
        json!({"threadId": "t-1", "expectedTurnId": "turn-9", "input": [{"type": "text", "text": "also"}]})
    );
    assert_eq!(
        driver.take_records(),
        vec![Body::Codex {
            codex: CodexRecord::TurnBound {
                prompt: "p1".into(),
                turn: "turn-9".into()
            }
        }]
    );
    assert!(driver.ends_turn(&json!({
        "method": "turn/completed",
        "params": {"threadId": "t-1", "turn": {"id": "turn-9"}}
    })));
}

#[test]
fn setters_change_only_later_prompt_snapshots() {
    let driver = CodexDriver::new(&params(None));
    launch(
        &driver,
        json!({"id": INITIALIZE_ID, "result": {}}),
        json!({"id": THREAD_ID, "result": {"thread": {"id": "t-1"}}}),
    )
    .unwrap();
    let before = driver.prompt_line("before", &json!("first")).unwrap();
    assert_eq!(before["params"]["model"], "gpt-requested");
    assert!(before["params"].get("effort").is_none());
    assert_eq!(before["params"]["approvalsReviewer"], "user");
    for setter in [
        json!({"type": "set_model", "model": "gpt-new"}),
        json!({"type": "set_effort", "level": "high"}),
        json!({"type": "set_permission_mode", "mode": "auto"}),
    ] {
        assert_eq!(driver.set_policy(&setter).0, Outcome::Applied);
    }
    let after = driver.prompt_line("after", &json!("second")).unwrap();
    assert_eq!(after["params"]["model"], "gpt-new");
    assert_eq!(after["params"]["effort"], "high");
    assert_eq!(after["params"]["approvalsReviewer"], "auto_review");
    assert_eq!(after["params"]["sandboxPolicy"]["type"], "workspaceWrite");
    let mut records = driver.dispatched("before", true);
    records.extend(driver.dispatched("after", true));
    assert_eq!(
        records,
        vec![
            Body::Codex {
                codex: CodexRecord::PromptPolicy {
                    prompt: "before".into(),
                    mode: "default".into(),
                    model: Some("gpt-requested".into()),
                    effort: None,
                }
            },
            Body::Codex {
                codex: CodexRecord::PromptPolicy {
                    prompt: "after".into(),
                    mode: "auto".into(),
                    model: Some("gpt-new".into()),
                    effort: Some("high".into()),
                }
            },
        ]
    );
    assert_eq!(
        driver
            .set_policy(&json!({"type": "set_effort", "level": "bogus"}))
            .0,
        Outcome::Failed
    );
    assert_eq!(
        driver
            .set_policy(&json!({"type": "set_permission_mode", "mode": "bypassPermissions"}))
            .0,
        Outcome::Failed
    );
}

#[test]
fn auto_review_downgrades_when_thread_reports_user_reviewer() {
    let mut spawn = params(None);
    spawn.permission_mode = "auto".into();
    let driver = CodexDriver::new(&spawn);
    launch(
        &driver,
        json!({"id":0,"result":{}}),
        json!({"id":1,"result":{"thread":{"id":"t-1"},"approvalsReviewer":"user"}}),
    )
    .unwrap();
    assert_eq!(driver.permission_mode(), "default");
    assert_eq!(
        driver.take_records(),
        vec![Body::PermissionModeChanged {
            mode: "default".into()
        }]
    );
    assert_eq!(
        driver.prompt_line("p", &json!("hello")).unwrap()["params"]["approvalsReviewer"],
        "user"
    );
}

#[test]
fn auto_review_retries_a_reviewer_refusal_once_as_default() {
    let mut spawn = params(None);
    spawn.permission_mode = "auto".into();
    let driver = CodexDriver::new(&spawn);
    let mut reviewers = Vec::new();
    driver.start_with(|line| {
        match line["method"].as_str().unwrap() {
            "initialize" => { driver.observe(&json!({"id":0,"result":{}})); }
            "thread/start" => {
                reviewers.push(line["params"]["approvalsReviewer"].clone());
                if reviewers.len() == 1 {
                    driver.observe(&json!({"id":1,"error":{"message":"approval reviewer unavailable"}}));
                } else {
                    driver.observe(&json!({"id":1,"result":{"thread":{"id":"t-1"},"approvalsReviewer":"user"}}));
                }
            }
            "initialized" => {}
            method => panic!("unexpected {method}"),
        }
        WriteStatus::Written
    }).unwrap();
    assert_eq!(reviewers, vec![json!("auto_review"), json!("user")]);
    assert_eq!(driver.wait_ready().unwrap(), "t-1");
    assert_eq!(
        driver.take_records(),
        vec![Body::PermissionModeChanged {
            mode: "default".into()
        }]
    );
}

#[test]
fn a_turn_reviewer_refusal_downgrades_the_next_prompt() {
    let mut spawn = params(None);
    spawn.permission_mode = "auto".into();
    let driver = CodexDriver::new(&spawn);
    launch(
        &driver,
        json!({"id":0,"result":{}}),
        json!({"id":1,"result":{"thread":{"id":"t-1"},"approvalsReviewer":"auto_review"}}),
    )
    .unwrap();
    let first = driver.prompt_line("p1", &json!("hello")).unwrap();
    assert_eq!(first["params"]["approvalsReviewer"], "auto_review");
    assert!(
        driver.ends_turn(&json!({"id":first["id"],"error":{"message":"approval reviewer failed"}}))
    );
    assert_eq!(driver.permission_mode(), "default");
    assert_eq!(
        driver.prompt_line("p2", &json!("again")).unwrap()["params"]["approvalsReviewer"],
        "user"
    );
    assert!(driver
        .take_records()
        .contains(&Body::PermissionModeChanged {
            mode: "default".into()
        }));
}
