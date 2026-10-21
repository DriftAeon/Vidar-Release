//! Unit tests for `journal.rs`, kept out of line so the module file holds only
//! production code.

use super::*;

/// A directory under TEMP that removes itself. No `tempfile` dependency in
/// this crate, and none added for tests.
struct Temp {
    path: PathBuf,
}

impl Temp {
    fn new(tag: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("falcon-journal-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn dir(&self) -> &Path {
        &self.path
    }

    fn journal(&self, session: &str) -> PathBuf {
        self.path.join(format!("{}.journal", file_stem(session)))
    }

    fn snapshot(&self, session: &str) -> PathBuf {
        self.path.join(format!("{}.snapshot", file_stem(session)))
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn diagnostic(text: &str) -> Body {
    Body::Event {
        body: EventBody::Diagnostic {
            text: text.to_string(),
        },
    }
}

fn started() -> Body {
    Body::Started {
        session: "s".into(),
        agent: "claude".into(),
        cwd: r"C:\Work\Example".into(),
        model: Some("opus".into()),
        permission_mode: "default".into(),
        conversation: None,
        pid: 4242,
    }
}

fn frame_for(seq: u64, text: &str) -> Vec<u8> {
    let record = Record {
        seq,
        generation: 1,
        at_ms: 1_700_000_000_000,
        body: diagnostic(text),
    };
    encode_frame(
        MAGIC_RECORD,
        &serde_json::to_vec(&record).expect("serialize"),
    )
}

fn size(path: &Path) -> u64 {
    fs::metadata(path).expect("metadata").len()
}

fn truncate(path: &Path, to: u64) {
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open to truncate");
    file.set_len(to).expect("set_len");
}

fn poke(path: &Path, at: usize, value: u8) {
    let mut data = fs::read(path).expect("read to poke");
    data[at] = value;
    fs::write(path, data).expect("write poked");
}

// --- append and read back -------------------------------------------------

#[test]
fn appends_are_read_back_in_order_with_dense_sequences_from_one() {
    let temp = Temp::new("dense");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    assert_eq!(journal.last_seq(), 0, "an empty journal is at seq 0");

    assert_eq!(journal.append(1, started()).expect("first"), 1);
    assert_eq!(journal.append(1, diagnostic("two")).expect("second"), 2);
    assert_eq!(journal.append(2, diagnostic("three")).expect("third"), 3);
    assert_eq!(journal.last_seq(), 3);

    let records = journal.records_after(0).expect("read back");
    assert_eq!(
        records.iter().map(|record| record.seq).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(records[0].body, started());
    assert_eq!(
        records[2].generation, 2,
        "generation is carried, not invented"
    );
    assert!(records[1].at_ms > 0, "append stamps the record");
}

#[test]
fn a_reopened_journal_continues_the_sequence() {
    let temp = Temp::new("reopen");
    let mut first = Journal::open(temp.dir(), "s").expect("open");
    first.append(1, diagnostic("one")).expect("one");
    first.append(1, diagnostic("two")).expect("two");
    drop(first);

    let mut second = Journal::open(temp.dir(), "s").expect("reopen");
    assert_eq!(second.last_seq(), 2);
    assert_eq!(second.append(1, diagnostic("three")).expect("three"), 3);
    assert_eq!(second.records_after(0).expect("read").len(), 3);
}

#[test]
fn two_sessions_share_a_directory_without_sharing_a_journal() {
    let temp = Temp::new("two-sessions");
    let mut left = Journal::open(temp.dir(), "left").expect("left");
    let mut right = Journal::open(temp.dir(), "right").expect("right");
    left.append(1, diagnostic("l1")).expect("l1");
    left.append(1, diagnostic("l2")).expect("l2");
    right.append(1, diagnostic("r1")).expect("r1");

    assert_eq!(left.last_seq(), 2);
    assert_eq!(right.last_seq(), 1, "sequences are per session");
    assert_eq!(right.records_after(0).expect("right records").len(), 1);
}

// --- durability ordering --------------------------------------------------

#[test]
fn append_returns_only_once_the_whole_frame_is_on_disk() {
    let temp = Temp::new("durable");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    let path = temp.journal("s");

    let mut expected_len = 0u64;
    for index in 0..5 {
        let seq = journal
            .append(1, diagnostic(&format!("record {index}")))
            .expect("append");

        // Read through an independent handle, the moment append returned.
        let data = fs::read(&path).expect("independent read");
        assert_eq!(
            data.len() as u64,
            size(&path),
            "no bytes are sitting in a user-space buffer"
        );
        assert!(data.len() as u64 > expected_len, "the frame grew the file");
        expected_len = data.len() as u64;

        // And it is a complete, digest-valid frame, not a prefix.
        let scan = scan_records(&data).expect("scan");
        assert!(!scan.torn, "nothing torn after a returned append");
        assert_eq!(scan.valid_len, data.len());
        assert_eq!(scan.records.last().expect("record").seq, seq);
    }
}

#[test]
fn a_refused_append_does_not_consume_a_sequence_or_touch_the_file() {
    let temp = Temp::new("refused");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let before = size(&temp.journal("s"));

    let oversized = diagnostic(&"x".repeat(MAX_RECORD + 64));
    match journal.append(1, oversized) {
        Err(JournalError::TooLarge { seq, bytes }) => {
            assert_eq!(seq, 2, "the refused record reports the seq it wanted");
            assert!(bytes > MAX_RECORD, "{bytes} must exceed the bound");
        }
        other => panic!("an oversized record must be refused: {other:?}"),
    }

    assert_eq!(journal.last_seq(), 1, "a refusal does not burn a sequence");
    assert_eq!(size(&temp.journal("s")), before, "and writes nothing");
    assert_eq!(journal.append(1, diagnostic("two")).expect("two"), 2);
}

#[test]
fn a_large_but_permitted_record_round_trips() {
    let temp = Temp::new("large");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    let text = "y".repeat(1024 * 1024);
    assert_eq!(journal.append(1, diagnostic(&text)).expect("append"), 1);

    let records = journal.records_after(0).expect("read back");
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].body, diagnostic(&text));
}

// --- torn tail ------------------------------------------------------------

#[test]
fn a_tail_torn_mid_payload_is_discarded_and_earlier_records_survive() {
    let temp = Temp::new("torn-payload");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, started()).expect("one");
    journal.append(1, diagnostic("two")).expect("two");
    let intact = size(&path);
    journal
        .append(1, diagnostic("three, the one the crash ate"))
        .expect("three");
    let full = size(&path);
    drop(journal);

    truncate(&path, full - 9);

    let mut recovered = Journal::open(temp.dir(), "s").expect("open recovers a torn tail");
    assert_eq!(
        recovered.last_seq(),
        2,
        "last_seq is the last intact record"
    );
    let records = recovered.records_after(0).expect("read back");
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].body, started());
    assert_eq!(size(&path), intact, "the torn bytes are gone for good");
    assert_eq!(
        recovered
            .append(1, diagnostic("three, again"))
            .expect("append"),
        3,
        "the sequence stays dense across the recovery"
    );
}

