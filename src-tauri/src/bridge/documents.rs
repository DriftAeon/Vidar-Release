// Documents: the Document tab catalog (inbox, newest runs, cached docs\ tree scan), the
// .md/.txt reader and writer, and the passage-comments sidecars.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::drop::validate_drop_path;
use super::{display_dir, is_doc, kind_of, open_drop_file, runs_dir, scan_kind, DisplayEntry, FILE_ATTRIBUTE_REPARSE_POINT};

/// The inbox is a folder of one-note files; newest first, capped so a
/// full inbox never pushes the run's own documents out of the picker.
fn inbox_dir() -> PathBuf {
    crate::paths::inbox_dir()
}
const INBOX_CAP: usize = 10;
/// `display\reviews\` documents (group "Reviews"), after Inbox; same cap and order.
const REVIEWS_CAP: usize = 10;
/// Top-level `display\` visuals (group "Display"), after Reviews; same cap and order.
const DISPLAY_CAP: usize = 10;
/// Catalog order inside a run folder before "newest first"
const RUN_PINNED: &[&str] = &["context.md", "notes.md", "plan.md"];
/// The repo's own docs tree, browsable from the Document picker:
/// every top-level folder except the ones already covered elsewhere in the
/// catalog (Inbox above; run folders have their own group; archive is closed).
fn docs_dir() -> PathBuf {
    crate::paths::docs_dir()
}
const DOCS_EXCLUDE: &[&str] = &["inbox", "runs", "archive"];
const DOCS_CAP: usize = 30;

/// How many run folders the picker's "Runs" folder lists (newest by name).
const RUNS_SHOWN: usize = 5;
/// Per-run cap on listed documents.
const RUN_CAP: usize = 40;

/// The newest `RUNS_SHOWN` run folders under `root` by name (the yyyy-mm-dd prefix sorts), newest
/// first; `_template` and other underscore folders are never listed.
fn recent_run_dirs_at(root: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(root) else { return Vec::new() };
    let mut runs: Vec<(String, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(|n| (n.to_owned(), e.path())))
        .filter(|(n, _)| !n.starts_with('_'))
        .collect();
    runs.sort_by(|a, b| b.0.cmp(&a.0));
    runs.truncate(RUNS_SHOWN);
    runs.into_iter().map(|(_, p)| p).collect()
}

/// One run folder's documents (group `Run · <slug>`): its root plus briefs/, reports/, reviews/ —
/// pinned CONTEXT, NOTES, plan first (root only), then newest first, capped `RUN_CAP`.
fn scan_run_at(run: &Path, now_ms: u64) -> Vec<DisplayEntry> {
    let slug = run.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let group = format!("Run · {slug}");
    let mut files: Vec<DisplayEntry> = Vec::new();
    for dir in std::iter::once(run.to_path_buf()).chain(["briefs", "reports", "reviews"].iter().map(|s| run.join(s))) {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if let Some(d) = doc_entry(&e.path(), now_ms, &group) {
                files.push(d);
            }
        }
    }
    // pinned names count only at the run root (a reviews\plan.md must not outrank NOTES.md)
    let rank = |e: &DisplayEntry| {
        let p = Path::new(&e.path);
        if p.parent() != Some(run) {
            return RUN_PINNED.len();
        }
        let n = p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        RUN_PINNED.iter().position(|x| *x == n).unwrap_or(RUN_PINNED.len())
    };
    files.sort_by(|a, b| rank(a).cmp(&rank(b)).then(b.mtime_ms.cmp(&a.mtime_ms)));
    files.truncate(RUN_CAP);
    files
}

/// `scan_run_at` for each of the newest `RUNS_SHOWN` runs under `root`, newest run first.
fn scan_runs_at(root: &Path, now_ms: u64) -> Vec<DisplayEntry> {
    recent_run_dirs_at(root).iter().flat_map(|r| scan_run_at(r, now_ms)).collect()
}

/// One catalog entry for a .md/.txt outside bridge\display; same mid-write skip as scan_kind.
fn doc_entry(p: &Path, now_ms: u64, group: &str) -> Option<DisplayEntry> {
    let name = p.to_string_lossy().to_ascii_lowercase();
    if !is_doc(&name) {
        return None;
    }
    let meta = fs::metadata(p).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime_ms = mtime_ms_of(&meta);
    if now_ms.saturating_sub(mtime_ms) < 2000 {
        return None;
    }
    Some(DisplayEntry { path: p.to_string_lossy().into_owned(), kind: kind_of(&name), mtime_ms, group: Some(group.to_owned()) })
}

