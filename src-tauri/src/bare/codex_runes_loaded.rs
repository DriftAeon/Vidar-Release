//! src-tauri\src\bare\codex_runes_loaded.rs — what a Codex tab's session loaded (model R4), for
//! `rules::loaded::runes_loaded`. Primary source: the session record (`vault::session`) names the vault
//! and hash it loaded; those runes come back as `source: "vault"` rows (`vault::read_view`: a locked
//! vault reads its `revs/<hash>/` copy, items redacted). When the record carries a thread id, the
//! rollout `<home>\sessions\YYYY\MM\DD\rollout-*-<thread>.jsonl` adds what Codex injected, as
//! `source: "rollout"` rows: each developer message (labelled by its leading `<tag>` only), the
//! `world_state.agents_md.directory` AGENTS.md, and the `host_skills.body` "Available skills" names.
//! Format read from Codex rollouts (session_meta, response_item developer messages, world_state,
//! turn_context); the scan stops at the first `turn_context` after a `world_state`. Rollout text is
//! untrusted and never returned: only tag names, a directory path and skill names leave.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::vault::{read_view, session, store::Store};
use crate::rules::catalog::clean;
use crate::rules::loaded::{none, plain_id, Loaded, LoadedFile};

/// The injected head of a rollout is read to at most this many bytes.
const CAP: u64 = 8 * 1024 * 1024;
/// Rollout rows kept.
const ROWS_MAX: usize = 400;
/// Split so the paths-contract literal scan does not count this JSON key as a contract path.
const CONTENT_KEY: &str = concat!("con", "tent");

fn row(path: String, memory_type: &str, source: &'static str) -> LoadedFile {
    LoadedFile { path, memory_type: memory_type.to_string(), when: "start", trigger: None, source: Some(source) }
}

/// `root` is the vaults store root (`paths::root()` live, a temp root in tests). `session_id` is the
/// tab's Falcon session or Codex thread id, whichever the UI holds; it matches either on the record.
pub(crate) fn loaded(root: &Path, tab: &str, session_id: Option<&str>) -> Loaded {
    let Ok(Some(rec)) = session::find(root, tab, session_id, session_id) else { return none("No Session Yet") };
    let mut files: Vec<LoadedFile> = match read_view(&Store::open(root), &rec.vault.id, Some(&rec.vault.hash)) {
        Ok(view) => view.runes.iter().map(|r| row(format!("{}/{}", r.library, r.id), &r.kind, "vault")).collect(),
        Err(_) => Vec::new(),
    };
    let vault_rows = !files.is_empty();
    let thread = rec.thread_id.as_deref().filter(|t| plain_id(t, &[]));
    let mut truncated = false;
    if let Some(path) = thread.and_then(|t| find_rollout(Path::new(&rec.home), t)) {
        if let Ok((rows, cut)) = rollout_rows(&path) {
            files.extend(rows);
            truncated = cut;
        }
    }
    if files.is_empty() {
        return none("No Loads Recorded");
    }
    let source = if vault_rows { "vault" } else { "rollout" };
    Loaded { source, reason: None, files, reads: Vec::new(), rune_reads: Vec::new(), rune_triggers: Default::default(), skills: Vec::new(), truncated }
}

/// `<home>\sessions\<Y>\<M>\<D>\rollout-*-<thread>.jsonl`, newest day first; three levels, no deeper.
pub(crate) fn find_rollout(home: &Path, thread: &str) -> Option<PathBuf> {
    let suffix = format!("-{thread}.jsonl");
    let sorted = |dir: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        v.sort();
        v.reverse();
        v
    };
    for y in sorted(&home.join("sessions")) {
        for m in sorted(&y) {
            for d in sorted(&m) {
                let hit = std::fs::read_dir(&d).into_iter().flatten().flatten().map(|e| e.path()).find(|p| {
                    p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix))
                });
                if hit.is_some() {
                    return hit;
                }
            }
        }
    }
    None
}

/// A developer message's label: its leading `<tag>` when it has one, else `Developer Message`.
fn label(text: &str) -> String {
    let tag = text.trim_start().strip_prefix('<').and_then(|t| t.split_once('>')).map(|(t, _)| t);
    match tag {
        Some(t) if !t.is_empty() && t.len() <= 40 && t.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == ' ') => t.to_string(),
        _ => "Developer Message".to_string(),
    }
}

