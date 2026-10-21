//! Command tests: a closure stands in for Slack and a thread-safe in-memory store for Credential
//! Manager. No test reaches the network.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;

use serde_json::json;

use super::*;
use crate::slack::vault::memory::Memory;

const TOKEN: &str = "xoxp-1111-2222-fixture";

type Handler = Box<dyn Fn(&Request) -> Result<Reply, SendError> + Send + Sync>;

struct Fake {
    handler: Handler,
    sent: Mutex<Vec<(String, String)>>,
}

impl Fake {
    fn new(handler: impl Fn(&Request) -> Result<Reply, SendError> + Send + Sync + 'static) -> Arc<Fake> {
        Arc::new(Fake { handler: Box::new(handler), sent: Mutex::new(Vec::new()) })
    }

    fn count(&self, method: &str) -> usize {
        self.sent.lock().unwrap().iter().filter(|(p, _)| p.starts_with(&format!("/api/{method}"))).count()
    }

    fn total(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
}

impl Transport for Fake {
    fn send(&self, req: &Request, headers: &Secret, _limits: Limits) -> Result<Reply, SendError> {
        self.sent.lock().unwrap().push((req.path.clone(), headers.expose().to_string()));
        (self.handler)(req)
    }
}

fn reply(status: u16, retry_after: Option<u64>, body: Value) -> Result<Reply, SendError> {
    Ok(Reply { status, retry_after, body: body.to_string().into_bytes() })
}

fn auth_body() -> Value {
    json!({ "ok": true, "url": "https://example.slack.com/", "team": "Example Workspace", "user": "fixture.user",
            "team_id": "T0FIXTURE1", "user_id": "U0FIXTURE1" })
}

fn search_body() -> Value {
    json!({ "ok": true, "messages": { "paging": { "pages": 1 }, "matches": [{
        "type": "message", "ts": "1700000000.000100", "user": "U0FIXTURE2", "username": "ada",
        "text": "ping <@U0FIXTURE3> about this",
        "channel": { "id": "C0FIXTURE1", "name": "general" } }] } })
}

fn happy(req: &Request) -> Result<Reply, SendError> {
    if req.path.starts_with("/api/auth.test") {
        reply(200, None, auth_body())
    } else if req.path.starts_with("/api/search.messages") {
        reply(200, None, search_body())
    } else if req.path.contains("user=U0FIXTURE2") {
        reply(200, None, json!({ "ok": true, "user": { "profile": { "display_name": "Ada" } } }))
    } else {
        reply(200, None, json!({ "ok": true, "user": { "name": "grace" } }))
    }
}

fn saved_store() -> Arc<Memory> {
    let m = Arc::new(Memory::default());
    vault::save(&*m, &Secret::new(TOKEN.into()), "U0FIXTURE1", "T0FIXTURE1", "example.slack.com").unwrap();
    m
}

fn budget() -> Budget {
    Budget::new(Duration::from_secs(20))
}

fn kind_of(r: &Result<Merged, ApiError>) -> ErrorKind {
    r.as_ref().unwrap_err().kind
}

#[test]
fn disconnect_between_check_and_save_leaves_no_credential() {
    // Disconnect lands after auth.test answered and before the commit.
    let core = Arc::new(Core::new());
    let store = Arc::new(Memory::default());
    let (c, s) = (core.clone(), store.clone());
    let net = Fake::new(move |req| {
        let out = happy(req);
        c.disconnect(&*s).unwrap();
        out
    });
    let r = core.connect_with(&*store, &*net, Secret::new(TOKEN.into()), &budget());
    assert_eq!(r.unwrap_err().message, "connect was superseded");
    assert!(store.empty());

    // Disconnect lands right after the commit: the credential is gone, and a later inbox sends nothing.
    let core = Core::new();
    let net = Fake::new(happy);
    let store = Memory::default();
    assert_eq!(core.connect_with(&store, &*net, Secret::new(TOKEN.into()), &budget()).unwrap().host, "example.slack.com");
    assert!(!store.empty());
    core.disconnect(&store).unwrap();
    assert!(store.empty());
    let sent = net.total();
    assert_eq!(kind_of(&core.inbox(&store, &*net, Instant::now(), &budget())), ErrorKind::Unset);
    assert_eq!(net.total(), sent);
}

#[test]
fn deadline_expiry_prevents_save() {
    let core = Arc::new(Core::new());
    let store = Arc::new(Memory::default());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (entered_tx, release_rx) = (Mutex::new(entered_tx), Mutex::new(release_rx));
    let net = Fake::new(move |req| {
        entered_tx.lock().unwrap().send(()).unwrap();
        let _ = release_rx.lock().unwrap().recv();
        happy(req)
    });
    let before = core.generation();
    let answer = connect_deadline(core.clone(), store.clone(), net.clone(), Secret::new(TOKEN.into()), Duration::from_millis(60));
    entered_rx.recv().unwrap();
    match answer {
        Answer::Error { error } => assert_eq!(error.kind, ErrorKind::Network),
        Answer::Ok(_) => panic!("connect should have timed out"),
    }
    assert!(core.generation() >= before + 2, "connect took one generation, the expiry another");
    // The abandoned exchange now finishes; its commit must find the generation moved on.
    release_tx.send(()).unwrap();
    let start = Instant::now();
    while Arc::strong_count(&store) > 1 && start.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(Arc::strong_count(&store), 1, "worker did not finish");
    assert!(store.empty());
}

#[test]
fn second_inbox_call_joins_the_first() {
    let core = Core::new();
    let store = saved_store();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (entered_tx, release_rx) = (Mutex::new(entered_tx), Mutex::new(release_rx));
    let first = AtomicBool::new(true);
    let net = Fake::new(move |req| {
        if req.path.starts_with("/api/search.messages") && first.swap(false, Ordering::SeqCst) {
            entered_tx.lock().unwrap().send(()).unwrap();
            let _ = release_rx.lock().unwrap().recv();
        }
        happy(req)
    });
    let base = Instant::now();
    let (a, b) = std::thread::scope(|s| {
        let a = s.spawn(|| core.inbox(&*store, &*net, base, &budget()));
        entered_rx.recv().unwrap();
        let b = s.spawn(|| core.inbox(&*store, &*net, base, &budget()));
        std::thread::sleep(Duration::from_millis(150));
        release_tx.send(()).unwrap();
        (a.join().unwrap(), b.join().unwrap())
    });
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a, b);
    assert_eq!(a.items.len(), 1);
    assert_eq!(net.count("search.messages"), 4, "one fetch served both calls");
    let sent = net.total();
    // Within 30 s the last result comes back without a send; after it, a new fetch runs.
    assert_eq!(core.inbox(&*store, &*net, base + Duration::from_secs(29), &budget()).unwrap(), a);
    assert_eq!(net.total(), sent);
    core.inbox(&*store, &*net, base + Duration::from_secs(31), &budget()).unwrap();
    assert_eq!(net.count("search.messages"), 8);
}

