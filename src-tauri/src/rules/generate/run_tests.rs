//! Tests for `run.rs`: argv and env vectors, the parsers on fixtures shaped from the W0 probe run
//! (`runtime\probe-generate\20261017-205314\result.json`: key lists, event types, the two auth signatures; ids and
//! text are made up, no token-like string), the classification table and the capped child run.

use std::ffi::OsString;

use super::*;

#[test]
fn claude_argv_is_the_probed_vector() {
    let got = claude_argv("claude-sonnet-5-5", "medium", Path::new(r"C:\H\gen-claude\skill.md"));
    let want: Vec<&str> = vec![
        "-p",
        "--model",
        "claude-sonnet-5-5",
        "--effort",
        "medium",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--tools",
        "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--system-prompt-file",
        r"C:\H\gen-claude\skill.md",
    ];
    assert_eq!(got, want);
    assert!(!got.iter().any(|a| a.contains("max-budget")));
}

#[test]
fn codex_argv_is_the_probed_vector() {
    let got = codex_argv("gpt-5.5", "high", Path::new(r"C:\H\gen-codex\work\0a1b2c3d"));
    let want: Vec<&str> = vec![
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "-c",
        "approval_policy=\"never\"",
        "-c",
        "model=\"gpt-5.5\"",
        "-c",
        "model_reasoning_effort=\"high\"",
        "--skip-git-repo-check",
        "--ephemeral",
        "-C",
        r"C:\H\gen-codex\work\0a1b2c3d",
        "-",
    ];
    assert_eq!(got, want);
}

fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
}

fn get<'a>(env: &'a [(OsString, OsString)], name: &str) -> Option<&'a OsString> {
    env.iter().find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case(name)).map(|(_, v)| v)
}

fn parent() -> Vec<(OsString, OsString)> {
    os(&[
        ("Path", r"C:\Windows;C:\Tools"),
        ("SystemRoot", r"C:\Windows"),
        ("USERPROFILE", r"C:\Users\someone"),
        ("TEMP", r"C:\Users\someone\AppData\Local\Temp"),
        ("ANTHROPIC_API_KEY", "x"),
        ("anthropic_base_url", "x"),
        ("CLAUDECODE", "1"),
        ("CLAUDE_CONFIG_DIR", r"C:\Users\someone\.claude"),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
        ("CODEX_HOME", r"C:\Users\someone\.codex"),
        ("CODEX_SANDBOX", "1"),
        ("OPENAI_API_KEY", "x"),
        ("VIDAR_TAB", "t1"),
        ("VIDAR_AGENT_HOME", "x"),
        ("FALCON_SESSION", "s1"),
        ("DISABLE_AUTOUPDATER", "0"),
    ])
}

#[test]
fn the_env_drops_every_scrubbed_prefix_and_sets_the_home_vars() {
    let home = Path::new(r"C:\H\gen-claude");
    let env = child_env(parent(), "claude", home);
    let names: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().to_ascii_uppercase()).collect();
    for dropped in
        ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_HOME", "CODEX_SANDBOX", "OPENAI_API_KEY", "VIDAR_TAB", "VIDAR_AGENT_HOME", "FALCON_SESSION"]
    {
        assert!(!names.contains(&dropped.to_string()), "{dropped} survived");
    }
    assert_eq!(get(&env, "Path").unwrap(), r"C:\Windows;C:\Tools");
    assert_eq!(get(&env, "SystemRoot").unwrap(), r"C:\Windows");
    let want = [
        ("CLAUDE_CONFIG_DIR", r"C:\H\gen-claude\config"),
        ("DISABLE_AUTOUPDATER", "1"),
        ("USERPROFILE", r"C:\H\gen-claude\user-home"),
        ("HOME", r"C:\H\gen-claude\user-home"),
        ("APPDATA", r"C:\H\gen-claude\user-home\AppData\Roaming"),
        ("LOCALAPPDATA", r"C:\H\gen-claude\user-home\AppData\Local"),
        ("TEMP", r"C:\H\gen-claude\user-home\AppData\Local\Temp"),
        ("TMP", r"C:\H\gen-claude\user-home\AppData\Local\Temp"),
    ];
    for (k, v) in want {
        assert_eq!(get(&env, k).unwrap(), v, "{k}");
    }
    // One entry per name, whatever the parent's spelling.
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), names.len());
    assert!(get(&env, "CODEX_HOME").is_none());
}

