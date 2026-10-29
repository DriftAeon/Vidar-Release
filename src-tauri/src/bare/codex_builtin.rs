//! src-tauri\src\bare\codex_builtin.rs — Codex's own bundled skills (`skills\.system\`: imagegen,
//! openai-docs, review-agent, skill-creator, skill-installer) as stock runes a vault switches.
//!
//! Codex writes those folders into CODEX_HOME itself (a fingerprint marker in `.system` makes it
//! restore them), so the folders are never removed or renamed. Codex 0.164 has a config switch: each
//! `[[skills.config]]` entry with `name` and `enabled = false` hides one skill (checked with
//! `codex debug prompt-input`), and `[skills.bundled] enabled = false` stops the install and hides all.
//! A stock rune names one by its source, `{{root}}/profiles/bare/codex-builtin/<name>`; that path is a
//! marker only (no folder), so the launch takes it out of the skill list before any copy is planned.
//! A vault that holds at least one built-in marker rune, on or off, manages them: a marker in the
//! vault's loaded runes is on, one in `Vault::off` (Modify's switched-off one-offs) is off, and a name
//! with no marker at all is off. A vault with no marker anywhere (every vault written before the five
//! stock runes existed) is unmanaged and leaves Codex's built-ins alone (all on), as does a launch
//! without a vault (test-only).

use std::path::Path;

use super::agent_homes::Agent;
use super::vault::Vault;

/// The skills Codex 0.164 bundles, as the folder names under `skills\.system\`.
pub(super) const NAMES: [&str; 5] = ["imagegen", "openai-docs", "review-agent", "skill-creator", "skill-installer"];

const MARKER: &str = "# Vidar: Codex built-in skills";

/// Which built-ins a Codex launch carries. `managed` is false for a launch without a vault.
#[derive(Debug, Default, PartialEq)]
pub(super) struct Builtins {
    managed: bool,
    on: Vec<String>,
}

/// The built-in a skill path stands for (`<root>/profiles/bare/codex-builtin/<name>`), if it is one.
fn name_of(root: &Path, skill: &str) -> Option<String> {
    let dir = root.join("profiles").join("bare").join("codex-builtin");
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
    let (dir, skill_n) = (norm(&dir.to_string_lossy()), norm(skill));
    let name = skill_n.strip_prefix(&dir)?.strip_prefix('/')?;
    NAMES.iter().find(|n| **n == name).map(|n| n.to_string())
}

/// True when `v` lists a built-in marker rune switched off (`Vault::off`; the stock rune ids are `codex-<name>`).
pub(super) fn holds_off(v: &Vault) -> bool {
    v.off.iter().any(|r| r.library == "stock" && NAMES.iter().any(|n| r.id == format!("codex-{n}")))
}

/// Takes the built-in markers out of `skills`. Codex keeps the names it carries; any other agent drops them.
/// `off_held`: the vault lists a marker rune off (`holds_off`). The launch is managed when a marker is
/// on in `skills` or held off; a vault with neither never carried the built-ins and leaves Codex alone.
pub(super) fn take(agent: Agent, root: &Path, skills: &mut Vec<String>, off_held: bool) -> Builtins {
    let mut on = Vec::new();
    skills.retain(|s| match name_of(root, s) {
        Some(n) => {
            if !on.contains(&n) {
                on.push(n);
            }
            false
        }
        None => true,
    });
    match agent {
        Agent::Codex => Builtins { managed: off_held || !on.is_empty(), on },
        Agent::Claude => Builtins::default(),
    }
}

impl Builtins {
    /// The config text for this launch: empty when unmanaged or all five are on.
    pub(super) fn config_text(&self) -> String {
        if !self.managed {
            return String::new();
        }
        if self.on.is_empty() {
            return format!("{MARKER}\n[skills.bundled]\nenabled = false\n");
        }
        let mut out = String::new();
        for name in NAMES.iter().filter(|n| !self.on.iter().any(|o| o == *n)) {
            out.push_str(&format!("[[skills.config]]\nname = \"{name}\"\nenabled = false\n\n"));
        }
        match out.is_empty() {
            true => out,
            false => format!("{MARKER}\n{}", out.trim_end().to_string() + "\n"),
        }
    }

