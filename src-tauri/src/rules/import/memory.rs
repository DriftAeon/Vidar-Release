//! src-tauri\src\rules\import\memory.rs — a Claude memory folder (`~\.claude\projects\<slug>\memory`) read as
//! one rules source for the importer (docs/runs/2026-10-17-bare-runes-flow fold 8, 9).
//! - Every top-level `*.md` but `MEMORY.md` (the index), in name order, becomes `## <section>` and its body
//!   after the front matter; `section` is the front matter `name:`, else the file stem. Headings inside a body
//!   move two levels down, so every brick's `section[0]` is its file's section.
//! - The library id is `slug("memory-" + memory_slug(cwd))`, taken from the folder's parent name, which is
//!   that slug. Read-only: nothing here writes.

use std::path::{Path, PathBuf};

use super::sources::MAX_BYTES;
use super::split::slug;

/// The memory index, which is not a memory.
const INDEX: &str = "MEMORY.md";

/// Claude Code's project folder name for `cwd`: each non-alphanumeric char becomes `-`. Twin of
/// `memory_slug` in `src-tauri/src/loadout.rs` (fold 9: duplicated, not shared).
pub fn memory_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// `~\.claude\projects\<memory_slug(cwd)>\memory`.
pub fn memory_dir(home: &Path, cwd: &Path) -> PathBuf {
    home.join(".claude").join("projects").join(memory_slug(&cwd.to_string_lossy())).join("memory")
}

/// The library a memory folder imports into, for a cwd.
pub fn library_id(cwd: &Path) -> String {
    slug(&format!("memory-{}", memory_slug(&cwd.to_string_lossy())))
}

/// A directory named `memory`.
pub fn is_memory_dir(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.eq_ignore_ascii_case("memory")) && path.is_dir()
}

/// The library for a memory folder path: `slug("memory-" + <project folder name>)`; `None` for any other path.
pub fn library_of_dir(path: &Path) -> Option<String> {
    if !is_memory_dir(path) {
        return None;
    }
    let project = path.parent()?.file_name()?.to_string_lossy().into_owned();
    Some(slug(&format!("memory-{project}")))
}

/// The import-library name of an input path (already expanded): a memory folder names its library from its project
/// folder, any other path by `sources::library_of`. Import, landing and the generator's payload all name through it.
pub fn import_library_of(imports: &Path, path: &Path, home: Option<&Path>, cwd: Option<&Path>, primary: &str) -> String {
    library_of_dir(path).unwrap_or_else(|| super::sources::library_of(imports, path, home, cwd, primary))
}

/// The memory files of `dir`, `MEMORY.md` left out, in name order (case-insensitive).
pub fn files(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")))
        .filter(|p| !p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(INDEX)))
        .collect();
    out.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default());
    out
}

/// `(front matter lines, body)` of a memory file, BOM and CRLF normalised.
fn front_and_body(text: &str) -> (Vec<String>, String) {
    let text = crate::fsx::strip_bom(text).replace("\r\n", "\n");
    let mut lines = text.split('\n');
    if lines.next().map(str::trim_end) == Some("---") {
        let rest: Vec<&str> = text.split('\n').skip(1).collect();
        if let Some(end) = rest.iter().position(|l| l.trim_end() == "---") {
            let front = rest[..end].iter().map(|s| s.to_string()).collect();
            return (front, rest[end + 1..].join("\n"));
        }
    }
    (Vec::new(), text)
}

/// The `## <section>` heading a memory file becomes: its front matter `name:`, else its file stem.
pub fn section_of(path: &Path, text: &str) -> String {
    let (front, _) = front_and_body(text);
    let name = front
        .iter()
        .find_map(|l| l.strip_prefix("name:"))
        .map(|v| v.trim().trim_matches(['"', '\'']).trim().to_string())
        .filter(|v| !v.is_empty());
    name.unwrap_or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default())
}

/// A body with every heading outside a fence two levels deeper (at most six).
fn demote(body: &str) -> String {
    let mut fence: Option<&str> = None;
    let mut out = Vec::new();
    for line in body.split('\n') {
        let t = line.trim_start();
        let mark = if t.starts_with("```") { Some("```") } else if t.starts_with("~~~") { Some("~~~") } else { None };
        match (fence, mark) {
            (None, Some(m)) => fence = Some(m),
            (Some(f), Some(m)) if f == m => fence = None,
            _ => {}
        }
        let level = line.bytes().take_while(|b| *b == b'#').count();
        let heading = fence.is_none() && mark.is_none() && (1..=6).contains(&level) && line[level..].starts_with(' ');
        out.push(if heading { format!("{}{}", "#".repeat((level + 2).min(6)), &line[level..]) } else { line.to_string() });
    }
    out.join("\n")
}

/// The folder as one markdown: per file `## <section>`, a blank line, the body, a blank line.
pub fn read_dir(dir: &Path) -> Result<String, String> {
    if !is_memory_dir(dir) {
        return Err(format!("{}: only a memory folder imports as a folder", dir.display()));
    }
    let mut out = String::new();
    for f in files(dir) {
        let text = crate::fsx::read_text_capped(&f, MAX_BYTES).map_err(|e| format!("{}: {e}", f.display()))?;
        let (_, body) = front_and_body(&text);
        let body = demote(body.trim_matches('\n'));
        out.push_str(&format!("## {}\n\n", section_of(&f, &text)));
        if !body.trim().is_empty() {
            out.push_str(&body);
            out.push_str("\n\n");
        }
        if out.len() as u64 > MAX_BYTES {
            return Err(format!("{}: the memory folder reads past {} KB", dir.display(), MAX_BYTES / 1024));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_memory_folder_reads_as_sections_in_name_order_without_the_index() {
        let root = std::env::temp_dir().join(format!("vidar-import-memory-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("projects").join("C--Work").join("memory");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("MEMORY.md"), "- [b](b.md)\n").unwrap();
        std::fs::write(dir.join("b.md"), "---\nname: Beta Note\ndescription: x\n---\n\n# Inner\n\nKeep beta short.\n").unwrap();
        std::fs::write(dir.join("A.md"), "\u{FEFF}Alpha has no front matter.\r\n\r\n```\n# not a heading\n```\n").unwrap();
        let text = read_dir(&dir).unwrap();
        assert_eq!(
            text,
            "## A\n\nAlpha has no front matter.\n\n```\n# not a heading\n```\n\n## Beta Note\n\n### Inner\n\nKeep beta short.\n\n"
        );
        assert_eq!(library_of_dir(&dir).as_deref(), Some("memory-c-work"));
        assert!(read_dir(&root).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_memory_library_id_passes_check_id_and_matches_the_folder() {
        let cwd = Path::new(r"D:\Work\Apps\Demo");
        assert_eq!(memory_slug(&cwd.to_string_lossy()), "D--Work-Apps-Demo");
        let id = library_id(cwd);
        assert_eq!(id, "memory-d-work-apps-demo");
        crate::rules::rune::check_id(&id).unwrap();
        let odd = library_id(Path::new(r"D:\Ünï Côde\a.b c"));
        crate::rules::rune::check_id(&odd).unwrap();
        assert_eq!(memory_dir(Path::new(r"C:\Users\example-user"), cwd), Path::new(r"C:\Users\example-user\.claude\projects\D--Work-Apps-Demo\memory"));
    }
}
