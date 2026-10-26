//! Unit tests for `process.rs`, kept out of line so the module file holds only
//! production code.

use super::*;

fn split(line: &str) -> Vec<String> {
    // Round-trip through the same parser Windows uses for a child's argv.
    use windows::Win32::UI::Shell::CommandLineToArgvW;
    let wide = super::wide(std::ffi::OsStr::new(line));
    let mut count = 0i32;
    let argv = unsafe { CommandLineToArgvW(PCWSTR(wide.as_ptr()), &mut count) };
    assert!(!argv.is_null());
    let mut out = Vec::new();
    for index in 0..count as usize {
        let pointer = unsafe { *argv.add(index) };
        out.push(unsafe { pointer.to_string().unwrap() });
    }
    unsafe {
        let _ = windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            argv.cast(),
        )));
    }
    out
}

#[test]
fn arguments_round_trip_through_windows_parsing() {
    let program = Path::new(r"C:\Program Files\node\node.exe");
    let args = vec![
        r"C:\Work\Example\tools\claude-sidecar.mjs".to_string(),
        "--cwd".to_string(),
        r"C:\path with spaces\".to_string(),
        r#"a "quoted" value"#.to_string(),
        "trailing\\\\".to_string(),
        String::new(),
    ];
    let line = command_line(program, &args);
    let text = String::from_utf16(&line[..line.len() - 1]).unwrap();
    let parsed = split(&text);
    assert_eq!(parsed[0], program.to_string_lossy());
    assert_eq!(&parsed[1..], args.as_slice());
}

#[test]
fn environment_block_is_sorted_and_scrubbed() {
    std::env::set_var("VIDAR_TAB", "should-be-removed");
    std::env::set_var("VIDAR_TAB_NAME", "should-be-removed");
    std::env::set_var("FALCON_TEST_ZZZ", "z");
    let block = environment_block(EnvBase::Inherit, &[("FALCON_TEST_AAA".into(), "a".into())]);
    let text = String::from_utf16(&block).unwrap();
    let entries: Vec<&str> = text.split('\0').filter(|s| !s.is_empty()).collect();
    assert!(entries.iter().all(|e| !e.starts_with("VIDAR_TAB=")));
    assert!(entries.iter().all(|e| !e.starts_with("VIDAR_TAB_NAME=")));
    assert!(entries.contains(&"FALCON_TEST_AAA=a"));
    assert!(entries.contains(&"FALCON_TEST_ZZZ=z"));
    let upper: Vec<String> = entries
        .iter()
        .map(|e| {
            // A per-drive entry's name is "=C:", so the split must skip the
            // leading '=' rather than yield an empty name.
            let split = e[1..].find('=').map(|i| i + 1).unwrap_or(e.len());
            e[..split].to_uppercase()
        })
        .collect();
    let mut sorted = upper.clone();
    sorted.sort();
    assert_eq!(upper, sorted, "CreateProcessW requires sorted names");
    assert_eq!(block[block.len() - 1], 0);
}

/// A bare (allowlist) spawn: every name on the contract's drop list is gone even when Falcon
/// carries it, the `=X:` entries and allowlisted names stay, Falcon's scrub still applies, and
/// the profile overlay plus the per-session additions land on top.
#[test]
fn the_allowlist_base_drops_every_drop_name_and_keeps_drive_entries() {
    let os = |k: &str, v: &str| (OsString::from(k), OsString::from(v));
    let mut inherited = vec![
        os("=C:", r"C:\Work"),
        os("=D:", r"D:\x"),
        os("Path", r"C:\Windows"),
        os("SystemRoot", r"C:\Windows"),
        os("TERM", "xterm"),
        os("USERPROFILE", r"C:\Users\testuser"),
        os("VIDAR_TAB", "stale"),
        os("FALCON_SESSION", "stale"),
        os("CLAUDECODE", "1"),
    ];
    for d in &crate::bare_env::contract().drop {
        inherited.push(os(&d.replace('*', "SESSION_ID"), "inherited"));
    }
    let additions = vec![
        ("USERPROFILE".to_string(), r"X:\h\user-home".to_string()),
        ("CLAUDE_CONFIG_DIR".to_string(), r"X:\h\claude-config".to_string()),
        ("FALCON_SESSION".to_string(), "s1".to_string()),
    ];
    let entries = environment_entries(EnvBase::Allowlist, inherited.clone(), &additions);
    let get = |n: &str| entries.get(&n.to_uppercase()).map(|(_, v)| v.to_string_lossy().into_owned());
    for d in &crate::bare_env::contract().drop {
        let name = d.replace('*', "SESSION_ID");
        if name.eq_ignore_ascii_case("CLAUDE_CONFIG_DIR") {
            assert_eq!(get(&name).as_deref(), Some(r"X:\h\claude-config"), "only the overlay's config dir");
        } else {
            assert!(get(&name).is_none(), "{name} survived the bare env");
        }
    }
    assert_eq!(get("=C:").as_deref(), Some(r"C:\Work"));
    assert!(get("=D:").is_some() && get("Path").is_some() && get("SystemRoot").is_some());
    assert_eq!(get("USERPROFILE").as_deref(), Some(r"X:\h\user-home"));
    assert_eq!(get("FALCON_SESSION").as_deref(), Some("s1"));
    for gone in ["TERM", "VIDAR_TAB", "CLAUDECODE"] {
        assert!(get(gone).is_none(), "{gone} reached a bare child");
    }
    // The same inherited env under the default base keeps what the allowlist drops.
    let inherit = environment_entries(EnvBase::Inherit, inherited, &[]);
    assert!(inherit.contains_key("ANTHROPIC_AUTH_TOKEN"));
}

