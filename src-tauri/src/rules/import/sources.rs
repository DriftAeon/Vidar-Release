//! src-tauri\src\rules\import\sources.rs — which rules files the importer offers and which library each
//! one fills (docs/projects/bare/onboarding-plan.md D5, D6). Read-only: nothing here writes.
//! - Listed when present: `~\.claude\CLAUDE.md` (`claude-user`), `<CODEX_HOME>\AGENTS.md`, else `~\.codex\AGENTS.md` (`codex-user`),
//!   `<defaultCwd>\CLAUDE.md` and `AGENTS.md` (`<dir-slug>-claude-md` / `-agents-md`). The primary agent's
//!   files come first. A Codex home's `AGENTS.override.md` replaces its `AGENTS.md` (Codex reads it first).
//! - Only `.md` files of 256 KB at most; a source is opened read-only.
//! - A library name already holding another source's `import.json` takes `-2`, `-3`, ... instead.
//! - `<codex home>\memories\memory_summary.md` names the `codex-memory` library.
//! - Nothing under the Bare agent homes (`%LOCALAPPDATA%\Vidar\homes`) is listed or read: a `CODEX_HOME`
//!   pointing at a Bare home is ignored, and `read` refuses such a path.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::split::slug;
use crate::rules::rune::{check_id, CONTEXTS};

/// The largest source read (D5).
pub const MAX_BYTES: u64 = 256 * 1024;
/// The library a Codex home's `memories\memory_summary.md` fills.
pub const CODEX_MEMORY: &str = "codex-memory";
/// Codex reads this before, and instead of, `AGENTS.md`.
pub const AGENTS_OVERRIDE: &str = "AGENTS.override.md";

/// One offered source (`RulesImportSource` in `src/ipc.ts`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// Absolute path, what scan and apply take back.
    pub path: String,
    /// The `~` form for display.
    pub shown: String,
    /// `claude` or `codex`.
    pub agent: String,
    pub library: String,
    /// The library folder already holds an import of this source.
    pub imported: bool,
}

/// What a path is for the importer: where it lives, which agent reads it, its base library name.
struct Candidate {
    path: PathBuf,
    agent: &'static str,
    base: String,
}

/// `path` with a leading `home` written as `~`, `\` separators.
pub fn tilde(path: &Path, home: Option<&Path>) -> String {
    let s = path.to_string_lossy().replace('/', "\\");
    if let Some(h) = home.map(|h| h.to_string_lossy().replace('/', "\\")).filter(|h| !h.is_empty()) {
        let h = h.trim_end_matches('\\');
        if s.get(..h.len()).is_some_and(|p| p.eq_ignore_ascii_case(h)) && (s.len() == h.len() || s[h.len()..].starts_with('\\')) {
            return format!("~{}", &s[h.len()..]);
        }
    }
    s
}

