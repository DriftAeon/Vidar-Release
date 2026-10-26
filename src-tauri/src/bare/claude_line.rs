//! The Claude Raw spawn line, built from inputs already resolved: the argv (settings and payload
//! args from the profile, then what the session's Rune Vault carries: `--plugin-dir`,
//! `--allowedTools`, `--permission-mode`) and the PowerShell line that runs it. Pure: no file is read.

use std::path::Path;

use super::{ps_quote, Profile};

/// The permission modes a vault's `mode` rune may start a session in: the single source Falcon also
/// compiles in (`src-falcon/src/protocol.rs` `ALLOWED_MODES`).
const ALLOWED_MODES: &str = include_str!("../../../contracts/permission-modes.json");

/// What a Raw line carries from the session's Rune Vault (run 2026-10-25-rune-vault L2b; model R1):
/// plugin rune folders (absolute, `<root>\plugins\<name>`), the permission allow list and mode.
/// Empty means the vault holds none: nothing of that kind rides the line.
#[derive(Default)]
pub(super) struct VaultArgs<'a> {
    pub plugins: &'a [String],
    pub allow: &'a [String],
    pub mode: Option<&'a str>,
}

/// Whether `mode` is one `contracts/permission-modes.json` lists.
pub(super) fn mode_allowed(mode: &str) -> bool {
    serde_json::from_str::<Vec<String>>(ALLOWED_MODES).is_ok_and(|m| m.iter().any(|x| x == mode))
}

/// The argv after the binary: the profile's `args` with `{{payload}}`, `{{root}}` and `{{home}}`
/// filled and `{{remoteControl}}` expanded to `--remote-control` when `remote_control` says so; then
/// one `--plugin-dir` per vault plugin, `--allowedTools` with the vault's allow list, and
/// `--permission-mode` with its mode (refused when not an allowed mode); then the strict MCP file.
pub(super) fn claude_args(
    p: &Profile,
    payload_path: &str,
    fill: &dyn Fn(&str) -> String,
    remote_control: &dyn Fn() -> bool,
    mcp_file: Option<&Path>,
    vault: &VaultArgs,
) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for a in &p.args {
        if a == "{{remoteControl}}" {
            if remote_control() {
                out.push("--remote-control".to_string());
            }
        } else {
            out.push(fill(&a.replace("{{payload}}", payload_path)));
        }
    }
    for dir in vault.plugins {
        out.extend(["--plugin-dir".to_string(), dir.clone()]);
    }
    if !vault.allow.is_empty() {
        out.extend(["--allowedTools".to_string(), vault.allow.join(",")]);
    }
    if let Some(mode) = vault.mode {
        if !mode_allowed(mode) {
            return Err(format!("Permission mode {mode:?} is not one Vidar admits ({}); Bare spawn refused", ALLOWED_MODES.trim()));
        }
        out.extend(["--permission-mode".to_string(), mode.to_string()]);
    }
    if let Some(file) = mcp_file {
        out.extend(["--mcp-config".into(), file.to_string_lossy().into_owned(), "--strict-mcp-config".into()]);
    }
    Ok(out)
}

/// The PowerShell line: a yellow `Write-Host` per warning, then `& <claude> <args>`, each quoted.
pub(super) fn spawn_line<'a>(warnings: impl IntoIterator<Item = &'a String>, claude: &Path, args: Vec<String>) -> String {
    let mut line = String::new();
    for w in warnings {
        line.push_str(&format!("Write-Host {} -ForegroundColor Yellow; ", ps_quote(&format!("[Vidar Bare: {w}]"))));
    }
    line.push_str("& ");
    line.push_str(&std::iter::once(claude.to_string_lossy().into_owned()).chain(args).map(|a| ps_quote(&a)).collect::<Vec<_>>().join(" "));
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allowed_modes_are_the_contracts_list() {
        for m in ["default", "acceptEdits", "plan", "auto"] {
            assert!(mode_allowed(m), "{m}");
        }
        assert!(!mode_allowed("bypassPermissions") && !mode_allowed("dontAsk") && !mode_allowed(""));
    }
}