#[test]
fn the_codex_env_sets_codex_home_and_no_claude_vars() {
    let env = child_env(parent(), "codex", Path::new(r"C:\H\gen-codex"));
    assert_eq!(get(&env, "CODEX_HOME").unwrap(), r"C:\H\gen-codex\config");
    assert_eq!(get(&env, "USERPROFILE").unwrap(), r"C:\H\gen-codex\user-home");
    assert!(get(&env, "CLAUDE_CONFIG_DIR").is_none() && get(&env, "DISABLE_AUTOUPDATER").is_none() && get(&env, "ANTHROPIC_API_KEY").is_none());
    assert!(get(&env, "CODEX_SANDBOX").is_none() && get(&env, "OPENAI_API_KEY").is_none());
}

const CLAUDE_OK: &str = r#"{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":2066,"duration_api_ms":1900,"num_turns":1,"result":"{\"runes\":[],\"sections\":[],\"dropped\":[]}","stop_reason":"end_turn","session_id":"00000000-0000-0000-0000-000000000000","total_cost_usd":0.008166,"usage":{"input_tokens":1234,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":567,"service_tier":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"completed","uuid":"00000000-0000-0000-0000-000000000001"}"#;
const CLAUDE_AUTH: &str = r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":null,"duration_ms":10,"duration_api_ms":0,"num_turns":1,"result":"Not logged in · Please run /login","stop_reason":"stop_sequence","session_id":"00000000-0000-0000-0000-000000000000","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{},"permission_denials":[],"terminal_reason":"completed","uuid":"00000000-0000-0000-0000-000000000002"}"#;
const CODEX_OK: &str = concat!(
    "{\"type\":\"thread.started\",\"thread_id\":\"00000000-0000-0000-0000-000000000003\"}\n",
    "{\"type\":\"turn.started\"}\n",
    "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"reasoning\",\"text\":\"thinking\"}}\n",
    "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"{\\\"count\\\":40}\"}}\n",
    "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":2100,\"cached_input_tokens\":0,\"cache_write_input_tokens\":0,\"output_tokens\":321,\"reasoning_output_tokens\":12}}\n",
);
const CODEX_AUTH: &str = concat!(
    "{\"type\":\"thread.started\",\"thread_id\":\"00000000-0000-0000-0000-000000000004\"}\n",
    "{\"type\":\"turn.started\"}\n",
    "{\"type\":\"error\",\"message\":\"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.example.test/v1/responses)\"}\n",
    "{\"type\":\"turn.failed\",\"error\":{\"message\":\"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header\"}}\n",
);

fn raw(exit: Option<i32>, stdout: &str, stderr: &str) -> Raw {
    Raw { exit, stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec(), ..Raw::default() }
}

#[test]
fn the_claude_parser_reads_result_cost_and_usage() {
    let r = classify("claude", &raw(Some(0), CLAUDE_OK, "")).unwrap();
    assert_eq!(r.text, r#"{"runes":[],"sections":[],"dropped":[]}"#);
    assert_eq!((r.cost_usd, r.input_tokens, r.output_tokens), (Some(0.008166), Some(1234), Some(567)));
}

#[test]
fn the_codex_parser_reads_the_last_agent_message_and_usage() {
    let r = classify("codex", &raw(Some(0), CODEX_OK, "WARN noise on stderr")).unwrap();
    assert_eq!(r, Reply { text: "{\"count\":40}".into(), cost_usd: None, input_tokens: Some(2100), output_tokens: Some(321) });
}

#[test]
fn the_classification_table() {
    // exit 0, good JSON.
    assert!(classify("claude", &raw(Some(0), CLAUDE_OK, "")).is_ok());
    // exit 1 with the auth JSON: login.
    assert_eq!(classify("claude", &raw(Some(1), CLAUDE_AUTH, "")).unwrap_err().split(':').next(), Some("login"));
    assert_eq!(classify("codex", &raw(Some(1), CODEX_AUTH, "ERROR 401 Unauthorized")).unwrap_err().split(':').next(), Some("login"));
    // exit 1 any other way: spawn.
    let other = CLAUDE_AUTH.replace("Not logged in · Please run /login", "Credit balance is too low");
    for (agent, r) in [
        ("claude", raw(Some(1), &other, "")),
        ("claude", raw(Some(1), "", "boom")),
        ("claude", raw(Some(1), "not json", "")),
        ("codex", raw(Some(2), "{\"type\":\"turn.failed\",\"error\":{\"message\":\"model overloaded\"}}\n", "")),
        ("codex", raw(Some(1), "", "ERROR something")),
        ("claude", raw(None, "", "")),
    ] {
        let e = classify(agent, &r).unwrap_err();
        assert!(e.starts_with("spawn: "), "{agent}: {e}");
    }
    // garbage on exit 0: output.
    for (agent, r) in [
        ("claude", raw(Some(0), "garbage", "")),
        ("claude", raw(Some(0), "[1,2]", "")),
        ("claude", raw(Some(0), "{\"is_error\":false}", "")),
        ("claude", raw(Some(0), &CLAUDE_AUTH.replace("Not logged in · Please run /login", "Oops"), "")),
        ("codex", raw(Some(0), "garbage", "")),
        ("codex", raw(Some(0), "{\"type\":\"turn.completed\",\"usage\":{}}\n", "")),
    ] {
        let e = classify(agent, &r).unwrap_err();
        assert!(e.starts_with("output: "), "{agent}: {e}");
    }
    // over the cap: output; timeout wins over everything.
    let over = Raw { overflow: Some("stdout"), ..raw(Some(1), "", "") };
    assert!(classify("claude", &over).unwrap_err().starts_with("output: stdout went over 4 MB"));
    let late = Raw { timed_out: true, ..raw(Some(1), CLAUDE_OK, "") };
    assert!(classify("claude", &late).unwrap_err().starts_with("timeout"));
}

/// A Claude `-p` JSON result with `is_error` and `text` as its `result`.
fn claude_error(text: &str) -> String {
    serde_json::json!({ "type": "result", "is_error": true, "result": text, "total_cost_usd": 0.0 }).to_string()
}

#[test]
fn a_refused_login_is_login_for_both_agents() {
    // Claude Code's wordings for an expired, revoked or rotated login (inferred from its known messages: the
    // 2026-10-25 run's text was not kept).
    for text in [
        "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth token has expired. Please obtain a new token or refresh your existing token.\"}}",
        "OAuth token revoked · Please run /login",
        "Invalid API key · Please run /login",
        "OAuth error: invalid_grant: refresh token not found or invalid",
    ] {
        for exit in [Some(1), Some(0)] {
            let e = classify("claude", &raw(exit, &claude_error(text), "")).unwrap_err();
            assert_eq!(e, "login: Claude's login has expired or was revoked; log in on a Bare Claude tab first", "{text}");
        }
    }
    // No JSON at all: stderr decides.
    let e = classify("claude", &raw(Some(1), "", "OAuth token has expired")).unwrap_err();
    assert!(e.starts_with("login: Claude's login has expired"), "{e}");
    // "Not logged in" keeps its own text.
    assert_eq!(classify("claude", &raw(Some(1), CLAUDE_AUTH, "")).unwrap_err(), "login: Claude is not logged in; log in on a Bare Claude tab first");
    // Codex: a refused refresh in a failure event, or on stderr when no event says why.
    let refused = "{\"type\":\"turn.failed\",\"error\":{\"message\":\"Your access token could not be refreshed: refresh_token_reused. Please log out and sign in again.\"}}\n";
    let e = classify("codex", &raw(Some(1), refused, "")).unwrap_err();
    assert_eq!(e, "login: Codex's login has expired or was revoked; log in on a Bare Codex tab first");
    assert!(classify("codex", &raw(Some(1), "", "error: invalid_grant")).unwrap_err().starts_with("login: Codex's login"));
    // Not an auth failure: still spawn.
    for (agent, r) in [
        ("claude", raw(Some(1), &claude_error("Credit balance is too low"), "")),
        ("claude", raw(Some(1), &claude_error("API Error: 500 Internal server error"), "")),
        ("codex", raw(Some(1), "{\"type\":\"turn.failed\",\"error\":{\"message\":\"model overloaded\"}}\n", "")),
    ] {
        assert!(classify(agent, &r).unwrap_err().starts_with("spawn: "), "{agent}");
    }
}

#[test]
fn a_timeout_keeps_the_stream_tails_tokens_and_stop_reason() {
    let long = "x".repeat(500);
    let r = Raw { timed_out: true, ..raw(None, &format!("partial\n{long}"), "warn: slow\nsecond line") };
    let e = classify("claude", &r).unwrap_err();
    assert!(e.starts_with("timeout: stdout tail: …"), "{e}");
    assert!(e.contains("; stderr tail: warn: slow second line") && !e.contains('\n'), "{e}");
    assert!(!e.contains(&"x".repeat(301)), "{e}");
    let json = r#"{"type":"result","stop_reason":"max_tokens","usage":{"output_tokens":77}}"#;
    let e = classify("claude", &Raw { timed_out: true, ..raw(None, json, "") }).unwrap_err();
    assert!(e.contains("output tokens: 77") && e.contains("stop reason: max_tokens"), "{e}");
    assert_eq!(classify("claude", &Raw { timed_out: true, ..raw(None, "", "") }), Err("timeout: no output".into()));
}

#[test]
fn stop_ends_a_child_within_about_a_second() {
    let job = Job::new().unwrap();
    let flag = Arc::new(AtomicBool::new(false));
    let raiser = flag.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        raiser.store(true, Ordering::SeqCst);
    });
    let start = Instant::now();
    let raw = execute_until(&cmd_spec(&["/c", "ping -n 60 127.0.0.1 >nul"], ""), &job, Duration::from_secs(30), OUT_CAP, || flag.load(Ordering::SeqCst)).unwrap();
    assert!(raw.cancelled && !raw.timed_out);
    assert!(start.elapsed() < Duration::from_millis(1500), "{:?}", start.elapsed());
    assert_eq!(classify("claude", &raw), Err("cancelled".into()));
}