#[test]
fn rate_hold_refuses_without_sending() {
    let core = Core::new();
    let store = saved_store();
    let net = Fake::new(|req| {
        if req.path.starts_with("/api/search.messages") {
            reply(429, Some(120), json!({ "ok": false, "error": "ratelimited" }))
        } else {
            happy(req)
        }
    });
    let base = Instant::now();
    let first = core.inbox(&*store, &*net, base, &budget());
    let e = first.unwrap_err();
    assert_eq!((e.kind, e.retry_after), (ErrorKind::Rate, Some(120)));
    assert_eq!(net.total(), 1, "the failing source ends the call");
    // Past the spacing window the hold alone refuses: nothing is sent.
    let second = core.inbox(&*store, &*net, base + Duration::from_secs(31), &budget());
    let e = second.unwrap_err();
    assert_eq!(e.kind, ErrorKind::Rate);
    assert!(e.retry_after.is_some_and(|s| (1..=120).contains(&s)));
    assert_eq!(net.total(), 1, "a held call never sends");
    // Disconnect clears the hold.
    core.disconnect(&*store).unwrap();
    vault::save(&*store, &Secret::new(TOKEN.into()), "U0FIXTURE1", "T0FIXTURE1", "example.slack.com").unwrap();
    core.inbox(&*store, &*net, base + Duration::from_secs(62), &budget()).unwrap_err();
    assert_eq!(net.total(), 2);
}