/// Regression for the slice-1 live failure: an explicit environment block
/// that drops Windows' per-drive current directories (`=C:=C:\path`) kills
/// node before it runs a line, because those entries are how a bare `C:`
/// resolves.
///
/// This test asserts only the property that matters — they reach the child.
/// It deliberately does NOT assert anything about `std::env::vars_os`: an
/// earlier version did, claiming that function omits them, and that claim
/// was false. It held under Git Bash (which strips them from the
/// environment it hands on) and failed under PowerShell (which does not),
/// so the test passed or failed depending on which shell launched cargo.
/// The original defect was never `vars_os` hiding them; it was this
/// module's own filter skipping any name starting with '='.
#[test]
fn per_drive_current_directories_survive_into_the_child() {
    let raw = current_environment();
    let per_drive: Vec<&(OsString, OsString)> = raw
        .iter()
        .filter(|(name, _)| name.to_string_lossy().starts_with('='))
        .collect();
    if per_drive.is_empty() {
        // Windows only materialises these once a process has a per-drive
        // cwd, and some shells strip them before launching a child. With
        // none present there is nothing for this test to prove.
        return;
    }

    let block = environment_block(EnvBase::Inherit, &[]);
    let text = String::from_utf16(&block).unwrap();
    for (name, _) in per_drive {
        let prefix = format!("{}=", name.to_string_lossy());
        assert!(
            text.split('\0').any(|entry| entry.starts_with(&prefix)),
            "per-drive entry {prefix} was dropped from the child's environment"
        );
    }
}

/// `node` rather than `cmd`: `cmd /c` takes its tail raw instead of using
/// `CommandLineToArgvW` rules, and node is what Falcon actually spawns.
fn node_request(script: &str) -> SpawnRequest {
    SpawnRequest {
        program: find_on_path("node").expect("node on PATH"),
        args: vec!["-e".into(), script.into()],
        cwd: std::env::temp_dir(),
        env: Vec::new(),
        env_base: EnvBase::Inherit,
    }
}

fn drain(reader: &PipeReader) -> (Vec<String>, Vec<usize>) {
    let mut lines = Vec::new();
    let mut overflows = Vec::new();
    reader
        .for_each_line(|line| lines.push(line.to_string()), |n| overflows.push(n))
        .expect("read pipe");
    (lines, overflows)
}

#[test]
fn spawn_round_trips_stdin_and_stdout() {
    let (child, output) = spawn(&node_request(
        "process.stdin.on('data',d=>process.stdout.write('echo:'+d));",
    ))
    .expect("spawn");
    child.write_line("hello").expect("write");
    child.close_stdin();
    let (lines, overflows) = drain(&output.stdout);
    assert_eq!(lines, vec!["echo:hello".to_string()]);
    assert!(overflows.is_empty());
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(0));
    assert_ne!(child.pid(), 0);
    assert_ne!(child.created_100ns(), 0);
}

/// Reproduces the slice-1 live failure: node received a main path it could
/// not resolve. Asserts on what the child actually parses out of the line.
#[test]
fn a_realistic_sidecar_argument_list_reaches_the_child_intact() {
    let script = r"C:\Work\Example\bridge\falcon\bundles\0.1.0-eb81bee1-d5d98120-3ecde6bb\sidecar\claude-sidecar.mjs";
    let args = vec![
        script.to_string(),
        "--falcon".to_string(),
        "--cwd".to_string(),
        r"C:\Users\testuser\AppData\Local\Temp\falcon\session".to_string(),
        "--permission-mode".to_string(),
        "default".to_string(),
        "--claude".to_string(),
        r"C:\Work\Example\bridge\falcon\store\claude\97164b20\claude.exe".to_string(),
        "--model".to_string(),
        "haiku".to_string(),
    ];
    let line = command_line(Path::new(r"C:\Program Files\nodejs\node.exe"), &args);
    let text = String::from_utf16(&line[..line.len() - 1]).unwrap();
    let parsed = split(&text);
    assert_eq!(
        parsed[1], script,
        "the script path the child parses out must be byte-identical\nline was: {text}"
    );
    assert_eq!(&parsed[1..], args.as_slice(), "line was: {text}");
}

/// The slice-1 live failure, reduced: every earlier spawn test used
/// `node -e`, which never calls `resolveMainPath`. Running a real script
/// *path* is what actually exercised the bug.
#[test]
fn node_runs_a_script_given_by_absolute_path() {
    let dir = std::env::temp_dir().join(format!("falcon-mainpath-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("probe.mjs");
    std::fs::write(&script, b"console.log('main-path-ok');\n").unwrap();

    let request = SpawnRequest {
        program: find_on_path("node").expect("node on PATH"),
        args: vec![script.to_string_lossy().into_owned()],
        cwd: dir.clone(),
        env: Vec::new(),
        env_base: EnvBase::Inherit,
    };
    let (child, output) = spawn(&request).expect("spawn");
    let mut lines = Vec::new();
    let mut errors = Vec::new();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let _ = output
                .stderr
                .for_each_line(|line| errors.push(line.to_string()), |_| {});
        });
        let _ = output
            .stdout
            .for_each_line(|line| lines.push(line.to_string()), |_| {});
    });
    let code = wait_for(&child, Duration::from_secs(20));
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(
        lines,
        vec!["main-path-ok".to_string()],
        "exit={code:?}\nstderr:\n{}",
        errors.join("\n")
    );
}

/// The slice-1 live failure and its guard. `std::fs::canonicalize` returns a
/// verbatim `\\?\C:\...` path; the node of that time mis-parsed that root in
/// `realpathSync`, called `lstat` on the bare drive letter and died with
/// `EISDIR`. Node 24.22.1 (installed 2026-10-20) runs the same path fine, so
/// whether the raw verbatim path fails depends on the node on PATH. What must
/// hold on every node is the guard: `plain_path` of the canonical path runs.
#[test]
fn node_runs_a_canonical_script_once_plain_path_strips_it() {
    let dir = std::env::temp_dir().join(format!("falcon-verbatim-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("probe.mjs");
    std::fs::write(&script, b"console.log('verbatim-ok');\n").unwrap();

    let canonical = std::fs::canonicalize(&script).unwrap();
    assert!(
        canonical.to_string_lossy().starts_with(r"\\?\"),
        "canonicalize is expected to produce a verbatim path here, got {}",
        canonical.display()
    );

    let run = |path: &Path| -> (Vec<String>, Vec<String>) {
        let request = SpawnRequest {
            program: find_on_path("node").expect("node on PATH"),
            args: vec![path.to_string_lossy().into_owned()],
            cwd: dir.clone(),
            env: Vec::new(),
            env_base: EnvBase::Inherit,
        };
        let (child, output) = spawn(&request).expect("spawn");
        let mut lines = Vec::new();
        let mut errors = Vec::new();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let _ = output
                    .stderr
                    .for_each_line(|line| errors.push(line.to_string()), |_| {});
            });
            let _ = output
                .stdout
                .for_each_line(|line| lines.push(line.to_string()), |_| {});
        });
        let _ = wait_for(&child, Duration::from_secs(20));
        (lines, errors)
    };

    let (plain, _) = run(&script);
    assert_eq!(
        plain,
        vec!["verbatim-ok".to_string()],
        "plain path must work"
    );

    let (stripped, _) = run(&plain_path(&canonical));
    let (verbatim, errors) = run(&canonical);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(
        stripped,
        vec!["verbatim-ok".to_string()],
        "plain_path of the canonical path must work on every node"
    );
    // Older node: the live EISDIR failure. Newer node: runs the script. Any
    // third outcome is a new node behaviour and needs a look.
    let old_failure = verbatim.is_empty() && errors.iter().any(|line| line.contains("EISDIR"));
    let runs = verbatim == vec!["verbatim-ok".to_string()];
    assert!(
        old_failure || runs,
        "the raw verbatim path neither ran nor hit the known EISDIR failure; \
         stdout={verbatim:?} stderr={errors:?}"
    );
}

