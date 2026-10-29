//! Protocol v1: typed frames over the authenticated session pipe.
//!
//! One explicit version, not a compatibility framework. A mismatch is refused without touching the live host or any
//! hosted session; the stable activation endpoint keeps its own small
//! slice-0 shape so an incompatible Vidar can still show the Falcon window.
//!
//! A connection is multiplexed: the client sends [`Request`]s, and the server
//! sends [`ServerFrame::Response`] for each one plus [`ServerFrame::Event`]
//! pushes for every session the connection has attached. Responses carry the
//! originating request id, so a client never has to infer ordering.
//!
//! Mutating operations additionally carry the session id and the child
//! generation. A reply that never arrives is resolved by asking, never by
//! retrying: [`Outcome::DeliveryUnknown`] is a terminal answer that says the
//! write to the child may or may not have landed.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_V1: u32 = 1;
pub const PROTOCOL_V2: u32 = 2;
pub const PROTOCOL_VERSION: u32 = PROTOCOL_V2;

/// The capability that admits [`Op::SteerPrompt`].
pub const CAPABILITY_STEER: &str = "steer";
pub const CAPABILITY_SETS_ECHO: &str = "sets-echo";
/// What this host serves beyond the protocol version's base set, listed in
/// the v2 negotiate reply's `capabilities` (additive; an older host sends
/// none). An op added inside a version is advertised there instead of bumping
/// the version, and a client never sends one the connected host did not
/// list: a host that cannot parse a request drops the whole connection, and
/// every hosted tab's lease with it (`serve.rs`, the request read loop).
pub const CAPABILITIES: &[&str] = &[CAPABILITY_STEER, CAPABILITY_SETS_ECHO];
/// The host can run hosted Codex turns. Not in [`CAPABILITIES`]: the host
/// lists it only when Codex resolves AND its driver runs turns
/// (`serve::negotiate`), and a client spawns a hosted Codex tab only on a
/// host that listed it; `supported_agents` alone says the runtime exists.
pub const CAPABILITY_CODEX_TURNS: &str = "codex_turns";
/// The host can relay allowlisted Codex reads to their requesting connection.
pub const CAPABILITY_CODEX_QUERY: &str = "codex_query";
/// The host's hosted Codex prompt takes one `skill` block beside its text (`turns::input`).
/// Listed with [`CAPABILITY_CODEX_TURNS`]; a client asks `skills/list` only on a host that
/// listed it.
pub const CAPABILITY_CODEX_SKILLS: &str = "codex_skills";
/// The host admits a Codex spawn with `profile: "bare"` (`codex.rs`): the child runs on the
/// Bare home's allowlisted env and the admitted payload. Listed with [`CAPABILITY_CODEX_TURNS`],
/// so only when Codex resolves; a client sends a profiled Codex spawn only to a host that listed
/// it (an older host refuses the profile outright).
pub const CAPABILITY_CODEX_BARE: &str = "codex_bare";
/// The key a Codex Bare spawn reply carries [`CodexBareSpawn`] under, beside `session`.
pub const CODEX_BARE_SPAWN_KEY: &str = "codex_bare";

/// What a hosted Codex Bare spawn ran, in its reply (key [`CODEX_BARE_SPAWN_KEY`]); the
/// profile, env names and admitted payload path ride in `SessionSummary` as for Claude.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct CodexBareSpawn {
    /// The Codex executable the child runs.
    pub executable: String,
    /// `installed` (the Codex install the Bare env's Path finds, the one Vidar runs in-process)
    /// or `bundle` (this host's own runtime: the pinned store, else its installed fallback).
    pub source: String,
    /// The package version beside that executable, when one is readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The `pwsh.exe` the child's Path finds after the WindowsApps folders are dropped
    /// (`bare_env::drop_app_alias_dirs`); None means Codex's shell falls back to Windows
    /// PowerShell 5.1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pwsh: Option<String>,
    /// The admitted `SpawnParams.codex_home` the child runs on; None when none was asked.
    /// Vidar ends a spawn whose request carried a home this does not echo (an older host).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_home: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
}

#[allow(dead_code)] // ALL and from_wire are read by the Vidar crate, which compiles this file too
impl Agent {
    /// Every variant, in declaration order.
    pub const ALL: [Agent; 2] = [Agent::Claude, Agent::Codex];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// The wire parse: an exact `as_str` match, else `None`.
    pub fn from_wire(s: &str) -> Option<Agent> {
        Agent::ALL.into_iter().find(|a| a.as_str() == s)
    }
}

/// Hard bound on one protocol frame. Sized above [`crate::process::LINE_CAP`]
/// so a child line Falcon accepted can always be re-framed with its envelope;
/// the activation endpoint keeps a much smaller bound of its own.
pub const MAX_SESSION_FRAME: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub op: Op,
}

/// The controller lease: proof that this connection is the one UI driving a
/// session.
///
/// Both halves are load-bearing and neither is redundant. The `token` is a
/// fresh unguessable value per acquisition, so a client cannot forge one or
/// keep using one after release. The `revision` is monotonic per session and
/// advances on every lease change, which is what lets a *stale* holder be
/// refused with a specific reason rather than a generic mismatch — and is the
/// fence the slice-4 transfer will prepare and commit against.
///
/// A lease is bound to the connection that acquired it. When that connection
/// goes away the lease is released and the revision advances, so a client that
/// crashes mid-turn cannot strand a session under a controller that no longer
/// exists.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Lease {
    pub token: String,
    pub revision: u64,
}