#[test]
fn a_tail_torn_inside_the_header_is_recovered_too() {
    let temp = Temp::new("torn-header");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let intact = size(&path);
    journal.append(1, diagnostic("two")).expect("two");
    let full = size(&path);
    drop(journal);

    // Only five bytes of the next frame's sixteen-byte header landed.
    truncate(&path, intact + 5);
    assert!(full > intact + 5);

    let recovered = Journal::open(temp.dir(), "s").expect("open");
    assert_eq!(recovered.last_seq(), 1);
    assert_eq!(size(&path), intact);
}

#[test]
fn a_zero_filled_tail_is_treated_as_torn_not_as_damage() {
    let temp = Temp::new("torn-zeros");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let intact = size(&path) as usize;
    journal.append(1, diagnostic("two")).expect("two");
    drop(journal);

    // The file was extended but the data never landed: NTFS shows zeros.
    let mut data = fs::read(&path).expect("read");
    for byte in data.iter_mut().skip(intact) {
        *byte = 0;
    }
    fs::write(&path, &data).expect("write zero tail");

    let recovered = Journal::open(temp.dir(), "s").expect("open");
    assert_eq!(recovered.last_seq(), 1);
    assert_eq!(
        size(&path) as usize,
        intact,
        "the zero fill is truncated away"
    );
}

#[test]
fn recovering_a_torn_tail_is_idempotent() {
    let temp = Temp::new("torn-twice");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    journal.append(1, diagnostic("two")).expect("two");
    let full = size(&path);
    drop(journal);

    truncate(&path, full - 4);
    let first = Journal::open(temp.dir(), "s").expect("first open");
    let after_recovery = size(&path);
    drop(first);

    let second = Journal::open(temp.dir(), "s").expect("second open");
    assert_eq!(second.last_seq(), 1);
    assert_eq!(size(&path), after_recovery, "a clean journal is left alone");
}

