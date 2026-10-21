//! Durable per-session journal: the record types, and the append/snapshot I/O.
//!
//! FROZEN CONTRACT. The types in this file are the boundary between the
//! journal writer and the pure reducer in `replay.rs`. Do not change a type,
//! a field name, a variant, or a signature: both sides are written against
//! them, and `replay.rs` cannot see this file's implementation.
//!
//! Ordering is the whole point. Falcon appends a reconstructive record and
//! flushes it *before* acknowledging the thing it describes, so a client is
//! never told "applied" about something that would vanish on a crash. A
//! snapshot is a compaction hint, never the source of truth: it records the
//! sequence it was taken at, and replay resumes from there.
//!
//! What this file owns: file layout, atomic writes, durability ordering,
//! recovery from a torn tail, and bounds. What it must not own: any
//! interpretation of what the records *mean* — that is `replay.rs`.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::protocol::{EventBody, Outcome};

/// Hard bound on one serialized record as read back from disk. Journals
/// written before [`LONE_RECORD_CAP`] existed may hold records up to here, so
/// the reader keeps accepting them; appends are bounded tighter.
pub const MAX_RECORD: usize = 16 * 1024 * 1024;

/// Room left in a protocol frame for the hydrate envelope around a lone record.
const ENVELOPE_HEADROOM: usize = 64 * 1024;

/// The largest record [`Journal::append`] accepts, and the largest a hydrate
/// page carries on its own: within [`MAX_RECORD`], and small enough that the
/// hydrate response still fits one wire frame. One constant for both sides, so
/// a record that appends always hydrates; a larger one is refused at append
/// and the caller journals an `Overflow` in its place.
pub const LONE_RECORD_CAP: usize =
    if MAX_RECORD < crate::protocol::MAX_SESSION_FRAME - ENVELOPE_HEADROOM {
        MAX_RECORD
    } else {
        crate::protocol::MAX_SESSION_FRAME - ENVELOPE_HEADROOM
    };

/// One durable entry. `seq` is per session, starts at 1, and is dense: replay
/// treats a gap as corruption, because a gap is indistinguishable from a
/// record that was lost.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Record {
    pub seq: u64,
    /// Which child generation produced this. A record from a previous
    /// generation must never mutate the state of its replacement.
    pub generation: u64,
    /// Milliseconds since the Unix epoch, recorded when appended.
    pub at_ms: u64,
    pub body: Body,
}

/// Everything reconstructive. Anything not listed here is diagnostic and must
/// not be needed to rebuild state.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "record", rename_all = "kebab-case")]
pub enum Body {
    /// The session was created. Always the first record of a generation.
    Started {
        session: String,
        agent: String,
        cwd: String,
        model: Option<String>,
        permission_mode: String,
        conversation: Option<String>,
        pid: u32,
    },
    /// An event that was published to clients, verbatim.
    Event {
        body: EventBody,
    },
    /// A mutating command was accepted from a client, before it was written to
    /// the child.
    ///
    /// USUALLY followed by exactly one `CommandSettled`, but not guaranteed: a
    /// host that dies between the two, or one whose settlement append fails,
    /// leaves an acceptance with no terminal record. That is deliberate and is
    /// the honest state — the command may well have reached the child — so a
    /// reducer must treat an unsettled acceptance as "in flight, outcome
    /// unknown" rather than as corruption.
    CommandAccepted {
        command: u64,
        client: String,
        kind: String,
        payload: serde_json::Value,
    },
    /// The terminal result of that command.
    CommandSettled {
        command: u64,
        outcome: Outcome,
        message: Option<String>,
    },
    /// A permission request opened by the agent.
    PermissionOpened {
        request: String,
        tool: String,
        input: serde_json::Value,
        truncated: bool,
    },
    /// A permission moved state. `settled` and `cancelled` are terminal; a
    /// failed delivery deliberately leaves it pending.
    PermissionState {
        request: String,
        state: String,
    },
    /// A prompt accepted into the queue, with the stable id clients retract by.
    PromptQueued {
        prompt: String,
        content: serde_json::Value,
    },
    PromptRetracted {
        prompt: String,
    },
    /// Handed to the child. `steered` marks a prompt folded into a turn that
    /// was already running (`Session::steer_prompt`); omitted when false, so
    /// an ordinary dispatch keeps its old shape.
    ///
    /// Recorded BEFORE the write (`session/dispatch.rs`), so it precedes any
    /// line the child answers with; a dispatch the child never took is then
    /// withdrawn by one of the two records below.
    PromptDispatched {
        prompt: String,
        #[serde(default, skip_serializing_if = "is_false")]
        steered: bool,
    },
    /// A dispatched prompt the agent never took (its write was refused, or
    /// hosted Codex refused its steer) back in the queue at position `at`,
    /// with the content a rebuilt queue needs. Follows its `PromptDispatched`.
    PromptRequeued {
        prompt: String,
        content: serde_json::Value,
        at: usize,
    },
    /// A prompt `pump` took from the queue whose write was refused outright
    /// (after its `PromptDispatched`), or whose line the driver could not
    /// build (no dispatch recorded): never delivered and no longer queued
    /// (the client was told why). Also a folded prompt whose steer the agent
    /// still had not answered at the turn end after its own, or when the
    /// child closed (hosted Codex): released rather than requeued, since it
    /// may have been applied, and announced by a Diagnostic. A steer refused
    /// after its turn ended is requeued instead (`PromptRequeued`).
    PromptUndelivered {
        prompt: String,
        reason: String,
    },
    /// The conversation id the CLI reported, once known.
    ConversationAdopted {
        conversation: String,
    },
    ModelChanged {
        model: String,
    },
    PermissionModeChanged {
        mode: String,
    },
    /// The controller lease changed hands.
    ///
    /// `holder` is `None` when the lease was released — including the implicit
    /// release when a controlling connection dies — and the client's own name
    /// when it was acquired. The token is deliberately NOT recorded: the
    /// journal is replayed to rebuild a view, and a replayed token would be a
    /// credential sitting in a file that outlives the connection it belonged
    /// to. `revision` is what a reducer needs, and it is the fence a transfer
    /// commits against.
    ControllerChanged {
        revision: u64,
        holder: Option<String>,
    },
    /// The child exited. Terminal for the generation.
    Exited {
        code: Option<i32>,
    },
    /// The unattended-permission watcher's disposition of one permission
    /// request opened with no controller attached.
    ///
    /// Diagnostic in shape but its own record rather than folded into
    /// `PermissionState`: it answers "what did the unattended path do", not
    /// "what state is the request in", and a reducer must not infer one from
    /// the other. `outcome` is one of `shown`, `show-failed`,
    /// `denied-timeout`, `denied-show-failed`, `attended`; `reason` carries
    /// the show error or the settled deny's message, when there is one.
    PermissionUnattended {
        request: String,
        outcome: String,
        reason: Option<String>,
    },
    /// Hosted Codex turn bookkeeping (`codex::driver::turns`), nested so the
    /// Codex vocabulary stays one variant of the shared record set.
    Codex {
        codex: CodexRecord,
    },
}

