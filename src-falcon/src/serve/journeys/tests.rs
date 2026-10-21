//! Hosted Codex end to end against a scripted app-server (C8).
//!
//! The host spawns `tests/fixtures/falcon-codex/fake-app-server.cjs` through
//! its real path: `Op::Spawn` -> `spawn_session` -> `CodexRuntime::spawn_request`.
//! The only test-side choice is the runtime's executable: node, run in a
//! scratch cwd that holds the fake as `app-server`, so the host's own argv
//! (`app-server --listen stdio://`) starts it unchanged. Ops go through
//! `dispatch` exactly as a connection's would; an adopting client is a second
//! `Client` that attaches, pages `Hydrate` and folds the records with
//! `replay::hydrate`. The fake logs every line it reads (`stdin.jsonl`), which
//! is what the inert-replay and once-only assertions read.

use super::*;
use crate::journal::{Record, Snapshot, LONE_RECORD_CAP};
use crate::protocol::{EventBody, Lease, Outcome, SpawnParams};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::Instant;

const FAKE: &str = include_str!("../../../../tests/fixtures/falcon-codex/fake-app-server.cjs");
const SERVER_REQUESTS: &str = include_str!("../../../../contracts/codex-server-requests.json");
const THREAD: &str = "thr-fake";
const WAIT: Duration = Duration::from_secs(20);

/// A scratch directory removed on drop (panic included).
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "falcon-journey-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&path).expect("scratch dir");
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The fake's working directory: the script, its scenario, its logs.
struct Fake {
    dir: Scratch,
}

impl Fake {
    fn new(tag: &str, rules: Vec<Value>) -> Self {
        let fake = Self {
            dir: Scratch::new(tag),
        };
        std::fs::write(fake.dir.0.join("app-server"), FAKE).unwrap();
        // The script is CommonJS whatever a parent package.json says.
        std::fs::write(fake.dir.0.join("package.json"), r#"{"type":"commonjs"}"#).unwrap();
        fake.script(rules);
        fake
    }

    /// The rules the next spawned fake reads at start.
    fn script(&self, rules: Vec<Value>) {
        let scenario = json!({ "rules": rules });
        std::fs::write(self.dir.0.join("scenario.json"), scenario.to_string()).unwrap();
    }

    fn cwd(&self) -> String {
        self.dir.0.display().to_string()
    }

    /// Every line the fake has read from the host, in order.
    fn received(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.0.join("stdin.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("the fake logs JSON"))
            .collect()
    }

    fn received_method(&self, method: &str) -> Vec<Value> {
        self.received()
            .into_iter()
            .filter(|line| line["method"] == method)
            .collect()
    }

    /// Have the fake write `message` to its stdout (or obey a control).
    fn inject(&self, message: Value) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.0.join("inject.jsonl"))
            .unwrap();
        file.write_all(format!("{message}\n").as_bytes()).unwrap();
    }
}

fn node() -> PathBuf {
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join("node.exe"))
                .find(|candidate| candidate.is_file())
        })
        .expect("node.exe on PATH: the fake app-server is a node script")
}

/// A host that runs only Codex, through node and the fake.
fn codex_host(journals: &Path, grace: Duration) -> Arc<Host> {
    Arc::new(Host {
        falcon: crate::registry::FalconRegistry {
            schema_version: 1,
            activation_endpoint: r"\\.\pipe\test-activation".into(),
            session_endpoint: r"\\.\pipe\test-session".into(),
            pid: 1,
            process_created_100ns: 42,
            executable: r"C:\test\falcon.exe".into(),
            profile_directory: r"C:\test\profile".into(),
            protocol_min: 1,
            protocol_max: PROTOCOL_VERSION,
            supported_agents: vec![Agent::Codex.as_str().into()],
            bundle_id: "test".into(),
            attach_secret: "secret".into(),
        },
        registry: Registry::for_incarnation(42),
        runtimes: vec![AgentRuntime::Codex(CodexRuntime {
            executable: node(),
        })],
        clients: AtomicUsize::new(0),
        vidar_clients: AtomicUsize::new(0),
        exiting: AtomicBool::new(false),
        journal_root: journals.to_path_buf(),
        show_shell: OnceLock::new(),
        unattended_grace: grace,
        unused_session_grace: Duration::from_secs(300),
        orphan_session_grace: Duration::from_secs(900),
        vidar_orphan_grace: Duration::from_secs(300),
        jettison_handoff: None,
        bus: BusHub::new(),
        peers: crate::serve::peer::PeerPolicy::none(),
    })
}

/// One client connection without a pipe: its frames land in `inbound`.
struct Conn {
    client: Arc<Client>,
    inbound: Receiver<ServerFrame>,
    attached: Mutex<HashMap<String, u64>>,
    next: AtomicU64,
}

impl Conn {
    fn new(id: u64) -> Self {
        let (outbound, inbound) = sync_channel(CLIENT_BACKLOG);
        Self {
            client: Arc::new(Client {
                id,
                outbound,
                dead: AtomicBool::new(false),
                shutdown: Arc::new(create_shutdown_signal().expect("shutdown event")),
            }),
            inbound,
            attached: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        }
    }

    fn send(&self, host: &Arc<Host>, op: Op) -> Response {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        dispatch(host, &self.client, "vidar", PROTOCOL_V2, &self.attached, Request { id, op })
    }

