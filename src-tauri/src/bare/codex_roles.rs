//! src-tauri\src\bare\codex_roles.rs — one Claude agent `.md` (`bareAgents`) turned into a Codex role
//! file (`<CODEX_HOME>\agents\<name>.toml`, read by Codex 0.163 agent-roles).
//! - `name` is the frontmatter `name`, trimmed, case kept (upstream only wants it non-empty); it is the
//!   file name too, so it must be a plain file name, and it may not be a built-in role (`default`,
//!   `explorer`, `worker`, any case). `nickname_candidates = ["<name>"]` only when upstream accepts the
//!   name as a nickname (ASCII letters, digits, spaces, `-`, `_`).
//! - `description` and `developer_instructions` (the body) are required and non-blank. No `model` (the
//!   role inherits the parent's), no tools key (Codex has no per-tool allowlist) and no other key.
//! - Read-only (a tools list present and naming none of Edit, Write, NotebookEdit, PowerShell) is by prompt
//!   only: the instructions open with `READ_ONLY_PREAMBLE`, the description ends with
//!   `READ_ONLY_SUFFIX`, and the file's first line is `READ_ONLY_MARKER` (a comment the Loadout reads).

use serde::Serialize;

use super::copies::{plain_name, scalar};

/// First line of a read-only role file; a TOML comment, so Codex ignores it.
pub const READ_ONLY_MARKER: &str = "# Vidar: read-only by prompt";
pub const READ_ONLY_PREAMBLE: &str =
    "Read-only role: never edit, write, delete or install, and never run a command that changes state. Codex does not sandbox this; you hold the line.";
pub const READ_ONLY_SUFFIX: &str = " (read-only by instruction)";
/// Codex 0.163's built-in roles (core/src/agent/role.rs); a role file may not take these names.
pub const BUILT_INS: [&str; 3] = ["default", "explorer", "worker"];
/// A tools list naming any of these is not read-only.
const WRITE_TOOLS: [&str; 4] = ["Edit", "Write", "NotebookEdit", "PowerShell"];

/// A converted role: its file name (`<name>.toml`) and the TOML bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct Role {
    pub file_name: String,
    pub bytes: Vec<u8>,
}

/// A role file's text opens with `READ_ONLY_MARKER` (a BOM and trailing blanks allowed).
pub fn read_only_by_prompt(text: &str) -> bool {
    text.strip_prefix('\u{feff}').unwrap_or(text).lines().next().is_some_and(|l| l.trim_end() == READ_ONLY_MARKER)
}

#[derive(Serialize)]
struct RoleToml<'a> {
    name: &'a str,
    description: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    nickname_candidates: Option<Vec<&'a str>>,
    developer_instructions: &'a str,
}

/// The frontmatter lines and the body of `text` (BOM and `\r` dropped); `None` without a closing `---`.
fn split(text: &str) -> Option<(Vec<&str>, String)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines().map(|l| l.trim_end_matches('\r'));
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    let rest: Vec<&str> = lines.collect();
    let end = rest.iter().position(|l| l.trim() == "---")?;
    let body = rest[end + 1..].join("\n");
    Some((rest[..end].to_vec(), body.trim().to_string()))
}

/// The tools frontmatter value as names (`Bash(git:*)` → `Bash`): a comma list, a `[a, b]` flow list or
/// a `- a` block list. `None` when the key is absent or lists nothing (every tool, as in Claude).
fn tools(block: &[&str]) -> Option<Vec<String>> {
    let at = block.iter().position(|l| l.starts_with("tools:"))?;
    let raw = block[at]["tools:".len()..].trim();
    let mut items: Vec<String> = if raw.is_empty() {
        block[at + 1..]
            .iter()
            .take_while(|l| l.trim().is_empty() || l.trim_start().starts_with('-'))
            .filter_map(|l| l.trim_start().strip_prefix('-').map(|v| v.trim().to_string()))
            .collect()
    } else {
        raw.trim_start_matches('[').trim_end_matches(']').split(',').map(|s| s.trim().to_string()).collect()
    };
    for item in &mut items {
        let unquoted = item.trim_matches(|c| c == '"' || c == '\'');
        *item = unquoted.split('(').next().unwrap_or("").trim().to_string();
    }
    items.retain(|s| !s.is_empty());
    (!items.is_empty()).then_some(items)
}

/// Upstream's nickname rule (agent_role_config.rs `normalize_agent_role_nickname_candidates`).
fn nickname_ok(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_'))
}