/// What a hosted Codex session adds to the journal about its turns.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CodexRecord {
    /// The turn a dispatched prompt's `turn/start` began, once Codex named it
    /// (its response or `turn/started`, whichever came first).
    TurnBound { prompt: String, turn: String },
    /// Codex refused a dispatched prompt's `turn/start` or `turn/steer`: the
    /// prompt was delivered and rejected, and no turn ran for it. A refused
    /// steer's prompt goes back to the queue (`PromptRequeued` follows).
    TurnRefused { prompt: String, reason: String },
    /// The policy a prompt's `turn/start` carried. Recorded only once the
    /// write landed (or may have), after its `PromptDispatched`.
    PromptPolicy {
        prompt: String,
        mode: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
    },
    /// The host answered a Codex server request itself
    /// (`codex::driver::requests`), once, before its line was published.
    /// `request` is the card key (`sr:<id>`); `disposition` is `refused`,
    /// `error` or `unknown`; `delivery` is the answer write's fate.
    ServerRequestAnswered {
        request: String,
        method: String,
        disposition: String,
        delivery: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// A file-change card's diff arrived (or changed) after the card opened,
    /// on a line of item `item` journaled just before this record; the view
    /// redraws card `request` (`sr:<id>`) from that item's changes. The
    /// card's own state stays in `PermissionState`.
    ApprovalDiff { request: String, item: String },
}

fn is_false(flag: &bool) -> bool {
    !*flag
}

/// A compaction hint: the reconstructed state as of `through_seq`.
///
/// Replay must produce identical state from `snapshot + records after
/// through_seq` and from `all records`. A snapshot that disagrees with the
/// journal is a bug in whichever wrote it, and must fail the attach loudly
/// rather than be preferred.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Snapshot {
    pub session: String,
    pub through_seq: u64,
    pub generation: u64,
    /// The reducer's state, opaque to this file.
    pub state: serde_json::Value,
}

/// Why a journal could not be used. Every variant must be distinguishable:
/// "the tail was torn by a crash" is recoverable, "sequence 7 is missing" is
/// not, and collapsing them would hide real corruption.
#[derive(Debug)]
pub enum JournalError {
    Io(String),
    /// A record did not deserialize. Carries the sequence position reached.
    Malformed {
        after_seq: u64,
        why: String,
    },
    /// `expected` was required, `found` was present.
    SequenceGap {
        expected: u64,
        found: u64,
    },
    /// A record exceeded [`LONE_RECORD_CAP`].
    TooLarge {
        seq: u64,
        bytes: usize,
    },
    /// The snapshot does not correspond to this journal.
    SnapshotMismatch {
        why: String,
    },
}

impl std::fmt::Display for JournalError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(why) => write!(formatter, "journal io: {why}"),
            Self::Malformed { after_seq, why } => {
                write!(formatter, "malformed record after seq {after_seq}: {why}")
            }
            Self::SequenceGap { expected, found } => {
                write!(
                    formatter,
                    "sequence gap: expected {expected}, found {found}"
                )
            }
            Self::TooLarge { seq, bytes } => {
                write!(
                    formatter,
                    "record {seq} is {bytes} bytes, over {LONE_RECORD_CAP}"
                )
            }
            Self::SnapshotMismatch { why } => write!(formatter, "snapshot mismatch: {why}"),
        }
    }
}

