// Workspace changes as a document (workbench review view).
// Git runs through `gitrun` (argument arrays, no shell, no pager, no external
// diff, no terminal prompts, a timeout and an output cap per call); this file
// is the Markdown writer that puts the result in bridge\display so the
// Document tab opens it like any other file (comments, source view, Location
// all reuse).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::gitrun::{self, GitOpts, GitOut};

const GIT_TIMEOUT: Duration = Duration::from_secs(15);
const CALL_CAP: usize = 2 * 1024 * 1024;
const UNTRACKED_FILE_CAP: u64 = 256 * 1024;
const DOC_CAP: usize = 1536 * 1024; // under the Document tab's 2 MiB input cap

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResult {
    path: String,
    files: usize,
    truncated: bool,
}

/// The review's git calls: 15 s, 2 MiB of stdout, no stdin. Its calls carry no
/// pathspecs, so literal pathspecs leave their output unchanged.
fn git(cwd: &Path, args: &[&str]) -> Result<GitOut, String> {
    gitrun::git(cwd, args, &GitOpts::read(GIT_TIMEOUT, CALL_CAP))
}

/// One `diff --git` section per file: (heading, body). Git's own headers stay in the body.
fn split_per_file(diff: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // "a/old b/new" — show the b side; renames read "old → new"
            let (a, b) = rest.split_once(" b/").map(|(a, b)| (a.trim_start_matches("a/"), b)).unwrap_or((rest, rest));
            let heading = if a == b { b.to_string() } else { format!("{a} → {b}") };
            out.push((heading, String::new()));
        }
        if let Some(cur) = out.last_mut() {
            cur.1.push_str(line);
            cur.1.push('\n');
        }
    }
    out
}

/// A fence longer than any run of leading backticks inside the block.
fn fence_for(body: &str) -> String {
    let longest = body.lines().map(|l| l.bytes().take_while(|b| *b == b'`').count()).max().unwrap_or(0);
    "`".repeat(longest.max(2) + 1)
}

fn push_block(doc: &mut String, heading: &str, lang: &str, body: &str) {
    let fence = fence_for(body);
    doc.push_str(&format!("\n### {}\n\n{fence}{lang}\n{}{}{fence}\n", heading.replace('\n', " "), body, if body.ends_with('\n') { "" } else { "\n" }));
}

fn fnv8(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.to_ascii_lowercase().bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("{:08x}", (h >> 32) as u32 ^ h as u32)
}

/// Untracked entries (`??`) from `status --porcelain=v1 -z`.
fn untracked_paths(status_z: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut parts = status_z.split('\0').peekable();
    while let Some(entry) = parts.next() {
        if entry.len() < 4 { continue; }
        let (xy, path) = entry.split_at(3);
        let x = xy.as_bytes()[0];
        // renames/copies carry the source path as the next NUL field
        if x == b'R' || x == b'C' { let _ = parts.next(); }
        if xy.starts_with("??") { out.push(path.to_string()); }
    }
    out
}

#[tauri::command]
pub fn review_workspace(cwd: String) -> Result<ReviewResult, String> {
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    let root_raw = git(&cwd_path, &["rev-parse", "--show-toplevel"])
        .map_err(|e| if e.contains("not a git repository") { "not a git repository".to_string() } else { e })?;
    let root_str = root_raw.text.trim().replace('/', "\\");
    if root_str.is_empty() {
        return Err("not a git repository (bare?)".into());
    }
    let root = PathBuf::from(&root_str);
    let leaf = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|o| o.text.trim().to_string()).unwrap_or_else(|_| "(no commits)".into());

    let mut doc = String::new();
    let mut files = 0usize;
    let mut truncated = false;
    let mut notes: Vec<String> = Vec::new();

    let staged = git(&root, &["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--submodule=short"]);
    let unstaged = git(&root, &["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--submodule=short"]);
    let status = git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

    let section = |doc: &mut String, title: &str, r: &Result<GitOut, String>, files: &mut usize, truncated: &mut bool| {
        doc.push_str(&format!("\n## {title}\n"));
        match r {
            Err(e) => doc.push_str(&format!("\n_{}_\n", e.replace('\n', " "))),
            Ok(o) => {
                let per = split_per_file(&o.text);
                if per.is_empty() { doc.push_str("\n_nothing_\n"); }
                for (heading, body) in per {
                    if doc.len() > DOC_CAP { *truncated = true; doc.push_str("\n_…document cap reached; remaining files omitted_\n"); break; }
                    *files += 1;
                    push_block(doc, &heading, "diff", &body);
                }
                if o.truncated { *truncated = true; doc.push_str("\n_…git output cut at 2 MiB_\n"); }
            }
        }
    };
    section(&mut doc, "Staged", &staged, &mut files, &mut truncated);
    section(&mut doc, "Unstaged", &unstaged, &mut files, &mut truncated);

    doc.push_str("\n## Untracked\n");
    match &status {
        Err(e) => doc.push_str(&format!("\n_{}_\n", e.replace('\n', " "))),
        Ok(o) => {
            let paths = untracked_paths(&o.text);
            if paths.is_empty() { doc.push_str("\n_nothing_\n"); }
            for rel in paths {
                if doc.len() > DOC_CAP { truncated = true; doc.push_str("\n_…document cap reached; remaining files omitted_\n"); break; }
                files += 1;
                let full = root.join(rel.replace('/', "\\"));
                let md = match fs::metadata(&full) { Ok(m) => m, Err(_) => { notes.push(format!("{rel}: unreadable")); continue; } };
                if md.is_dir() { doc.push_str(&format!("\n### {rel}\n\n_directory_\n")); continue; }
                if md.len() > UNTRACKED_FILE_CAP { doc.push_str(&format!("\n### {rel}\n\n_untracked, {} KB — not shown_\n", md.len() / 1024)); continue; }
                let bytes = fs::read(&full).unwrap_or_default();
                if bytes.contains(&0) { doc.push_str(&format!("\n### {rel}\n\n_untracked binary, {} bytes_\n", bytes.len())); continue; }
                let text = String::from_utf8_lossy(&bytes);
                let mut body = format!("--- /dev/null\n+++ b/{rel}\n");
                for l in text.lines() { body.push('+'); body.push_str(l); body.push('\n'); }
                push_block(&mut doc, &format!("{rel} (untracked)"), "diff", &body);
            }
        }
    }

    // no timestamp in the text: the Document tab shows the file's mtime and its refresh notice
    let mut head = format!(
        "# Workspace changes — {leaf}\n\nRepo `{root_str}` · branch `{branch}` · {files} file{}\n\n_Everything below is the working tree as git sees it right now — staged, unstaged and untracked — not any one agent's edits. Reload regenerates._\n",
        if files == 1 { "" } else { "s" }
    );
    if !notes.is_empty() { head.push_str(&format!("\n_{}_\n", notes.join(" · "))); }
    head.push_str(&doc);

    let out_dir = crate::bridge::display_dir();
    let _ = fs::create_dir_all(&out_dir);
    let out_path = out_dir.join(format!("review-workspace-{}-{}.md", leaf.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>(), fnv8(&root_str)));
    fs::write(&out_path, head.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    Ok(ReviewResult { path: out_path.to_string_lossy().into_owned(), files, truncated })
}