#[test]
fn an_empty_journal_file_opens_clean() {
    let temp = Temp::new("empty");
    let journal = Journal::open(temp.dir(), "s").expect("open");
    assert_eq!(journal.last_seq(), 0);
    assert!(journal.records_after(0).expect("read").is_empty());
    assert!(temp.journal("s").exists(), "open creates the file");
}

// --- interior corruption --------------------------------------------------

#[test]
fn an_interior_flipped_byte_fails_the_open_with_malformed() {
    let temp = Temp::new("interior");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let after_first = size(&path) as usize;
    journal.append(1, diagnostic("two")).expect("two");
    journal.append(1, diagnostic("three")).expect("three");
    drop(journal);

    // Damage the second record's payload, well inside the file.
    poke(&path, after_first + HEADER + 3, b'!');

    // `Journal` is deliberately not `Debug` (it is a frozen type), so the
    // Ok arm is reduced to something printable before matching.
    match Journal::open(temp.dir(), "s").map(|journal| journal.last_seq()) {
        Err(JournalError::Malformed { after_seq, why }) => {
            assert_eq!(after_seq, 1, "reports the last sequence it reached");
            assert!(why.contains("digest"), "{why}");
        }
        other => panic!("interior damage must fail the open: {other:?}"),
    }
}

#[test]
fn an_interior_frame_header_that_is_not_ours_fails_the_open() {
    let temp = Temp::new("interior-magic");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let after_first = size(&path) as usize;
    journal.append(1, diagnostic("two")).expect("two");
    journal.append(1, diagnostic("three")).expect("three");
    drop(journal);

    poke(&path, after_first, b'Z');

    assert!(
        matches!(
            Journal::open(temp.dir(), "s"),
            Err(JournalError::Malformed { after_seq: 1, .. })
        ),
        "a broken interior header is damage, not a torn tail"
    );
}

#[test]
fn interior_damage_wins_over_a_torn_tail() {
    let temp = Temp::new("both");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let after_first = size(&path) as usize;
    journal.append(1, diagnostic("two")).expect("two");
    journal.append(1, diagnostic("three")).expect("three");
    let full = size(&path);
    drop(journal);

    truncate(&path, full - 6);
    poke(&path, after_first + HEADER + 2, b'!');

    assert!(
        matches!(
            Journal::open(temp.dir(), "s"),
            Err(JournalError::Malformed { .. })
        ),
        "a torn tail must not excuse damage behind it"
    );
}