// ---------------------------------------------------------------------------
// On-disk format
// ---------------------------------------------------------------------------
//
// Every record, and the snapshot, is written as one self-delimiting frame:
//
//     magic    4 bytes  b"FJR2" for a record, b"FJS2" for a snapshot
//     length   4 bytes  u32 little-endian, the payload length in bytes
//     head     8 bytes  sha256("falcon-frame-head" ++ magic ++ length)[..8]
//     body     8 bytes  sha256("falcon-frame-body" ++ magic ++ length ++ payload)[..8]
//     payload  length bytes, compact JSON
//
// Why framed-and-digested rather than newline-delimited JSON. Torn-tail
// recovery has to answer, from the bytes alone, "was this record finished?" —
// and it has to answer it *differently* from "is this record corrupt", because
// one is a crash we recover from and the other is damage we must refuse.
// NDJSON has only one end marker, the newline, so the reader learns a record
// was unfinished only by failing to parse it, which is indistinguishable from
// interior damage. An explicit length moves that decision before the parse.
//
// Why the length carries its own digest, separate from the payload's. The
// length is not data: it is the number that decides how much of the file this
// frame owns, and therefore where — or whether — the next record begins. A
// digest that covers length and payload together can only be checked once the
// length has already been believed, which leaves the reader believing an
// unverified number at exactly the moment it decides "this frame runs past the
// end of the file, so the tail was torn". An in-range length raised to point
// past EOF would then condemn every intact record behind it (FJR1 did this;
// see `scan_records`). With the header authenticated first, the two questions
// separate cleanly:
//   - header digest fails  -> the length is unknowable, so where this frame
//                             ends is unknowable, so whether anything survives
//                             behind it is unknowable. Refuse. Never truncate.
//   - header digest passes -> the length is the one we wrote, so a frame that
//                             reaches or overruns EOF positively establishes
//                             that no later record can exist: records are
//                             contiguous and the next would start past the end.
//                             Only then is dropping the tail legitimate.
// The payload digest keeps its own job: telling intact bytes from rewritten or
// zero-filled ones, which a length alone cannot, and which matters because a
// crash on NTFS can leave the extended tail zero-filled rather than short.
// Cost is a second sha256 over sixteen bytes, inside an fsync.
//
// Both digests are unkeyed, so they detect corruption, not forgery: anything
// that can write this file can also recompute them. The threat this format
// defends against is damage, and the discipline it enforces is that no number
// out of the file is acted on before it has been checked against itself.
//
// FJR1/FJS1 (16-byte header, one digest over length ++ payload) is retired.
// Its frames are refused by name rather than reinterpreted: the magic differs,
// so a v1 file can never be misread as v2.
//
// Files, under the directory given to `open`:
//
//     <stem>.journal        the append-only record log
//     <stem>.snapshot       the newest snapshot, replaced atomically
//     <stem>.snapshot.tmp   the staging file for that replace
//
// `<stem>` is the session id when it is already a safe Windows file name, and
// otherwise a sanitized prefix plus a hash of the full id (see `file_stem`) —
// a session id is an untrusted string and must not be able to steer a write
// out of the directory or onto a DOS device.

const MAGIC_RECORD: [u8; 4] = *b"FJR2";
const MAGIC_SNAPSHOT: [u8; 4] = *b"FJS2";
/// The retired one-digest format. Kept only so its files are refused by name.
const MAGIC_RECORD_V1: [u8; 4] = *b"FJR1";
const MAGIC_SNAPSHOT_V1: [u8; 4] = *b"FJS1";
const HEADER: usize = 24;
/// Where each field sits in the header, so nothing is indexed by arithmetic.
const LENGTH_AT: std::ops::Range<usize> = 4..8;
const HEAD_DIGEST_AT: std::ops::Range<usize> = 8..16;
const BODY_DIGEST_AT: std::ops::Range<usize> = 16..24;

fn digest8(domain: &[u8], parts: &[&[u8]]) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    for part in parts {
        hasher.update(part);
    }
    let full = hasher.finalize();
    let mut short = [0u8; 8];
    short.copy_from_slice(&full[..8]);
    short
}

/// Authenticates the header on its own, so the length can be checked before it
/// is used. Domain-separated from the payload digest: the two cover overlapping
/// bytes, and a value from one must never satisfy the other.
fn head_digest(magic: &[u8], length: &[u8]) -> [u8; 8] {
    digest8(b"falcon-frame-head", &[magic, length])
}

fn body_digest(magic: &[u8], length: &[u8], payload: &[u8]) -> [u8; 8] {
    digest8(b"falcon-frame-body", &[magic, length, payload])
}