    fn ok(&self, host: &Arc<Host>, op: Op) -> Value {
        let response = self.send(host, op);
        assert_eq!(response.outcome, Outcome::Applied, "{:?}", response.error);
        response.payload.unwrap_or(Value::Null)
    }

    fn control(&self, host: &Arc<Host>, session: &str) -> Lease {
        let payload = self.ok(
            host,
            Op::AcquireControl {
                session: session.into(),
            },
        );
        Lease {
            token: payload["token"].as_str().unwrap().into(),
            revision: payload["revision"].as_u64().unwrap(),
        }
    }

    /// Live events delivered so far.
    fn live(&self) -> Vec<EventBody> {
        self.inbound
            .try_iter()
            .filter_map(|frame| match frame {
                ServerFrame::Event(event) => Some(event.body),
                _ => None,
            })
            .collect()
    }
}

/// Spawn a hosted Codex session on the fake; `(session, generation)`.
fn spawn(host: &Arc<Host>, conn: &Conn, fake: &Fake, resume: Option<&str>) -> (String, u64) {
    let payload = conn.ok(
        host,
        Op::Spawn(SpawnParams {
            agent: Some(Agent::Codex),
            cwd: fake.cwd(),
            model: None,
            effort: None,
            permission_mode: "default".into(),
            resume: resume.map(str::to_string),
            ctl_secret: None,
            rules_file: None,
            tab_name: None,
            gateway: None,
            profile: None,
            payload_file: None,
            row_key: None,
            set_plugin_dirs: Vec::new(),
        }),
    );
    (
        payload["session"]["session"].as_str().unwrap().into(),
        payload["session"]["generation"].as_u64().unwrap(),
    )
}

/// What an adopting client rebuilds: attach, page every record, fold them.
struct View {
    records: Vec<Record>,
    state: crate::replay::State,
}

fn adopt(host: &Arc<Host>, conn: &Conn, session: &str) -> View {
    let attached = conn.ok(
        host,
        Op::Attach {
            session: session.into(),
        },
    );
    let through = attached["through"].as_u64().unwrap();
    let snapshot: Option<Snapshot> = serde_json::from_value(attached["snapshot"].clone()).unwrap();
    let mut after = snapshot.as_ref().map_or(0, |snapshot| snapshot.through_seq);
    let mut records: Vec<Record> = Vec::new();
    loop {
        let page = conn.ok(
            host,
            Op::Hydrate {
                session: session.into(),
                after,
                through,
            },
        );
        let batch: Vec<Record> = serde_json::from_value(page["records"].clone()).unwrap();
        if let Some(last) = batch.last() {
            after = last.seq;
        }
        records.extend(batch);
        if !page["more"].as_bool().unwrap_or(false) {
            break;
        }
    }
    let state = crate::replay::hydrate(snapshot.as_ref(), &records).expect("replay folds");
    View { records, state }
}

impl View {
    fn agent_lines(&self) -> Vec<&Value> {
        self.state
            .events
            .iter()
            .filter_map(|event| match event {
                EventBody::Agent { line } => Some(line),
                _ => None,
            })
            .collect()
    }

    fn queued(&self) -> Vec<(String, Value)> {
        self.state
            .queued_prompts
            .iter()
            .map(|queued| (queued.prompt.clone(), queued.content.clone()))
            .collect()
    }
}

/// Every record journaled so far, as wire JSON bodies.
fn bodies(session: &crate::session::Session) -> Vec<Value> {
    session
        .hydrate_from(0, session.journal_position(), usize::MAX, usize::MAX)
        .expect("journal reads")
        .0
        .into_iter()
        .map(|record| serde_json::to_value(&record.body).unwrap())
        .collect()
}

fn permission_states(bodies: &[Value], request: &str) -> Vec<String> {
    bodies
        .iter()
        .filter(|body| body["record"] == "permission-state" && body["request"] == request)
        // Pointers, not quoted field names: the paths-contract scan counts
        // those as layout literals.
        .map(|body| body.pointer("/state").and_then(Value::as_str).unwrap().to_string())
        .collect()
}

fn has_codex(bodies: &[Value], kind: &str, prompt: &str) -> bool {
    bodies.iter().any(|body| {
        body["record"] == "codex" && body["codex"]["kind"] == kind && body["codex"]["prompt"] == prompt
    })
}