/// Top-level documents of `display\reviews\` (group "Reviews", newest first, `REVIEWS_CAP`).
fn scan_reviews_at(dir: &Path, now_ms: u64) -> Vec<DisplayEntry> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut reviews: Vec<DisplayEntry> = rd.flatten().filter_map(|e| doc_entry(&e.path(), now_ms, "Reviews")).collect();
    reviews.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    reviews.truncate(REVIEWS_CAP);
    reviews
}

/// Top-level `.svg`/`.html`/`.png` of `display\` (group "Display", newest first, `DISPLAY_CAP`):
/// no subfolders (so not `reviews\`), no reparse points, no dot-names, same 2 s mid-write skip.
/// Listed only: Document paints them through the display readers (`display_child`), and
/// `read_document`/`write_document` keep refusing them (`DOC_EXT`).
fn scan_display_at(dir: &Path, now_ms: u64) -> Vec<DisplayEntry> {
    use std::os::windows::fs::MetadataExt;
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<DisplayEntry> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            if name.starts_with('.') || !(name.ends_with(".svg") || name.ends_with(".html") || name.ends_with(".png")) {
                return None;
            }
            let md = fs::symlink_metadata(&p).ok()?;
            if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !md.is_file() {
                return None;
            }
            let mtime_ms = mtime_ms_of(&md);
            if now_ms.saturating_sub(mtime_ms) < 2000 {
                return None;
            }
            Some(DisplayEntry { path: p.to_string_lossy().into_owned(), kind: kind_of(&name), mtime_ms, group: Some("Display".to_owned()) })
        })
        .collect();
    files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    files.truncate(DISPLAY_CAP);
    files
}

/// `docs\inbox\*` (group "Inbox", newest first, `INBOX_CAP`), `display\reviews\`, the top of `display\`
/// (group "Display", `scan_display_at`), then the documents of
/// the newest `RUNS_SHOWN` run folders (group `Run · <slug>` each, newest run first; see `scan_run_at`).
pub(super) fn scan_run_docs(now_ms: u64) -> Vec<DisplayEntry> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(inbox_dir()) {
        let mut inbox: Vec<DisplayEntry> = rd
            .flatten()
            .filter(|e| !e.file_name().eq_ignore_ascii_case("README.md"))
            .filter_map(|e| doc_entry(&e.path(), now_ms, "Inbox"))
            .collect();
        inbox.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
        inbox.truncate(INBOX_CAP);
        out.extend(inbox);
    }
    out.extend(scan_reviews_at(&crate::paths::display_reviews_dir(), now_ms));
    // Astra Code's reports (its cwd is the astra-reports path id) stay listed beside the review tab's.
    out.extend(scan_reviews_at(&crate::paths::bridge_dir().join("astra-reports"), now_ms));
    out.extend(scan_display_at(&display_dir(), now_ms));
    out.extend(scan_runs_at(&runs_dir(), now_ms));
    out
}

/// Top-level `docs\` folders eligible for the picker: directories only, the
/// exclusion list dropped case-insensitively, sorted by name (the catalog
/// order, independent of filesystem enumeration order).
fn docs_top_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = fs::read_dir(root) else { return Vec::new() };
    let mut tops: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(|n| (n.to_owned(), e.path())))
        .filter(|(n, _)| !DOCS_EXCLUDE.iter().any(|x| x.eq_ignore_ascii_case(n)))
        .collect();
    tops.sort_by(|a, b| a.0.cmp(&b.0));
    tops
}

/// True for a `.md`/`.txt` file `doc_entry` would have accepted except that it
/// was modified under 2 s ago — the same mid-write guard, asked the opposite
/// question: not "is this ready", but "is there one we're deliberately not
/// showing yet".
fn is_doc_but_too_fresh(p: &Path, now_ms: u64) -> bool {
    let name = p.to_string_lossy().to_ascii_lowercase();
    if !is_doc(&name) {
        return false;
    }
    let Ok(meta) = fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    now_ms.saturating_sub(mtime_ms_of(&meta)) < 2000
}