#[test]
fn plain_path_strips_only_what_it_safely_can() {
    assert_eq!(
        plain_path(Path::new(r"\\?\C:\Work\Example")),
        PathBuf::from(r"C:\Work\Example")
    );
    assert_eq!(
        plain_path(Path::new(r"\\?\UNC\server\share\file")),
        PathBuf::from(r"\\server\share\file")
    );
    // Already plain: untouched.
    assert_eq!(
        plain_path(Path::new(r"C:\Work\Example")),
        PathBuf::from(r"C:\Work\Example")
    );
    // Too long for a plain path: the prefix is load-bearing, so keep it.
    let long = format!(r"\\?\C:\{}", "x".repeat(300));
    assert_eq!(plain_path(Path::new(&long)), PathBuf::from(&long));
}

#[test]
fn scrubbed_names_do_not_reach_the_child() {
    std::env::set_var("CLAUDE_CODE_ENTRYPOINT", "vidar-test");
    let mut request = node_request(
        "console.log(JSON.stringify([process.env.CLAUDE_CODE_ENTRYPOINT??null,process.env.FALCON_SESSION??null]));",
    );
    request.env.push(("FALCON_SESSION".into(), "s-1".into()));
    let (child, output) = spawn(&request).expect("spawn");
    let (lines, _) = drain(&output.stdout);
    assert_eq!(lines, vec![r#"[null,"s-1"]"#.to_string()]);
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(0));
}

/// The Codex-child path: no `FALCON_SESSION` addition, so only the scrub keeps
/// the parent's (a Falcon started from a hosted session) out of the child.
#[test]
fn an_inherited_falcon_session_does_not_reach_the_child() {
    std::env::set_var("FALCON_SESSION", "s-parent");
    let request = node_request("console.log(JSON.stringify(process.env.FALCON_SESSION??null));");
    assert!(request.env.iter().all(|(name, _)| name != "FALCON_SESSION"));
    let (child, output) = spawn(&request).expect("spawn");
    let (lines, _) = drain(&output.stdout);
    assert_eq!(lines, vec!["null".to_string()]);
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(0));
}

/// The five names added with the pty mirror (colour and terminal hints, the root
/// and the WebView2 args) are scrubbed too, not only the session markers.
#[test]
fn the_terminal_and_root_names_do_not_reach_the_child() {
    let names = [
        "NO_COLOR",
        "TERM",
        "COLORTERM",
        "VIDAR_ROOT",
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    ];
    for name in names {
        assert!(SCRUBBED_ENV.contains(&name), "{name} is in the scrub list");
        std::env::set_var(name, "vidar-test");
    }
    let request = node_request(
        "console.log(JSON.stringify(['NO_COLOR','TERM','COLORTERM','VIDAR_ROOT','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'].filter((n)=>process.env[n]!==undefined)));",
    );
    let (child, output) = spawn(&request).expect("spawn");
    let (lines, _) = drain(&output.stdout);
    assert_eq!(lines, vec!["[]".to_string()]);
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(0));
}

#[test]
fn oversized_lines_are_dropped_and_the_next_line_still_arrives() {
    let script = format!(
        "process.stdout.write('x'.repeat({}) + '\\n'); console.log('after');",
        LINE_CAP + 64
    );
    let (child, output) = spawn(&node_request(&script)).expect("spawn");
    let (lines, overflows) = drain(&output.stdout);
    // Compare lengths in the message: the dropped line is megabytes wide.
    let widths: Vec<usize> = lines.iter().map(String::len).collect();
    assert_eq!(lines, vec!["after".to_string()], "line widths {widths:?}");
    assert_eq!(overflows.len(), 1, "overflows {overflows:?}");
    assert!(overflows[0] > LINE_CAP);
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(0));
}

/// The slice's ownership invariant: killing the Job removes the root *and*
/// a grandchild it started, not just the process Falcon spawned.
#[test]
fn terminating_the_job_removes_a_descendant() {
    let script = "const{spawn}=require('child_process');\
         const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});\
         console.log(c.pid); setInterval(()=>{},1000);";
    let (child, output) = spawn(&node_request(script)).expect("spawn");

    let mut lines = Vec::new();
    let mut chunk = vec![0u8; 256];
    let deadline = Instant::now() + Duration::from_secs(20);
    while lines.is_empty() && Instant::now() < deadline {
        let read = output.stdout.read(&mut chunk).expect("read stdout");
        assert_ne!(read, 0, "child exited before reporting its grandchild");
        let text = String::from_utf8_lossy(&chunk[..read]).into_owned();
        lines.extend(
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string),
        );
    }
    let grandchild: u32 = lines.first().expect("grandchild pid").parse().expect("pid");
    assert!(process_is_alive(grandchild), "grandchild should be running");

    child.terminate_tree();
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(1));

    let deadline = Instant::now() + Duration::from_secs(10);
    while process_is_alive(grandchild) && Instant::now() < deadline {
        std::thread::sleep(POLL);
    }
    assert!(
        !process_is_alive(grandchild),
        "Job termination left grandchild {grandchild} alive"
    );
}

/// A child that never reads its stdin: node only drains the pipe once
/// something resumes the stream, so a timer keeps it alive and deaf.
fn deaf_child() -> (Child, ChildOutput) {
    spawn(&node_request("setInterval(()=>{},1000);")).expect("spawn")
}

/// Comfortably past the 64 KiB pipe buffer, so `WriteFile` cannot finish
/// until the child reads — which this child never will.
fn unreadable_line() -> String {
    "x".repeat(8 * PIPE_BUFFER as usize)
}