/// Converts one agent `.md`; `Err` is the reason it is skipped.
pub fn convert(text: &str) -> Result<Role, String> {
    let Some((block, body)) = split(text) else { return Err("has no frontmatter".into()) };
    let name = scalar(&block, "name", false).ok_or("has no `name`")?;
    let description = scalar(&block, "description", true).ok_or("has no `description`")?;
    if body.is_empty() {
        return Err("has no body".into());
    }
    if !plain_name(&name) || name.ends_with(['.', ' ']) {
        return Err(format!("name {name:?} is not a plain file name"));
    }
    if BUILT_INS.iter().any(|b| b.eq_ignore_ascii_case(&name)) {
        return Err(format!("name {name:?} is a Codex built-in role"));
    }
    let read_only = tools(&block).is_some_and(|t| !t.iter().any(|x| WRITE_TOOLS.iter().any(|w| w.eq_ignore_ascii_case(x))));
    let (description, instructions) = if read_only {
        (format!("{description}{READ_ONLY_SUFFIX}"), format!("{READ_ONLY_PREAMBLE}\n\n{body}"))
    } else {
        (description, body)
    };
    let role = RoleToml {
        name: &name,
        description: &description,
        nickname_candidates: nickname_ok(&name).then(|| vec![name.as_str()]),
        developer_instructions: &instructions,
    };
    let toml = toml::to_string(&role).map_err(|e| format!("could not be written as TOML ({e})"))?;
    let text = if read_only { format!("{READ_ONLY_MARKER}\n{toml}") } else { toml };
    Ok(Role { file_name: format!("{name}.toml"), bytes: text.into_bytes() })
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Role {
        fn read_only(&self) -> bool {
            read_only_by_prompt(std::str::from_utf8(&self.bytes).unwrap())
        }
    }

    fn table(role: &Role) -> toml::Table {
        std::str::from_utf8(&role.bytes).unwrap().parse().unwrap()
    }

    const PLAIN: &str = "---\nname: Striker\ndescription: Executes a brief.\nmodel: claude-sonnet-5-5\ntools: Read, Edit, Write, Bash\n---\n\nDo the brief.\nThen report.\n";

    #[test]
    fn a_writing_agent_becomes_a_plain_role_without_model_or_tools() {
        let role = convert(PLAIN).unwrap();
        assert_eq!(role.file_name, "Striker.toml");
        assert!(!role.read_only());
        let text = String::from_utf8(role.bytes.clone()).unwrap();
        assert!(!text.starts_with('#'), "{text}");
        // The body is written as a multiline string, readable in the file.
        assert!(text.contains("developer_instructions = \"\"\"\nDo the brief.\nThen report.\"\"\""), "{text}");
        let t = table(&role);
        let keys: Vec<&str> = t.keys().map(String::as_str).collect();
        assert_eq!(keys.len(), 4, "{keys:?}");
        assert_eq!(t["name"].as_str(), Some("Striker"));
        assert_eq!(t["description"].as_str(), Some("Executes a brief."));
        assert_eq!(t["nickname_candidates"].as_array().unwrap()[0].as_str(), Some("Striker"));
        assert_eq!(t["developer_instructions"].as_str(), Some("Do the brief.\nThen report."));
        // No tools key at all: every tool, not read-only.
        let none = convert("---\nname: any\ndescription: D.\n---\nBody.\n").unwrap();
        assert!(!none.read_only());
    }

    #[test]
    fn a_read_only_agent_is_marked_by_prompt() {
        for tools in ["tools: Read, Grep, Glob, Bash", "tools: [Read, \"Bash(git log:*)\"]", "tools:\n  - Read\n  - Grep"] {
            let src = format!("---\nname: Orion\ndescription: Reviews.\n{tools}\n---\nReview it.\n");
            let role = convert(&src).unwrap();
            assert!(role.read_only(), "{tools}");
            let text = String::from_utf8(role.bytes.clone()).unwrap();
            assert_eq!(text.lines().next(), Some(READ_ONLY_MARKER));
            let t = table(&role);
            assert_eq!(t["description"].as_str(), Some("Reviews. (read-only by instruction)"));
            assert_eq!(t["developer_instructions"].as_str().unwrap(), format!("{READ_ONLY_PREAMBLE}\n\nReview it."));
        }
        let writer = convert("---\nname: w\ndescription: D.\ntools:\n  - Read\n  - NotebookEdit\n---\nB.\n").unwrap();
        assert!(!writer.read_only());
    }

    #[test]
    fn missing_fields_bad_names_and_built_ins_are_skipped() {
        assert!(convert("---\nname: a\ndescription: D.\n---\n  \n").unwrap_err().contains("no body"));
        assert!(convert("---\ndescription: D.\n---\nB.\n").unwrap_err().contains("`name`"));
        assert!(convert("---\nname: a\n---\nB.\n").unwrap_err().contains("`description`"));
        assert!(convert("No frontmatter.").unwrap_err().contains("frontmatter"));
        for b in ["default", "Explorer", "worker"] {
            let e = convert(&format!("---\nname: {b}\ndescription: D.\n---\nB.\n")).unwrap_err();
            assert!(e.contains("built-in"), "{e}");
        }
        assert!(convert("---\nname: a/b\ndescription: D.\n---\nB.\n").unwrap_err().contains("plain file name"));
        // A name upstream refuses as a nickname still makes a role, just without one.
        let role = convert("---\nname: plan.o\ndescription: D.\n---\nB.\n").unwrap();
        assert!(!table(&role).contains_key("nickname_candidates"));
    }

    #[test]
    fn awkward_bodies_round_trip_through_toml() {
        let body = "Quotes \"\"\" and ''' and \\ backslash\r\n\ttab, unicode é, a \u{7} bell,\n# not a comment\nend \"";
        let src = format!("\u{feff}---\r\nname: 'odd-one'\r\ndescription: \"Says \\\"hi\\\"\"\r\ntools: Read\r\n---\r\n{body}\r\n");
        let role = convert(&src).unwrap();
        let t = table(&role);
        assert_eq!(t["name"].as_str(), Some("odd-one"));
        assert_eq!(t["description"].as_str(), Some("Says \"hi\" (read-only by instruction)"));
        let want = format!("{READ_ONLY_PREAMBLE}\n\n{}", body.replace("\r\n", "\n"));
        assert_eq!(t["developer_instructions"].as_str().unwrap(), want);
    }
}