fn wait_until<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(found) = probe() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn rpc(id: &str, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn note(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

fn turn_value(turn: &str, status: &str) -> Value {
    json!({ "id": turn, "status": status, "items": [] })
}

fn completed(turn: &str) -> Value {
    note(
        "turn/completed",
        json!({ "threadId": THREAD, "turn": turn_value(turn, "completed") }),
    )
}

/// initialize, thread/start, thread/resume and model/list, answered at once.
fn startup() -> Vec<Value> {
    let thread = json!({ "thread": { "id": THREAD }, "model": "gpt-fake" });
    vec![
        json!({ "method": "initialize", "send": [rpc("$id", json!({ "userAgent": "fake" }))] }),
        json!({ "method": "thread/start", "send": [rpc("$id", thread.clone())] }),
        json!({ "method": "thread/resume", "send": [rpc("$id", thread)] }),
        json!({ "method": "model/list", "send": [rpc("$id", json!({ "data": [] }))] }),
    ]
}

/// The next `turn/start` binds `turn` (response, then `turn/started`), then
/// sends `then`.
fn turn(turn: &str, then: Vec<Value>) -> Value {
    let mut send = vec![
        rpc("$id", json!({ "turn": turn_value(turn, "inProgress") })),
        note(
            "turn/started",
            json!({ "threadId": THREAD, "turn": turn_value(turn, "inProgress") }),
        ),
    ];
    send.extend(then);
    json!({ "method": "turn/start", "times": 1, "send": send })
}

fn refused_steer() -> Value {
    json!({ "method": "turn/steer", "times": 1, "send": [{
        "jsonrpc": "2.0", "id": "$id",
        "error": { "code": -32600, "message": "expected turn is no longer active" }
    }] })
}

/// The command-approval card method, checked against the shared contract
/// rather than assumed.
fn card_method() -> &'static str {
    let method = "item/commandExecution/requestApproval";
    let contract: Value = serde_json::from_str(SERVER_REQUESTS).unwrap();
    assert_eq!(contract["requests"][method]["disposition"], "card");
    method
}

fn card(id: u64, turn: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": card_method(), "params": {
        "threadId": THREAD, "turnId": turn, "itemId": format!("cmd-{id}"),
        "command": "echo hi", "cwd": "."
    } })
}

fn submit(host: &Arc<Host>, conn: &Conn, session: &str, generation: u64, lease: &Lease, content: Value) -> String {
    let payload = conn.ok(
        host,
        Op::Submit {
            session: session.into(),
            generation,
            lease: lease.clone(),
            content,
        },
    );
    payload["prompt"].as_str().unwrap().into()
}

fn stop(host: &Arc<Host>, client: &Arc<Client>, session: &str, generation: u64, lease: &Lease) -> Response {
    dispatch(
        host,
        client,
        "vidar",
        PROTOCOL_V2,
        &Mutex::new(HashMap::new()),
        Request {
            id: 900,
            op: Op::Interrupt {
                session: session.into(),
                generation,
                lease: lease.clone(),
            },
        },
    )
}

fn terminate(host: &Arc<Host>, conn: &Conn, session: &str, lease: &Lease) {
    conn.ok(
        host,
        Op::Terminate {
            session: session.into(),
            lease: lease.clone(),
        },
    );
    let found = host.registry.get(session).unwrap();
    wait_until("the child to exit", || found.exited().map(|_| ()));
}