    /// Appends the switch to the Codex `config.toml` (written last: every regeneration of the file
    /// drops it). A block from an earlier call is replaced.
    pub(super) fn apply(&self, config: &Path) -> Result<(), String> {
        if !self.managed {
            return Ok(());
        }
        let text = crate::fsx::read_text(config).map_err(|e| format!("Codex config {}: {e}; Bare spawn refused", config.display()))?;
        let text = crate::fsx::strip_bom(&text);
        let base = text.split(MARKER).next().unwrap_or("").trim_end();
        let block = self.config_text();
        let next = match block.is_empty() {
            true => format!("{base}\n"),
            false => format!("{base}\n\n{block}"),
        };
        if next == text {
            return Ok(());
        }
        crate::fsx::atomic_write(config, next.as_bytes()).map_err(|e| format!("Codex config {}: {e}; Bare spawn refused", config.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(root: &Path, n: &str) -> String {
        root.join("profiles").join("bare").join("codex-builtin").join(n).to_string_lossy().into_owned()
    }

    #[test]
    fn markers_leave_the_skill_list_and_codex_keeps_their_names() {
        let root = Path::new("X:/root");
        let other = "X:/root/profiles/bare/codex-skills/vidar-control".to_string();
        let mut skills = vec![other.clone(), skill(root, "imagegen"), skill(root, "openai-docs")];
        let b = take(Agent::Codex, root, &mut skills, true);
        assert_eq!(skills, vec![other.clone()]);
        assert_eq!(b.on, vec!["imagegen", "openai-docs"]);
        assert!(b.managed);
        let mut skills = vec![skill(root, "imagegen"), other.clone()];
        let c = take(Agent::Claude, root, &mut skills, true);
        assert_eq!(skills, vec![other], "Claude never sees a Codex built-in");
        assert_eq!(c, Builtins::default());
    }

    #[test]
    fn off_names_hide_one_each_and_none_on_turns_bundled_off() {
        let some = Builtins { managed: true, on: vec!["imagegen".into(), "skill-creator".into()] };
        let t = some.config_text();
        assert!(t.contains("name = \"openai-docs\"") && t.contains("name = \"review-agent\"") && t.contains("name = \"skill-installer\""), "{t}");
        assert!(!t.contains("\"imagegen\"") && !t.contains("\"skill-creator\""), "{t}");
        assert_eq!(t.matches("enabled = false").count(), 3);
        assert_eq!(Builtins { managed: true, on: NAMES.iter().map(|n| n.to_string()).collect() }.config_text(), "");
        assert!(Builtins { managed: true, on: Vec::new() }.config_text().contains("[skills.bundled]\nenabled = false"));
        assert_eq!(Builtins { managed: false, on: Vec::new() }.config_text(), "");
    }

    #[test]
    fn apply_replaces_its_own_block_and_leaves_the_rest() {
        let dir = std::env::temp_dir().join(format!("vidar-codex-builtin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.toml");
        std::fs::write(&cfg, "[skills]\ninclude_instructions = false\n").unwrap();
        let off = Builtins { managed: true, on: Vec::new() };
        off.apply(&cfg).unwrap();
        off.apply(&cfg).unwrap();
        let text = std::fs::read_to_string(&cfg).unwrap();
        assert_eq!(text.matches("[skills.bundled]").count(), 1, "{text}");
        assert!(text.starts_with("[skills]\ninclude_instructions = false\n"));
        let on = Builtins { managed: true, on: NAMES.iter().map(|n| n.to_string()).collect() };
        on.apply(&cfg).unwrap();
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), "[skills]\ninclude_instructions = false\n");
        Builtins::default().apply(&dir.join("missing.toml")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