/// Why a mutation carrying a lease was refused.
///
/// Named separately from the error text because a client must be able to act on
/// the difference: `Vacant` means acquire and retry, `Mismatch` means another UI
/// holds the session and retrying is wrong.
///
/// There is deliberately no `Stale` variant. One existed and was unreachable:
/// every acquisition issues a fresh token, so "right token, wrong revision"
/// cannot arise from any lease this server hands out, and a caller in that
/// situation received `Mismatch` — which tells a client NOT to retry, the
/// opposite of what a stale holder should do. A named outcome no code path can
/// produce is worse than one that is absent, and the unit test covering it had
/// to fabricate a lease the server never issues, which is how it went unnoticed.
/// A transfer advances the revision under a held token and will need it
/// back; it should return then, with a path that can actually reach it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeaseRefusal {
    /// No controller holds this session at all.
    Vacant,
    /// A different lease holds it: another token, or a revision this server
    /// never issued for that token.
    Mismatch,
}

impl LeaseRefusal {
    pub fn message(self, current: u64) -> String {
        match self {
            Self::Vacant => "no controller holds this session".into(),
            Self::Mismatch => {
                format!("another client holds the controller lease at revision {current}")
            }
        }
    }
}

/// Every client operation in protocol v1.
///
/// Mutating operations on a live child carry the [`Lease`]. Read-only ones
/// (`List`, `Attach`, `Hydrate`, `Detach`) do not, so a second client can
/// attach and rebuild its view without disturbing the controller. `Release`
/// does not either: it is only valid once the child has exited, at which point
/// there is nothing left to control.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Op {
    /// Must be the first request on a connection. Carries the registry's attach
    /// secret, so slice-0 authentication and version agreement are one step and
    /// no unauthenticated frame is ever dispatched.
    Negotiate {
        protocol: u32,
        client: String,
        secret: String,
    },
    List,
    Spawn(SpawnParams),
    Attach {
        session: String,
    },
    /// Fetch journal records for rebuilding, `after` exclusive, bounded by the
    /// `through` the attach returned.
    ///
    /// Paged deliberately. A session's journal can outgrow one frame, and the
    /// alternatives are both wrong: truncating silently would hand a client an
    /// incomplete history it believes is complete, and refusing the attach
    /// would make a long session permanently unattachable. Paging keeps every
    /// frame inside the bound while the client still sees all of it.
    Hydrate {
        session: String,
        after: u64,
        through: u64,
    },
    Detach {
        session: String,
    },
    /// Take the controller lease for a session, if it is free.
    ///
    /// Deliberately never steals. Taking control away from a live holder is the
    /// slice-4 transfer, which fences the source at a journal barrier first;
    /// a bare steal here would let two UIs both believe they are driving. The
    /// lease is freed automatically when its holder's connection ends, so a
    /// dead client cannot hold a session hostage.
    AcquireControl {
        session: String,
    },
    /// Give up the lease. Idempotent, and refused if another client holds it.
    ReleaseControl {
        session: String,
        lease: Lease,
    },
    /// Graceful: EOF to the child, bounded wait, then the Job. The conversation
    /// stays resumable.
    Close {
        session: String,
        lease: Lease,
    },
    /// Drop Falcon's reservation without killing anything. Only valid once the
    /// child has exited — so there is no live child to control and no lease.
    Release {
        session: String,
    },
    /// Immediate Job termination, no graceful phase.
    Terminate {
        session: String,
        lease: Lease,
    },
    /// Queue a prompt. Falcon owns the queue, not the sidecar.
    ///
    /// This returns as soon as the prompt is durably queued, carrying the
    /// `prompt` id to retract it by — it does **not** wait for the agent to
    /// answer. Ownership is the point: while the sidecar held the queue, a
    /// prompt was unretractable and unenumerable the moment it was written,
    /// and every prompt still waiting died with the sidecar. Falcon holds them,
    /// journals them, and hands the child exactly one at a time.
    Submit {
        session: String,
        generation: u64,
        lease: Lease,
        /// Text, or Messages content blocks, exactly as the renderer sends today.
        content: serde_json::Value,
    },
    /// Drop a queued prompt that has not reached the child yet.
    ///
    /// Refused once dispatched: at that point the agent may already be acting
    /// on it, and reporting a retraction that did not happen is worse than
    /// refusing one that could not.
    RetractPrompt {
        session: String,
        generation: u64,
        lease: Lease,
        prompt: String,
    },
    /// Dispatch a queued prompt now, into the running turn, without
    /// interrupting it (the Steer button). Agent-agnostic: the host hands the
    /// prompt over as a `user` line marked `steer`, and each agent runtime
    /// folds it its own way. With no turn running it is an ordinary dispatch.
    /// Refused once the prompt is dispatched or retracted, and by an agent
    /// that cannot steer yet (hosted Codex `turn/steer` before Codex names
    /// the running turn); a refused prompt stays queued.
    /// Send only to a host whose negotiate reply listed [`CAPABILITY_STEER`].
    SteerPrompt {
        session: String,
        generation: u64,
        lease: Lease,
        prompt: String,
    },
    Interrupt {
        session: String,
        generation: u64,
        lease: Lease,
    },
    /// Relay an allowlisted read-only app-server request. Its reply is returned
    /// only on this connection's response frame and is never journaled.
    /// Send only when negotiate listed [`CAPABILITY_CODEX_QUERY`].
    Query {
        session: String,
        generation: u64,
        method: String,
        params: serde_json::Value,
    },
    PermissionResponse {
        session: String,
        generation: u64,
        lease: Lease,
        request: String,
        behavior: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_input: Option<serde_json::Value>,
    },
    SetModel {
        session: String,
        generation: u64,
        lease: Lease,
        model: String,
    },
    /// Session-scoped reasoning effort; `level` must be in `effort_levels()`.
    SetEffort {
        session: String,
        generation: u64,
        lease: Lease,
        level: String,
    },
    SetPermissionMode {
        session: String,
        generation: u64,
        lease: Lease,
        mode: String,
    },
    /// Replace this connection's bus subscriptions. No session, no lease:
    /// only a completed negotiate is required. A pattern ending `.*`
    /// matches everything with that prefix; any
    /// other string matches exactly.
    Subscribe {
        topics: Vec<String>,
    },
    /// Fan a message out to every subscriber on this host whose pattern
    /// matches `topic`, and reply `{ delivered: <n> }`. `reply_to`, when set,
    /// names the topic the answer should land on — a request is exactly a
    /// Publish with `reply_to` set and a subscriber listening there first.
    /// Live-only: a subscriber that is not connected right now never sees it,
    /// and the requester's own timeout is the fallback, same as the
    /// file-based bridges this replaces.
    Publish {
        topic: String,
        /// Wire key `msg_id`, not `id`: `Request` flattens `Op` beside its own
        /// `id: u64`, and a second `id` key on the same JSON object is a
        /// deserialize error (`serde(flatten)` rejects the duplicate field
        /// rather than picking one) — verified against this exact shape
        /// before landing. The Rust name stays `id` because that is what it
        /// means; only the wire key differs from the request envelope's.
        #[serde(rename = "msg_id")]
        id: String,
        payload: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to: Option<String>,
    },
}