/// spawn -> turn -> approval -> detach/adopt -> answer -> exit -> resume with
/// history -> a card left open at exit. Asserts the wire the fake read, what
/// the host journaled, and what each adopting client rebuilt.
#[test]
fn a_hosted_codex_session_survives_approval_adopt_resume_and_exit() {
    let journals = Scratch::new("journey-journals");
    // Zero grace: an unattended card is never denied, so the adopter answers it.
    let host = codex_host(&journals.0, Duration::ZERO);
    let mut rules = startup();
    rules.push(turn(
        "turn-1",
        vec![
            note("item/agentMessage/delta", json!({ "threadId": THREAD, "turnId": "turn-1", "delta": "Checking." })),
            card(100, "turn-1"),
        ],
    ));
    rules.push(json!({ "response": 100, "times": 1, "send": [
        note("serverRequest/resolved", json!({ "threadId": THREAD, "requestId": 100 })),
        completed("turn-1"),
    ] }));
    let fake = Fake::new("journey", rules);

    // Spawn: initialize (experimentalApi, jsonrpc 2.0), initialized, thread/start.
    let a = Conn::new(1);
    let (sid, generation) = spawn(&host, &a, &fake, None);
    let session = host.registry.get(&sid).unwrap();
    let opening: Vec<Value> = fake.received();
    let methods: Vec<&str> = opening.iter().map(|line| line["method"].as_str().unwrap()).collect();
    assert_eq!(methods, ["initialize", "initialized", "thread/start"]);
    assert_eq!(opening[0]["jsonrpc"], "2.0");
    assert_eq!(opening[0]["params"]["capabilities"]["experimentalApi"], true);
    assert_eq!(opening[2]["params"]["cwd"], fake.cwd());
    assert_eq!(session.conversation().as_deref(), Some(THREAD));

    // Turn: the prompt goes out as turn/start; the card opens with a view attached.
    let lease = a.control(&host, &sid);
    a.ok(&host, Op::Attach { session: sid.clone() });
    let prompt = submit(&host, &a, &sid, generation, &lease, json!("list the files"));
    wait_until("the card to open", || {
        (permission_states(&bodies(&session), "sr:100") == ["opened"]).then_some(())
    });
    let starts = fake.received_method("turn/start");
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0]["params"]["threadId"], THREAD);
    assert_eq!(starts[0]["params"]["input"], json!([{ "type": "text", "text": "list the files" }]));
    // The card's state is journaled before its line is published.
    let mut seen = Vec::new();
    wait_until("the attached view to see the card request", || {
        seen.extend(a.live());
        seen.iter()
            .any(|event| matches!(event,
                EventBody::Agent { line } if line["id"] == 100 && line["method"] == card_method()))
            .then_some(())
    });

    // Detach: the tab goes away with the card open and the turn running.
    a.ok(&host, Op::ReleaseControl { session: sid.clone(), lease });
    a.ok(&host, Op::Detach { session: sid.clone() });

    // Adopt: a second client rebuilds the turn and the open card.
    let b = Conn::new(2);
    let view = adopt(&host, &b, &sid);
    assert_eq!(view.state.conversation.as_deref(), Some(THREAD));
    assert!(view.queued().is_empty(), "the prompt left the queue when dispatched");
    assert_eq!(view.state.codex_turn, Some((prompt.clone(), "turn-1".to_string())));
    let rebuilt = view.agent_lines();
    assert!(rebuilt.iter().any(|line| line["method"] == "falcon/thread"));
    assert!(rebuilt.iter().any(|line| line["method"] == "item/agentMessage/delta"));
    assert!(rebuilt.iter().any(|line| line["id"] == 100 && line["method"] == card_method()));
    let states: Vec<Value> = view
        .records
        .iter()
        .map(|record| serde_json::to_value(&record.body).unwrap())
        .collect();
    assert_eq!(permission_states(&states, "sr:100"), ["opened"], "the adopter sees the card open");

    // Approval: the adopter answers once; a second answer is refused by name.
    let lease = b.control(&host, &sid);
    let answer = |behavior: &str| {
        b.send(
            &host,
            Op::PermissionResponse {
                session: sid.clone(),
                generation,
                lease: lease.clone(),
                request: "sr:100".into(),
                behavior: behavior.into(),
                message: None,
                updated_input: None,
            },
        )
    };
    assert_eq!(answer("allow").outcome, Outcome::Applied);
    let again = answer("allow");
    assert_eq!(again.outcome, Outcome::Failed);
    assert!(again.error.unwrap().contains("no pending permission sr:100"));
    wait_until("the card to settle", || {
        (permission_states(&bodies(&session), "sr:100").last().map(String::as_str) == Some("settled"))
            .then_some(())
    });
    let answers: Vec<Value> = fake
        .received()
        .into_iter()
        .filter(|line| line["id"] == 100 && line.get("method").is_none())
        .collect();
    assert_eq!(answers, [json!({ "jsonrpc": "2.0", "id": 100, "result": { "decision": "accept" } })]);
    assert_eq!(
        permission_states(&bodies(&session), "sr:100"),
        ["opened", "settled"],
        "the reader journals the state it sees on the next line: Returned is overtaken by \
         serverRequest/resolved"
    );
    wait_until("the turn to end", || {
        b.live()
            .iter()
            .any(|event| matches!(event, EventBody::Agent { line } if line["method"] == "turn/completed"))
            .then_some(())
    });

    // Exit: Close is EOF on stdin; the fake exits 0 and the host journals it.
    b.ok(&host, Op::Close { session: sid.clone(), lease: lease.clone() });
    wait_until("the exit record", || {
        bodies(&session)
            .contains(&json!({ "record": "exited", "code": 0 }))
            .then_some(())
    });
    b.ok(&host, Op::Detach { session: sid.clone() });
    b.ok(&host, Op::Release { session: sid.clone() });

    // Resume with history: excludeTurns, one page of turns/list, then turns again.
    let mut rules = startup();
    rules.push(json!({ "method": "thread/turns/list", "times": 1, "send": [rpc("$id", json!({
        "data": [{ "id": "turn-1", "status": "completed", "items": [
            { "type": "agentMessage", "id": "m1", "text": "Checking." }
        ] }],
        "nextCursor": null
    }))] }));
    rules.push(turn("turn-2", vec![card(200, "turn-2")]));
    fake.script(rules);
    let read_before = fake.received().len();
    let (resumed, generation) = spawn(&host, &b, &fake, Some(THREAD));
    let session = host.registry.get(&resumed).unwrap();
    let opening: Vec<Value> = fake.received()[read_before..].to_vec();
    let methods: Vec<&str> = opening.iter().map(|line| line["method"].as_str().unwrap()).collect();
    assert_eq!(&methods[..3], ["initialize", "initialized", "thread/resume"]);
    assert_eq!(opening[2]["params"]["threadId"], THREAD);
    assert_eq!(opening[2]["params"]["excludeTurns"], true);
    wait_until("the history page request", || {
        (fake.received_method("thread/turns/list").len() == 1).then_some(())
    });
    let page = &fake.received_method("thread/turns/list")[0];
    assert_eq!(page["params"]["threadId"], THREAD);
    assert_eq!(page["params"]["itemsView"], "full");

    let c = Conn::new(3);
    let view = wait_until("the history outcome", || {
        let view = adopt(&host, &c, &resumed);
        let ended = view
            .agent_lines()
            .iter()
            .any(|line| line["method"] == "falcon/history" && line["params"]["phase"] == "end");
        if !ended {
            c.ok(&host, Op::Detach { session: resumed.clone() });
        }
        ended.then_some(view)
    });
    let history: Vec<Value> = view
        .agent_lines()
        .into_iter()
        .filter(|line| line["method"].as_str().is_some_and(|m| m.starts_with("falcon/")))
        .map(|line| json!([line["method"], line["params"]["phase"], line["params"]["turn"]["id"]]))
        .collect();
    assert_eq!(
        history,
        [
            json!(["falcon/thread", null, null]),
            json!(["falcon/history", "start", null]),
            json!(["falcon/history", "turn", "turn-1"]),
            json!(["falcon/history", "end", null]),
        ]
    );
    let end = view
        .agent_lines()
        .into_iter()
        .find(|line| line["params"]["phase"] == "end")
        .unwrap()
        .clone();
    assert_eq!(end["params"]["count"], 1);
    assert_eq!(end["params"]["truncated"], false);
    assert!(view
        .agent_lines()
        .iter()
        .any(|line| line["method"] == "falcon/thread" && line["params"]["resumed"] == true));

    // The resumed thread runs turns; a card left open at exit is cancelled by it.
    let lease = c.control(&host, &resumed);
    submit(&host, &c, &resumed, generation, &lease, json!("again"));
    wait_until("the second card", || {
        (permission_states(&bodies(&session), "sr:200") == ["opened"]).then_some(())
    });
    fake.inject(json!({ "$exit": 3 }));
    // `exited()` flips before the exit records are journaled: wait for those.
    let journal = wait_until("the exit record", || {
        let journal = bodies(&session);
        journal
            .contains(&json!({ "record": "exited", "code": 3 }))
            .then_some(journal)
    });
    assert_eq!(permission_states(&journal, "sr:200"), ["opened", "cancelled-by-exit"]);
    let view = {
        c.ok(&host, Op::Detach { session: resumed.clone() });
        adopt(&host, &c, &resumed)
    };
    assert_eq!(view.state.exited, Some(Some(3)));
}