/// First line the child prints, or a panic. Used to learn a grandchild's
/// pid before the test starts interfering with the child.
fn first_stdout_line(reader: &PipeReader) -> String {
    let mut chunk = vec![0u8; 256];
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let read = reader.read(&mut chunk).expect("read stdout");
        assert_ne!(read, 0, "child exited before printing a line");
        text.push_str(&String::from_utf8_lossy(&chunk[..read]));
        if let Some(line) = text.lines().next() {
            if text.contains('\n') {
                return line.trim().to_string();
            }
        }
    }
    panic!("no line from the child within 20s");
}

/// The P1: a child that stops consuming stdin used to strand the write
/// holding the stdin mutex, and `stop()` then blocked on that same mutex
/// before it ever reached Job termination. Both halves are asserted here —
/// the write is bounded, and the stop still takes the whole tree down.
///
/// The tree, not just the root: the root's own liveness cannot be checked
/// by pid here, because this process still holds its handle and so keeps
/// the pid resolvable. `wait_for` covers the root; the grandchild covers
/// the Job.
#[test]
fn a_blocked_stdin_write_cannot_strand_stop() {
    let (child, output) = spawn(&node_request(
        "const{spawn}=require('child_process');\
         const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});\
         console.log(c.pid); setInterval(()=>{},1000);",
    ))
    .expect("spawn");
    let grandchild: u32 = first_stdout_line(&output.stdout)
        .parse()
        .expect("grandchild pid");
    assert!(process_is_alive(grandchild), "grandchild should be running");

    let started = Instant::now();
    let status = child.write_line_within(&unreadable_line(), Duration::from_millis(300));
    let write_took = started.elapsed();
    assert!(
        write_took < Duration::from_secs(3),
        "write was not bounded: {write_took:?}"
    );
    // Bytes are in the pipe even though the line never finished, so the
    // honest answer is "may have been delivered", never a flat failure.
    assert!(
        matches!(status, WriteStatus::PossiblyDelivered(_)),
        "status {status:?}"
    );
    assert!(!status.is_definite_failure());
    assert!(!status.is_written());
    assert!(status.message().is_some());

    let stopping = Instant::now();
    child.stop();
    let stop_took = stopping.elapsed();
    assert!(
        stop_took < STOP_GRACE + Duration::from_secs(10),
        "stop took {stop_took:?}"
    );
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(1));
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_is_alive(grandchild) && Instant::now() < deadline {
        std::thread::sleep(POLL);
    }
    assert!(
        !process_is_alive(grandchild),
        "stop left grandchild {grandchild} alive"
    );
    // A stopping child refuses further writes outright, and says so
    // definitely: nothing was queued.
    let refused = child.write_line_status("after the stop");
    assert!(refused.is_definite_failure(), "refused {refused:?}");
    drop(output);
}

/// The escape hatch the whole design leans on: Job termination needs no
/// mutex, and it is what releases a writer parked in `WriteFile`. Proven by
/// watching the abandoned writer thread finish afterwards.
#[test]
fn terminating_the_job_releases_an_abandoned_write() {
    let (child, output) = deaf_child();
    let status = child.write_line_within(&unreadable_line(), Duration::from_millis(300));
    assert!(
        matches!(status, WriteStatus::PossiblyDelivered(_)),
        "status {status:?}"
    );
    assert_eq!(child.stdin.in_flight.load(Ordering::SeqCst), 1);

    let started = Instant::now();
    child.terminate_tree();
    let took = started.elapsed();
    assert!(
        took < Duration::from_secs(2),
        "terminate_tree took {took:?}"
    );
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(1));

    let deadline = Instant::now() + Duration::from_secs(10);
    while child.stdin.in_flight.load(Ordering::SeqCst) > 0 && Instant::now() < deadline {
        std::thread::sleep(POLL);
    }
    assert_eq!(
        child.stdin.in_flight.load(Ordering::SeqCst),
        0,
        "the parked writer never unblocked after the Job died"
    );
    drop(output);
}

/// Graceful close still works against a deaf child: cancelling the parked
/// `WriteFile` hands the stdin handle back, so EOF can be delivered without
/// killing anything.
#[test]
fn close_stdin_cancels_a_blocked_write() {
    let (child, output) = deaf_child();
    let status = child.write_line_within(&unreadable_line(), Duration::from_millis(300));
    assert!(
        matches!(status, WriteStatus::PossiblyDelivered(_)),
        "status {status:?}"
    );

    let started = Instant::now();
    let closed = child.close_stdin();
    let took = started.elapsed();
    assert!(
        took < CLOSE_GRACE + Duration::from_secs(2),
        "close_stdin took {took:?}"
    );
    assert!(closed, "a cancelled write should have released stdin");
    let after = child.write_line_status("stdin is gone");
    assert!(after.is_definite_failure(), "after {after:?}");

    child.terminate_tree();
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(1));
    drop(output);
}

/// Writes queued behind a stuck one are refused, and refused honestly: they
/// never reach `WriteFile`, so "not written" is a fact the writer thread
/// enforces rather than a guess.
#[test]
fn writes_queued_behind_a_stuck_one_are_refused_without_writing() {
    let (child, output) = deaf_child();
    let first = child.write_line_within(&unreadable_line(), Duration::from_millis(300));
    assert!(
        matches!(first, WriteStatus::PossiblyDelivered(_)),
        "first {first:?}"
    );

    // Every one of these parks on the stdin mutex the stuck write owns.
    for index in 1..MAX_PENDING_WRITES {
        let queued = child.write_line_within("queued", Duration::from_millis(50));
        assert!(
            queued.is_definite_failure(),
            "queued write {index} reported {queued:?}"
        );
    }
    assert_eq!(
        child.stdin.in_flight.load(Ordering::SeqCst),
        MAX_PENDING_WRITES
    );
    let capped = child.write_line_within("one too many", Duration::from_millis(50));
    assert!(capped.is_definite_failure(), "capped {capped:?}");
    assert!(capped.message().unwrap().contains("already queued"));

    child.terminate_tree();
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(1));
    drop(output);
}