/// `docs\<top>\` for each top folder `docs_top_dirs` keeps, `.md`/`.txt` at
/// depth 1 and depth 2, one group `Docs · <top>` per folder, newest first,
/// capped `DOCS_CAP`. Takes the root as a parameter so it can be pointed at a
/// temp dir under test; the cached, real-root entry point is `scan_docs_tree`.
/// The second return value is true iff a doc file existed but was skipped for
/// being under 2 s old — `scan_docs_tree` must not cache that result, or the
/// file stays invisible for the rest of the cache's 30 s window instead of
/// showing up on the very next tick once it's no longer mid-write.
fn scan_docs_tree_at(root: &Path, now_ms: u64) -> (Vec<DisplayEntry>, bool) {
    let mut out = Vec::new();
    let mut skipped_fresh = false;
    for (name, dir) in docs_top_dirs(root) {
        let group = format!("Docs · {name}");
        let mut files: Vec<DisplayEntry> = Vec::new();
        let Ok(rd1) = fs::read_dir(&dir) else { continue };
        for e in rd1.flatten() {
            let p = e.path();
            if p.is_dir() {
                let Ok(rd2) = fs::read_dir(&p) else { continue };
                for e2 in rd2.flatten() {
                    match doc_entry(&e2.path(), now_ms, &group) {
                        Some(d) => files.push(d),
                        None => skipped_fresh |= is_doc_but_too_fresh(&e2.path(), now_ms),
                    }
                }
            } else {
                match doc_entry(&p, now_ms, &group) {
                    Some(d) => files.push(d),
                    None => skipped_fresh |= is_doc_but_too_fresh(&p, now_ms),
                }
            }
        }
        files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
        files.truncate(DOCS_CAP);
        out.extend(files);
    }
    (out, skipped_fresh)
}

/// mtimes of `docs\` itself and each top dir it currently holds: a new file
/// bumps its parent dir's mtime on NTFS (caught here), an edit to an existing
/// file does not (caught by the 30 s expiry in `scan_docs_tree` instead).
fn docs_dir_sig(root: &Path) -> Vec<(String, u64)> {
    let mut sig = Vec::new();
    if let Ok(meta) = fs::metadata(root) {
        sig.push((root.to_string_lossy().into_owned(), mtime_ms_of(&meta)));
    }
    for (name, dir) in docs_top_dirs(root) {
        if let Ok(meta) = fs::metadata(&dir) {
            sig.push((name, mtime_ms_of(&meta)));
        }
    }
    sig
}

static DOCS_CACHE: Mutex<Option<(Vec<(String, u64)>, u64, Vec<DisplayEntry>)>> = Mutex::new(None);

/// Cached `scan_docs_tree_at(docs_dir(), now_ms)`: `start_display_poller` calls
/// this every 2 s, and re-walking every top folder to depth 2 on each tick was
/// ~70 metadata() calls and ~12 read_dirs for no reason.
pub(super) fn scan_docs_tree(now_ms: u64) -> Vec<DisplayEntry> {
    let sig = docs_dir_sig(&docs_dir());
    {
        let cache = DOCS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((csig, at, entries)) = cache.as_ref() {
            if *csig == sig && now_ms.saturating_sub(*at) < 30_000 {
                return entries.clone();
            }
        }
    }
    let (out, skipped_fresh) = scan_docs_tree_at(&docs_dir(), now_ms);
    // A file skipped only for being <2s old will look right again on the very
    // next 2 s poll tick; caching this result would hide it for the rest of
    // the 30 s window instead.
    if !skipped_fresh {
        *DOCS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((sig, now_ms, out.clone()));
    }
    out
}