/// Attach, hydrate and replay are reads: however many clients adopt, nothing
/// reaches the child. The fence is a read-only query sent after them: the
/// child's stdin is ordered, so anything an adopt wrote would precede it.
#[test]
fn adopting_and_replaying_write_nothing_to_the_child() {
    let journals = Scratch::new("inert-journals");
    let host = codex_host(&journals.0, Duration::ZERO);
    let mut rules = startup();
    rules.push(turn(
        "turn-1",
        vec![
            note("item/agentMessage/delta", json!({ "threadId": THREAD, "turnId": "turn-1", "delta": "Working." })),
            card(7, "turn-1"),
        ],
    ));
    let fake = Fake::new("inert", rules);
    let a = Conn::new(1);
    let (sid, generation) = spawn(&host, &a, &fake, None);
    let session = host.registry.get(&sid).unwrap();
    let lease = a.control(&host, &sid);
    submit(&host, &a, &sid, generation, &lease, json!("go"));
    wait_until("the card line", || {
        bodies(&session)
            .iter()
            .any(|body| body["body"]["line"]["id"] == 7)
            .then_some(())
    });
    let before = fake.received();

    for id in 10..13 {
        let adopter = Conn::new(id);
        let view = adopt(&host, &adopter, &sid);
        assert!(view.agent_lines().iter().any(|line| line["id"] == 7));
        // A second rebuild from the same connection, page by page.
        let again = adopter.ok(&host, Op::Hydrate { session: sid.clone(), after: 0, through: u64::MAX });
        assert!(!again["records"].as_array().unwrap().is_empty());
        let mut state = crate::replay::State::default();
        for record in &view.records {
            crate::replay::reduce(&mut state, record).unwrap();
        }
        assert_eq!(state, view.state, "replay is deterministic");
        adopter.ok(&host, Op::Detach { session: sid.clone() });
    }
    // Unattached hydrate is a read too.
    let reader = Conn::new(20);
    reader.ok(&host, Op::Hydrate { session: sid.clone(), after: 0, through: u64::MAX });

    let fence = Conn::new(21);
    adopt(&host, &fence, &sid);
    let reply = fence.ok(
        &host,
        Op::Query {
            session: sid.clone(),
            generation,
            method: "model/list".into(),
            params: json!({}),
        },
    );
    assert_eq!(reply["response"]["result"], json!({ "data": [] }));
    let after = fake.received();
    assert_eq!(&after[..before.len()], &before[..]);
    let added: Vec<&str> = after[before.len()..]
        .iter()
        .map(|line| line["method"].as_str().unwrap_or("<response>"))
        .collect();
    assert_eq!(added, ["model/list"], "only the fence query reached the child");
    terminate(&host, &a, &sid, &lease);
}

/// H1: a steer Codex refuses goes back to the queue, an adopting client sees
/// it waiting, and the turn end sends it as the next turn.
#[test]
fn a_refused_steer_is_requeued_and_survives_adopt() {
    let journals = Scratch::new("steer-journals");
    let host = codex_host(&journals.0, Duration::ZERO);
    let mut rules = startup();
    rules.push(turn("turn-1", vec![]));
    rules.push(refused_steer());
    rules.push(turn("turn-2", vec![completed("turn-2")]));
    let fake = Fake::new("steer", rules);
    let a = Conn::new(1);
    let (sid, generation) = spawn(&host, &a, &fake, None);
    let session = host.registry.get(&sid).unwrap();
    let lease = a.control(&host, &sid);
    let first = submit(&host, &a, &sid, generation, &lease, json!("first"));
    wait_until("turn-1 to bind", || has_codex(&bodies(&session), "turn-bound", &first).then_some(()));

    let second = submit(&host, &a, &sid, generation, &lease, json!("second"));
    let steered = a.ok(
        &host,
        Op::SteerPrompt {
            session: sid.clone(),
            generation,
            lease: lease.clone(),
            prompt: second.clone(),
        },
    );
    assert_eq!(steered["steered"], true);
    wait_until("the requeue", || {
        bodies(&session)
            .iter()
            .any(|body| body["record"] == "prompt-requeued" && body["prompt"] == second.as_str())
            .then_some(())
    });
    let steer = fake.received_method("turn/steer");
    assert_eq!(steer.len(), 1);
    assert_eq!(steer[0]["params"]["expectedTurnId"], "turn-1");
    assert!(has_codex(&bodies(&session), "turn-refused", &second));
    assert_eq!(session.queued_prompts(), [second.clone()]);

    let b = Conn::new(2);
    let view = adopt(&host, &b, &sid);
    assert_eq!(view.queued(), [(second.clone(), json!("second"))], "the adopter sees it waiting");
    assert_eq!(view.state.codex_turn, Some((first.clone(), "turn-1".to_string())));

    fake.inject(completed("turn-1"));
    wait_until("the requeued prompt to start turn-2", || {
        (fake.received_method("turn/start").len() == 2).then_some(())
    });
    let start = &fake.received_method("turn/start")[1];
    assert_eq!(start["params"]["input"], json!([{ "type": "text", "text": "second" }]));
    wait_until("turn-2 to bind", || has_codex(&bodies(&session), "turn-bound", &second).then_some(()));
    b.ok(&host, Op::Detach { session: sid.clone() });
    let view = adopt(&host, &b, &sid);
    assert!(view.queued().is_empty());
    assert_eq!(view.state.codex_turn, Some((second, "turn-2".to_string())));
    terminate(&host, &a, &sid, &lease);
}