#[test]
fn an_absurd_frame_length_is_malformed_not_a_torn_tail() {
    let temp = Temp::new("bad-length");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    drop(journal);

    // A length field no valid record could carry, at offset 4..8.
    let mut data = fs::read(&path).expect("read");
    data[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    fs::write(&path, data).expect("write");

    assert!(matches!(
        Journal::open(temp.dir(), "s"),
        Err(JournalError::Malformed { after_seq: 0, .. })
    ));
}

// --- a length field that lies ---------------------------------------------

/// The review's witness. Three valid records; record two's length is raised
/// to a value that is still in range but runs past the end of the file. A
/// scan that reads that number before verifying it calls everything from
/// record two on "a torn tail", and `open` truncates there — destroying
/// record three, which is whole.
#[test]
fn an_interior_length_inflated_past_the_end_is_refused_with_the_file_untouched() {
    let temp = Temp::new("inflated-interior");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let after_first = size(&path) as usize;
    journal.append(1, diagnostic("two")).expect("two");
    journal
        .append(1, diagnostic("three, the record that must survive"))
        .expect("three");
    drop(journal);

    let original = fs::read(&path).expect("read");
    // In range (1..=MAX_RECORD), and longer than everything left in the file.
    let inflated = (original.len() - after_first - HEADER + 4096) as u32;
    let mut damaged = original.clone();
    damaged[after_first + 4..after_first + 8].copy_from_slice(&inflated.to_le_bytes());
    fs::write(&path, &damaged).expect("write damaged");

    match Journal::open(temp.dir(), "s").map(|journal| journal.last_seq()) {
        Err(JournalError::Malformed { after_seq, .. }) => {
            assert_eq!(after_seq, 1, "the scan stops at the damaged record");
        }
        other => {
            panic!("an interior length pointing past the end is damage, not a torn tail: {other:?}")
        }
    }
    assert_eq!(
        fs::read(&path).expect("reread"),
        damaged,
        "a refusal leaves the file byte-identical"
    );

    // And record three really was still on disk: undo the one field we broke.
    fs::write(&path, &original).expect("restore");
    let repaired = Journal::open(temp.dir(), "s").expect("reopen after repair");
    assert_eq!(repaired.last_seq(), 3, "record three was never lost");
    assert_eq!(repaired.records_after(2).expect("tail").len(), 1);
}

/// The same lie told about the last record. There is nothing after it, so
/// "runs past the end" looks exactly like a crash mid-append — but the
/// record is whole, and discarding it loses an acknowledged write.
#[test]
fn an_inflated_length_on_the_last_record_is_refused_not_taken_as_a_torn_tail() {
    let temp = Temp::new("inflated-tail");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let after_first = size(&path) as usize;
    journal
        .append(1, diagnostic("two, whole and fsynced before the damage"))
        .expect("two");
    drop(journal);

    let original = fs::read(&path).expect("read");
    let mut damaged = original.clone();
    // One byte more than the file holds: the smallest possible lie.
    let inflated = (original.len() - after_first - HEADER + 1) as u32;
    damaged[after_first + 4..after_first + 8].copy_from_slice(&inflated.to_le_bytes());
    fs::write(&path, &damaged).expect("write damaged");

    match Journal::open(temp.dir(), "s").map(|journal| journal.last_seq()) {
        Err(JournalError::Malformed { .. }) => {}
        other => {
            panic!("a length that cannot be trusted must not drive a truncation: {other:?}")
        }
    }
    assert_eq!(
        fs::read(&path).expect("reread"),
        damaged,
        "a refusal leaves the file byte-identical"
    );

    fs::write(&path, &original).expect("restore");
    assert_eq!(
        Journal::open(temp.dir(), "s")
            .expect("reopen after repair")
            .last_seq(),
        2,
        "record two was whole the entire time"
    );
}

/// A length that is in range *and* inside the file still has to be the one
/// we wrote. Only the header's own digest can say so, and it has to say so
/// before the number is used for anything.
#[test]
fn a_frame_header_is_verified_before_its_length_is_used() {
    let temp = Temp::new("header-digest");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let after_first = size(&path) as usize;
    journal
        .append(1, diagnostic("a second record with room to shrink"))
        .expect("two");
    journal.append(1, diagnostic("three")).expect("three");
    drop(journal);

    let mut data = fs::read(&path).expect("read");
    let claimed = u32::from_le_bytes([
        data[after_first + 4],
        data[after_first + 5],
        data[after_first + 6],
        data[after_first + 7],
    ]);
    data[after_first + 4..after_first + 8].copy_from_slice(&(claimed - 3).to_le_bytes());
    fs::write(&path, &data).expect("write damaged");

    match Journal::open(temp.dir(), "s").map(|journal| journal.last_seq()) {
        Err(JournalError::Malformed { after_seq, why }) => {
            assert_eq!(after_seq, 1);
            assert!(
                why.contains("header"),
                "the header check must be what fired: {why}"
            );
        }
        other => panic!("a header that fails its own digest must not be used: {other:?}"),
    }
}

/// The same check in the position where calling it a torn tail is most
/// tempting: the last record. A header we cannot authenticate says nothing
/// about where its frame ends, so it cannot say that nothing follows.
#[test]
fn a_damaged_header_digest_on_the_last_record_is_refused_not_recovered() {
    let temp = Temp::new("head-digest-tail");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let after_first = size(&path) as usize;
    journal.append(1, diagnostic("two")).expect("two");
    drop(journal);

    let original = fs::read(&path).expect("read");
    let at = after_first + HEAD_DIGEST_AT.start;
    poke(&path, at, original[at] ^ 0xff);

    match Journal::open(temp.dir(), "s").map(|journal| journal.last_seq()) {
        Err(JournalError::Malformed { after_seq, why }) => {
            assert_eq!(after_seq, 1);
            assert!(why.contains("header"), "{why}");
        }
        other => {
            panic!("a header that fails its digest is damage of unknown extent: {other:?}")
        }
    }
    assert_eq!(
        size(&path) as usize,
        original.len(),
        "nothing was truncated away"
    );
}

/// The counterweight: a genuine unfinished append, where the frame is
/// full-length on disk because the file was extended but the last bytes of
/// the payload never landed. The header is authentic, so the length is
/// believable, so nothing can be hiding after it — this one does recover.
#[test]
fn a_tail_whose_payload_never_landed_is_still_a_torn_tail() {
    let temp = Temp::new("torn-payload-zeros");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let intact = size(&path) as usize;
    journal
        .append(1, diagnostic("two, the append that was interrupted"))
        .expect("two");
    drop(journal);

    let mut data = fs::read(&path).expect("read");
    let end = data.len();
    for byte in data[end - 6..].iter_mut() {
        *byte = 0;
    }
    fs::write(&path, &data).expect("write");

    let recovered = Journal::open(temp.dir(), "s").expect("open recovers a real torn tail");
    assert_eq!(
        recovered.last_seq(),
        1,
        "recovery stops at the last intact record"
    );
    assert_eq!(
        size(&path) as usize,
        intact,
        "and only the unfinished frame is dropped"
    );
}

// --- the retired frame format ---------------------------------------------

/// Journals written by the FJR1 build are refused by name. Their length
/// field was never independently verifiable, so every answer this build
/// could give about one would be a guess — including "the tail is torn".
#[test]
fn a_retired_v1_journal_is_refused_and_left_alone() {
    let temp = Temp::new("v1");
    let path = temp.journal("s");

    // Built the way the old encoder built it: one digest over length ++ payload.
    let record = Record {
        seq: 1,
        generation: 1,
        at_ms: 1_700_000_000_000,
        body: diagnostic("old build"),
    };
    let payload = serde_json::to_vec(&record).expect("serialize");
    let length = (payload.len() as u32).to_le_bytes();
    let mut hasher = Sha256::new();
    hasher.update(length);
    hasher.update(&payload);
    let digest = hasher.finalize();
    let mut v1 = Vec::new();
    v1.extend_from_slice(&MAGIC_RECORD_V1);
    v1.extend_from_slice(&length);
    v1.extend_from_slice(&digest[..8]);
    v1.extend_from_slice(&payload);
    fs::write(&path, &v1).expect("write a v1 journal");

    match Journal::open(temp.dir(), "s").map(|journal| journal.last_seq()) {
        Err(JournalError::Malformed { after_seq, why }) => {
            assert_eq!(after_seq, 0);
            assert!(why.contains("FJR1"), "the refusal names the format: {why}");
        }
        other => panic!("a v1 journal must be refused, never guessed at: {other:?}"),
    }
    assert_eq!(
        fs::read(&path).expect("reread"),
        v1,
        "and left exactly as it was"
    );
}

#[test]
fn a_retired_v1_snapshot_is_refused_by_name() {
    let temp = Temp::new("v1-snap");
    let journal = Journal::open(temp.dir(), "s").expect("open");

    let payload = serde_json::to_vec(&snapshot_of("s", 0, "old")).expect("serialize");
    let length = (payload.len() as u32).to_le_bytes();
    let mut hasher = Sha256::new();
    hasher.update(length);
    hasher.update(&payload);
    let digest = hasher.finalize();
    let mut v1 = Vec::new();
    v1.extend_from_slice(&MAGIC_SNAPSHOT_V1);
    v1.extend_from_slice(&length);
    v1.extend_from_slice(&digest[..8]);
    v1.extend_from_slice(&payload);
    fs::write(&temp.snapshot("s"), v1).expect("write a v1 snapshot");

    match journal.read_snapshot() {
        Err(JournalError::SnapshotMismatch { why }) => {
            assert!(why.contains("FJS1"), "{why}");
        }
        other => panic!("a v1 snapshot must be reported, not ignored: {other:?}"),
    }
}

// --- sequence gaps --------------------------------------------------------

#[test]
fn a_missing_interior_record_is_a_sequence_gap() {
    let temp = Temp::new("gap");
    let path = temp.journal("s");
    let mut bytes = Vec::new();
    for seq in [1u64, 2, 4] {
        bytes.extend_from_slice(&frame_for(seq, "body"));
    }
    fs::write(&path, &bytes).expect("write hand-built journal");

    match Journal::open(temp.dir(), "s").map(|journal| journal.last_seq()) {
        Err(JournalError::SequenceGap { expected, found }) => {
            assert_eq!((expected, found), (3, 4));
        }
        other => panic!("a gap must not be recovered from: {other:?}"),
    }
}

#[test]
fn a_journal_that_does_not_start_at_one_is_a_sequence_gap() {
    let temp = Temp::new("gap-start");
    fs::write(&temp.journal("s"), frame_for(2, "body")).expect("write");
    assert!(matches!(
        Journal::open(temp.dir(), "s"),
        Err(JournalError::SequenceGap {
            expected: 1,
            found: 2
        })
    ));
}

#[test]
fn a_repeated_sequence_is_a_gap_too() {
    let temp = Temp::new("gap-repeat");
    let mut bytes = frame_for(1, "one");
    bytes.extend_from_slice(&frame_for(1, "one again"));
    fs::write(&temp.journal("s"), bytes).expect("write");
    assert!(matches!(
        Journal::open(temp.dir(), "s"),
        Err(JournalError::SequenceGap {
            expected: 2,
            found: 1
        })
    ));
}

#[test]
fn records_disappearing_behind_the_journal_are_reported() {
    let temp = Temp::new("shrunk");
    let path = temp.journal("s");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    let after_first = size(&path);
    journal.append(1, diagnostic("two")).expect("two");

    // Cut the second record off outside the journal's knowledge: seq 2 was
    // already acknowledged, so silently returning one record would lie.
    truncate(&path, after_first);
    assert!(matches!(
        journal.records_after(0),
        Err(JournalError::Malformed { after_seq: 1, .. })
    ));
}

// --- records_after boundaries --------------------------------------------

#[test]
fn records_after_respects_its_boundaries() {
    let temp = Temp::new("after");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    for index in 1..=3 {
        journal
            .append(1, diagnostic(&format!("r{index}")))
            .expect("append");
    }

    let seqs = |records: Vec<Record>| {
        records
            .into_iter()
            .map(|record| record.seq)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        seqs(journal.records_after(0).expect("from zero")),
        vec![1, 2, 3]
    );
    assert_eq!(
        seqs(journal.records_after(1).expect("after first")),
        vec![2, 3]
    );
    assert_eq!(
        seqs(journal.records_after(2).expect("after second")),
        vec![3]
    );
    assert!(
        journal.records_after(3).expect("at last_seq").is_empty(),
        "after the last sequence there is nothing"
    );
    assert!(
        journal
            .records_after(99)
            .expect("beyond last_seq")
            .is_empty(),
        "beyond the end is empty, not an error"
    );
    assert!(Journal::open(temp.dir(), "fresh")
        .expect("fresh")
        .records_after(0)
        .expect("empty")
        .is_empty());
}

// --- snapshots ------------------------------------------------------------

fn snapshot_of(session: &str, through: u64, marker: &str) -> Snapshot {
    Snapshot {
        session: session.to_string(),
        through_seq: through,
        generation: 1,
        state: serde_json::json!({ "marker": marker, "events": [1, 2, 3] }),
    }
}

#[test]
fn a_snapshot_round_trips() {
    let temp = Temp::new("snap");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    assert!(journal.read_snapshot().expect("no snapshot yet").is_none());

    journal.append(1, diagnostic("one")).expect("one");
    journal.append(1, diagnostic("two")).expect("two");
    let snapshot = snapshot_of("s", 2, "first");
    journal.write_snapshot(&snapshot).expect("write");

    assert_eq!(
        journal.read_snapshot().expect("read"),
        Some(snapshot.clone())
    );

    drop(journal);
    let reopened = Journal::open(temp.dir(), "s").expect("reopen");
    assert_eq!(reopened.read_snapshot().expect("read"), Some(snapshot));
}

#[test]
fn writing_a_snapshot_replaces_the_previous_one_and_leaves_no_temp() {
    let temp = Temp::new("snap-replace");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    for index in 1..=3 {
        journal
            .append(1, diagnostic(&format!("r{index}")))
            .expect("append");
    }
    journal
        .write_snapshot(&snapshot_of("s", 1, "old"))
        .expect("old");
    journal
        .write_snapshot(&snapshot_of("s", 3, "new"))
        .expect("new");

    let read = journal.read_snapshot().expect("read").expect("some");
    assert_eq!(read.through_seq, 3);
    assert_eq!(read.state["marker"], serde_json::json!("new"));

    let temps: Vec<_> = fs::read_dir(temp.dir())
        .expect("read dir")
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(
        temps.is_empty(),
        "the staging file is renamed, never left behind"
    );
}

#[test]
fn a_truncated_snapshot_is_reported_not_ignored() {
    let temp = Temp::new("snap-torn");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    journal
        .write_snapshot(&snapshot_of("s", 1, "whole"))
        .expect("write");

    let path = temp.snapshot("s");
    truncate(&path, size(&path) - 7);

    match journal.read_snapshot() {
        Err(JournalError::SnapshotMismatch { why }) => {
            assert!(why.contains("claims"), "{why}");
        }
        other => panic!("a torn snapshot must be reported: {other:?}"),
    }
}

#[test]
fn a_snapshot_with_a_flipped_byte_is_reported() {
    let temp = Temp::new("snap-flip");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    journal
        .write_snapshot(&snapshot_of("s", 1, "whole"))
        .expect("write");

    let path = temp.snapshot("s");
    poke(&path, HEADER + 4, b'~');

    assert!(matches!(
        journal.read_snapshot(),
        Err(JournalError::SnapshotMismatch { .. })
    ));
}

#[test]
fn an_empty_or_unframed_snapshot_file_is_reported() {
    let temp = Temp::new("snap-unframed");
    let journal = Journal::open(temp.dir(), "s").expect("open");
    let path = temp.snapshot("s");

    fs::write(&path, b"").expect("empty");
    assert!(matches!(
        journal.read_snapshot(),
        Err(JournalError::SnapshotMismatch { .. })
    ));

    // Bare JSON, as a naive writer would leave it: not a valid frame.
    fs::write(
        &path,
        br#"{"session":"s","through_seq":0,"generation":1,"state":{}}"#,
    )
    .expect("bare json");
    assert!(matches!(
        journal.read_snapshot(),
        Err(JournalError::SnapshotMismatch { .. })
    ));
}

#[test]
fn a_snapshot_from_another_session_is_refused_both_ways() {
    let temp = Temp::new("snap-session");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");

    assert!(matches!(
        journal.write_snapshot(&snapshot_of("other", 1, "wrong")),
        Err(JournalError::SnapshotMismatch { .. })
    ));

    // And on the way in, for a file written by something else.
    let payload = serde_json::to_vec(&snapshot_of("other", 1, "wrong")).expect("serialize");
    fs::write(&temp.snapshot("s"), encode_frame(MAGIC_SNAPSHOT, &payload)).expect("write");
    assert!(matches!(
        journal.read_snapshot(),
        Err(JournalError::SnapshotMismatch { .. })
    ));
}

#[test]
fn a_snapshot_ahead_of_the_journal_is_refused_both_ways() {
    let temp = Temp::new("snap-ahead");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");

    assert!(
        matches!(
            journal.write_snapshot(&snapshot_of("s", 99, "ahead")),
            Err(JournalError::SnapshotMismatch { .. })
        ),
        "a snapshot cannot describe records the journal does not have"
    );

    let payload = serde_json::to_vec(&snapshot_of("s", 99, "ahead")).expect("serialize");
    fs::write(&temp.snapshot("s"), encode_frame(MAGIC_SNAPSHOT, &payload)).expect("write");
    assert!(matches!(
        journal.read_snapshot(),
        Err(JournalError::SnapshotMismatch { .. })
    ));
}

#[test]
fn a_snapshot_behind_the_journal_is_fine() {
    let temp = Temp::new("snap-behind");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    for index in 1..=4 {
        journal
            .append(1, diagnostic(&format!("r{index}")))
            .expect("append");
    }
    journal
        .write_snapshot(&snapshot_of("s", 2, "behind"))
        .expect("write");

    let snapshot = journal.read_snapshot().expect("read").expect("some");
    let tail = journal.records_after(snapshot.through_seq).expect("tail");
    assert_eq!(
        tail.iter().map(|record| record.seq).collect::<Vec<_>>(),
        vec![3, 4],
        "replay resumes from the snapshot's sequence"
    );
}

// --- session ids as file names -------------------------------------------

#[test]
fn a_session_id_cannot_steer_the_write_out_of_the_directory() {
    let temp = Temp::new("traversal");
    let inner = temp.dir().join("inner");
    let mut journal = Journal::open(&inner, r"..\..\escape").expect("open");
    journal.append(1, diagnostic("one")).expect("append");

    let files: Vec<String> = fs::read_dir(&inner)
        .expect("read dir")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        files.len(),
        1,
        "one journal, inside the directory: {files:?}"
    );
    assert!(!files[0].contains(".."), "{files:?}");
    assert!(
        !temp.dir().join("escape.journal").exists(),
        "nothing was written to the parent"
    );
}