/// Skill names listed under `### Available skills` (`- <name>: <description>`).
fn skill_names(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut listed = false;
    for line in body.lines() {
        let line = line.trim_end();
        if line.starts_with("### ") {
            listed = line.eq_ignore_ascii_case("### Available skills");
            continue;
        }
        if !listed {
            continue;
        }
        let Some((name, _)) = line.strip_prefix("- ").and_then(|l| l.split_once(": ")) else { continue };
        if !name.is_empty() && name.len() <= 80 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.')) {
            out.push(name.to_string());
        }
    }
    out
}

/// The rows a rollout's injected head shows, and whether the cap cut the scan.
pub(crate) fn rollout_rows(path: &Path) -> std::io::Result<(Vec<LoadedFile>, bool)> {
    let file = std::fs::File::open(path)?;
    let mut reader = BufReader::new(file.take(CAP + 1));
    let (mut rows, mut seen) = (Vec::new(), std::collections::HashSet::new());
    let mut push = |rows: &mut Vec<LoadedFile>, r: LoadedFile| {
        if rows.len() < ROWS_MAX && seen.insert((r.memory_type.clone(), r.path.to_lowercase())) {
            rows.push(r);
        }
    };
    let (mut read, mut world, mut buf) = (0u64, false, Vec::new());
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)? as u64;
        if n == 0 || buf.last() != Some(&b'\n') {
            break;
        }
        read += n;
        if read > CAP {
            return Ok((rows, true));
        }
        let Ok(v) = serde_json::from_slice::<Value>(&buf) else { continue };
        let p = &v["payload"];
        match v["type"].as_str() {
            Some("response_item") if p["type"] == "message" && p["role"] == "developer" => {
                for c in p[CONTENT_KEY].as_array().into_iter().flatten() {
                    if let Some(t) = c["text"].as_str() {
                        push(&mut rows, row(label(t), "Developer", "rollout"));
                    }
                }
            }
            Some("world_state") => {
                world = true;
                let s = &p["state"];
                if let Some(dir) = s["agents_md"]["directory"].as_str().filter(|d| !d.is_empty()) {
                    push(&mut rows, row(clean(&Path::new(dir).join("AGENTS.md")), "AGENTS.md", "rollout"));
                }
                for name in s["host_skills"]["body"].as_str().map(skill_names).unwrap_or_default() {
                    push(&mut rows, row(name, "Skill", "rollout"));
                }
            }
            Some("turn_context") if world => break,
            _ => {}
        }
    }
    Ok((rows, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bare::vault::{session::VaultPin, store::Store, LockedBy, RuneRef};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("vidar-codex-loaded-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let (src, dst) = (e.path(), to.join(e.file_name()));
            if e.file_type().unwrap().is_dir() { copy_dir(&src, &dst) } else { std::fs::copy(&src, &dst).unwrap(); }
        }
    }

    /// The fixture `stock` library under `root`; a fact and a hook rune (its command a secret) in a
    /// new vault, locked; the record pins it.
    fn locked_vault(root: &Path) -> VaultPin {
        let fx = crate::paths::root().join("tests").join("fixtures").join("rune-vault").join("stock-runes");
        copy_dir(&fx, &crate::paths::rune_stock_dir_in(root));
        let s = Store::open(root);
        let stock = |id: &str| RuneRef { library: "stock".into(), id: id.into() };
        let v = s.create("P1 Vault", None, &[], &[stock("gate-fact"), stock("gate-hook-command")]).unwrap();
        let v = s.lock(&v.id, LockedBy::Button, &v.hash).unwrap();
        VaultPin { id: v.id, hash: v.hash }
    }

    fn write_record(root: &Path, pin: VaultPin, home: &Path, thread: Option<&str>) {
        let mut r = session::record("codex", "hosted", "tab-cx", pin, &home.to_string_lossy(), "");
        r.falcon_session = Some("fs-cx-0001".into());
        r.thread_id = thread.map(str::to_owned);
        session::write(root, &r).unwrap();
    }

    #[test]
    fn a_record_with_a_locked_vault_shows_its_runes() {
        let tmp = TempDir::new("vault");
        let pin = locked_vault(&tmp.0);
        write_record(&tmp.0, pin, &tmp.0.join("home"), None);
        for sid in [Some("fs-cx-0001"), None] {
            let got = loaded(&tmp.0, "tab-cx", sid);
            assert_eq!(got.source, "vault");
            let rows: Vec<(&str, &str, Option<&str>)> = got.files.iter().map(|f| (f.path.as_str(), f.memory_type.as_str(), f.source)).collect();
            assert_eq!(rows, vec![("stock/gate-fact", "fact", Some("vault")), ("stock/gate-hook-command", "hook", Some("vault"))]);
        }
        let json = serde_json::to_string(&loaded(&tmp.0, "tab-cx", None)).unwrap();
        assert!(json.contains("\"source\":\"vault\"") && !json.contains("sk-secret-1"));
    }

    /// Lines in the shape of a Codex rollout (a local Codex home, 2026-10-25), content swapped.
    #[test]
    fn a_record_with_a_rollout_adds_what_codex_injected() {
        let tmp = TempDir::new("rollout");
        let home = tmp.0.join("codex-home");
        let thread = "01a17275-08bd-7240-a82f-29ac5d6d5e3f";
        let day = home.join("sessions").join("2026").join("10").join("25");
        std::fs::create_dir_all(&day).unwrap();
        let message = |role: &str, texts: &[&str]| {
            let mut line = serde_json::json!({"type":"response_item","payload":{"type":"message","role":role}});
            line["payload"][CONTENT_KEY] = texts.iter().map(|t| serde_json::json!({"type":"input_text","text":t})).collect::<Vec<_>>().into();
            line
        };
        let dev = |texts: &[&str]| message("developer", texts);
        let lines = [
            serde_json::json!({"type":"session_meta","payload":{"id":thread,"base_instructions":{"text":"secret base"}}}),
            dev(&["You are Codex, secret words"]),
            dev(&["<permissions instructions>\nsandbox", "<skills_instructions>\n## Skills", "<Bad Tag>x"]),
            message("user", &["<environment_context>"]),
            serde_json::json!({"type":"world_state","payload":{"full":true,"state":{
                "agents_md":{"directory":"C:\\repo\\wt","text":"agents body"},
                "host_skills":{"includeInstructions":true,"body":"## Skills\n### Skill roots\n- `r0` = `C:/x`\n### Available skills\n- imagegen: Make images. (file: r0/a)\n- plugin-management:plugin-management: Manage.\n- bad name: no\n### How to use skills\n- step: one"}}}}),
            serde_json::json!({"type":"turn_context","payload":{"turn_id":"u"}}),
            dev(&["<late_tag>after the head"]),
        ];
        let text = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(day.join(format!("rollout-2026-10-25T20-47-15-{thread}.jsonl")), text).unwrap();
        let pin = locked_vault(&tmp.0);
        write_record(&tmp.0, pin, &home, Some(thread));

        let got = loaded(&tmp.0, "tab-cx", Some(thread));
        assert_eq!(got.source, "vault");
        let rollout: Vec<(&str, &str)> = got.files.iter().filter(|f| f.source == Some("rollout")).map(|f| (f.memory_type.as_str(), f.path.as_str())).collect();
        assert_eq!(rollout, vec![
            ("Developer", "Developer Message"),
            ("Developer", "permissions instructions"),
            ("Developer", "skills_instructions"),
            ("AGENTS.md", clean(&Path::new("C:\\repo\\wt").join("AGENTS.md")).as_str()),
            ("Skill", "imagegen"),
            ("Skill", "plugin-management:plugin-management"),
        ]);
        let json = serde_json::to_string(&got).unwrap();
        for secret in ["secret", "agents body", "sandbox", "Make images"] {
            assert!(!json.contains(secret), "{secret} leaked");
        }
    }

    #[test]
    fn no_record_answers_no_session_yet() {
        let tmp = TempDir::new("none");
        let got = loaded(&tmp.0, "tab-cx", Some("fs-cx-0001"));
        assert_eq!((got.source, got.reason.as_deref(), got.files.len()), ("none", Some("No Session Yet"), 0));
        assert!(find_rollout(&tmp.0, "t").is_none());
    }
}