/// H1: two Stops for one turn send one `turn/interrupt`, and both get its
/// outcome; a Stop after the turn ended writes nothing.
#[test]
fn two_stops_send_one_interrupt() {
    let journals = Scratch::new("stop-journals");
    let host = codex_host(&journals.0, Duration::ZERO);
    let mut rules = startup();
    rules.push(turn("turn-1", vec![]));
    // Answered by injection, so both Stops are in flight before it lands.
    rules.push(json!({ "method": "turn/interrupt", "times": 1, "send": [] }));
    let fake = Fake::new("stop", rules);
    let a = Conn::new(1);
    let (sid, generation) = spawn(&host, &a, &fake, None);
    let session = host.registry.get(&sid).unwrap();
    let lease = a.control(&host, &sid);
    let prompt = submit(&host, &a, &sid, generation, &lease, json!("long job"));
    wait_until("turn-1 to bind", || has_codex(&bodies(&session), "turn-bound", &prompt).then_some(()));

    let client = Arc::clone(&a.client);
    std::thread::scope(|scope| {
        let first = scope.spawn(|| stop(&host, &client, &sid, generation, &lease));
        wait_until("the interrupt", || {
            (fake.received_method("turn/interrupt").len() == 1).then_some(())
        });
        let second = scope.spawn(|| stop(&host, &client, &sid, generation, &lease));
        // Let the second Stop reach the join; the outcome does not depend on it.
        std::thread::sleep(Duration::from_millis(200));
        let interrupt = fake.received_method("turn/interrupt")[0].clone();
        assert_eq!(interrupt["params"], json!({ "threadId": THREAD, "turnId": "turn-1" }));
        fake.inject(json!({ "jsonrpc": "2.0", "id": interrupt["id"], "result": {} }));
        let first = first.join().unwrap();
        let second = second.join().unwrap();
        assert_eq!(first.outcome, Outcome::Applied, "{:?}", first.error);
        assert_eq!(second.outcome, Outcome::Applied, "{:?}", second.error);
    });
    assert_eq!(fake.received_method("turn/interrupt").len(), 1, "one interrupt per turn");

    fake.inject(note(
        "turn/completed",
        json!({ "threadId": THREAD, "turn": turn_value("turn-1", "interrupted") }),
    ));
    wait_until("the turn end", || {
        bodies(&session)
            .iter()
            .any(|body| body["body"]["line"]["method"] == "turn/completed")
            .then_some(())
    });
    let late = stop(&host, &a.client, &sid, generation, &lease);
    assert_eq!(late.outcome, Outcome::Failed);
    assert!(late.error.unwrap().contains("no Codex turn is running"));
    assert_eq!(fake.received_method("turn/interrupt").len(), 1);
    terminate(&host, &a, &sid, &lease);
}