impl Op {
    /// The op's wire tag (`"spawn"`, `"acquire-control"`, …) without
    /// serialising it: a `Submit` can carry a frame-sized payload, and the
    /// client reads this for error text while holding its control lock.
    /// Must equal the serde `op` tag; a test checks every variant.
    pub fn name(&self) -> &'static str {
        match self {
            Op::Negotiate { .. } => "negotiate",
            Op::List => "list",
            Op::Spawn(_) => "spawn",
            Op::Attach { .. } => "attach",
            Op::Hydrate { .. } => "hydrate",
            Op::Detach { .. } => "detach",
            Op::AcquireControl { .. } => "acquire-control",
            Op::ReleaseControl { .. } => "release-control",
            Op::Close { .. } => "close",
            Op::Release { .. } => "release",
            Op::Terminate { .. } => "terminate",
            Op::Submit { .. } => "submit",
            Op::RetractPrompt { .. } => "retract-prompt",
            Op::SteerPrompt { .. } => "steer-prompt",
            Op::Interrupt { .. } => "interrupt",
            Op::Query { .. } => "query",
            Op::PermissionResponse { .. } => "permission-response",
            Op::SetModel { .. } => "set-model",
            Op::SetEffort { .. } => "set-effort",
            Op::SetPermissionMode { .. } => "set-permission-mode",
            Op::Subscribe { .. } => "subscribe",
            Op::Publish { .. } => "publish",
        }
    }
}