/// A leading `~` expanded against `home`.
pub fn expand(path: &str, home: Option<&Path>) -> PathBuf {
    match (path.strip_prefix('~'), home) {
        (Some(rest), Some(h)) if rest.is_empty() || rest.starts_with(['\\', '/']) => h.join(rest.trim_start_matches(['\\', '/'])),
        _ => PathBuf::from(path),
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().replace('/', "\\").eq_ignore_ascii_case(&b.to_string_lossy().replace('/', "\\"))
}

/// `path` is `root` or inside it, compared as written (case-insensitive, either separator) and, when both
/// resolve, canonically, so a `..` or a junction cannot walk in.
pub fn under_root(path: &Path, root: &Path) -> bool {
    let inside = |p: &Path, r: &Path| {
        let (p, r) = (p.to_string_lossy().replace('/', "\\").to_lowercase(), r.to_string_lossy().replace('/', "\\").to_lowercase());
        let r = r.trim_end_matches('\\');
        !r.is_empty() && p.starts_with(r) && (p.len() == r.len() || p[r.len()..].starts_with('\\'))
    };
    if inside(path, root) {
        return true;
    }
    match (std::fs::canonicalize(path), std::fs::canonicalize(root)) {
        (Ok(p), Ok(r)) => inside(&p, &r),
        _ => false,
    }
}

/// The Bare agent homes folder (`%LOCALAPPDATA%\Vidar\homes`), the parent of this install's home.
pub fn agent_homes_root() -> Option<PathBuf> {
    crate::bare::home::resolve().ok().and_then(|h| h.parent().map(Path::to_path_buf))
}

/// The Codex home's instruction file Codex reads: `AGENTS.override.md` when present, else `AGENTS.md`.
pub fn codex_agents(codex_home: &Path) -> PathBuf {
    let over = codex_home.join(AGENTS_OVERRIDE);
    if over.is_file() {
        over
    } else {
        codex_home.join("AGENTS.md")
    }
}

/// `vidar-claude-md` for `C:\x\Vidar\CLAUDE.md`: the folder's slug, then the file stem's, then `md`.
fn file_base(path: &Path) -> String {
    let dir = path.parent().and_then(Path::file_name).map(|d| slug(&d.to_string_lossy())).unwrap_or_default();
    let stem = path.file_stem().map(|s| slug(&s.to_string_lossy())).unwrap_or_else(|| "rules".to_string());
    let dir = if dir.is_empty() || dir == "rule" { "file".to_string() } else { dir };
    format!("{dir}-{stem}-md")
}

fn candidates(home: Option<&Path>, codex_home: Option<&Path>, cwd: Option<&Path>, primary: &str) -> Vec<Candidate> {
    let mut out = Vec::new();
    if let Some(h) = home {
        out.push(Candidate { path: h.join(".claude").join("CLAUDE.md"), agent: "claude", base: "claude-user".into() });
    }
    if let Some(c) = codex_home {
        out.push(Candidate { path: codex_agents(c), agent: "codex", base: "codex-user".into() });
    }
    if let Some(c) = cwd {
        for (file, agent) in [("CLAUDE.md", "claude"), ("AGENTS.md", "codex")] {
            let path = c.join(file);
            if !out.iter().any(|o: &Candidate| same_path(&o.path, &path)) {
                out.push(Candidate { base: file_base(&path), path, agent });
            }
        }
    }
    let primary = if primary == "codex" { "codex" } else { "claude" };
    out.sort_by_key(|c| c.agent != primary); // stable: listed order within each agent
    out
}

/// The `source` field of a library's `import.json`, if it has one.
pub fn imported_source(dir: &Path) -> Option<String> {
    let v: serde_json::Value = crate::fsx::read_json(&dir.join("import.json")).ok()?;
    v.get("source").and_then(|s| s.as_str()).map(str::to_string)
}

/// The library for `shown` (a source in `~` form) starting from `base`: the first of `base`, `base-2`, ...
/// that is a valid id, not a scope context, and either free or already this source's import.
fn library_for(imports: &Path, base: &str, shown: &str) -> (String, bool) {
    for n in 1..1000 {
        let name = if n == 1 { base.to_string() } else { format!("{base}-{n}") };
        if check_id(&name).is_err() || CONTEXTS.contains(&name.as_str()) {
            continue;
        }
        match imported_source(&imports.join(&name)) {
            Some(src) if src.eq_ignore_ascii_case(shown) => return (name, true),
            Some(_) => continue,
            None => return (name, false),
        }
    }
    (format!("{base}-{}", std::process::id()), false)
}

/// Whether `path` is a source the importer reads: an existing `.md` file of at most `MAX_BYTES`.
fn readable(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
        && std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES)
}

/// The Codex home the importer reads: `CODEX_HOME` when set and non-empty, else `<home>\.codex` (never created);
/// `None` when it sits under the Bare agent homes (a Bare tab's own home is never an import source).
pub fn live_codex_home(home: Option<&Path>) -> Option<PathBuf> {
    let homes = agent_homes_root();
    crate::rules::codex::codex_home_from(std::env::var_os("CODEX_HOME"), home.map(Path::to_path_buf))
        .filter(|c| !homes.as_deref().is_some_and(|h| under_root(c, h)))
}

/// The offered sources, primary agent's first; `imports` is `paths::rune_imports_dir`.
pub fn list(imports: &Path, home: Option<&Path>, cwd: Option<&Path>, primary: &str) -> Vec<Source> {
    list_in(imports, home, live_codex_home(home).as_deref(), cwd, primary)
}

/// `list` with the Codex home given, so it reads no environment.
pub fn list_in(imports: &Path, home: Option<&Path>, codex_home: Option<&Path>, cwd: Option<&Path>, primary: &str) -> Vec<Source> {
    let mut taken: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for c in candidates(home, codex_home, cwd, primary).into_iter().filter(|c| readable(&c.path)) {
        let shown = tilde(&c.path, home);
        let (mut library, mut imported) = library_for(imports, &c.base, &shown);
        // Two listed sources never share a name (a clash adds `-2`).
        let mut n = 2;
        while taken.contains(&library) {
            (library, imported) = library_for(imports, &format!("{}-{n}", c.base), &shown);
            n += 1;
        }
        taken.push(library.clone());
        out.push(Source { path: c.path.to_string_lossy().into_owned(), shown, agent: c.agent.to_string(), library, imported });
    }
    out
}

/// The library for any path scan or apply is handed: a listed source's own name, else `<dir>-<stem>-md`.
pub fn library_of(imports: &Path, path: &Path, home: Option<&Path>, cwd: Option<&Path>, primary: &str) -> String {
    library_of_in(imports, path, home, live_codex_home(home).as_deref(), cwd, primary)
}