#[test]
fn distinct_session_ids_never_share_a_file() {
    assert_ne!(file_stem("a/b"), file_stem("a_b"));
    assert_ne!(file_stem(".."), file_stem("__"));
    assert_eq!(file_stem("plain-session_1.0"), "plain-session_1.0");
}

#[test]
fn a_dos_device_name_does_not_become_a_dos_device() {
    let temp = Temp::new("device");
    for name in ["NUL", "con", "COM1"] {
        assert_ne!(
            file_stem(name).to_ascii_uppercase(),
            name.to_ascii_uppercase(),
            "{name} must not be used verbatim"
        );
    }
    let mut journal = Journal::open(temp.dir(), "NUL").expect("open");
    journal.append(1, diagnostic("one")).expect("append");
    drop(journal);

    let reopened = Journal::open(temp.dir(), "NUL").expect("reopen");
    assert_eq!(reopened.last_seq(), 1, "the write went to a real file");
}

// --- indexed hydrate windows ----------------------------------------------

/// Page through `journal` the way hydration does and return every record seen.
fn page_all(journal: &Journal, through: u64, limit: usize, budget: usize) -> Vec<Record> {
    let mut seen = Vec::new();
    let mut after = 0u64;
    loop {
        let window = journal.window(after, through, limit, budget);
        let page = window.read().expect("window reads");
        assert!(page.len() <= limit, "a page never exceeds its count");
        if let Some(last) = page.last() {
            after = last.seq;
        }
        let more = window.more;
        assert!(!page.is_empty() || !more, "a page with more after it is never empty");
        seen.extend(page);
        if !more {
            return seen;
        }
    }
}