/// A gateway module id (contracts/modules.json `idPattern` `^[a-z][a-z0-9-]{0,31}$`).
/// Inline bytes keep it `Copy`; on the wire it is the bare id string. Which ids
/// exist is the pack registry's business: Falcon admits any well-formed id and
/// vendor-prepare.ps1 refuses one with no gateway pack behind it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Gateway { len: u8, bytes: [u8; Gateway::MAX] }
impl Gateway {
    pub const MAX: usize = 32;
    pub fn new(id: &str) -> Option<Self> {
        let b = id.as_bytes();
        let ok = !b.is_empty() && b.len() <= Self::MAX && b[0].is_ascii_lowercase()
            && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
        if !ok { return None; }
        let mut bytes = [0u8; Self::MAX];
        bytes[..b.len()].copy_from_slice(b);
        Some(Self { len: b.len() as u8, bytes })
    }
    pub fn as_str(&self) -> &str {
        // Only `new` builds one, from ASCII it checked.
        std::str::from_utf8(&self.bytes[..self.len as usize]).unwrap_or("")
    }
}
impl std::fmt::Debug for Gateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Gateway({})", self.as_str())
    }
}
impl Serialize for Gateway {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}
impl<'de> Deserialize<'de> for Gateway {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let id = <std::borrow::Cow<'de, str>>::deserialize(d)?;
        Self::new(&id).ok_or_else(|| serde::de::Error::custom("invalid gateway id"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
    pub set: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SpawnParams {
    /// Required by protocol v2. Protocol v1 maps an omitted agent to Claude.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<Agent>,
    pub cwd: String,
    /// Declared before `model` only for key order: Vidar's client serialises this
    /// type and sent `permission_mode` before `model` when it built the frame by
    /// hand. The host reads both orders.
    pub permission_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Reasoning effort for a Claude session; must be in `effort_levels()`.
    /// Codex spawns ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Resuming an existing conversation. The reservation is keyed on this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    /// Per-session control-bus secret, exported to the hosted child as
    /// `VIDAR_CTL_SECRET`. Optional both ways so an older host or client
    /// interoperates: omitted on the wire when None, None when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctl_secret: Option<String>,
    /// Built rules file (`<vidar>\runtime\rules\built\<hash12>.md`) the Claude
    /// sidecar appends to the system prompt. Optional both ways, like
    /// `ctl_secret`; the host admits it only under that directory (`claude.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules_file: Option<String>,
    /// The Vidar tab's name (`Amber Raptor`), exported to the hosted child as
    /// `VIDAR_TAB_NAME` and echoed in `SessionSummary` so a re-adopting Vidar
    /// names the tab the same. Optional both ways, like `rules_file`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_name: Option<String>,
    /// Gateway identity only; credentials are resolved locally by vendor preparation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<Gateway>,
    /// Launch profile id (`bare`: `<root>\profiles\bare\claude.json`, or `codex.json` for a
    /// Codex spawn on a host that listed [`CAPABILITY_CODEX_BARE`]); refused with
    /// `rules_file` or `gateway`. The host builds the child's env from the allowlist and the
    /// profile instead of inheriting its own (`claude.rs`). Optional both ways, like `gateway`;
    /// an older host ignores it, and the missing echo in `SessionSummary.profile` tells Vidar so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// A Bare row's built payload (`<home>\layer\payload-<hash12>.md`), handed to the sidecar
    /// as `--payload` (Codex: read once and passed as `-c developer_instructions=`) in place of
    /// the profile's static one. Profile only; the host admits it
    /// only under the profile home's `layer\` (`claude.rs`). Optional both ways, like `profile`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_file: Option<String>,
    /// A Claude Bare MCP config directly under the profile home's layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_file: Option<String>,
    /// The launcher row key the payload was built from. Echoed in `SessionSummary` so a
    /// re-adopted tab's /clear rebuilds the same row. Optional both ways.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_key: Option<String>,
    /// Exact launch pick; Some([]) explicitly selects no sets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sets: Option<Vec<SetRef>>,
    /// A Claude Bare row's rune-set plugin folders (`<home>\layer\plugins\<set>-<hash12>\`,
    /// `bare/set_plugin.rs`), in ref order, handed to the sidecar as `--set-plugin` after the
    /// profile's own plugins. Profile only; the host admits each one under the profile home's
    /// `layer\plugins\` and drops (never refuses on) any that fail (`claude.rs`). Optional both
    /// ways: omitted on the wire when empty, empty when absent; an older host ignores it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub set_plugin_dirs: Vec<String>,
    /// A Codex Bare row's set-combination home (`<home>\codex-homes\<hash12>`, holding the
    /// combination's `config.toml` with its MCP server tables), used as `CODEX_HOME` in place
    /// of the profile's own. Codex profile only; the host admits it with
    /// `codex_payload::admit_codex_home` and refuses the spawn on any failure (`codex.rs`).
    /// Echoed as `CodexBareSpawn.codex_home`; None keeps the profile's home. Optional both ways.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_home: Option<String>,
    /// A Claude Bare row's set-combination config dir (`<home>\claude-homes\<hash12>`), used as
    /// `CLAUDE_CONFIG_DIR` (and `VIDAR_AGENT_HOME`) in place of the profile overlay's own. Claude
    /// profile only; after the overlay's own admission the host admits it with
    /// `claude::admit_claude_config` (under the home, an existing folder, and either the overlay's
    /// dir or a `claude-homes` combination folder) and refuses the spawn on any failure. Echoed as
    /// `SessionSummary.claude_config_dir`; None keeps the overlay's dir. Optional both ways: an
    /// older host ignores it, and the missing echo tells Vidar so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_config_dir: Option<String>,
    /// A Claude Bare session's plugin runes, by name as the vault holds them (Vidar builds the
    /// list from the session's Rune Vault; the host never picks what loads). Each name matches
    /// `^[a-z0-9][a-z0-9-]{0,63}$` and is admitted only as `<install root>\plugins\<name>`, an
    /// existing directory with no reparse point on it or on `plugins\`; the install root is the
    /// host's own (from its `--registry`), never the client's. Handed to the sidecar as
    /// `--set-plugin` after `set_plugin_dirs`, in order. Profile only. Unlike `set_plugin_dirs`,
    /// any name that fails refuses the whole spawn (`claude/spawn_args.rs`). Optional both ways:
    /// omitted on the wire when empty, empty when absent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugin_names: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ServerFrame {
    Response(Response),
    Event(Event),
    /// A bus message fanned out to a matching subscriber. Never `Event`: a
    /// reader that pattern-matches on `t == "event"` (`falcon/events.rs`'s session
    /// reader loop) must not mistake one for a session push.
    Bus(BusFrame),
}

/// One message on the bus: a `Publish` as delivered to a subscriber.
///
/// No `seq` — the bus is live-only with no journal, so there is nothing to
/// detect a gap against (see [`Op::Publish`]).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BusFrame {
    pub topic: String,
    pub id: String,
    /// The publisher's negotiated client name. Untrusted and cosmetic, same
    /// as `Event`'s connection-level `client_name` — it identifies, it does
    /// not authorise.
    pub from: String,
    pub payload: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Response {
    pub request: u64,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The terminal result of a mutating command. `DeliveryUnknown` exists because
/// a write to the child can fail after the bytes may already have been
/// consumed; Falcon reports that honestly rather than retrying an ambiguous
/// write and risking a duplicate prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Applied,
    Failed,
    DeliveryUnknown,
}

impl Response {
    pub fn applied(request: u64, payload: serde_json::Value) -> Self {
        Self {
            request,
            outcome: Outcome::Applied,
            payload: Some(payload),
            error: None,
        }
    }

    pub fn failed(request: u64, error: impl Into<String>) -> Self {
        Self {
            request,
            outcome: Outcome::Failed,
            payload: None,
            error: Some(error.into()),
        }
    }

    pub fn delivery_unknown(request: u64, error: impl Into<String>) -> Self {
        Self {
            request,
            outcome: Outcome::DeliveryUnknown,
            payload: None,
            error: Some(error.into()),
        }
    }
}

/// A push from a session. `seq` is a dense, per-session event counter,
/// strictly increasing from 1 over exactly the events that were broadcast —
/// never over the silent records a session also journals — so a client can
/// detect a dropped event by checking its own stream for a gap.
///
/// `seq` is not a journal position and must never be compared to one. The
/// `through` an attach returns (see [`Op::Hydrate`] and
/// `crate::session::Session::attach`) lives on the journal's number line,
/// which also advances for records nothing ever broadcast, so `through` can
/// be numerically greater than or equal to the `seq` of an event delivered
/// live after that same attach. Hydration reads the journal up to `through`;
/// it never replays by `seq`, and a client must accept every event delivered
/// live after attach rather than filtering it against `through`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Event {
    pub session: String,
    pub generation: u64,
    pub seq: u64,
    #[serde(flatten)]
    pub body: EventBody,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum EventBody {
    /// A durable semantic record, broadcast after its journal append. The
    /// journal stores the original record rather than this wire envelope.
    Record {
        body: serde_json::Value,
    },
    /// One verbatim line from the Claude sidecar's stdout.
    Agent {
        line: serde_json::Value,
    },
    /// A child stdout line that exceeded the cap and was dropped.
    Overflow {
        bytes: u64,
    },
    /// A child stderr line, for diagnosis only.
    Diagnostic {
        text: String,
    },
    Exit {
        code: Option<i32>,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SessionSummary {
    pub session: String,
    pub generation: u64,
    pub agent: String,
    pub cwd: String,
    pub conversation: Option<String>,
    pub pid: u32,
    pub model: Option<String>,
    pub permission_mode: String,
    pub attached: usize,
    pub exited: Option<i32>,
    /// Prompts Falcon holds that have not reached the child, oldest first.
    /// Visible here because a reconnecting client must be able to see — and
    /// retract — work it queued before it went away.
    #[serde(default)]
    pub queued_prompts: Vec<String>,
    /// Ids of permission requests this session still has open (state
    /// `Opened`, not yet answered, settled or cancelled), oldest first order
    /// not guaranteed. Visible here so a client with two hosted sessions can
    /// tell which one needs attention without attaching to each in turn.
    #[serde(default)]
    pub pending_permissions: Vec<String>,
    /// Set once this session has lost a journal append. It still streams and
    /// can still be read; it will not accept another mutation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded: Option<String>,
    /// The last client name that acquired the controller lease, kept after
    /// the lease is released (`None` only if nobody ever held it). Vidar reads
    /// it on startup to re-adopt the sessions a release swap left behind, and
    /// skips ones last driven elsewhere (a Jettisoned shell). `default` keeps
    /// an older host, which never sends it, parseable.
    #[serde(default)]
    pub last_holder: Option<String>,
    /// The `SpawnParams.rules_file` this host admitted and passed on. Its
    /// presence after a rules-bearing spawn is Vidar's proof the host is new
    /// enough to honour it; an older host never sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules_file: Option<String>,
    /// The `SpawnParams.tab_name` this host admitted (Claude sessions). A
    /// re-adopt after a Vidar swap reads it back as the tab's title; an older
    /// host never sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_name: Option<String>,
    /// Gateway identity only; credentials are resolved locally by vendor preparation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<Gateway>,
    /// The `SpawnParams.profile` this host admitted and built the child's env from. Vidar
    /// refuses (and ends) a profiled spawn whose reply lacks it; a re-adopt keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Names (never values) of the env a profiled child was given, sorted; Vidar records them
    /// in the launch manifest. Absent for a default spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_names: Option<Vec<String>>,
    /// The `SpawnParams.payload_file` this host admitted and passed as `--payload`. Vidar
    /// refuses (and ends) a payload-bearing spawn whose reply lacks it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_file: Option<String>,
    /// The `SpawnParams.row_key` this host admitted; a re-adopt reads it back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sets: Option<Vec<SetRef>>,
    /// The admitted `SpawnParams.claude_config_dir` the child runs on; None when none was asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_config_dir: Option<String>,
}

/// The permission behaviours a client may send. `bypassPermissions` and
/// `dontAsk` have no representation here at all, matching the refusal already
/// enforced in Vidar's `agent.rs` and in the sidecar.
pub const ALLOWED_BEHAVIORS: &[&str] = &["allow", "deny"];

/// The permission modes a hosted Claude session may start in or switch to.
/// A launcher entry cannot widen it. Single source: `contracts/permission-modes.json`
/// at the repo root, also read by the frontend and the sidecar. The path is
/// relative to this file, so it resolves the same from both crates.
pub static ALLOWED_MODES: std::sync::LazyLock<Vec<&'static str>> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!("../../contracts/permission-modes.json"))
        .expect("contracts/permission-modes.json is a JSON array of strings")
});

/// The effort levels a hosted Claude session may start with.
/// Single source: `contracts/effort-levels.json` at the repo root.
pub fn effort_levels() -> Vec<&'static str> {
    serde_json::from_str(include_str!("../../contracts/effort-levels.json"))
        .expect("contracts/effort-levels.json is a JSON array of strings")
}

pub fn valid_conversation_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

// `falcon_shell` is set for the whole src-falcon crate (its build.rs). The gate
// keeps these tests out of src-tauri, which compiles this file too by `#[path]`
// (falcon.rs): they would run twice, and the last one reaches the
// shell-only `crate::process`. Everything above the tests must stay free of
// `crate::` references for the same reason.
#[cfg(all(test, falcon_shell))]
mod tests {
    use super::*;

    #[test]
    fn requests_round_trip_through_their_tag() {
        let request = Request {
            id: 7,
            op: Op::Spawn(SpawnParams {
                agent: Some(Agent::Claude),
                // checkout root at test time (src-falcon's parent), not a machine path
                cwd: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .expect("CARGO_MANIFEST_DIR has a parent")
                    .display()
                    .to_string(),
                model: Some("sonnet".into()),
                effort: None,
                permission_mode: "default".into(),
                resume: None,
                ctl_secret: None,
                rules_file: None,
                tab_name: None,
                gateway: None,
                profile: None,
                payload_file: None,
                mcp_file: None,
                row_key: None,
                sets: None,
                set_plugin_dirs: Vec::new(), codex_home: None, claude_config_dir: None, plugin_names: Vec::new(),
            }),
        };
        let text = serde_json::to_string(&request).unwrap();
        assert!(text.contains(r#""op":"spawn""#), "{text}");
        let back: Request = serde_json::from_str(&text).unwrap();
        assert!(matches!(back.op, Op::Spawn(_)));
        assert_eq!(back.id, 7);
    }

    /// `plugin_names` is optional both ways: an old request without it reads as empty and an
    /// empty list stays off the wire; a list round-trips in order.
    #[test]
    fn spawn_plugin_names_are_optional_both_ways() {
        let old: Request = serde_json::from_str(
            r#"{"id":1,"op":"spawn","cwd":"C:\\work","permission_mode":"default"}"#,
        )
        .unwrap();
        let Op::Spawn(old) = old.op else { panic!("expected spawn") };
        assert!(old.plugin_names.is_empty());
        assert!(!serde_json::to_string(&old).unwrap().contains("plugin_names"));
        let new: Request = serde_json::from_str(
            r#"{"id":2,"op":"spawn","cwd":"C:\\work","permission_mode":"default","plugin_names":["vidar-app","gate"]}"#,
        )
        .unwrap();
        let Op::Spawn(new) = new.op else { panic!("expected spawn") };
        assert_eq!(new.plugin_names, ["vidar-app", "gate"]);
        assert!(serde_json::to_string(&new).unwrap().contains(r#""plugin_names":["vidar-app","gate"]"#));
    }

    #[test]
    fn spawn_agent_field_obeys_the_versioned_wire_shape() {
        let v1: Request = serde_json::from_str(
            r#"{"id":1,"op":"spawn","cwd":"C:\\work","permission_mode":"default"}"#,
        )
        .unwrap();
        let Op::Spawn(v1) = v1.op else {
            panic!("expected spawn")
        };
        assert_eq!(v1.agent, None);
        assert!(!serde_json::to_string(&v1).unwrap().contains("agent"));

        let v2: Request = serde_json::from_str(
            r#"{"id":1,"op":"spawn","agent":"codex","cwd":"C:\\work","permission_mode":"default"}"#,
        )
        .unwrap();
        let Op::Spawn(v2) = v2.op else {
            panic!("expected spawn")
        };
        assert_eq!(v2.agent, Some(Agent::Codex));
    }

    /// Old Vidar (no `ctl_secret`) and new host, or the reverse, must still
    /// speak: absent reads as None, None is omitted on the wire.
    #[test]
    fn spawn_ctl_secret_is_optional_both_ways() {
        let old: Request = serde_json::from_str(
            r#"{"id":1,"op":"spawn","cwd":"C:\\work","permission_mode":"default"}"#,
        )
        .unwrap();
        let Op::Spawn(old) = old.op else {
            panic!("expected spawn")
        };
        assert_eq!(old.ctl_secret, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("ctl_secret"));

        let new: Request = serde_json::from_str(
            r#"{"id":1,"op":"spawn","cwd":"C:\\work","permission_mode":"default","ctl_secret":"ab"}"#,
        )
        .unwrap();
        let Op::Spawn(new) = new.op else {
            panic!("expected spawn")
        };
        assert_eq!(new.ctl_secret.as_deref(), Some("ab"));
    }

    /// Old Vidar (no `rules_file`) still spawns on a new host.
    #[test]
    fn spawn_params_without_rules_file_parses() {
        let old: Request = serde_json::from_str(
            r#"{"id":1,"op":"spawn","cwd":"C:\\work","permission_mode":"default"}"#,
        )
        .unwrap();
        let Op::Spawn(old) = old.op else {
            panic!("expected spawn")
        };
        assert_eq!(old.rules_file, None);
    }

    /// New Vidar without rules sends a frame an old host reads unchanged.
    #[test]
    fn rules_file_none_omitted_on_wire() {
        let params: SpawnParams = serde_json::from_str(
            r#"{"cwd":"C:\\work","permission_mode":"default","rules_file":"C:\\r.md"}"#,
        )
        .unwrap();
        assert_eq!(params.rules_file.as_deref(), Some(r"C:\r.md"));
        let none = SpawnParams {
            rules_file: None,
            ..params
        };
        assert!(!serde_json::to_string(&none).unwrap().contains("rules_file"));
    }

    /// The summary echo is Vidar's stale-host proof: present when set,
    /// absent (and None on read) when not.
    #[test]
    fn summary_carries_rules_file() {
        let old = r#"{"session":"s1","generation":1,"agent":"claude","cwd":"C:\\w",
            "conversation":null,"pid":1,"model":null,"permission_mode":"default",
            "attached":0,"exited":null}"#;
        let mut summary: SessionSummary = serde_json::from_str(old).unwrap();
        assert_eq!(summary.rules_file, None);
        assert!(!serde_json::to_string(&summary).unwrap().contains("rules_file"));
        summary.rules_file = Some(r"C:\v\runtime\rules\built\0123456789ab.md".into());
        let text = serde_json::to_string(&summary).unwrap();
        let back: SessionSummary = serde_json::from_str(&text).unwrap();
        assert_eq!(back.rules_file, summary.rules_file);
    }

    #[test]
    fn sets_keep_absent_empty_and_two_refs_on_both_wires() {
        let spawn = r#"{"cwd":"C:\\work","permission_mode":"default"}"#;
        let summary = r#"{"session":"s1","generation":1,"agent":"claude","cwd":"C:\\w",
            "conversation":null,"pid":1,"model":null,"permission_mode":"default",
            "attached":0,"exited":null}"#;
        let refs = vec![
            SetRef { library: None, set: "base".into() },
            SetRef { library: Some("team".into()), set: "review".into() },
        ];
        for sets in [None, Some(vec![]), Some(refs)] {
            let mut p: SpawnParams = serde_json::from_str(spawn).unwrap();
            p.sets = sets.clone();
            let wire = serde_json::to_value(&p).unwrap();
            assert_eq!(wire.get("sets").is_some(), sets.is_some());
            let back: SpawnParams = serde_json::from_value(wire).unwrap();
            assert_eq!(back.sets, sets);
            let mut s: SessionSummary = serde_json::from_str(summary).unwrap();
            s.sets = sets.clone();
            let wire = serde_json::to_value(&s).unwrap();
            assert_eq!(wire.get("sets").is_some(), sets.is_some());
            let back: SessionSummary = serde_json::from_value(wire).unwrap();
            assert_eq!(back.sets, sets);
        }
        assert!(CAPABILITIES.contains(&CAPABILITY_SETS_ECHO));
    }

    /// `tab_name` is optional both ways: absent on the wire when None, None when absent,
    /// and carried through `SessionSummary` for a re-adopt.
    #[test]
    fn tab_name_is_optional_both_ways() {
        let old: SpawnParams = serde_json::from_str(
            r#"{"cwd":"C:\\work","permission_mode":"default"}"#,
        )
        .unwrap();
        assert_eq!(old.tab_name, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("tab_name"));
        let new: SpawnParams = serde_json::from_str(
            r#"{"cwd":"C:\\work","permission_mode":"default","tab_name":"Amber Raptor"}"#,
        )
        .unwrap();
        assert_eq!(new.tab_name.as_deref(), Some("Amber Raptor"));
        let summary_json = r#"{"session":"s1","generation":1,"agent":"claude","cwd":"C:\\w",
            "conversation":null,"pid":1,"model":null,"permission_mode":"default",
            "attached":0,"exited":null}"#;
        let mut summary: SessionSummary = serde_json::from_str(summary_json).unwrap();
        assert_eq!(summary.tab_name, None);
        assert!(!serde_json::to_string(&summary).unwrap().contains("tab_name"));
        summary.tab_name = Some("Amber Raptor".into());
        let back: SessionSummary =
            serde_json::from_str(&serde_json::to_string(&summary).unwrap()).unwrap();
        assert_eq!(back.tab_name.as_deref(), Some("Amber Raptor"));
    }

    /// `Request` flattens `Op` beside its own `id: u64`. Before the
    /// `msg_id` rename on `Op::Publish`, this shape produced a JSON object
    /// with two `"id"` keys and failed on the way back in with "duplicate
    /// field `id`" — a real bug the brief's field names walked into, not a
    /// hypothetical.
    #[test]
    fn publish_carries_its_message_id_without_colliding_with_the_request_id() {
        let request = Request {
            id: 7,
            op: Op::Publish {
                topic: "ask.open".into(),
                id: "msg-1".into(),
                payload: serde_json::json!({}),
                reply_to: None,
            },
        };
        let text = serde_json::to_string(&request).unwrap();
        assert!(text.contains(r#""msg_id":"msg-1""#), "{text}");
        let back: Request = serde_json::from_str(&text).unwrap();
        assert_eq!(back.id, 7);
        match back.op {
            Op::Publish { id, .. } => assert_eq!(id, "msg-1"),
            other => panic!("expected Publish, got {other:?}"),
        }
    }

    #[test]
    fn op_name_matches_the_serialised_tag_for_every_variant() {
        let lease = || Lease {
            token: "t".into(),
            revision: 1,
        };
        let s = || "s".to_string();
        let ops = vec![
            Op::Negotiate {
                protocol: 2,
                client: s(),
                secret: s(),
            },
            Op::List,
            Op::Spawn(SpawnParams {
                agent: None,
                cwd: s(),
                permission_mode: s(),
                model: None,
                effort: None,
                resume: None,
                ctl_secret: None,
                rules_file: None,
                tab_name: None,
                gateway: None,
                profile: None,
                payload_file: None,
                mcp_file: None,
                row_key: None,
                sets: None,
                set_plugin_dirs: Vec::new(), codex_home: None, claude_config_dir: None, plugin_names: Vec::new(),
            }),
            Op::Attach { session: s() },
            Op::Hydrate {
                session: s(),
                after: 0,
                through: 0,
            },
            Op::Detach { session: s() },
            Op::AcquireControl { session: s() },
            Op::ReleaseControl {
                session: s(),
                lease: lease(),
            },
            Op::Close {
                session: s(),
                lease: lease(),
            },
            Op::Release { session: s() },
            Op::Terminate {
                session: s(),
                lease: lease(),
            },
            Op::Submit {
                session: s(),
                generation: 0,
                lease: lease(),
                content: serde_json::json!("x"),
            },
            Op::RetractPrompt {
                session: s(),
                generation: 0,
                lease: lease(),
                prompt: s(),
            },
            Op::SteerPrompt {
                session: s(),
                generation: 0,
                lease: lease(),
                prompt: s(),
            },
            Op::Interrupt {
                session: s(),
                generation: 0,
                lease: lease(),
            },
            Op::Query {
                session: s(),
                generation: 0,
                method: "model/list".into(),
                params: serde_json::json!({}),
            },
            Op::PermissionResponse {
                session: s(),
                generation: 0,
                lease: lease(),
                request: s(),
                behavior: s(),
                message: None,
                updated_input: None,
            },
            Op::SetModel {
                session: s(),
                generation: 0,
                lease: lease(),
                model: s(),
            },
            Op::SetEffort {
                session: s(),
                generation: 0,
                lease: lease(),
                level: s(),
            },
            Op::SetPermissionMode {
                session: s(),
                generation: 0,
                lease: lease(),
                mode: s(),
            },
            Op::Subscribe { topics: vec![] },
            Op::Publish {
                topic: s(),
                id: s(),
                payload: serde_json::json!({}),
                reply_to: None,
            },
        ];
        for op in ops {
            let value = serde_json::to_value(&op).unwrap();
            assert_eq!(value["op"].as_str(), Some(op.name()), "{value}");
        }
    }

    #[test]
    fn steer_prompt_round_trips_on_the_wire() {
        let op = Op::SteerPrompt {
            session: "s1".into(),
            generation: 4,
            lease: Lease {
                token: "tok".into(),
                revision: 7,
            },
            prompt: "p-9".into(),
        };
        let text = serde_json::to_string(&Request { id: 3, op }).unwrap();
        let back: Request = serde_json::from_str(&text).unwrap();
        assert_eq!(back.id, 3);
        match back.op {
            Op::SteerPrompt {
                session,
                generation,
                lease,
                prompt,
            } => {
                assert_eq!(
                    (session.as_str(), generation, prompt.as_str()),
                    ("s1", 4, "p-9")
                );
                assert_eq!((lease.token.as_str(), lease.revision), ("tok", 7));
            }
            other => panic!("expected steer-prompt, got {other:?}"),
        }
        assert!(text.contains(r#""op":"steer-prompt""#), "{text}");
        assert!(CAPABILITIES.contains(&CAPABILITY_STEER));
    }

    #[test]
    fn unknown_operations_are_refused_rather_than_defaulted() {
        let error = serde_json::from_str::<Request>(r#"{"id":1,"op":"bypass-permissions"}"#);
        assert!(error.is_err());
    }

    #[test]
    fn frames_carry_their_server_discriminator() {
        let frame = ServerFrame::Event(Event {
            session: "s-1".into(),
            generation: 3,
            seq: 1,
            body: EventBody::Exit { code: Some(0) },
        });
        let text = serde_json::to_string(&frame).unwrap();
        assert!(text.contains(r#""t":"event""#), "{text}");
        assert!(text.contains(r#""kind":"exit""#), "{text}");
    }

    #[test]
    fn conversation_ids_must_be_uuid_shaped() {
        assert!(valid_conversation_id(
            "c4ee6c0d-1111-2222-3333-444444444444"
        ));
        assert!(!valid_conversation_id("../../escape"));
        assert!(!valid_conversation_id(""));
    }

    #[test]
    fn session_frame_bound_exceeds_the_child_line_cap() {
        // A line Falcon accepted from the child must always re-frame.
        assert!(MAX_SESSION_FRAME > crate::process::LINE_CAP);
    }

    #[test]
    fn from_wire_takes_only_exact_ids() {
        assert_eq!(Agent::from_wire("claude"), Some(Agent::Claude));
        assert_eq!(Agent::from_wire("codex"), Some(Agent::Codex));
        for s in ["Claude", "", "grok"] {
            assert_eq!(Agent::from_wire(s), None);
        }
    }
}

#[cfg(test)]
#[path = "protocol/gateway_tests.rs"]
mod gateway_tests;