#[test]
fn error_text_is_one_capped_line() {
    let long = format!("{{\"is_error\":true,\"result\":\"{}\"}}", "x ".repeat(500));
    let e = classify("claude", &raw(Some(1), &long, "")).unwrap_err();
    assert!(e.starts_with("spawn: claude ended with exit code 1: ") && e.chars().count() < 400 && !e.contains('\n'), "{e}");
}

fn cmd_spec(args: &[&str], stdin: &str) -> Spec {
    let sys = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    Spec {
        program: sys.join("System32").join("cmd.exe"),
        args: args.iter().map(|s| s.to_string()).collect(),
        // No inherited Path: `sort` and `ping` are found through the one entry given.
        env: vec![(OsString::from("SystemRoot"), sys.clone().into_os_string()), (OsString::from("Path"), sys.join("System32").into_os_string())],
        cwd: std::env::temp_dir(),
        config: None,
        stdin: stdin.to_string(),
    }
}

#[test]
fn execute_refuses_an_instruction_file_in_the_config_dir_or_cwd_before_spawning() {
    let job = Job::new().unwrap();
    let base = std::env::temp_dir().join(format!("vidar-run-clean-{}", std::process::id()));
    let (config, cwd) = (base.join("config"), base.join("work"));
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let mut spec = cmd_spec(&["/c", "exit 0"], "");
    (spec.config, spec.cwd) = (Some(config.clone()), cwd.clone());
    assert!(execute(&spec, &job, Duration::from_secs(30), OUT_CAP).is_ok());
    std::fs::write(config.join("AGENTS.md"), "# planted").unwrap();
    assert_eq!(execute(&spec, &job, Duration::from_secs(30), OUT_CAP).unwrap_err(), "spawn: generator home holds AGENTS.md");
    std::fs::remove_file(config.join("AGENTS.md")).unwrap();
    std::fs::write(cwd.join("CLAUDE.md"), "# planted").unwrap();
    assert_eq!(execute(&spec, &job, Duration::from_secs(30), OUT_CAP).unwrap_err(), "spawn: generator home holds CLAUDE.md");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn execute_feeds_stdin_and_captures_both_streams() {
    let job = Job::new().unwrap();
    // `sort` echoes stdin (sorted); the stderr line comes from the redirected echo.
    let raw = execute(&cmd_spec(&["/c", "sort & echo oops 1>&2 & exit 3"], "alpha\nbeta\n"), &job, Duration::from_secs(30), OUT_CAP).unwrap();
    assert_eq!(raw.exit, Some(3));
    assert!(String::from_utf8_lossy(&raw.stdout).contains("alpha") && String::from_utf8_lossy(&raw.stdout).contains("beta"));
    assert!(String::from_utf8_lossy(&raw.stderr).contains("oops"));
    assert!(raw.overflow.is_none() && !raw.timed_out);
}

#[test]
fn execute_ends_a_child_past_the_timeout() {
    let job = Job::new().unwrap();
    let start = Instant::now();
    let raw = execute(&cmd_spec(&["/c", "ping -n 60 127.0.0.1 >nul"], ""), &job, Duration::from_millis(400), OUT_CAP).unwrap();
    assert!(raw.timed_out);
    assert!(start.elapsed() < Duration::from_secs(20));
    assert!(classify("claude", &raw).unwrap_err().starts_with("timeout"));
}

#[test]
fn execute_ends_a_child_that_overflows_the_cap() {
    let job = Job::new().unwrap();
    let raw = execute(&cmd_spec(&["/c", "for /L %i in (1,1,100000) do @echo 0123456789012345678901234567890123456789"], ""), &job, Duration::from_secs(60), 1000).unwrap();
    assert_eq!(raw.overflow, Some("stdout"));
    assert_eq!(raw.stdout.len(), 1000);
    assert!(classify("codex", &raw).unwrap_err().starts_with("output: "));
}

#[test]
fn a_missing_program_is_a_spawn_error() {
    let job = Job::new().unwrap();
    let mut spec = cmd_spec(&[], "");
    spec.program = PathBuf::from(r"C:\definitely\not\here.exe");
    assert!(execute(&spec, &job, Duration::from_secs(5), OUT_CAP).unwrap_err().starts_with("spawn: "));
}