/// A line several pipe buffers wide still arrives whole: the writer thread
/// loops over partial `WriteFile` results exactly as the old inline write
/// did.
#[test]
fn a_line_wider_than_the_pipe_buffer_reaches_a_reading_child() {
    let (child, output) = spawn(&node_request(
        "let n=0;process.stdin.on('data',d=>{n+=d.length});\
         process.stdin.on('end',()=>console.log('got:'+n));",
    ))
    .expect("spawn");
    let width = 3 * PIPE_BUFFER as usize;
    assert!(child.write_line(&"y".repeat(width)).is_ok());
    assert!(child.close_stdin());
    let (lines, overflows) = drain(&output.stdout);
    assert_eq!(lines, vec![format!("got:{}", width + 1)]);
    assert!(overflows.is_empty());
    assert_eq!(wait_for(&child, Duration::from_secs(10)), Some(0));
}

/// Confirmed present on this machine before the tests below needed them.
const POWERSHELL_PATH: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
const WAITFOR_PATH: &str = r"C:\Windows\System32\waitfor.exe";
/// Confirmed live: `(Get-Command pwsh).Source` resolved here, and this
/// exact path ran `$PSVersionTable.PSVersion` reporting 7.6.6 and
/// `(Get-Process -Id $PID).Path` reporting itself.
/// `C:\Program Files\PowerShell\7\pwsh.exe` was checked and does not
/// exist on this machine -- this MSIX path is the real one.
const PWSH7_PATH: &str =
    r"C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe";

/// `waitfor.exe` rejects any signal name containing a character outside
/// `a-z A-Z 0-9` (and 128-255) — verified live: a dashed token made it
/// print "ERROR: The signal cannot contain characters other than..." and
/// exit within microseconds, well before anything in a probe below ever
/// touched it. So: letters and digits only, no separators.
fn unique_signal_token() -> String {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    format!(
        "falconGrandchild{}{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

/// Reads raw stdout until a `MARKER <pid>` line arrives or `deadline`
/// passes. Never `for_each_line`: that only returns at end-of-stream, and
/// this child's stdout does not close until it is killed.
fn read_marker_pid(reader: &PipeReader, deadline: Instant) -> Option<u32> {
    let mut chunk = vec![0u8; 256];
    let mut text = String::new();
    while Instant::now() < deadline {
        let read = reader.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        text.push_str(&String::from_utf8_lossy(&chunk[..read]));
        for line in text.lines() {
            if let Some(pid) = line
                .trim()
                .strip_prefix("MARKER ")
                .and_then(|rest| rest.trim().parse::<u32>().ok())
            {
                return Some(pid);
            }
        }
    }
    None
}

/// Best-effort direct kill, independent of the Job: the safety net so a
/// failing assertion below never leaves `waitfor.exe` parked for its full
/// 300s timeout. Returns what actually happened instead of assuming it
/// worked, since a silent failure here would be indistinguishable from a
/// slow death in every caller that only polls afterward.
fn force_kill_pid(pid: u32) -> Result<(), String> {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE};
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }
        .map_err(|error| format!("OpenProcess({pid}, PROCESS_TERMINATE): {error}"))?;
    let handle = OwnedHandle::new(handle);
    unsafe { TerminateProcess(handle.handle(), 1) }
        .map_err(|error| format!("TerminateProcess({pid}): {error}"))
}

/// Poll until `pid` is no longer alive, or `timeout` passes.
fn poll_until_dead(pid: u32, timeout: Duration) -> Option<Duration> {
    let started = Instant::now();
    let deadline = started + timeout;
    loop {
        if !process_is_alive(pid) {
            return Some(started.elapsed());
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL);
    }
}

/// A query-rights handle, distinct from [`process_is_alive`]'s
/// `PROCESS_QUERY_LIMITED_INFORMATION`: `IsProcessInJob` documents that it
/// needs the fuller `PROCESS_QUERY_INFORMATION` right.
fn open_query_handle(pid: u32) -> Option<OwnedHandle> {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION};
    unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, false, pid) }
        .ok()
        .map(OwnedHandle::new)
}

/// `Some(true/false)` for "is this process in the given job (or in any
/// job, for `job_handle: None`)", `None` if the query itself failed.
fn is_process_in_job(process_handle: HANDLE, job_handle: Option<HANDLE>) -> Option<bool> {
    use windows::Win32::System::JobObjects::IsProcessInJob;
    let mut result = windows::core::BOOL(0);
    match unsafe { IsProcessInJob(process_handle, job_handle, &mut result) } {
        Ok(()) => Some(result.as_bool()),
        Err(_) => None,
    }
}

#[derive(Debug)]
struct GrandchildProbe {
    marker_pid: Option<u32>,
    alive_after_report: bool,
    died_within: Option<Duration>,
    stderr: String,
}

/// A PowerShell script that starts `waitfor.exe` as its own grandchild via
/// `Start-Process` (`start_process_flag` controls whether that goes
/// through `ShellExecuteEx`) and reports the grandchild's pid on stdout,
/// then blocks. Shared by every probe below.
fn grandchild_probe_request(shell_path: &str, start_process_flag: &str) -> SpawnRequest {
    let token = unique_signal_token();
    let script = format!(
        "$p = Start-Process -FilePath '{waitfor}' -ArgumentList @('/t','300','{token}') {flag} -PassThru; \
         Write-Output ('MARKER ' + $p.Id); [Console]::Out.Flush(); Start-Sleep -Seconds 120",
        waitfor = WAITFOR_PATH,
        token = token,
        flag = start_process_flag,
    );
    SpawnRequest {
        program: PathBuf::from(shell_path),
        args: vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-Command".into(),
            script,
        ],
        cwd: std::env::temp_dir(),
        env: Vec::new(),
        env_base: EnvBase::Inherit,
    }
}

/// Same grandchild-reporting shape as [`grandchild_probe_request`], but
/// starts `waitfor.exe` with raw .NET `System.Diagnostics.Process.Start`
/// directly — no `Start-Process` cmdlet anywhere. A plain `CreateProcess`
/// (`UseShellExecute = $false`), so this isolates the cmdlet itself as a
/// variable from the MSIX/Store package context pwsh 7 runs in.
fn dotnet_process_start_probe_request(shell_path: &str) -> SpawnRequest {
    let token = unique_signal_token();
    let script = format!(
        "$psi = [System.Diagnostics.ProcessStartInfo]::new(); \
         $psi.FileName = '{waitfor}'; \
         $psi.Arguments = '/t 300 {token}'; \
         $psi.UseShellExecute = $false; \
         $psi.CreateNoWindow = $true; \
         $p = [System.Diagnostics.Process]::Start($psi); \
         Write-Output ('MARKER ' + $p.Id); [Console]::Out.Flush(); Start-Sleep -Seconds 120",
        waitfor = WAITFOR_PATH,
        token = token,
    );
    SpawnRequest {
        program: PathBuf::from(shell_path),
        args: vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-Command".into(),
            script,
        ],
        cwd: std::env::temp_dir(),
        env: Vec::new(),
        env_base: EnvBase::Inherit,
    }
}

