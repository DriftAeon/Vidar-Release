//! src-tauri\src\bare\e2e_snap_tests.rs — runes e2e, Rust seams (run 2026-10-24-runesets-full-stack, U2).
//! Materialises `tests/fixtures/runes-e2e/seed.json` into a fresh temp tree (twin of
//! `tools/sandbox/runes-seed.mjs`), calls the pure seams against that tree only and compares normalised
//! JSON with `tests/fixtures/runes-e2e/snap/<name>.json` (`UPDATE_RUNES_SNAP=1` rewrites them).
//! Rules: `tests/fixtures/runes-e2e/README.md`. Plan v2 cases 2, 3, 4, 8, 9, 11 carry explicit assertions.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::sets_list;
use crate::rules::import::local::{self, LocalEnv};
use crate::rules::import::{memory, split};

struct Tree {
    base: PathBuf,
    app: PathBuf,
    home: PathBuf,
    work: PathBuf,
    tokens: Vec<(&'static str, String)>,
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn strip_verbatim(p: &Path) -> PathBuf {
    PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\"))
}

fn sub(s: &str, tokens: &[(&str, String)]) -> String {
    tokens.iter().fold(s.to_string(), |acc, (k, v)| acc.replace(k, v))
}

fn sub_json(v: &Value, tokens: &[(&str, String)]) -> Value {
    match v {
        Value::String(s) => Value::String(sub(s, tokens)),
        Value::Array(a) => Value::Array(a.iter().map(|x| sub_json(x, tokens)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (sub(k, tokens), sub_json(x, tokens))).collect()),
        other => other.clone(),
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let mut c = std::process::Command::new("git");
    c.current_dir(cwd).args(args);
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy().to_uppercase().starts_with("GIT_") {
            c.env_remove(k);
        }
    }
    let out = c.output().expect("git runs");
    assert!(out.status.success(), "git {args:?} in {}: {}", cwd.display(), String::from_utf8_lossy(&out.stderr));
}

fn seed_json() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("runes-e2e").join("seed.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("seed.json parses")
}

impl Tree {
    /// A fresh tree under the canonicalised temp dir, the seed's files and steps written into it.
    fn seed() -> Tree {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let temp = strip_verbatim(&std::fs::canonicalize(std::env::temp_dir()).expect("temp dir resolves"));
        let base = temp.join(format!("vidar-e2e-snap-{}-{nanos}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        let (app, home, work) = (base.join("app"), base.join("profile"), base.join("work").join("runes-e2e"));
        std::fs::create_dir_all(&base).unwrap();
        let work_slug = memory::memory_slug(&work.to_string_lossy());
        let tokens = vec![
            ("<APP>", app.to_string_lossy().into_owned()),
            ("<HOME>", home.to_string_lossy().into_owned()),
            ("<WORK>", work.to_string_lossy().into_owned()),
            ("<WORK_SLUG>", work_slug.clone()),
            ("<MEMORY_LIB>", split::slug(&format!("memory-{work_slug}"))),
        ];
        let tree = Tree { base, app, home, work, tokens };
        let seed = seed_json();
        for f in seed["files"].as_array().expect("files") {
            let abs = tree.seed_path(f["path"].as_str().expect("path"));
            let content = match (f.get("text"), f.get("json")) {
                (Some(t), None) => sub(t.as_str().expect("text"), &tree.tokens),
                (None, Some(j)) => serde_json::to_string_pretty(&sub_json(j, &tree.tokens)).unwrap() + "\n",
                _ => panic!("seed entry {} needs exactly one of text or json", abs.display()),
            };
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(&abs, content).unwrap();
        }
        for s in seed["steps"].as_array().expect("steps") {
            assert_eq!(s["op"], "git-worktree");
            let (repo, wt) = (tree.seed_path(s["repo"].as_str().unwrap()), tree.seed_path(s["worktree"].as_str().unwrap()));
            let add: Vec<&str> = s["add"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
            git(&repo, &["init", "-q", "-b", "main"]);
            let mut args = vec!["add", "--"];
            args.extend(&add);
            git(&repo, &args);
            git(&repo, &["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
            git(&repo, &["worktree", "add", "-q", "-b", s["branch"].as_str().unwrap(), &wt.to_string_lossy()]);
        }
        tree
    }

    fn seed_path(&self, p: &str) -> PathBuf {
        let mut parts = p.split('/');
        let head = parts.next().unwrap();
        let mut out = match head {
            "<APP>" => self.app.clone(),
            "<HOME>" => self.home.clone(),
            "<WORK>" => self.work.clone(),
            other => panic!("seed path {p} starts with {other}"),
        };
        for seg in parts {
            let seg = sub(seg, &self.tokens);
            assert!(!seg.is_empty() && seg != "." && seg != "..", "seed path {p} has a bad segment");
            out.push(seg);
        }
        out
    }

    fn token(&self, name: &str) -> &str {
        &self.tokens.iter().find(|(k, _)| *k == name).expect("token").1
    }

    fn config(&self) -> PathBuf {
        crate::paths::config_path_in(&self.app)
    }
}

// ---- normalisation (README § Snapshot normalisation) ----

fn replace_ci(hay: &str, needle: &str, with: &str) -> String {
    // ASCII lowercase keeps byte offsets, so match positions index the original.
    let (lh, ln) = (hay.to_ascii_lowercase(), needle.to_ascii_lowercase());
    let mut out = String::new();
    let mut at = 0;
    while let Some(i) = lh[at..].find(&ln) {
        out.push_str(&hay[at..at + i]);
        out.push_str(with);
        at += i + ln.len();
        // The path tail after a root: separators become `/` up to whitespace or a quote.
        let tail: String = hay[at..].chars().take_while(|c| !c.is_whitespace() && *c != '"').collect();
        out.push_str(&tail.replace('\\', "/"));
        at += tail.len();
    }
    out.push_str(&hay[at..]);
    out
}

fn is_date(b: &[u8]) -> bool {
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

fn dates_to_token(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if i + 10 <= b.len() && s.is_char_boundary(i) && s.is_char_boundary(i + 10) && is_date(&b[i..i + 10]) {
            out.push_str("<DATE>");
            i += 10;
        } else {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

struct Norm {
    /// Roots, longest first, in the as-given and the canonical form.
    roots: Vec<(String, &'static str)>,
    slugs: Vec<(String, &'static str)>,
}

impl Norm {
    fn new(t: &Tree) -> Norm {
        let mut roots: Vec<(String, &'static str)> = Vec::new();
        for (name, p) in [("<WORK>", &t.work), ("<APP>", &t.app), ("<HOME>", &t.home)] {
            let given = p.to_string_lossy().into_owned();
            let canon = std::fs::canonicalize(p).map(|c| strip_verbatim(&c).to_string_lossy().into_owned()).unwrap_or_else(|_| given.clone());
            for form in [given, canon] {
                for f in [form.replace('/', "\\"), form.replace('\\', "/")] {
                    if !roots.iter().any(|(r, _)| r.eq_ignore_ascii_case(&f)) {
                        roots.push((f, name));
                    }
                }
            }
        }
        roots.sort_by_key(|(r, _)| std::cmp::Reverse(r.len()));
        let slugs = vec![(t.token("<WORK_SLUG>").to_string(), "<WORK_SLUG>"), (t.token("<MEMORY_LIB>").to_string(), "<MEMORY_LIB>")];
        Norm { roots, slugs }
    }

    fn text(&self, s: &str) -> String {
        let mut s = s.replace(r"\\?\", "");
        for (root, name) in &self.roots {
            s = replace_ci(&s, root, name);
        }
        for (slug, name) in &self.slugs {
            s = replace_ci_plain(&s, slug, name);
        }
        dates_to_token(&s)
    }

    fn value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.value(x)).collect()),
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, x)| {
                        let stamp = matches!(k.as_str(), "date" | "importedOn") && x.is_string();
                        (self.text(k), if stamp { json!("<DATE>") } else { self.value(x) })
                    })
                    .collect::<Map<_, _>>(),
            ),
            other => other.clone(),
        }
    }
}

/// Case-insensitive replace with no path-tail handling (slug tokens are not paths).
fn replace_ci_plain(hay: &str, needle: &str, with: &str) -> String {
    let (lh, ln) = (hay.to_ascii_lowercase(), needle.to_ascii_lowercase());
    let mut out = String::new();
    let mut at = 0;
    while let Some(i) = lh[at..].find(&ln) {
        out.push_str(&hay[at..at + i]);
        out.push_str(with);
        at += i + ln.len();
    }
    out.push_str(&hay[at..]);
    out
}

fn snap_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("runes-e2e").join("snap").join(format!("{name}.json"))
}

/// Compares `value` (normalised, pretty, LF) with `snap/<name>.json`; `UPDATE_RUNES_SNAP=1` rewrites it.
fn check(t: &Tree, name: &str, value: &Value) {
    let text = serde_json::to_string_pretty(&Norm::new(t).value(value)).unwrap() + "\n";
    let path = snap_path(name);
    if std::env::var_os("UPDATE_RUNES_SNAP").is_some_and(|v| v == "1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("snapshot {} missing ({e}); run with UPDATE_RUNES_SNAP=1", path.display())).replace("\r\n", "\n");
    if want == text {
        return;
    }
    let (w, g): (Vec<&str>, Vec<&str>) = (want.lines().collect(), text.lines().collect());
    let at = (0..w.len().max(g.len())).find(|i| w.get(*i) != g.get(*i)).unwrap_or(0);
    panic!("snapshot {name} differs at line {}\n  snap: {}\n  got:  {}\nUPDATE_RUNES_SNAP=1 rewrites it", at + 1, w.get(at).unwrap_or(&"(end)"), g.get(at).unwrap_or(&"(end)"));
}

// ---- seams ----

fn discover_from(t: &Tree, cwd: &Path) -> Value {
    let (config, imports) = (t.config(), crate::paths::rune_imports_dir_in(&t.app));
    let (settings, codex) = (t.home.join(".claude").join("settings.json"), t.home.join(".codex"));
    let (catalog, _) = super::bundles::load(&t.app);
    let env = LocalEnv { imports: &imports, config: &config, home: Some(&t.home), cwd, primary: "claude", settings: Some(&settings), codex_home: Some(&codex), homes: None, claude_json: None, catalog: Some(&catalog) };
    serde_json::to_value(local::discover(&env)).unwrap()
}

fn same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().replace('/', "\\").eq_ignore_ascii_case(&b.to_string_lossy().replace('/', "\\"))
}

#[test]
fn discover_main_and_worktree() {
    let t = Tree::seed();
    let wt = t.work.join(".worktrees").join("e2e");
    let (main, linked) = (discover_from(&t, &t.work), discover_from(&t, &wt));
    // Case 4: from the linked worktree the project CLAUDE.md / AGENTS.md name the main checkout's.
    let rules = |v: &Value| v["files"].as_array().unwrap().iter().filter(|f| f["kind"] == "rules").map(|f| PathBuf::from(f["path"].as_str().unwrap())).collect::<Vec<_>>();
    for name in ["CLAUDE.md", "AGENTS.md"] {
        let want = t.work.join(name);
        assert!(rules(&main).iter().any(|p| same(p, &want)), "main checkout lists {name}");
        assert!(rules(&linked).iter().any(|p| same(p, &want)), "worktree lists the main checkout's {name}");
        assert!(!rules(&linked).iter().any(|p| same(p, &wt.join(name))), "worktree does not list its own {name}");
    }
    assert!(linked["files"].as_array().unwrap().iter().all(|f| !f["path"].as_str().unwrap().contains(".worktrees")));
    // Case 7: skills and agents beside rules and memory under the profile.
    let kinds = |v: &Value| -> std::collections::BTreeSet<String> { v["files"].as_array().unwrap().iter().map(|f| f["kind"].as_str().unwrap().to_string()).collect() };
    for k in ["rules", "memory", "skill", "agent", "hook", "mcp"] {
        assert!(kinds(&main).contains(k), "discovery offers {k}");
    }
    // Case 3: the Codex config.toml rows, each server once; atlassian is a pinned hosted row.
    let mcp: Vec<&Value> = main["files"].as_array().unwrap().iter().filter(|f| f["kind"] == "mcp").collect();
    let shown: Vec<&str> = mcp.iter().filter_map(|f| f["shown"].as_str()).collect();
    assert_eq!(shown, ["atlassian", "openaiDeveloperDocs"]);
    let atlassian = mcp.iter().find(|f| f["shown"] == "atlassian").unwrap();
    assert_eq!((atlassian["hosted"].as_str(), atlassian["ticked"].as_bool()), (Some("atlassian"), Some(true)));
    check(&t, "discover-main", &main);
    check(&t, "discover-worktree", &linked);
}

#[test]
fn sets_list_names_the_rules_library_add_on_without_a_library() {
    // The `sets` snapshot stays as the view test's frozen fixture: generation hiding left with the
    // row shapes (vault migrate converts `row-*`), so the seam no longer reproduces it.
    let t = Tree::seed();
    let got = serde_json::to_value(sets_list::sets_in(&t.app)).unwrap();
    // Case 10: the rules library's add-on set is listed without a library.
    let listed = got.as_array().unwrap().iter().any(|e| e["set"] == "vidar-recall" && e["library"].as_str().unwrap_or("").is_empty());
    assert!(listed, "{got}");
}