fn encode_frame(magic: [u8; 4], payload: &[u8]) -> Vec<u8> {
    let length = (payload.len() as u32).to_le_bytes();
    let mut frame = Vec::with_capacity(HEADER + payload.len());
    frame.extend_from_slice(&magic);
    frame.extend_from_slice(&length);
    frame.extend_from_slice(&head_digest(&magic, &length));
    frame.extend_from_slice(&body_digest(&magic, &length, payload));
    frame.extend_from_slice(payload);
    frame
}

fn io_error(context: &str, error: std::io::Error) -> JournalError {
    JournalError::Io(format!("{context}: {error}"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// Names Windows resolves to a device no matter what extension follows.
const DOS_DEVICES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// The file stem for `session`: the id itself when that is already safe, and a
/// sanitized prefix plus a digest of the whole id when it is not. Hashing on
/// the unsafe path keeps distinct ids on distinct files — sanitizing alone
/// would map `a/b` and `a_b` onto the same journal.
fn file_stem(session: &str) -> String {
    let sanitized: String = session
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let device = sanitized
        .split('.')
        .next()
        .map(|head| DOS_DEVICES.contains(&head.to_ascii_uppercase().as_str()))
        .unwrap_or(false);
    let plain = !sanitized.is_empty()
        && sanitized.as_str() == session
        && sanitized.len() <= 64
        && !sanitized.starts_with('.')
        && !device;
    if plain {
        return sanitized;
    }
    // On this branch the id was not usable as-is, so the dots go too: a name
    // built out of `.` and `..` is confusing at best and, in the wrong API, a
    // path component at worst. The digest is what keeps ids distinct.
    let digest = format!("{:x}", Sha256::digest(session.as_bytes()));
    let prefix: String = sanitized
        .chars()
        .take(32)
        .map(|character| if character == '.' { '_' } else { character })
        .collect();
    format!("{prefix}-{}", &digest[..16])
}

/// What a scan of the record log found.
struct Scan {
    records: Vec<Record>,
    /// Byte offset of each record's frame, by position: `offsets[i]` is where
    /// seq `i + 1` starts. Seeds the journal's in-memory page index.
    offsets: Vec<u64>,
    /// Bytes covered by whole, verified frames. Anything past this is a torn
    /// tail and is safe to drop.
    valid_len: usize,
    // diagnostic only; production code branches on valid_len, tests assert torn
    #[allow(dead_code)] // never read outside tests
    torn: bool,
}

/// Walk the frames in `data`, verifying framing, digests and dense sequencing.
///
/// Returns `Ok` with `torn = true` when the trailing bytes are an unfinished
/// write; returns `Err` for anything that cannot be explained that way. The
/// caller truncates on `torn`, so every path that sets it is destructive and
/// has to be *positively* established, never merely plausible.
///
/// The one invariant the whole walk rests on: frames are contiguous, so at each
/// step there is exactly one candidate record start, `offset`. Everything the
/// scan decides is about that one position, which is why "nothing valid can be
/// hiding after this" is answerable at all — but only once we know where this
/// frame ends, and that is the length, and the length must be verified before
/// it is believed. `torn` is therefore reachable in exactly three ways:
///
///   1. the remainder is all zeros — no frame starts with a zero byte, and
///      nothing follows zeros but zeros. No number from the file is used.
///   2. the remainder is shorter than a header — a record cannot fit. No
///      number from the file is used.
///   3. the header passed its own digest, and the length it authenticates
///      reaches or overruns the end of the file — so the next frame would
///      start at or past EOF and no later record exists.
///
/// Anything else — including a header that fails its digest, whatever its
/// position — is ambiguous damage and is refused with the file untouched.
fn scan_records(data: &[u8]) -> Result<Scan, JournalError> {
    let mut records: Vec<Record> = Vec::new();
    let mut offsets: Vec<u64> = Vec::new();
    let mut offset = 0usize;
    let mut expected = 1u64;

    loop {
        if offset == data.len() {
            return Ok(Scan {
                records,
                offsets,
                valid_len: offset,
                torn: false,
            });
        }
        let rest = &data[offset..];

        // (1) A crash can leave the tail zero-filled instead of short: the file
        // was extended before the data landed.
        let zero_filled = rest[0] == 0 && rest.iter().all(|byte| *byte == 0);
        if zero_filled {
            return Ok(Scan {
                records,
                offsets,
                valid_len: offset,
                torn: true,
            });
        }

        // (2) Fewer bytes than a header: the writer died inside the header, and
        // no record could be hiding in what is left.
        if rest.len() < HEADER {
            return Ok(Scan {
                records,
                offsets,
                valid_len: offset,
                torn: true,
            });
        }

        let magic = &rest[..4];
        if magic != MAGIC_RECORD {
            // We always write the magic first and in one buffer, so a wrong
            // magic that is not zero-fill is damage, not an unfinished write.
            let why = if magic == MAGIC_RECORD_V1 {
                "frame is a retired FJR1 record: that format's length field was \
                 not independently verifiable, so it cannot be read safely here"
                    .to_string()
            } else {
                format!("frame magic {magic:02x?} is not a record header")
            };
            return Err(JournalError::Malformed {
                after_seq: expected - 1,
                why,
            });
        }

        // The header is verified before its length is read for anything at all.
        // This ordering is the fix for the defect this format exists to close:
        // an unverified length that pointed past the end used to be read as
        // "the tail was torn", and `open` truncated there — discarding every
        // intact record behind it. A header we cannot authenticate tells us
        // nothing about where this frame ends, so it cannot tell us that
        // nothing survives after it, so it can never authorise a truncation.
        if head_digest(magic, &rest[LENGTH_AT]).as_slice() != &rest[HEAD_DIGEST_AT] {
            return Err(JournalError::Malformed {
                after_seq: expected - 1,
                why: "frame header failed its own digest: the length is not \
                      trustworthy, and damage of unknown extent is refused \
                      rather than repaired"
                    .into(),
            });
        }

        let length = u32::from_le_bytes([rest[4], rest[5], rest[6], rest[7]]) as usize;
        if length == 0 || length > MAX_RECORD {
            // Authenticated and still impossible: this was never our writer.
            return Err(JournalError::Malformed {
                after_seq: expected - 1,
                why: format!("frame claims {length} bytes, outside 1..={MAX_RECORD}"),
            });
        }
        let end = HEADER + length;
        if rest.len() < end {
            // (3) The length is the one we wrote, and it runs past what the
            // file holds: the append was cut short, and the next frame would
            // begin past the end, so nothing intact is being discarded.
            return Ok(Scan {
                records,
                offsets,
                valid_len: offset,
                torn: true,
            });
        }
        let payload = &rest[HEADER..end];
        let at_eof = offset + end == data.len();
        if body_digest(magic, &rest[LENGTH_AT], payload).as_slice() != &rest[BODY_DIGEST_AT] {
            if at_eof {
                // (3) again: the authenticated length says this frame owns the
                // rest of the file, so no record follows it, and a payload that
                // fails its digest there is a write that never finished
                // landing — the zero-filled-extension shape, typically.
                return Ok(Scan {
                    records,
                    offsets,
                    valid_len: offset,
                    torn: true,
                });
            }
            return Err(JournalError::Malformed {
                after_seq: expected - 1,
                why: "payload digest mismatch with records after it".into(),
            });
        }
        // Past the digest the bytes are the bytes we wrote, so a parse failure
        // or a wrong sequence is a real defect, at the tail as much as inside.
        let record: Record =
            serde_json::from_slice(payload).map_err(|error| JournalError::Malformed {
                after_seq: expected - 1,
                why: format!("record did not deserialize: {error}"),
            })?;
        if record.seq != expected {
            return Err(JournalError::SequenceGap {
                expected,
                found: record.seq,
            });
        }
        expected += 1;
        records.push(record);
        offsets.push(offset as u64);
        offset += end;
    }
}

/// The durable journal for one session.
///
/// Implementation notes that are part of the contract, not suggestions:
/// - `append` must not return until the bytes are durable. Falcon acknowledges
///   commands on the strength of that return value.
/// - A process killed mid-append must leave a journal that `open` can recover
///   by discarding only the torn trailing record. Earlier records are intact.
/// - `open` on a torn tail recovers; `open` on an interior gap or a malformed
///   interior record fails. The difference is the whole safety story.
pub struct Journal {
    session: String,
    path: PathBuf,
    snapshot_path: PathBuf,
    #[allow(dead_code)] // only read by write_snapshot, which has no production caller yet
    snapshot_temp: PathBuf,
    /// Opened read/write, never wrapped in a `BufWriter`: a user-space buffer
    /// is exactly the thing that could hold bytes back past a return.
    file: File,
    /// Bytes of verified journal. Every write starts here.
    len: u64,
    last_seq: u64,
    /// Frame start of every durable record, by position (`offsets[i]` is seq
    /// `i + 1`). Built once by the open scan and extended by each successful
    /// append, so a hydrate page is located without re-reading or re-hashing
    /// the log: a live journal reaches tens of thousands of records, and the
    /// full rescan per page was quadratic under the session's journal lock.
    offsets: Vec<u64>,
    /// Set when a failed append could not be rolled back, so the file may hold
    /// a partial frame that a later append would bury in the interior.
    poisoned: Option<String>,
}

impl Journal {
    /// Open or create the journal for `session` under `directory`.
    ///
    /// Recovers a torn trailing record; refuses interior corruption.
    pub fn open(directory: &std::path::Path, session: &str) -> Result<Self, JournalError> {
        fs::create_dir_all(directory)
            .map_err(|error| io_error("create journal directory", error))?;
        let stem = file_stem(session);
        let path = directory.join(format!("{stem}.journal"));
        let snapshot_path = directory.join(format!("{stem}.snapshot"));
        let snapshot_temp = directory.join(format!("{stem}.snapshot.tmp"));

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)
            .map_err(|error| io_error("open journal", error))?;

        let data = fs::read(&path).map_err(|error| io_error("read journal", error))?;
        // Load-bearing order: the scan runs to completion and its refusal
        // propagates *before* any write below. A refused open must leave the
        // journal byte-identical — the caller's next move on a refusal is to
        // look at the file, and a reader that "repairs" ambiguous damage has
        // destroyed the evidence and possibly acknowledged records with it.
        let scan = scan_records(&data)?;

        if scan.valid_len as u64 != data.len() as u64 {
            // Drop the torn tail for good: leaving it would put the partial
            // frame in the interior as soon as the next record is appended.
            file.set_len(scan.valid_len as u64)
                .map_err(|error| io_error("truncate torn tail", error))?;
            file.sync_all()
                .map_err(|error| io_error("sync after truncating torn tail", error))?;
        }

        let last_seq = scan.records.last().map(|record| record.seq).unwrap_or(0);
        file.seek(SeekFrom::Start(scan.valid_len as u64))
            .map_err(|error| io_error("seek to journal end", error))?;

        Ok(Self {
            session: session.to_string(),
            path,
            snapshot_path,
            snapshot_temp,
            file,
            len: scan.valid_len as u64,
            last_seq,
            offsets: scan.offsets,
            poisoned: None,
        })
    }

    /// Append one record durably and return the sequence it was given.
    ///
    /// Assigns `seq` itself, densely; callers must not choose it.
    pub fn append(&mut self, generation: u64, body: Body) -> Result<u64, JournalError> {
        self.append_capped(generation, body, LONE_RECORD_CAP)
    }

    /// [`Journal::append`] under the pre-847b995 cap ([`MAX_RECORD`]), so a
    /// test can write the oversized records older journals may still hold.
    #[cfg(test)]
    pub(crate) fn append_legacy(&mut self, generation: u64, body: Body) -> Result<u64, JournalError> {
        self.append_capped(generation, body, MAX_RECORD)
    }

    fn append_capped(
        &mut self,
        generation: u64,
        body: Body,
        cap: usize,
    ) -> Result<u64, JournalError> {
        if let Some(why) = &self.poisoned {
            return Err(JournalError::Io(format!("journal is poisoned: {why}")));
        }
        let seq = self.last_seq + 1;
        let record = Record {
            seq,
            generation,
            at_ms: now_ms(),
            body,
        };
        let payload = serde_json::to_vec(&record)
            .map_err(|error| JournalError::Io(format!("serialize record {seq}: {error}")))?;
        if payload.len() > cap {
            // Refused before anything is written, and without consuming the
            // sequence: the next append still gets `seq`.
            return Err(JournalError::TooLarge {
                seq,
                bytes: payload.len(),
            });
        }
        let frame = encode_frame(MAGIC_RECORD, &payload);
        let at = self.len;
        match self.write_durably(&frame) {
            Ok(()) => {
                self.len = at + frame.len() as u64;
                self.last_seq = seq;
                self.offsets.push(at);
                Ok(seq)
            }
            Err(error) => {
                self.rollback(at);
                Err(error)
            }
        }
    }

    /// The one place durability ordering lives: position, write, flush, fsync,
    /// and only then return. Every error path returns before the caller could
    /// treat the record as written.
    fn write_durably(&mut self, frame: &[u8]) -> Result<(), JournalError> {
        self.file
            .seek(SeekFrom::Start(self.len))
            .map_err(|error| io_error("seek before append", error))?;
        self.file
            .write_all(frame)
            .map_err(|error| io_error("write record", error))?;
        self.file
            .flush()
            .map_err(|error| io_error("flush record", error))?;
        self.file
            .sync_all()
            .map_err(|error| io_error("fsync record", error))?;
        Ok(())
    }

    /// Cut a failed append back off the end. If that fails the file may hold a
    /// partial frame, which a later append would turn into interior damage —
    /// so the journal refuses further writes instead.
    fn rollback(&mut self, to: u64) {
        let undone = self.file.set_len(to).and_then(|()| self.file.sync_all());
        match undone {
            Ok(()) => self.len = to,
            Err(error) => {
                self.poisoned = Some(format!("could not roll back a failed append: {error}"));
            }
        }
    }

    /// The highest sequence durably written, or 0 for an empty journal.
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// Locate one hydrate page from the in-memory index alone: records with
    /// `after < seq <= through`, at most `limit` of them, stopping before the
    /// payload bytes would pass `byte_budget`. The first record in range is
    /// always included, however large, so the caller can report it as too
    /// large rather than page forever.
    ///
    /// No I/O happens here. The caller takes this under the journal lock and
    /// reads it with [`Window::read`] after releasing the lock: the bytes it
    /// names are below `len`, already durable, and only an append past `len`
    /// or a rollback of such an append ever touches the file again.
    pub fn window(&self, after: u64, through: u64, limit: usize, byte_budget: usize) -> Window {
        let upper = through.min(self.last_seq);
        let first_seq = after.saturating_add(1);
        let offset_of = |seq: u64| -> u64 {
            self.offsets
                .get((seq - 1) as usize)
                .copied()
                .unwrap_or(self.len)
        };
        let start = if first_seq <= upper {
            offset_of(first_seq)
        } else {
            self.len
        };
        let mut end = start;
        let mut seq = first_seq;
        let mut count = 0usize;
        let mut used = 0usize;
        while seq <= upper && count < limit {
            let next = offset_of(seq + 1);
            // The payload is the record's own compact serialization, the same
            // bytes the wire budget is measured in.
            let size = (next - offset_of(seq)) as usize - HEADER;
            if count > 0 && (size >= byte_budget || used + size > byte_budget) {
                break;
            }
            used += size;
            count += 1;
            end = next;
            seq += 1;
        }
        Window {
            path: self.path.clone(),
            start,
            end,
            first_seq,
            count,
            more: seq <= upper,
        }
    }

    /// Every record with `seq > after`, in order. A full scan of the log;
    /// hydration pages through [`Journal::window`] instead.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn records_after(&self, after: u64) -> Result<Vec<Record>, JournalError> {
        let data = fs::read(&self.path).map_err(|error| io_error("read journal", error))?;
        let scan = scan_records(&data)?;
        let on_disk = scan.records.last().map(|record| record.seq).unwrap_or(0);
        if on_disk < self.last_seq {
            // Something outside this process removed records we already
            // acknowledged. Reporting fewer records than we promised would be
            // the silent version of the failure this whole file exists to stop.
            return Err(JournalError::Malformed {
                after_seq: on_disk,
                why: format!(
                    "journal ends at seq {on_disk} but seq {} was acknowledged",
                    self.last_seq
                ),
            });
        }
        Ok(scan
            .records
            .into_iter()
            .filter(|record| record.seq > after)
            .collect())
    }

    /// Write a snapshot atomically. A torn snapshot must never be readable as
    /// a valid one — write to a temporary and rename.
    #[allow(dead_code)] // exercised by this module's own tests; no production caller yet
    pub fn write_snapshot(&mut self, snapshot: &Snapshot) -> Result<(), JournalError> {
        if snapshot.session != self.session {
            return Err(JournalError::SnapshotMismatch {
                why: format!(
                    "snapshot is for session {}, this journal is {}",
                    snapshot.session, self.session
                ),
            });
        }
        if snapshot.through_seq > self.last_seq {
            return Err(JournalError::SnapshotMismatch {
                why: format!(
                    "snapshot is through seq {} but the journal ends at {}",
                    snapshot.through_seq, self.last_seq
                ),
            });
        }
        let payload = serde_json::to_vec(snapshot)
            .map_err(|error| JournalError::Io(format!("serialize snapshot: {error}")))?;
        if payload.len() > u32::MAX as usize {
            return Err(JournalError::Io(format!(
                "snapshot is {} bytes, too large to frame",
                payload.len()
            )));
        }
        let frame = encode_frame(MAGIC_SNAPSHOT, &payload);

        let staged = (|| -> Result<(), JournalError> {
            let mut temp = File::create(&self.snapshot_temp)
                .map_err(|error| io_error("create snapshot temp", error))?;
            temp.write_all(&frame)
                .map_err(|error| io_error("write snapshot temp", error))?;
            temp.flush()
                .map_err(|error| io_error("flush snapshot temp", error))?;
            temp.sync_all()
                .map_err(|error| io_error("fsync snapshot temp", error))?;
            // Closed here, before the rename: Windows refuses to replace a file
            // that still has an open handle.
            drop(temp);
            fs::rename(&self.snapshot_temp, &self.snapshot_path)
                .map_err(|error| io_error("replace snapshot", error))
        })();

        if staged.is_err() {
            // A half-written temp must not be left where a later run could read
            // it; it is never the file `read_snapshot` looks at, but it is
            // still litter with a plausible name.
            let _ = fs::remove_file(&self.snapshot_temp);
        }
        staged?;
        sync_directory(&self.snapshot_path);
        Ok(())
    }

    /// The newest valid snapshot, if any. A snapshot that fails validation is
    /// reported, never silently ignored: replaying from zero when a snapshot
    /// exists would hide the bug that produced it.
    pub fn read_snapshot(&self) -> Result<Option<Snapshot>, JournalError> {
        // There is only ever one snapshot file, replaced by rename, so "the
        // newest" and "the one on disk" are the same thing by construction.
        let data = match fs::read(&self.snapshot_path) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error("read snapshot", error)),
        };
        let mismatch = |why: String| JournalError::SnapshotMismatch { why };

        if data.len() < HEADER {
            return Err(mismatch(format!(
                "snapshot file is {} bytes, shorter than a frame header",
                data.len()
            )));
        }
        let magic = &data[..4];
        if magic != MAGIC_SNAPSHOT {
            if magic == MAGIC_SNAPSHOT_V1 {
                return Err(mismatch(
                    "snapshot is in the retired FJS1 format and is not read by this build".into(),
                ));
            }
            return Err(mismatch(format!(
                "snapshot magic {magic:02x?} is not a snapshot header"
            )));
        }
        // Header first, as in `scan_records`: the length decides how these
        // bytes are cut up, so it is checked against itself before it is used.
        // Nothing destructive hangs off a snapshot read, but a length believed
        // early is the habit that produced the record-log defect.
        if head_digest(magic, &data[LENGTH_AT]).as_slice() != &data[HEAD_DIGEST_AT] {
            return Err(mismatch(
                "snapshot header failed its own digest: its length is not trustworthy".into(),
            ));
        }
        let length = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
        if data.len() != HEADER + length {
            return Err(mismatch(format!(
                "snapshot frame claims {length} bytes, file holds {}",
                data.len().saturating_sub(HEADER)
            )));
        }
        let payload = &data[HEADER..];
        if body_digest(magic, &data[LENGTH_AT], payload).as_slice() != &data[BODY_DIGEST_AT] {
            return Err(mismatch("snapshot digest does not match its bytes".into()));
        }
        let snapshot: Snapshot = serde_json::from_slice(payload)
            .map_err(|error| mismatch(format!("snapshot did not deserialize: {error}")))?;
        if snapshot.session != self.session {
            return Err(mismatch(format!(
                "snapshot is for session {}, this journal is {}",
                snapshot.session, self.session
            )));
        }
        if snapshot.through_seq > self.last_seq {
            return Err(mismatch(format!(
                "snapshot is through seq {} but the journal ends at {}",
                snapshot.through_seq, self.last_seq
            )));
        }
        Ok(Some(snapshot))
    }
}