/// Starts a PowerShell child under the Job; the PowerShell script starts
/// `waitfor.exe` as its own grandchild via `Start-Process`
/// (`start_process_flag` controls whether that goes through
/// `ShellExecuteEx`), reports the grandchild's pid, then this kills the
/// tree the way a host death would and watches whether the grandchild
/// goes with it. The marker is force-killed before returning on every
/// path — including an early return from a missing marker — so a failing
/// probe cannot strand it for 300s.
fn probe_grandchild_survival(shell_path: &str, start_process_flag: &str) -> GrandchildProbe {
    let (child, output) =
        spawn(&grandchild_probe_request(shell_path, start_process_flag)).expect("spawn shell");

    // Drain stderr on its own thread, into a shared buffer, so a
    // PowerShell warning can never fill the pipe and block the script
    // before it prints the marker -- but is still visible in the report.
    let stderr = output.stderr;
    let stderr_text = Arc::new(Mutex::new(String::new()));
    let stderr_text_writer = Arc::clone(&stderr_text);
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 4096];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    lock(&stderr_text_writer).push_str(&String::from_utf8_lossy(&buffer[..read]))
                }
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(30);
    let marker_pid = read_marker_pid(&output.stdout, deadline);
    let alive_after_report = marker_pid.map(process_is_alive).unwrap_or(false);

    // Kill the tree the way the host dying would: terminate the Job, then
    // drop the Child so the job handle it held is gone too.
    child.terminate_tree();
    drop(child);

    let mut died_within = None;
    if let Some(pid) = marker_pid {
        let started = Instant::now();
        let poll_deadline = started + Duration::from_secs(15);
        loop {
            if !process_is_alive(pid) {
                died_within = Some(started.elapsed());
                break;
            }
            if Instant::now() >= poll_deadline {
                break;
            }
            std::thread::sleep(POLL);
        }
        // Safety net regardless of the outcome above: never let the
        // marker linger for its full 300s timeout.
        let _ = force_kill_pid(pid);
    }

    // The process (and so its stderr pipe) has been dead for as long as
    // the poll above took, which is ample time for the drain thread to
    // have caught up.
    let stderr = lock(&stderr_text).clone();

    GrandchildProbe {
        marker_pid,
        alive_after_report,
        died_within,
        stderr,
    }
}

/// Live-proof reproduction: `Start-Process -WindowStyle Hidden` makes
/// PowerShell start the grandchild through `ShellExecuteEx`
/// (`UseShellExecute = true`), the leading hypothesis for why the
/// `waitfor.exe` in the live 10-process tree outlived the Job that killed
/// the other nine.
#[test]
fn a_grandchild_started_via_shellexecute_dies_with_the_job() {
    let probe = probe_grandchild_survival(POWERSHELL_PATH, "-WindowStyle Hidden");
    println!("shellexecute probe: {probe:?}");
    assert!(
        probe.marker_pid.is_some(),
        "never observed a MARKER pid on the child's stdout within 30s"
    );
    assert!(
        probe.alive_after_report,
        "marker pid {:?} was already gone right after it was reported",
        probe.marker_pid
    );
    assert!(
        probe.died_within.is_some(),
        "marker pid {:?} (started via ShellExecute) survived 15s after terminate_tree",
        probe.marker_pid
    );
}

/// Same probe, but `-NoNewWindow` forces a plain `CreateProcess` instead
/// of `ShellExecuteEx`. If this one dies and the ShellExecute variant
/// above does not, that isolates the escape to `ShellExecuteEx`.
#[test]
fn a_grandchild_started_without_shellexecute_dies_with_the_job() {
    let probe = probe_grandchild_survival(POWERSHELL_PATH, "-NoNewWindow");
    println!("plain CreateProcess probe: {probe:?}");
    assert!(
        probe.marker_pid.is_some(),
        "never observed a MARKER pid on the child's stdout within 30s"
    );
    assert!(
        probe.alive_after_report,
        "marker pid {:?} was already gone right after it was reported",
        probe.marker_pid
    );
    assert!(
        probe.died_within.is_some(),
        "marker pid {:?} (started without ShellExecute) survived 15s after terminate_tree",
        probe.marker_pid
    );
}

/// `(in_any_job, in_falcons_job)` for `pid`, queried against Falcon's
/// actual Job handle held in `job_mutex`. `None` in either slot means the
/// query itself failed (e.g. the process was already gone), not "false".
fn job_membership(
    pid: u32,
    job_mutex: &Mutex<Option<OwnedHandle>>,
) -> (Option<bool>, Option<bool>) {
    let Some(handle) = open_query_handle(pid) else {
        return (None, None);
    };
    let in_any_job = is_process_in_job(handle.handle(), None);
    let guard = lock(job_mutex);
    let in_falcons_job = guard
        .as_ref()
        .and_then(|job| is_process_in_job(handle.handle(), Some(job.handle())));
    (in_any_job, in_falcons_job)
}

#[derive(Debug)]
struct JobCloseProbe {
    shell_path: String,
    start_process_flag: String,
    child_pid: u32,
    grandchild_pid: Option<u32>,
    /// `IsProcessInJob(intermediate_shell, NULL / falcons_job)` taken
    /// before anything is killed.
    shell_in_any_job_before: Option<bool>,
    shell_in_falcons_job_before: Option<bool>,
    /// `IsProcessInJob(grandchild, NULL / falcons_job)` taken before
    /// anything is killed.
    grandchild_in_any_job_before: Option<bool>,
    grandchild_in_falcons_job_before: Option<bool>,
    /// What the external `TerminateProcess(child_pid)` call itself
    /// reported, captured instead of assumed.
    direct_kill_result: Result<(), String>,
    child_dead_within: Option<Duration>,
    grandchild_dead_within: Option<Duration>,
}