#[test]
fn status_never_serialises_a_token() {
    let store = saved_store();
    let json = serde_json::to_string(&status_with(&*store)).unwrap();
    assert_eq!(json, r#"{"host":"example.slack.com","tokenSaved":true}"#);
    assert!(!json.contains("xoxp"));
    let empty = serde_json::to_string(&status_with(&Memory::default())).unwrap();
    assert_eq!(empty, r#"{"host":null,"tokenSaved":false}"#);
    // A remote error body that echoes the token is redacted before it can reach the UI.
    let core = Core::new();
    let net = Fake::new(|_| reply(200, None, json!({ "ok": false, "error": format!("bad {TOKEN}") })));
    let e = core.connect_with(&Memory::default(), &*net, Secret::new(TOKEN.into()), &budget()).unwrap_err();
    let out = serde_json::to_string(&Answer::<Connected>::Error { error: e }).unwrap();
    assert!(!out.contains(TOKEN), "{out}");
    assert!(out.contains("error"));
}

#[test]
fn names_fetch_runs_without_the_lock() {
    let core = Arc::new(Core::new());
    let store = saved_store();
    let free = Arc::new(AtomicUsize::new(0));
    let busy = Arc::new(AtomicUsize::new(0));
    let (c, f, b) = (core.clone(), free.clone(), busy.clone());
    let net = Fake::new(move |req| {
        if c.state.try_lock().is_ok() { f.fetch_add(1, Ordering::SeqCst) } else { b.fetch_add(1, Ordering::SeqCst) };
        happy(req)
    });
    let out = core.inbox(&*store, &*net, Instant::now(), &budget()).unwrap();
    assert!(net.count("users.info") >= 2, "senders and mentioned users are looked up");
    assert_eq!(busy.load(Ordering::SeqCst), 0, "a send ran while the lock was held");
    assert_eq!(free.load(Ordering::SeqCst), net.total());
    assert_eq!(out.items[0].sender, "Ada");
    assert_eq!(out.items[0].text, "ping @grace about this");
    // Cached names are not fetched again after the spacing window.
    let before = net.count("users.info");
    core.inbox(&*store, &*net, Instant::now() + Duration::from_secs(31), &budget()).unwrap();
    assert_eq!(net.count("users.info"), before);
}

#[test]
fn connect_commit_drops_inbox_fetched_mid_connect() {
    // An inbox fetch for the old account finishes while Connect waits on auth.test.
    let core = Arc::new(Core::new());
    let store = saved_store();
    let inner = Fake::new(happy);
    let base = Instant::now();
    let (c, s, i) = (core.clone(), store.clone(), inner.clone());
    let net = Fake::new(move |req| {
        if req.path.starts_with("/api/auth.test") {
            c.inbox(&*s, &*i, base, &budget()).unwrap();
        }
        happy(req)
    });
    core.connect_with(&*store, &*net, Secret::new(TOKEN.into()), &budget()).unwrap();
    assert_eq!(inner.count("search.messages"), 4);
    // Inside the spacing window, yet the old result is gone: this fetches again.
    core.inbox(&*store, &*inner, base + Duration::from_secs(1), &budget()).unwrap();
    assert_eq!(inner.count("search.messages"), 8, "the mid-connect result was served after Connect");
}

#[test]
fn disconnect_clear_is_not_repopulated() {
    let core = Arc::new(Core::new());
    let store = saved_store();
    let first = AtomicBool::new(true);
    let (c, s) = (core.clone(), store.clone());
    let net = Fake::new(move |req| {
        if req.path.starts_with("/api/search.messages") && first.swap(false, Ordering::SeqCst) {
            c.disconnect(&*s).unwrap();
        }
        happy(req)
    });
    let base = Instant::now();
    assert!(core.inbox(&*store, &*net, base, &budget()).is_err());
    assert!(lock(&core.flight).last.is_none(), "a fetch that lost its generation cached its result");
    vault::save(&*store, &Secret::new(TOKEN.into()), "U0FIXTURE1", "T0FIXTURE1", "example.slack.com").unwrap();
    let sent = net.total();
    core.inbox(&*store, &*net, base + Duration::from_secs(1), &budget()).unwrap();
    assert!(net.total() > sent, "the cleared result was served");
}

#[test]
fn errors_are_not_replayed_after_the_flight() {
    let core = Core::new();
    let store = saved_store();
    let fail = AtomicBool::new(true);
    let net = Fake::new(move |req| {
        if req.path.starts_with("/api/search.messages") && fail.swap(false, Ordering::SeqCst) {
            reply(500, None, json!({}))
        } else {
            happy(req)
        }
    });
    let base = Instant::now();
    assert_eq!(kind_of(&core.inbox(&*store, &*net, base, &budget())), ErrorKind::Endpoint);
    let sent = net.total();
    core.inbox(&*store, &*net, base + Duration::from_secs(1), &budget()).unwrap();
    assert!(net.total() > sent, "the error was replayed inside the spacing window");
}

#[test]
fn expired_budget_refuses_save() {
    let core = Core::new();
    let store = Memory::default();
    let net = Fake::new(|req| {
        std::thread::sleep(Duration::from_millis(150));
        happy(req)
    });
    let r = core.connect_with(&store, &*net, Secret::new(TOKEN.into()), &Budget::new(Duration::from_millis(60)));
    assert_eq!(r.unwrap_err().kind, ErrorKind::Network);
    assert!(store.empty(), "a connect past its budget saved");
}

#[test]
fn failed_connect_keeps_the_hold() {
    let core = Core::new();
    let store = saved_store();
    let net = Fake::new(|req| {
        if req.path.starts_with("/api/search.messages") {
            reply(429, Some(120), json!({ "ok": false, "error": "ratelimited" }))
        } else {
            happy(req)
        }
    });
    let base = Instant::now();
    assert_eq!(kind_of(&core.inbox(&*store, &*net, base, &budget())), ErrorKind::Rate);
    let other = Memory::default();
    let e = core.connect_with(&other, &*net, Secret::new(TOKEN.into()), &budget()).unwrap_err();
    assert_eq!((e.kind, e.message.as_str()), (ErrorKind::Rate, "ratelimited"));
    assert!(other.empty());
    assert!(core.hold.held_for(Instant::now()).is_some(), "a failed Connect cleared the hold");
    let sent = net.total();
    assert_eq!(kind_of(&core.inbox(&*store, &*net, base + Duration::from_secs(31), &budget())), ErrorKind::Rate);
    assert_eq!(net.total(), sent);
}

#[test]
fn read_error_is_not_unset() {
    struct Broken;
    impl Store for Broken {
        fn read(&self) -> Result<Option<crate::credman::Cred>, String> {
            Err("CredReadW failed (5)".to_string())
        }
        fn write(&self, _: &crate::credman::Cred) -> Result<(), String> {
            Err("no".to_string())
        }
        fn delete(&self) -> Result<(), String> {
            Err("no".to_string())
        }
    }
    let core = Core::new();
    let net = Fake::new(happy);
    assert_eq!(kind_of(&core.inbox(&Broken, &*net, Instant::now(), &budget())), ErrorKind::Endpoint);
    assert_eq!(net.total(), 0);
    let st = status_with(&Broken);
    assert!(!st.token_saved);
    assert_eq!(st.error.as_ref().map(|e| e.kind), Some(ErrorKind::Endpoint));
    assert!(serde_json::to_string(&st).unwrap().contains("\"error\""));
    // An entry this build would not have written still reads as not connected, with no error.
    let bad = Memory::default();
    *bad.saved.lock().unwrap() = Some(("U0FIXTURE1".into(), "T0FIXTURE1 evil.com".into(), TOKEN.into()));
    assert_eq!(kind_of(&core.inbox(&bad, &*net, Instant::now(), &budget())), ErrorKind::Unset);
    assert!(status_with(&bad).error.is_none());
}