/// One hydrate page's position in the record log, chosen by
/// [`Journal::window`] under the journal lock and read without it.
#[derive(Debug, Clone)]
pub struct Window {
    path: PathBuf,
    start: u64,
    end: u64,
    first_seq: u64,
    count: usize,
    /// Records in the requested range remain past this window.
    pub more: bool,
}

impl Window {
    /// Read and verify exactly the frames this window names.
    ///
    /// Strict, unlike the open scan: every byte here was acknowledged, so a
    /// short file, a failed digest or a wrong sequence is damage, never a torn
    /// tail.
    pub fn read(&self) -> Result<Vec<Record>, JournalError> {
        if self.count == 0 {
            return Ok(Vec::new());
        }
        let mut file = File::open(&self.path).map_err(|error| io_error("open journal", error))?;
        file.seek(SeekFrom::Start(self.start))
            .map_err(|error| io_error("seek to hydrate window", error))?;
        let mut data = vec![0u8; (self.end - self.start) as usize];
        file.read_exact(&mut data).map_err(|error| {
            if error.kind() == std::io::ErrorKind::UnexpectedEof {
                JournalError::Malformed {
                    after_seq: self.first_seq - 1,
                    why: format!(
                        "journal ends before byte {} but records through it were acknowledged",
                        self.end
                    ),
                }
            } else {
                io_error("read hydrate window", error)
            }
        })?;
        decode_frames(&data, self.first_seq, self.count)
    }
}