/// Reproduces the live proof's actual kill path: nothing in this probe
/// ever calls `terminate_tree()` or `TerminateJobObject`. The direct
/// child is force-killed by pid from outside, the way `Stop-Process
/// -Force` killed the Falcon host, and the Job is torn down purely by its
/// last handle closing (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
///
/// `Child::drop` itself calls `terminate_tree()` (an explicit
/// `TerminateJobObject`, see its impl above), so a plain `drop(child)`
/// would not isolate the handle-close path — it would still call
/// `TerminateJobObject` explicitly as long as `child.job` holds `Some`.
/// So this takes the Job's `OwnedHandle` out of that `Mutex` first, which
/// makes `Child::drop`'s own `terminate_tree()` find `None` and no-op,
/// then drops the `Child`, then drops the raw handle separately. That
/// last drop — `OwnedHandle::drop` in `security.rs`, which calls
/// `CloseHandle` and nothing else — is the only thing in this whole probe
/// that can make `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` fire.
fn run_job_close_probe(shell_path: &str, start_process_flag: &str) -> JobCloseProbe {
    run_job_close_probe_for_request(
        shell_path,
        start_process_flag,
        grandchild_probe_request(shell_path, start_process_flag),
    )
}

/// Same probe, but for a caller-built `SpawnRequest` instead of the
/// `Start-Process`-cmdlet script `grandchild_probe_request` builds. Lets
/// [`a_grandchild_started_by_pwsh7_dotnet_process_start_stays_in_the_job`]
/// isolate the cmdlet itself as a variable.
fn run_job_close_probe_for_request(
    shell_path: &str,
    mode_label: &str,
    request: SpawnRequest,
) -> JobCloseProbe {
    let (child, output) =
        spawn(&request).unwrap_or_else(|error| panic!("spawn {shell_path}: {error}"));
    let child_pid = child.pid();

    let stderr = output.stderr;
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 4096];
        while matches!(stderr.read(&mut buffer), Ok(read) if read > 0) {}
    });

    let deadline = Instant::now() + Duration::from_secs(30);
    let grandchild_pid = read_marker_pid(&output.stdout, deadline);

    // Fact 2: query while everything is still alive and still assigned
    // to Falcon's job, before anything below kills or closes anything --
    // both the intermediate shell (Falcon's direct child) and the
    // grandchild.
    let (shell_in_any_job_before, shell_in_falcons_job_before) =
        job_membership(child_pid, &child.job);
    let (grandchild_in_any_job_before, grandchild_in_falcons_job_before) = grandchild_pid
        .map(|pid| job_membership(pid, &child.job))
        .unwrap_or((None, None));

    // Kill ONLY the direct child, externally, by pid — never
    // `child.stop()` or `child.terminate_tree()`. Captured rather than
    // assumed: a silent failure here would look identical, in the poll
    // below, to "the kill worked but the Job took its time."
    let direct_kill_result = force_kill_pid(child_pid);

    // Isolate the handle-close path: see the function doc above.
    let job_handle = lock(&child.job).take();
    drop(child);
    drop(job_handle);

    let child_dead_within = poll_until_dead(child_pid, Duration::from_secs(15));
    let grandchild_dead_within =
        grandchild_pid.and_then(|pid| poll_until_dead(pid, Duration::from_secs(15)));

    // Safety net regardless of the outcome above.
    let _ = force_kill_pid(child_pid);
    if let Some(pid) = grandchild_pid {
        let _ = force_kill_pid(pid);
    }

    let probe = JobCloseProbe {
        shell_path: shell_path.to_string(),
        start_process_flag: mode_label.to_string(),
        child_pid,
        grandchild_pid,
        shell_in_any_job_before,
        shell_in_falcons_job_before,
        grandchild_in_any_job_before,
        grandchild_in_falcons_job_before,
        direct_kill_result,
        child_dead_within,
        grandchild_dead_within,
    };
    println!(
        "[{} {}] shell(pid {}): in_any_job={:?} in_falcons_job={:?} | \
         grandchild(pid {:?}): in_any_job={:?} in_falcons_job={:?} | \
         child_dead_within={:?} grandchild_dead_within={:?}",
        probe.shell_path,
        probe.start_process_flag,
        probe.child_pid,
        probe.shell_in_any_job_before,
        probe.shell_in_falcons_job_before,
        probe.grandchild_pid,
        probe.grandchild_in_any_job_before,
        probe.grandchild_in_falcons_job_before,
        probe.child_dead_within,
        probe.grandchild_dead_within,
    );
    probe
}

/// The coordinator's hypothesis, isolated: if a handle to Falcon's Job
/// leaked into some other process, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
/// would never fire even though `terminate_tree()` (tests 1 and 2) works
/// fine, because that call bypasses handle-close entirely. This test
/// takes the explicit-terminate call out of the path completely.
#[test]
fn a_grandchild_dies_when_the_job_handle_closes_without_an_explicit_terminate() {
    let probe = run_job_close_probe(POWERSHELL_PATH, "-WindowStyle Hidden");
    assert!(
        probe.grandchild_pid.is_some(),
        "never observed a MARKER pid on the child's stdout within 30s"
    );
    assert!(
        probe.grandchild_dead_within.is_some(),
        "grandchild pid {:?} survived 15s after the direct child was force-killed by pid \
         and the Job's last handle was dropped, with no explicit TerminateJobObject call \
         anywhere in this test; IsProcessInJob(any)={:?} IsProcessInJob(falcon's)={:?}",
        probe.grandchild_pid,
        probe.grandchild_in_any_job_before,
        probe.grandchild_in_falcons_job_before
    );
}

/// Same probe, but checks the whole tree: whether the job-close path
/// kills anything at all, or nothing at all.
#[test]
fn a_child_tree_dies_when_the_job_handle_closes_without_an_explicit_terminate() {
    let probe = run_job_close_probe(POWERSHELL_PATH, "-NoNewWindow");
    assert!(
        probe.grandchild_pid.is_some(),
        "never observed a MARKER pid on the child's stdout within 30s"
    );
    assert!(
        probe.child_dead_within.is_some(),
        "direct child pid {} survived 15s after being force-killed by pid",
        probe.child_pid
    );
    assert!(
        probe.grandchild_dead_within.is_some(),
        "grandchild pid {:?} survived 15s after the Job's last handle closed with no \
         explicit TerminateJobObject call anywhere in this test; IsProcessInJob(any)={:?} \
         IsProcessInJob(falcon's)={:?}",
        probe.grandchild_pid,
        probe.grandchild_in_any_job_before,
        probe.grandchild_in_falcons_job_before
    );
}

