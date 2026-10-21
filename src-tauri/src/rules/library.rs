//! src-tauri\src\rules\library.rs — the rune library on disk: `rules/ facts/ procedures/ sets/` folders of
//! `<id>.md`, `tombstones.md` (retired ids) and the one trust boundary: an id is a grammar-checked name, and
//! the file it names must resolve inside the library root. Parsing a rune is `rune.rs`; the
//! dangling-reference rules are `check.rs`.

use std::path::{Path, PathBuf};

use super::rune::{self, Rune, KINDS};

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: String,
    /// `rule`, `fact`, `procedure` or `set`, from the folder the file sits in.
    pub kind: &'static str,
    pub folder: &'static str,
    /// Canonical, under the library root.
    pub path: PathBuf,
}

/// One `.md` file found under a kind folder, at any depth: the id is the file stem, the kind the top folder.
struct Hit {
    id: String,
    folder: &'static str,
    kind: &'static str,
    path: PathBuf,
}

pub struct Library {
    /// Canonical, so `starts_with` is a real containment test.
    pub root: PathBuf,
    /// (id, note after the id)
    tombstones: Vec<(String, String)>,
    /// Every rune file in the tree, sorted by path.
    index: Vec<Hit>,
}

/// Collect `.md` files below `dir`, recursing into real sub-folders (symlinked folders are not followed).
fn walk(dir: &Path, folder: &'static str, kind: &'static str, out: &mut Vec<Hit>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            walk(&path, folder, kind, out);
        } else if path.extension().is_some_and(|x| x == "md") {
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
            out.push(Hit { id, folder, kind, path });
        }
    }
}

impl Library {
    pub fn open(root: &Path) -> Result<Library, String> {
        let root = root
            .canonicalize()
            .map_err(|e| format!("rules library {} is not readable: {e}", root.display()))?;
        if !root.is_dir() {
            return Err(format!("rules library {} is not a folder", root.display()));
        }
        let tombstones = crate::fsx::read_text(&root.join("tombstones.md")).unwrap_or_default();
        let mut index = Vec::new();
        for (folder, kind) in KINDS {
            walk(&root.join(folder), folder, kind, &mut index);
        }
        index.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Library { root, tombstones: parse_tombstones(&tombstones), index })
    }

    /// `rules/core/x.md`: the path under the library root, forward slashes, for messages.
    fn rel(&self, p: &Path) -> String {
        p.strip_prefix(&self.root).unwrap_or(p).to_string_lossy().replace('\\', "/")
    }

    /// The library folder's own name (recall links read `<name>/<folder>/<id>.md`).
    pub fn folder_name(&self) -> String {
        self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// The file for `id`: `Ok(None)` when no kind folder has it, an error for a bad id, a hit in more than
    /// one folder, or a file that resolves outside the root (a symlink pointing out).
    pub fn entry(&self, id: &str) -> Result<Option<Entry>, String> {
        rune::check_id(id)?;
        let mut hits: Vec<&Hit> = self.index.iter().filter(|h| h.id == id).collect();
        if hits.len() > 1 {
            let paths: Vec<String> = hits.iter().map(|h| self.rel(&h.path)).collect();
            return Err(format!("`{id}` exists more than once in the library ({})", paths.join(", ")));
        }
        let Some(hit) = hits.pop() else { return Ok(None) };
        let canon = hit.path.canonicalize().map_err(|_| format!("`{id}` content file is missing"))?;
        if !canon.starts_with(&self.root) {
            return Err(format!("`{id}` content path leaves the library"));
        }
        Ok(Some(Entry { id: id.to_string(), kind: hit.kind, folder: hit.folder, path: canon }))
    }

    /// Read and parse the entry's file; the header must agree with the id and the folder.
    pub fn load(&self, entry: &Entry) -> Result<Rune, String> {
        let text = crate::fsx::read_text(&entry.path)
            .map_err(|e| format!("`{}` content is not readable: {e}", entry.id))?;
        let parsed = rune::parse(&text).map_err(|e| format!("`{}`: {e}", entry.id))?;
        if parsed.id != entry.id {
            return Err(format!("`{}` header name is `{}`, which does not match the file name", entry.id, parsed.id));
        }
        if parsed.kind != entry.kind {
            return Err(format!("`{}` is kind `{}` but sits in {}/", entry.id, parsed.kind, entry.folder));
        }
        Ok(parsed)
    }

    /// Every rule and fact whose header parses, each with its library-relative path (`rules/app/x.md`, `/`
    /// separators), for the recall directive; the rest come back as warnings.
    pub fn recall_pool(&self) -> (Vec<(Rune, String)>, Vec<String>) {
        let (mut runes, mut warnings) = (Vec::new(), Vec::new());
        for hit in self.index.iter().filter(|h| h.folder == "rules" || h.folder == "facts") {
            let (kind, stem) = (hit.kind, &hit.id);
            let at = self.rel(&hit.path);
            let entry = match self.entry(stem) {
                Ok(Some(e)) => e,
                Ok(None) => continue,
                Err(e) => {
                    warnings.push(format!("recall skipped {at}: {e}"));
                    continue;
                }
            };
            match self.load(&entry) {
                Ok(r) if r.kind == kind => runes.push((r, self.rel(&entry.path))),
                Ok(_) => {}
                Err(e) => warnings.push(format!("recall skipped {at}: {e}")),
            }
        }
        (runes, warnings)
    }

    /// Every rune file that loads, with its canonical path; the rest come back as messages.
    pub fn all_runes(&self) -> (Vec<(Rune, PathBuf)>, Vec<String>) {
        let (mut runes, mut errors) = (Vec::new(), Vec::new());
        for hit in &self.index {
            match self.entry(&hit.id) {
                Ok(Some(e)) => match self.load(&e) {
                    Ok(r) => runes.push((r, e.path)),
                    Err(m) => errors.push(m),
                },
                Ok(None) => {}
                Err(m) => errors.push(m),
            }
        }
        errors.dedup();
        (runes, errors)
    }

    /// The tombstone note for `id` (empty when the line names nothing more).
    pub fn tombstone(&self, id: &str) -> Option<&str> {
        self.tombstones.iter().find(|(t, _)| t == id).map(|(_, note)| note.as_str())
    }
}

fn cells(line: &str) -> Vec<String> {
    line.trim().trim_matches('|').split('|').map(|c| c.trim().to_string()).collect()
}

fn is_separator(cells: &[String]) -> bool {
    cells.iter().all(|c| !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':' || ch == ' '))
}

/// Bullet lines (`- id — note`) or table rows (`| id | note |`); anything else is prose.
fn parse_tombstones(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let (id, note) = if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            let rest = rest.trim();
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            (rest[..end].to_string(), rest[end..].to_string())
        } else if t.starts_with('|') {
            let row = cells(t);
            if is_separator(&row) {
                continue;
            }
            (row.first().cloned().unwrap_or_default(), row[1.min(row.len())..].join(" "))
        } else {
            continue;
        };
        let id = id.trim_matches(|c: char| c == '`' || c == ':' || c == ',').to_string();
        if id.is_empty() || id.eq_ignore_ascii_case("id") || id.starts_with('(') {
            continue;
        }
        let note = note.trim().trim_start_matches(|c: char| "—-:–".contains(c)).trim().to_string();
        out.push((id, note));
    }
    out
}