/// The index-located slice must return exactly what a full scan returns, in
/// pages bounded by count and by bytes, after appends and after a reopen that
/// rebuilds the index. Regression guard for replacing the per-page full rescan.
#[test]
fn indexed_windows_match_a_full_scan_across_pages_and_appends() {
    let temp = Temp::new("window");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, started()).expect("started");
    for index in 0..40 {
        // Uneven sizes so the byte budget cuts pages at varying counts.
        journal
            .append(1, diagnostic(&"y".repeat(10 + (index * 37) % 300)))
            .expect("append");
    }
    let full = journal.records_after(0).expect("full scan");
    assert_eq!(page_all(&journal, u64::MAX, 7, usize::MAX), full, "count-bounded pages");
    assert_eq!(page_all(&journal, u64::MAX, 1000, 900), full, "byte-bounded pages");

    // `through` caps the range; `after` past the end is empty.
    let capped = page_all(&journal, 12, 5, usize::MAX);
    assert_eq!(capped, full[..12].to_vec());
    let empty = journal.window(41, u64::MAX, 10, usize::MAX);
    assert!(!empty.more);
    assert!(empty.read().expect("empty window").is_empty());

    // Appends extend the index.
    for index in 0..5 {
        journal.append(2, diagnostic(&format!("late {index}"))).expect("late");
    }
    let full = journal.records_after(0).expect("full scan after appends");
    assert_eq!(full.len(), 46);
    assert_eq!(page_all(&journal, u64::MAX, 9, 700), full, "after appends");
    let tail = journal.window(41, u64::MAX, 100, usize::MAX);
    assert_eq!(tail.read().expect("tail"), full[41..].to_vec());

    // A reopen rebuilds the index from the scan.
    drop(journal);
    let reopened = Journal::open(temp.dir(), "s").expect("reopen");
    assert_eq!(page_all(&reopened, u64::MAX, 6, 500), full, "after reopen");
}