/// The coordinator's live-proof variable, isolated: the real hook chain
/// runs `pwsh.exe` 7.x (`#requires -Version 7.0`), not Windows PowerShell
/// 5.1. `Start-Process` is a different implementation between the two.
/// Same job-close-only mechanism as the two tests above (no
/// `terminate_tree`, no explicit `TerminateJobObject` anywhere), with
/// `-WindowStyle Hidden` (ShellExecute).
#[test]
#[ignore = "documents a real defect: pwsh 7 (MSIX) grandchildren started via \
            Start-Process escape Job membership entirely (IsProcessInJob = false), \
            confirmed live-reproducible; see the process::tests job-close probes"]
fn a_grandchild_started_via_pwsh7_shellexecute_dies_when_the_job_handle_closes() {
    let probe = run_job_close_probe(PWSH7_PATH, "-WindowStyle Hidden");
    assert!(
        probe.grandchild_pid.is_some(),
        "never observed a MARKER pid on the child's stdout within 30s"
    );
    assert!(
        probe.grandchild_dead_within.is_some(),
        "grandchild pid {:?} survived 15s after the pwsh7 direct child was force-killed by \
         pid and the Job's last handle was dropped, with no explicit TerminateJobObject \
         call anywhere in this test; shell in_any_job={:?} in_falcons_job={:?}; grandchild \
         in_any_job={:?} in_falcons_job={:?}",
        probe.grandchild_pid,
        probe.shell_in_any_job_before,
        probe.shell_in_falcons_job_before,
        probe.grandchild_in_any_job_before,
        probe.grandchild_in_falcons_job_before
    );
}

/// Same as above, but `-NoNewWindow` (plain `CreateProcess`, no
/// ShellExecute) under pwsh 7 specifically.
#[test]
#[ignore = "documents a real defect: pwsh 7 (MSIX) grandchildren started via \
            Start-Process escape Job membership entirely (IsProcessInJob = false) even \
            without ShellExecute, ruling out the ShellExecute theory; see the \
            process::tests job-close probes"]
fn a_grandchild_started_via_pwsh7_plain_createprocess_dies_when_the_job_handle_closes() {
    let probe = run_job_close_probe(PWSH7_PATH, "-NoNewWindow");
    assert!(
        probe.grandchild_pid.is_some(),
        "never observed a MARKER pid on the child's stdout within 30s"
    );
    assert!(
        probe.grandchild_dead_within.is_some(),
        "grandchild pid {:?} survived 15s after the pwsh7 direct child was force-killed by \
         pid and the Job's last handle was dropped, with no explicit TerminateJobObject \
         call anywhere in this test; shell in_any_job={:?} in_falcons_job={:?}; grandchild \
         in_any_job={:?} in_falcons_job={:?}",
        probe.grandchild_pid,
        probe.shell_in_any_job_before,
        probe.shell_in_falcons_job_before,
        probe.grandchild_in_any_job_before,
        probe.grandchild_in_falcons_job_before
    );
}

/// Distinguishes the two candidate causes of the pwsh7 escape above:
/// (A) the `Start-Process` cmdlet itself creates breakaway children, vs
/// (B) the MSIX/Store package context pwsh 7 runs in puts children
/// outside the Job no matter what API is used (e.g. a broker process).
/// This starts the grandchild with raw .NET `Process.Start` -- a plain
/// `CreateProcess`, no cmdlet involved. If the grandchild is in the Job
/// and dies, that is (A). If it is not in the Job and survives, that is
/// (B), and it is not something a Job object can prevent.
///
/// Measured live: cause (B). The grandchild is outside the Job
/// (`IsProcessInJob` = false against both NULL and Falcon's Job handle)
/// and survives the job-close path even with zero `Start-Process`
/// cmdlet involvement -- a plain `CreateProcess` via raw .NET. That
/// rules out (A): the cmdlet is not the cause.
#[test]
#[ignore = "documents a real defect: cause is (B), the pwsh 7 MSIX/Store package context, \
            not the Start-Process cmdlet -- grandchildren escape Job membership even via \
            raw .NET Process.Start with no cmdlet involved; see the process::tests \
            job-close probes"]
fn a_grandchild_started_by_pwsh7_dotnet_process_start_stays_in_the_job() {
    let probe = run_job_close_probe_for_request(
        PWSH7_PATH,
        "[Process]::Start (no Start-Process cmdlet)",
        dotnet_process_start_probe_request(PWSH7_PATH),
    );
    assert!(
        probe.grandchild_pid.is_some(),
        "never observed a MARKER pid on the child's stdout within 30s"
    );
    assert!(
        probe.grandchild_dead_within.is_some(),
        "grandchild pid {:?} survived 15s after the pwsh7 direct child was force-killed by \
         pid and the Job's last handle was dropped, with no explicit TerminateJobObject \
         call anywhere in this test, even though it was started with raw .NET \
         Process.Start (no Start-Process cmdlet); shell in_any_job={:?} \
         in_falcons_job={:?}; grandchild in_any_job={:?} in_falcons_job={:?}",
        probe.grandchild_pid,
        probe.shell_in_any_job_before,
        probe.shell_in_falcons_job_before,
        probe.grandchild_in_any_job_before,
        probe.grandchild_in_falcons_job_before
    );
}

fn process_is_alive(pid: u32) -> bool {
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    // `PROCESS_QUERY_LIMITED_INFORMATION` alone does NOT include
    // `SYNCHRONIZE`. Without it, `WaitForSingleObject` below never
    // reports signaled, so this always claimed "alive" once `OpenProcess`
    // merely *succeeded* -- which it can keep doing for a process that
    // has already exited, for as long as anything else in the system
    // still resolves that pid. That was invisible in the grandchild
    // checks elsewhere in this file, because a killed grandchild with no
    // other handle on it becomes fully unresolvable quickly, so those
    // callers took the `Err` branch below instead of ever reaching the
    // broken wait. It was not invisible for a direct child: verified live
    // against `child.try_wait()` (Falcon's own full-rights handle, which
    // correctly reported the exit code within ~200ms) and `tasklist`
    // (also immediate) while this handle's wait kept reporting "alive"
    // past 45s straight.
    let Ok(handle) = (unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    }) else {
        return false;
    };
    let handle = OwnedHandle::new(handle);
    // A reused PID is still "alive"; these tests run inside one short window.
    let waited = unsafe { WaitForSingleObject(handle.handle(), 0) };
    waited != WAIT_OBJECT_0
}