/// Decode `count` contiguous record frames starting at `first_seq`, refusing
/// anything that does not verify.
fn decode_frames(data: &[u8], first_seq: u64, count: usize) -> Result<Vec<Record>, JournalError> {
    let mut records = Vec::with_capacity(count);
    let mut offset = 0usize;
    let mut expected = first_seq;
    let damaged = |expected: u64, why: &str| JournalError::Malformed {
        after_seq: expected - 1,
        why: why.to_string(),
    };
    while offset < data.len() {
        let rest = &data[offset..];
        if rest.len() < HEADER || rest[..4] != MAGIC_RECORD {
            return Err(damaged(expected, "indexed frame has no record header"));
        }
        if head_digest(&rest[..4], &rest[LENGTH_AT]).as_slice() != &rest[HEAD_DIGEST_AT] {
            return Err(damaged(expected, "indexed frame header failed its own digest"));
        }
        let length = u32::from_le_bytes([rest[4], rest[5], rest[6], rest[7]]) as usize;
        if length == 0 || length > MAX_RECORD || rest.len() < HEADER + length {
            return Err(damaged(expected, "indexed frame length does not fit its window"));
        }
        let payload = &rest[HEADER..HEADER + length];
        if body_digest(&rest[..4], &rest[LENGTH_AT], payload).as_slice() != &rest[BODY_DIGEST_AT] {
            return Err(damaged(expected, "indexed frame payload digest mismatch"));
        }
        let record: Record =
            serde_json::from_slice(payload).map_err(|error| JournalError::Malformed {
                after_seq: expected - 1,
                why: format!("record did not deserialize: {error}"),
            })?;
        if record.seq != expected {
            return Err(JournalError::SequenceGap {
                expected,
                found: record.seq,
            });
        }
        records.push(record);
        expected += 1;
        offset += HEADER + length;
    }
    if records.len() != count {
        return Err(damaged(expected, "hydrate window held fewer records than indexed"));
    }
    Ok(records)
}

/// fsync the directory entry after a rename, where the platform allows it.
/// Windows has no handle you can open on a directory through `std::fs`, so
/// this is a no-op there and the rename's own ordering is what we rely on.
#[allow(dead_code)] // only called from write_snapshot, which has no production caller yet
fn sync_directory(file: &Path) {
    if let Some(directory) = file.parent() {
        if let Ok(handle) = File::open(directory) {
            let _ = handle.sync_all();
        }
    }
}

#[cfg(test)]
mod tests;