/// A record larger than the byte budget still leads its own page, so the
/// caller sees it and can refuse it by name instead of paging forever.
#[test]
fn an_oversized_record_leads_its_own_window() {
    let temp = Temp::new("window-big");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("small")).expect("small");
    journal.append(1, diagnostic(&"z".repeat(2000))).expect("big");
    journal.append(1, diagnostic("after")).expect("after");

    let first = journal.window(0, u64::MAX, 10, 500);
    assert_eq!(first.read().expect("first").len(), 1, "stops before the big one");
    assert!(first.more);
    let second = journal.window(1, u64::MAX, 10, 500);
    let page = second.read().expect("second");
    assert_eq!(page.len(), 1, "the big record alone");
    assert_eq!(page[0].seq, 2);
    assert!(second.more);
}

/// Bytes the index names were acknowledged, so damage under them is refused,
/// never read as a torn tail.
#[test]
fn a_window_over_damaged_bytes_is_refused() {
    let temp = Temp::new("window-damage");
    let mut journal = Journal::open(temp.dir(), "s").expect("open");
    journal.append(1, diagnostic("one")).expect("one");
    journal.append(1, diagnostic("two")).expect("two");
    let path = temp.journal("s");
    let at = size(&path) as usize - 2;
    let data = fs::read(&path).expect("read");
    poke(&path, at, data[at] ^ 0xff);
    assert!(matches!(
        journal.window(0, u64::MAX, 10, usize::MAX).read(),
        Err(JournalError::Malformed { .. })
    ));
    truncate(&path, 10);
    assert!(matches!(
        journal.window(0, u64::MAX, 10, usize::MAX).read(),
        Err(JournalError::Malformed { .. })
    ));
}