#[cfg(test)]
mod docs_tree_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn create_document_writes_into_the_given_reviews_dir() {
        let reviews = std::env::temp_dir()
            .join(format!("vidar-create-doc-test-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()))
            .join("display")
            .join("reviews");
        assert!(!reviews.exists());
        let made = create_document_in(&reviews, "Notes".into()).unwrap();
        assert_eq!(PathBuf::from(&made), reviews.join("Notes.md"));
        assert_eq!(fs::read_to_string(&made).unwrap(), "# Notes\n");
        assert!(create_document_in(&reviews, "Notes".into()).is_err());
        let _ = fs::remove_dir_all(reviews.parent().unwrap());
    }

    #[test]
    fn groups_by_top_folder_and_drops_excluded_ones() {
        let root = std::env::temp_dir().join(format!(
            "vidar-docs-tree-test-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        write(&root.join("reference").join("a.md"), "a");
        write(&root.join("reference").join("sub").join("b.md"), "b");
        write(&root.join("shelf").join("c.txt"), "c");
        write(&root.join("inbox").join("skip.md"), "skip");
        write(&root.join("runs").join("skip2.md"), "skip");
        write(&root.join("archive").join("skip3.md"), "skip");

        // now_ms far enough past write time that the 2 s mid-write skip doesn't hide these
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 10_000;
        let (entries, skipped_fresh) = scan_docs_tree_at(&root, now_ms);
        let groups: std::collections::BTreeSet<_> = entries.iter().filter_map(|e| e.group.clone()).collect();
        assert_eq!(groups, ["Docs · reference".to_string(), "Docs · shelf".to_string()].into_iter().collect());
        assert!(entries.iter().all(|e| !e.path.contains("skip")));
        assert!(entries.iter().any(|e| e.path.ends_with("a.md")));
        assert!(entries.iter().any(|e| e.path.ends_with("b.md"))); // depth 2
        assert!(!skipped_fresh);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn runs_group_lists_newest_five_newest_run_first_pinning_only_at_root() {
        let root = std::env::temp_dir().join(format!(
            "vidar-runs-test-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        for d in 1..=6 {
            write(&root.join(format!("2026-10-0{d}-run{d}")).join("plan.md"), "p");
        }
        write(&root.join("_template").join("plan.md"), "t");
        write(&root.join("2026-10-06-run6").join("reviews").join("plan.md"), "nested");
        write(&root.join("2026-10-06-run6").join("notes.md"), "n");
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 10_000;
        let got = scan_runs_at(&root, now_ms);
        let groups: Vec<&str> = got.iter().filter_map(|e| e.group.as_deref()).collect();
        assert!(groups.iter().all(|g| *g != "Run · 2026-10-01-run1" && !g.contains("_template")));
        let mut order: Vec<&str> = Vec::new();
        for g in &groups { if order.last() != Some(g) { order.push(g); } }
        assert_eq!(order, ["Run · 2026-10-06-run6", "Run · 2026-10-05-run5", "Run · 2026-10-04-run4", "Run · 2026-10-03-run3", "Run · 2026-10-02-run2"]);
        // newest run's root pins NOTES before plan; the nested plan.md is unpinned (last)
        let run6: Vec<&DisplayEntry> = got.iter().filter(|e| e.group.as_deref() == Some("Run · 2026-10-06-run6")).collect();
        assert_eq!(run6.len(), 3);
        assert!(run6[0].path.ends_with("notes.md"));
        assert!(run6[1].path.ends_with("plan.md") && !run6[1].path.contains("reviews"));
        assert!(run6[2].path.contains("reviews"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reviews_group_lists_md_only_newest_first_and_skips_dirs() {
        let root = std::env::temp_dir().join(format!(
            "vidar-reviews-test-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        write(&root.join("a.md"), "a");
        write(&root.join("b.diff"), "b");
        write(&root.join("sub").join("c.md"), "c");
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 10_000;
        let got = scan_reviews_at(&root, now_ms);
        assert_eq!(got.len(), 1);
        assert!(got[0].path.ends_with("a.md"));
        assert_eq!(got[0].group.as_deref(), Some("Reviews"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn display_group_caps_at_ten_and_skips_a_file_written_in_the_last_two_seconds() {
        let root = std::env::temp_dir().join(format!(
            "vidar-display-cap-test-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let base = SystemTime::now() - std::time::Duration::from_secs(120);
        for i in 0..11u64 {
            let n = format!("v{i:02}.svg");
            write(&root.join(&n), "x");
            let f = fs::OpenOptions::new().write(true).open(root.join(&n)).unwrap();
            f.set_modified(base + std::time::Duration::from_secs(i)).unwrap();
        }
        write(&root.join("fresh.png"), "x"); // mtime is now: still being written
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        let got = scan_display_at(&root, now_ms);
        let names: Vec<&str> = got.iter().map(|e| Path::new(&e.path).file_name().unwrap().to_str().unwrap()).collect();
        assert_eq!(got.len(), DISPLAY_CAP);
        assert!(!names.contains(&"fresh.png"), "a file under 2 s old is skipped");
        assert_eq!(names[0], "v10.svg");
        assert!(!names.contains(&"v00.svg"), "the oldest falls off the cap");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn display_group_lists_top_level_visuals_newest_first_read_only() {
        let root = std::env::temp_dir().join(format!(
            "vidar-display-group-test-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let base = SystemTime::now() - std::time::Duration::from_secs(60);
        for (i, n) in ["old.png", "mid.html", "new.svg"].iter().enumerate() {
            write(&root.join(n), "x");
            let f = fs::OpenOptions::new().write(true).open(root.join(n)).unwrap();
            f.set_modified(base + std::time::Duration::from_secs(i as u64 * 10)).unwrap();
        }
        write(&root.join("note.md"), "md");
        write(&root.join(".hidden.svg"), "h");
        write(&root.join("reviews").join("finding.svg"), "r");
        write(&root.join("sub.svg").join("inner.svg"), "d"); // a folder named like a visual
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 10_000;
        let got = scan_display_at(&root, now_ms);
        let names: Vec<&str> = got.iter().map(|e| Path::new(&e.path).file_name().unwrap().to_str().unwrap()).collect();
        assert_eq!(names, ["new.svg", "mid.html", "old.png"]);
        assert!(got.iter().all(|e| e.group.as_deref() == Some("Display")));
        assert_eq!(got.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["svg", "html", "png"]);
        // read-only: the document reader/writer gate still refuses every listed visual
        for e in &got {
            assert!(validate_drop_path(&e.path, DOC_EXT).is_err(), "{} must not pass DOC_EXT", e.path);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_too_fresh_to_show_is_flagged_so_the_caller_wont_cache_the_gap() {
        let root = std::env::temp_dir().join(format!(
            "vidar-docs-tree-fresh-test-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        write(&root.join("reference").join("brand-new.md"), "new");

        // now_ms close to the write: the file is still inside the 2 s mid-write window
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        let (entries, skipped_fresh) = scan_docs_tree_at(&root, now_ms);
        assert!(entries.is_empty());
        assert!(skipped_fresh);

        let _ = fs::remove_dir_all(&root);
    }
}

/// Snapshot of the catalog's .md/.txt documents for a listener that missed the
/// last emission (the Document tab on init): inbox + newest runs + the repo's
/// docs tree, then the same 20-entry bridge\display window as the event.
fn list_documents_now() -> Vec<DisplayEntry> {
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut docs = scan_run_docs(now_ms);
    docs.extend(scan_docs_tree(now_ms));
    docs.extend(scan_kind(now_ms, &is_doc, 20).unwrap_or_default());
    docs
}

/// The scan runs off the main thread: it walks the docs tree on disk.
#[tauri::command]
pub async fn list_documents() -> Result<Vec<DisplayEntry>, String> {
    tauri::async_runtime::spawn_blocking(list_documents_now).await.map_err(|e| e.to_string())
}

/* ---- documents (workbench Document view) ----
   Same trust boundary as the drop readers: trusted-local-frontend readers of
   eligible files. read_document is NOT the preview reader — over the cap is an
   error, and it returns the handle's mtime so the state knows which version it
   holds. stat_document lets the frontend watch the open path itself, whatever
   the catalog window shows. */

const DOC_EXT: &[&str] = &["md", "txt"];
const MAX_DOC_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    name: String,
    bytes: u64,
    /// mtime of the handle the text was read from — a snapshot, not a lock
    mtime_ms: u64,
    text: String,
    lossy: bool,
}

fn mtime_ms_of(md: &fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ---- containment (security audit W1-7) ----
   read/stat/write_document take a webview string. A path is served only when, after `..` is
   resolved lexically and the existing part is canonicalised (junctions resolve to their
   target), it is inside a root Document serves: the Vidar folder (docs, runs, bridge\display,
   reviews, runes), the user's `~\.claude` and global runes library; or it is an instruction
   file the Runes view lists (CLAUDE.md, AGENTS.md, GEMINI.md, anything under a `.claude`,
   `.codex` or `.gemini` folder: loaded by an agent from any project); or Rust saw the OS drop
   that file onto the window (`note_dropped`, fed by the window's drag-drop event, which the
   webview cannot forge). Anything else is refused. */

const INSTRUCTION_NAMES: &[&str] = &["claude.md", "agents.md", "gemini.md", "claude.local.md"];
const INSTRUCTION_DIRS: &[&str] = &[".claude", ".codex", ".gemini"];
const DROPPED_CAP: usize = 256;
static DROPPED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Records files the OS dropped on the window; they stay openable in Document this session.
pub fn note_dropped(paths: &[PathBuf]) {
    let mut d = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    for p in paths {
        if !d.contains(p) {
            if d.len() >= DROPPED_CAP {
                d.remove(0);
            }
            d.push(p.clone());
        }
    }
}

/// `..` and `.` resolved without touching the disk; a `..` past the root is an error.
fn lexical_normalize(p: &Path) -> Result<PathBuf, String> {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                let has_name = out.components().any(|c| matches!(c, Component::Normal(_)));
                if !has_name {
                    return Err("path refused: outside the document folders".into());
                }
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

/// Canonical form of `p` even when its tail does not exist yet: the deepest existing ancestor
/// is canonicalised and the missing names are re-appended.
fn canonical_lenient(p: &Path) -> Option<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(c) = fs::canonicalize(&cur) {
            let mut out = c;
            for t in tail.iter().rev() {
                out.push(t);
            }
            return Some(out);
        }
        let name = cur.file_name()?.to_os_string();
        tail.push(name);
        if !cur.pop() {
            return None;
        }
    }
}

fn is_instruction_file(canon: &Path) -> bool {
    let name = canon.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if INSTRUCTION_NAMES.contains(&name.as_str()) {
        return true;
    }
    canon.parent().into_iter().flat_map(|p| p.components()).any(|c| {
        INSTRUCTION_DIRS.iter().any(|d| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(d))
    })
}

fn doc_roots() -> Vec<PathBuf> {
    let mut v = vec![crate::paths::root()];
    v.extend(crate::paths::claude_dir());
    v.extend(crate::paths::global_runes_dir());
    v
}

fn confine_doc_in(path: &str, roots: &[PathBuf], dropped: &[PathBuf]) -> Result<PathBuf, String> {
    let refuse = || "document path refused: outside the folders Document serves".to_string();
    let p = validate_drop_path(path, DOC_EXT)?;
    let norm = lexical_normalize(&p)?;
    let canon = canonical_lenient(&norm).ok_or_else(refuse)?;
    let in_root = roots.iter().filter_map(|r| fs::canonicalize(r).ok()).any(|r| canon.starts_with(&r));
    let ok = in_root
        || is_instruction_file(&canon)
        || dropped.iter().filter_map(|d| canonical_lenient(d)).any(|d| d == canon);
    if !ok {
        return Err(refuse());
    }
    Ok(norm)
}

fn confine_doc(path: &str) -> Result<PathBuf, String> {
    let dropped = DROPPED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    confine_doc_in(path, &doc_roots(), &dropped)
}

#[tauri::command]
pub fn read_document(path: String) -> Result<Document, String> {
    let p = confine_doc(&path)?;
    let (md, buf, more) = open_drop_file(&p, MAX_DOC_BYTES)?;
    if more {
        return Err(format!("document over {} MiB", MAX_DOC_BYTES / 1024 / 1024));
    }
    let lossy = std::str::from_utf8(&buf).is_err();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Document { name, bytes: md.len(), mtime_ms: mtime_ms_of(&md), text, lossy })
}

/// `None` = the file is gone (or no longer eligible); `Some(mtime)` otherwise.
#[tauri::command]
pub fn stat_document(path: String) -> Option<u64> {
    let p = confine_doc(&path).ok()?;
    let (md, _, _) = open_drop_file(&p, 0).ok()?;
    Some(mtime_ms_of(&md))
}

// Serialise commands too: another frontend must not pass the same old mtime
// while an earlier app write is still preparing its replacement.
static DOCUMENT_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
static DOCUMENT_TMP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub fn create_document(name: String) -> Result<String, String> {
    create_document_in(&crate::paths::display_reviews_dir(), name)
}

/// New documents land in `display\reviews\`, where the Reviews group lists them.
fn create_document_in(dir: &Path, name: String) -> Result<String, String> {
    use std::io::Write;
    let _guard = DOCUMENT_WRITES.lock().map_err(|e| e.to_string())?;
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.chars().any(|c| c.is_control()) {
        return Err("use a document filename, not a path".into());
    }
    let filename = if std::path::Path::new(name).extension().is_none() { format!("{name}.md") } else { name.to_owned() };
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(filename);
    let path_string = path.to_string_lossy().into_owned();
    validate_drop_path(&path_string, DOC_EXT)?;
    let title = path.file_stem().unwrap_or_default().to_string_lossy();
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| e.to_string())?;
    let result = file.write_all(format!("# {title}\n").as_bytes()).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = result { let _ = fs::remove_file(&path); return Err(e.to_string()); }
    Ok(path_string)
}

#[tauri::command]
pub fn write_document(path: String, text: String, expected_mtime: u64) -> Result<u64, String> {
    use std::io::Write;
    let _guard = DOCUMENT_WRITES.lock().map_err(|e| e.to_string())?;
    let p = confine_doc(&path)?;
    if text.len() > MAX_DOC_BYTES { return Err("document over 2 MiB".into()); }
    let (md, buf, more) = open_drop_file(&p, MAX_DOC_BYTES).map_err(|e| format!("conflict: {e}"))?;
    if mtime_ms_of(&md) != expected_mtime { return Err("conflict: changed on disk".into()); }
    if more || std::str::from_utf8(&buf).is_err() { return Err("cannot edit an oversized or lossy document".into()); }
    if md.permissions().readonly() { return Err("document is read-only".into()); }
    let id = DOCUMENT_TMP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = p.with_file_name(format!(".vidar-document-{}-{id}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
    let prepared = file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).and_then(|_| file.metadata());
    drop(file);
    let result = (|| {
        let written = prepared.map_err(|e| e.to_string())?;
        // Check again immediately before replacement; polling alone cannot
        // protect edits made since the frontend loaded its version.
        let (current, _, _) = open_drop_file(&p, 0).map_err(|e| format!("conflict: {e}"))?;
        if mtime_ms_of(&current) != expected_mtime { return Err("conflict: changed on disk".into()); }
        fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
        Ok(mtime_ms_of(&written))
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result
}

/* ---- passage comments (workbench Document view) ----
   Sidecar `<doc>.comments.json` beside a Markdown document under
   bridge\display. Vidar is the ONLY writer; agents read it. Confinement is by
   the document's canonical parent (a sidecar that doesn't exist yet can't be
   canonicalised) and the sidecar name is derived here, never accepted from the
   frontend. Read and save both validate the whole file against the caps. */

const COMMENTS_MAX_BYTES: usize = 256 * 1024;
const COMMENTS_MAX: usize = 200;
const COMMENT_TEXT_MAX: usize = 2000;
const COMMENT_QUOTE_MAX: usize = 500;
const COMMENT_ID_MAX: usize = 64;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    id: String,
    line_start: u64,
    line_end: u64,
    quote: String,
    text: String,
    at_ms: u64,
    status: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CommentsFile {
    version: u32,
    doc: String,
    comments: Vec<Comment>,
}

/// (sidecar path, document file name). The document must be a `.md` whose
/// canonical parent is under the display dir.
fn comments_sidecar(doc_path: &str) -> Result<(PathBuf, String), String> {
    let p = validate_drop_path(doc_path, &["md"])?;
    let parent = p.parent().ok_or("document has no parent directory")?;
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let root = fs::canonicalize(display_dir()).map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) {
        return Err("bridge\\display only".into());
    }
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok((parent.join(format!("{name}.comments.json")), name))
}

fn validate_comments(f: &CommentsFile, doc_name: &str) -> Result<(), String> {
    if f.version != 1 {
        return Err(format!("comments version {} not supported", f.version));
    }
    if f.doc != doc_name {
        return Err("comments file names a different document".into());
    }
    if f.comments.len() > COMMENTS_MAX {
        return Err(format!("over {COMMENTS_MAX} comments"));
    }
    let mut ids = std::collections::HashSet::new();
    for c in &f.comments {
        if c.id.is_empty() || c.id.chars().count() > COMMENT_ID_MAX || !ids.insert(c.id.as_str()) {
            return Err("comment id missing, too long or duplicated".into());
        }
        if c.line_start >= c.line_end {
            return Err(format!("comment {}: bad line range", c.id));
        }
        if c.quote.chars().count() > COMMENT_QUOTE_MAX || c.text.chars().count() > COMMENT_TEXT_MAX {
            return Err(format!("comment {}: quote or text over the cap", c.id));
        }
        if c.status != "open" && c.status != "resolved" {
            return Err(format!("comment {}: unknown status", c.id));
        }
    }
    Ok(())
}

/// Absent sidecar = empty set. A link in the sidecar's place is refused (the
/// same no-follow open as documents); invalid content is an error the frontend
/// shows, disabling comments for that document rather than guessing.
#[tauri::command]
pub fn read_comments(doc_path: String) -> Result<CommentsFile, String> {
    let (side, name) = comments_sidecar(&doc_path)?;
    match fs::symlink_metadata(&side) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CommentsFile { version: 1, doc: name, comments: Vec::new() });
        }
        Err(e) => return Err(e.to_string()),
        Ok(_) => {}
    }
    let (_, buf, more) = open_drop_file(&side, COMMENTS_MAX_BYTES)?;
    if more {
        return Err(format!("comments file over {} KiB", COMMENTS_MAX_BYTES / 1024));
    }
    let f: CommentsFile = serde_json::from_slice(&buf).map_err(|e| format!("comments file invalid: {e}"))?;
    validate_comments(&f, &name)?;
    Ok(f)
}

/// Whole-file replace: validate, write an exclusively created temp file in the
/// same directory, rename over the sidecar. Returns the new mtime.
#[tauri::command]
pub fn save_comments(doc_path: String, json: String) -> Result<u64, String> {
    use std::io::Write;
    let (side, name) = comments_sidecar(&doc_path)?;
    if json.len() > COMMENTS_MAX_BYTES {
        return Err(format!("comments over {} KiB", COMMENTS_MAX_BYTES / 1024));
    }
    let f: CommentsFile = serde_json::from_str(&json).map_err(|e| format!("comments invalid: {e}"))?;
    validate_comments(&f, &name)?;
    let out = serde_json::to_string_pretty(&f).map_err(|e| e.to_string())?;
    if let Ok(md) = fs::symlink_metadata(&side) {
        use std::os::windows::fs::MetadataExt;
        if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !md.is_file() {
            return Err("a link sits where the comments file goes — remove it first".into());
        }
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = side.with_file_name(format!("{name}.comments.{}-{nanos}.tmp", std::process::id()));
    {
        let mut t = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
        if let Err(e) = t.write_all(out.as_bytes()).and_then(|_| t.sync_all()) {
            drop(t);
            let _ = fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    }
    if let Err(e) = fs::rename(&tmp, &side) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    let md = fs::metadata(&side).map_err(|e| e.to_string())?;
    Ok(mtime_ms_of(&md))
}

#[cfg(test)]
mod confine_tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("vidar-confine-doc-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn allowed_root_file_is_accepted_and_dotdot_inside_is_resolved() {
        let base = scratch("ok");
        let root = base.join("root");
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes").join("a.md"), "a").unwrap();
        let roots = [root.clone()];
        let p = root.join("notes").join("a.md");
        assert!(confine_doc_in(&p.to_string_lossy(), &roots, &[]).is_ok());
        let dd = format!("{}\\notes\\..\\notes\\a.md", root.display());
        let got = confine_doc_in(&dd, &roots, &[]).unwrap();
        assert!(!got.to_string_lossy().contains(".."));
        // a not-yet-existing file under the root is fine
        assert!(confine_doc_in(&root.join("notes").join("new.md").to_string_lossy(), &roots, &[]).is_ok());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn dotdot_escape_is_refused() {
        let base = scratch("dd");
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(base.join("secret.md"), "s").unwrap();
        let esc = format!("{}\\..\\secret.md", root.display());
        assert!(confine_doc_in(&esc, &[root.clone()], &[]).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn another_drive_or_outside_path_is_refused() {
        let base = scratch("drv");
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        let roots = [root];
        for p in ["Z:\\nowhere\\x.md", "C:\\Windows\\Temp\\x.txt", "C:\\..\\..\\x.md"] {
            assert!(confine_doc_in(p, &roots, &[]).is_err(), "{p}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn junction_escape_is_refused() {
        let base = scratch("jn");
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("s.md"), "s").unwrap();
        let link = root.join("link");
        let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&link).arg(&outside).output();
        if !matches!(&made, Ok(o) if o.status.success()) {
            eprintln!("skipped: mklink /J failed");
            let _ = fs::remove_dir_all(&base);
            return;
        }
        let via = link.join("s.md");
        assert!(confine_doc_in(&via.to_string_lossy(), &[root], &[]).is_err());
        let _ = std::process::Command::new("cmd").args(["/c", "rmdir"]).arg(&link).output();
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn dropped_and_instruction_files_are_accepted_elsewhere() {
        let base = scratch("drop");
        let root = base.join("root");
        let other = base.join("other");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(other.join(".claude")).unwrap();
        fs::write(other.join("note.md"), "n").unwrap();
        fs::write(other.join("CLAUDE.md"), "c").unwrap();
        fs::write(other.join(".claude").join("r.md"), "r").unwrap();
        let roots = [root];
        let note = other.join("note.md");
        assert!(confine_doc_in(&note.to_string_lossy(), &roots, &[]).is_err());
        assert!(confine_doc_in(&note.to_string_lossy(), &roots, &[note.clone()]).is_ok());
        assert!(confine_doc_in(&other.join("CLAUDE.md").to_string_lossy(), &roots, &[]).is_ok());
        assert!(confine_doc_in(&other.join(".claude").join("r.md").to_string_lossy(), &roots, &[]).is_ok());
        let _ = fs::remove_dir_all(&base);
    }
}
