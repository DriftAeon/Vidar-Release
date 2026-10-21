// Startup archival of old bridge review artefacts. Moves, never deletes; same volume, so rename.
// An item whose destination name already exists is skipped. Errors are logged and swallowed.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

pub(super) const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Runs the sweeps on a background thread so startup never waits on disk. The top of the display
/// folder (every file there, `review-*` included) belongs to `display_sweep::run_startup` alone: decided
/// and look-only files into `archive\shown\<month>\`, old documents into `archive\reviews\`, then loose
/// archive-root files by month. `display\reviews\` → `archive\reviews\` predates it.
pub fn sweep_review_artefacts() {
    std::thread::spawn(|| {
        let now = SystemTime::now();
        let review = crate::paths::review_dir();
        let archive = crate::paths::display_archive_reviews_dir();
        sweep_reviews_dir(&crate::paths::display_reviews_dir(), &archive, now);
        let now_ms = now.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let moved = super::display_sweep::run_startup(&super::display_sweep::Ctx::live(), now_ms, &|a, b| fs::rename(a, b));
        eprintln!("[sweep] display: {moved} moved");
        sweep_review_ids(&review, &review.join("archive"), now);
        sweep_stale(&crate::paths::review_stale_dir(), &review.join("archive").join("stale"), now);
    });
}

fn is_old(t: SystemTime, now: SystemTime) -> bool {
    now.duration_since(t).map(|d| d > MAX_AGE).unwrap_or(false)
}

fn is_hex_id(name: &str) -> bool {
    name.len() == 8 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Newest file mtime under `dir`; None when it holds no file (a dir's own mtime moves with renames).
fn newest_mtime(dir: &Path) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    for e in fs::read_dir(dir).ok()?.filter_map(|e| e.ok()) {
        let Ok(md) = e.metadata() else { continue };
        let t = if md.is_dir() { newest_mtime(&e.path()) } else { md.modified().ok() };
        if let Some(t) = t {
            if newest.map_or(true, |n| t > n) {
                newest = Some(t);
            }
        }
    }
    newest
}

fn move_item(src: &Path, dest_dir: &Path) {
    let Some(name) = src.file_name() else { return };
    if let Err(e) = fs::create_dir_all(dest_dir) {
        eprintln!("[sweep] cannot create {}: {e}", dest_dir.display());
        return;
    }
    let dest = dest_dir.join(name);
    if fs::symlink_metadata(&dest).is_ok() {
        eprintln!("[sweep] skipped {}: {} already exists", src.display(), dest.display());
        return;
    }
    if let Err(e) = fs::rename(src, &dest) {
        eprintln!("[sweep] could not move {}: {e}", src.display());
    }
}

/// Regular files in `display\reviews\` (the home of review artefacts).
fn sweep_reviews_dir(reviews: &Path, dest: &Path, now: SystemTime) {
    let Ok(rd) = fs::read_dir(reviews) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        let Ok(md) = e.metadata() else { continue };
        if md.is_file() && md.modified().map_or(false, |t| is_old(t, now)) {
            move_item(&e.path(), dest);
        }
    }
}

/// Finished `<8 hex>` review dirs: `done.json` present and nothing inside newer than MAX_AGE.
fn sweep_review_ids(review: &Path, dest: &Path, now: SystemTime) {
    let Ok(rd) = fs::read_dir(review) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        if !is_hex_id(&e.file_name().to_string_lossy()) {
            continue;
        }
        let p = e.path();
        if !e.metadata().map_or(false, |m| m.is_dir()) || !p.join("done.json").is_file() {
            continue;
        }
        if newest_mtime(&p).map_or(false, |t| is_old(t, now)) {
            move_item(&p, dest);
        }
    }
}

/// Everything parked in the dispatch stale dir.
fn sweep_stale(stale: &Path, dest: &Path, now: SystemTime) {
    let Ok(rd) = fs::read_dir(stale) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        if e.metadata().and_then(|m| m.modified()).map_or(false, |t| is_old(t, now)) {
            move_item(&e.path(), dest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    fn age(p: &Path, days: u64) {
        let t = SystemTime::now() - Duration::from_secs(days * 24 * 60 * 60);
        let f = File::options().write(true).open(p).unwrap_or_else(|_| File::open(p).unwrap());
        f.set_modified(t).unwrap();
    }

    #[test]
    fn sweeps_old_artefacts_and_leaves_the_rest() {
        let root = std::env::temp_dir().join(format!("vidar-sweep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (display, review) = (root.join("display"), root.join("review"));
        let stale = review.join("dispatch").join("stale");
        fs::create_dir_all(&display).unwrap();
        fs::create_dir_all(&stale).unwrap();

        fs::write(display.join("review-old.html"), "x").unwrap();
        age(&display.join("review-old.html"), 10);
        fs::write(display.join("review-new.html"), "x").unwrap();
        fs::create_dir_all(display.join("reviews").join("sub")).unwrap();
        fs::write(display.join("reviews").join("brief-old.md"), "x").unwrap();
        age(&display.join("reviews").join("brief-old.md"), 10);
        fs::write(display.join("reviews").join("brief-new.md"), "x").unwrap();
        fs::write(display.join("review-clash.html"), "x").unwrap();
        age(&display.join("review-clash.html"), 10);
        let darch = root.join("archive").join("reviews");
        fs::create_dir_all(&darch).unwrap();
        fs::write(darch.join("review-clash.html"), "keep").unwrap();

        for (id, done) in [("aaaaaaaa", false), ("bbbbbbbb", true)] {
            let d = review.join(id);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("pending.json"), "x").unwrap();
            age(&d.join("pending.json"), 10);
            if done {
                fs::write(d.join("done.json"), "x").unwrap();
                age(&d.join("done.json"), 10);
            }
        }
        fs::write(stale.join("old.json"), "x").unwrap();
        age(&stale.join("old.json"), 10);

        let now = SystemTime::now();
        sweep_reviews_dir(&display.join("reviews"), &darch, now);
        sweep_review_ids(&review, &review.join("archive"), now);
        sweep_stale(&stale, &review.join("archive").join("stale"), now);

        // the top of the display folder is the display lifecycle's alone: old review-* files stay here
        assert!(display.join("review-old.html").is_file());
        assert!(!darch.join("review-old.html").exists());
        assert!(darch.join("brief-old.md").is_file());
        assert!(!display.join("reviews").join("brief-old.md").exists());
        assert!(display.join("reviews").join("brief-new.md").is_file());
        assert!(display.join("reviews").join("sub").is_dir());
        assert!(display.join("review-new.html").is_file());
        assert!(display.join("review-clash.html").is_file());
        assert_eq!(fs::read_to_string(darch.join("review-clash.html")).unwrap(), "keep");
        assert!(review.join("aaaaaaaa").is_dir());
        assert!(review.join("archive").join("bbbbbbbb").join("done.json").is_file());
        assert!(!review.join("bbbbbbbb").exists());
        assert!(review.join("archive").join("stale").join("old.json").is_file());
        let _ = fs::remove_dir_all(&root);
    }
}