/// `library_of` with the Codex home given, so it reads no environment.
pub fn library_of_in(imports: &Path, path: &Path, home: Option<&Path>, codex_home: Option<&Path>, cwd: Option<&Path>, primary: &str) -> String {
    if let Some(s) = list_in(imports, home, codex_home, cwd, primary).into_iter().find(|s| same_path(Path::new(&s.path), path)) {
        return s.library;
    }
    let summary = codex_home.map(|c| c.join("memories").join("memory_summary.md"));
    let base = if summary.is_some_and(|s| same_path(&s, path)) { CODEX_MEMORY.to_string() } else { file_base(path) };
    library_for(imports, &base, &tilde(path, home)).0
}

/// Read a source read-only: `.md`, at most `MAX_BYTES`, UTF-8; a memory folder reads as one synthesized
/// markdown (`memory.rs`). A path under the Bare agent homes is refused.
pub fn read(path: &Path) -> Result<String, String> {
    read_in(path, agent_homes_root().as_deref())
}

/// `read` with the agent homes root given, so it reads no environment.
pub fn read_in(path: &Path, homes: Option<&Path>) -> Result<String, String> {
    if homes.is_some_and(|h| under_root(path, h)) {
        return Err(format!("{}: a Bare agent home does not import", path.display()));
    }
    if path.is_dir() {
        return super::memory::read_dir(path);
    }
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
        return Err(format!("{}: only .md files import", path.display()));
    }
    crate::fsx::read_text_capped(path, MAX_BYTES).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_leaves_a_path_unchanged_when_home_ends_inside_a_multibyte_char() {
        // `home` is 6 bytes; byte 6 of the path sits inside the two-byte `é`.
        let home = Path::new(r"C:\Use");
        assert_eq!(tilde(Path::new(r"C:\Usé\x.md"), Some(home)), r"C:\Usé\x.md");
        assert_eq!(tilde(Path::new(r"C:\Use\x.md"), Some(home)), r"~\x.md");
    }

    #[test]
    fn sources_list_the_primary_agent_first_and_name_clashes_apart() {
        let root = std::env::temp_dir().join(format!("vidar-import-sources-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (home, cwd, imports) = (root.join("home"), root.join("Work Dir"), crate::paths::rune_imports_dir_in(&root));
        for p in [home.join(".claude/CLAUDE.md"), home.join(".codex/AGENTS.md"), cwd.join("AGENTS.md"), cwd.join("CLAUDE.md")] {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "- Keep every change small and reviewed.\n").unwrap();
        }
        std::fs::write(cwd.join("notes.txt"), "x").unwrap();
        // `claude-user` already holds another source's import: this one takes `-2`.
        std::fs::create_dir_all(imports.join("claude-user")).unwrap();
        std::fs::write(imports.join("claude-user/import.json"), r#"{"source":"~\\elsewhere\\CLAUDE.md"}"#).unwrap();
        let codex_home = home.join(".codex");
        let got = list_in(&imports, Some(&home), Some(&codex_home), Some(&cwd), "codex");
        let names: Vec<(&str, &str)> = got.iter().map(|s| (s.agent.as_str(), s.library.as_str())).collect();
        assert_eq!(names, vec![("codex", "codex-user"), ("codex", "work-dir-agents-md"), ("claude", "claude-user-2"), ("claude", "work-dir-claude-md")]);
        assert_eq!(got[0].shown, "~\\.codex\\AGENTS.md");
        assert!(got.iter().all(|s| !s.imported));
        assert_eq!(expand("~\\.claude\\CLAUDE.md", Some(&home)), home.join(".claude\\CLAUDE.md"));
        assert_eq!(library_of_in(&imports, &cwd.join("CLAUDE.md"), Some(&home), Some(&codex_home), Some(&cwd), ""), "work-dir-claude-md");
        assert_eq!(library_of_in(&imports, &root.join("x/Rules.md"), Some(&home), Some(&codex_home), None, ""), "x-rules-md");
        assert!(read(&cwd.join("notes.txt")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn candidates_list_agents_md_from_the_given_codex_home_not_dot_codex() {
        let (home, custom) = (Path::new(r"C:\h\user"), Path::new(r"D:\elsewhere\codex-home"));
        let got = candidates(Some(home), Some(custom), None, "codex");
        let paths: Vec<PathBuf> = got.iter().filter(|c| c.agent == "codex").map(|c| c.path.clone()).collect();
        assert_eq!(paths, vec![custom.join("AGENTS.md")]);
        assert!(!got.iter().any(|c| c.path.starts_with(home.join(".codex"))));
    }
}