/// H1 leftover: a prompt at the child line cap (its `turn/start` line just
/// fits `LINE_CAP` when measured with the widest request id) whose steer Codex refuses is requeued with its full
/// content, and the turn end sends all of it. Its records are far under the
/// journal cap, so the requeue journals.
#[test]
fn a_prompt_at_the_line_cap_is_requeued_whole() {
    let journals = Scratch::new("line-cap-journals");
    let host = codex_host(&journals.0, Duration::ZERO);
    let mut rules = startup();
    rules.push(turn("turn-1", vec![]));
    rules.push(refused_steer());
    rules.push(turn("turn-2", vec![completed("turn-2")]));
    let fake = Fake::new("line-cap", rules);
    let a = Conn::new(1);
    let (sid, generation) = spawn(&host, &a, &fake, None);
    let session = host.registry.get(&sid).unwrap();
    let lease = a.control(&host, &sid);
    let first = submit(&host, &a, &sid, generation, &lease, json!("first"));
    wait_until("turn-1 to bind", || has_codex(&bodies(&session), "turn-bound", &first).then_some(()));

    // The first turn/start as the host wrote it, less its text, is the
    // overhead; request ids 2 and 4 have the same width. `check_prompt`
    // measures with the widest id (20 digits), so the largest accepted prompt
    // writes `extra` bytes under the cap.
    let first_start = &fake.received_method("turn/start")[0];
    let extra = u64::MAX.to_string().len() - first_start["id"].to_string().len();
    let overhead = first_start.to_string().len() - "first".len() + extra;
    let big = "x".repeat(crate::process::LINE_CAP - overhead);
    let held = submit(&host, &a, &sid, generation, &lease, json!(big));
    let steered = a.ok(
        &host,
        Op::SteerPrompt {
            session: sid.clone(),
            generation,
            lease: lease.clone(),
            prompt: held.clone(),
        },
    );
    assert_eq!(steered["steered"], true);
    wait_until("the requeue", || {
        bodies(&session)
            .iter()
            .any(|body| body["record"] == "prompt-requeued" && body["prompt"] == held.as_str())
            .then_some(())
    });
    let requeued: Vec<Value> = bodies(&session)
        .into_iter()
        .filter(|body| body["record"] == "prompt-requeued" && body["prompt"] == held.as_str())
        .collect();
    assert_eq!(
        requeued[0].pointer("/content").and_then(Value::as_str).map(str::len),
        Some(big.len()),
        "whole content"
    );
    let b = Conn::new(2);
    let view = adopt(&host, &b, &sid);
    assert_eq!(view.queued(), [(held.clone(), json!(big))]);

    fake.inject(completed("turn-1"));
    wait_until("the held prompt to start turn-2", || {
        (fake.received_method("turn/start").len() == 2).then_some(())
    });
    let start = &fake.received_method("turn/start")[1];
    assert_eq!(
        start["bytes"].as_u64(),
        Some((crate::process::LINE_CAP - extra) as u64),
        "at the upper-bound cap"
    );
    wait_until("turn-2 to bind", || has_codex(&bodies(&session), "turn-bound", &held).then_some(()));
    terminate(&host, &a, &sid, &lease);
}

/// H1 inferred that a prompt journaled as `PromptQueued` near the record cap
/// could fail to journal its `PromptRequeued` (a few bytes larger), leaving
/// replay without a prompt the live queue still holds. Confirmed: such a
/// prompt is over the child line cap, so its steer write is refused outright
/// and `put_back` requeues it. The requeue now journals the replay marker in
/// place of content it cannot carry, and the turn end drops the prompt as
/// undelivered in the journal and the live queue alike. `submit` now refuses
/// such a prompt, so the test seeds the queue directly, as a requeue leaves it.
#[test]
fn a_prompt_at_the_record_cap_is_requeued_in_replay_too() {
    let journals = Scratch::new("cap-journals");
    let host = codex_host(&journals.0, Duration::ZERO);
    let mut rules = startup();
    rules.push(turn("turn-1", vec![]));
    let fake = Fake::new("cap", rules);
    let a = Conn::new(1);
    let (sid, generation) = spawn(&host, &a, &fake, None);
    let session = host.registry.get(&sid).unwrap();
    let lease = a.control(&host, &sid);
    let first = submit(&host, &a, &sid, generation, &lease, json!("first"));
    wait_until("turn-1 to bind", || has_codex(&bodies(&session), "turn-bound", &first).then_some(()));

    // Size the content so its PromptQueued record lands a few bytes under the
    // cap: the PromptRequeued that repeats it is then over.
    let probe = |content: &str| {
        serde_json::to_vec(&Record {
            seq: session.journal_position() + 1,
            generation,
            at_ms: 1_000_000_000_000,
            body: crate::journal::Body::PromptQueued {
                prompt: format!("p{}", "0".repeat(32)),
                content: json!(content),
            },
        })
        .unwrap()
        .len()
    };
    let big = "x".repeat(LONE_RECORD_CAP - 4 - probe(""));
    assert_eq!(probe(&big), LONE_RECORD_CAP - 4);
    let held = session.enqueue_prompt(json!(big)).unwrap();
    let steered = a.send(
        &host,
        Op::SteerPrompt {
            session: sid.clone(),
            generation,
            lease: lease.clone(),
            prompt: held.clone(),
        },
    );
    assert_eq!(steered.outcome, Outcome::Failed);
    assert!(steered.error.unwrap().contains("exceeds"), "refused by the line cap");
    assert_eq!(session.queued_prompts(), [held.clone()], "the live queue has it back");
    let journal = bodies(&session);
    let requeued: Vec<&Value> = journal
        .iter()
        .filter(|body| body["record"] == "prompt-requeued" && body["prompt"] == held.as_str())
        .collect();
    assert_eq!(requeued.len(), 1, "the requeue is journaled");
    let marker = requeued[0].pointer("/content").and_then(Value::as_str).unwrap();
    assert!(marker.contains("too large to replay"), "{marker}");

    let b = Conn::new(2);
    let view = adopt(&host, &b, &sid);
    let queued: Vec<String> = view.queued().into_iter().map(|(prompt, _)| prompt).collect();
    assert_eq!(queued, [held.clone()], "replay agrees with the live queue");

    // No turn/start can carry it either: the turn end drops it, journaled.
    fake.inject(completed("turn-1"));
    wait_until("the undelivered record", || {
        bodies(&session)
            .iter()
            .any(|body| body["record"] == "prompt-undelivered" && body["prompt"] == held.as_str())
            .then_some(())
    });
    assert!(session.queued_prompts().is_empty());
    b.ok(&host, Op::Detach { session: sid.clone() });
    assert!(adopt(&host, &b, &sid).queued().is_empty(), "replay agrees again");
    assert_eq!(fake.received_method("turn/start").len(), 1);
    assert!(fake.received_method("turn/steer").is_empty());
    terminate(&host, &a, &sid, &lease);
}

/// H1 leftover probe, not a gate: a steer with no turn running is an ordinary
/// dispatch; when its write is refused outright the host requeues it. The
/// host side is right (dispatched, then requeued); whether a view clears its
/// in-turn flag is `host-payload.ts`'s, which this cannot see.
#[test]
#[ignore = "H1 leftover probe: documents behaviour, does not gate"]
fn probe_a_no_turn_steer_refused_outright_is_requeued() {
    let journals = Scratch::new("probe-steer-journals");
    let host = codex_host(&journals.0, Duration::ZERO);
    let fake = Fake::new("probe-steer", startup());
    let a = Conn::new(1);
    let (sid, generation) = spawn(&host, &a, &fake, None);
    let session = host.registry.get(&sid).unwrap();
    let lease = a.control(&host, &sid);
    // A write is refused outright only for a stopping child or a line over
    // `LINE_CAP`. Queued straight onto the idle session (as a requeue leaves
    // it), so `pump` has not already dropped it as undelivered.
    let prompt = session
        .enqueue_prompt(json!("x".repeat(crate::process::LINE_CAP)))
        .unwrap();
    let steered = a.send(
        &host,
        Op::SteerPrompt {
            session: sid.clone(),
            generation,
            lease: lease.clone(),
            prompt: prompt.clone(),
        },
    );
    eprintln!("probe: steer outcome {:?} {:?}", steered.outcome, steered.error);
    let records: Vec<Value> = bodies(&session)
        .into_iter()
        .filter(|body| body["prompt"] == prompt.as_str())
        .map(|body| json!([body["record"], body["steered"], body["at"]]))
        .collect();
    eprintln!("probe: records {records:?}");
    eprintln!("probe: live queue {:?}", session.queued_prompts());
    terminate(&host, &a, &sid, &lease);
}

/// H1 leftover: a steer Codex never answers outlives its own turn's end
/// (still refusable then), and is released at the next turn end (its
/// `Turns.requests` entry and folded content dropped), journaled
/// `prompt-undelivered` with a Diagnostic, not requeued: Codex may have
/// applied it.
#[test]
fn an_unanswered_steer_is_released_at_the_next_turn_end() {
    let journals = Scratch::new("probe-held-journals");
    let host = codex_host(&journals.0, Duration::ZERO);
    let mut rules = startup();
    rules.push(turn("turn-1", vec![]));
    rules.push(json!({ "method": "turn/steer", "times": 1, "send": [] }));
    rules.push(turn("turn-2", vec![completed("turn-2")]));
    let fake = Fake::new("probe-held", rules);
    let a = Conn::new(1);
    let (sid, generation) = spawn(&host, &a, &fake, None);
    let session = host.registry.get(&sid).unwrap();
    let lease = a.control(&host, &sid);
    let first = submit(&host, &a, &sid, generation, &lease, json!("first"));
    wait_until("turn-1 to bind", || has_codex(&bodies(&session), "turn-bound", &first).then_some(()));
    let second = submit(&host, &a, &sid, generation, &lease, json!("second"));
    a.ok(
        &host,
        Op::SteerPrompt {
            session: sid.clone(),
            generation,
            lease: lease.clone(),
            prompt: second.clone(),
        },
    );
    wait_until("the steer", || (fake.received_method("turn/steer").len() == 1).then_some(()));
    fake.inject(completed("turn-1"));
    wait_until("the turn end", || {
        bodies(&session)
            .iter()
            .any(|body| body["body"]["line"]["method"] == "turn/completed")
            .then_some(())
    });
    assert!(session.driver.steer_pending(&second), "refusable past its own turn");
    assert!(!bodies(&session)
        .iter()
        .any(|body| body["record"] == "prompt-undelivered"));
    let third = submit(&host, &a, &sid, generation, &lease, json!("third"));
    wait_until("the release", || {
        bodies(&session)
            .iter()
            .any(|body| body["record"] == "prompt-undelivered" && body["prompt"] == second.as_str())
            .then_some(())
    });
    assert!(has_codex(&bodies(&session), "turn-bound", &third));
    assert!(!session.driver.steer_pending(&second), "released at the next turn end");
    let announced = format!(
        "Steered prompt {second} may not have been delivered: the agent never answered the \
         steer, and the following turn has ended."
    );
    wait_until("the diagnostic", || {
        bodies(&session)
            .iter()
            .any(|body| body["body"]["text"] == announced.as_str())
            .then_some(())
    });
    let records: Vec<Value> = bodies(&session)
        .into_iter()
        .filter(|body| body["prompt"] == second.as_str())
        .map(|body| body["record"].clone())
        .collect();
    assert!(
        !records.iter().any(|record| record == "prompt-requeued"),
        "not requeued: {records:?}"
    );
    assert!(session.queued_prompts().is_empty());
    assert_eq!(fake.received_method("turn/start").len(), 2, "second not re-sent");
    let b = Conn::new(2);
    let view = adopt(&host, &b, &sid);
    assert!(view.queued().is_empty(), "an adopter does not see it waiting");
    terminate(&host, &a, &sid, &lease);
}
