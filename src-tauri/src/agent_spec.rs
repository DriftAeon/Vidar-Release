//! src-tauri\src\agent_spec.rs — the one AgentSpec table, keyed by the Falcon `Agent`.
//! `ALL`, `parse` (the one string boundary) and `spec` (an exhaustive match, no `_`) are
//! the whole surface; every per-agent label, folder, login and carry rule that tables elsewhere
//! repeat reads from here. The list and the wire parse live on `Agent` in protocol.rs. Host-compiled
//! Falcon files never reference this module.
//! `tests/agent-ids-parity.test.mjs` pins `ALL`, `AGENT_IDS` and the `protocol.rs` variants to one list.

pub(crate) use crate::falcon::Agent;

/// Every agent, in the order `AGENT_IDS` (`src/agents/id.ts`) and `protocol.rs` list them.
pub const ALL: [Agent; 2] = Agent::ALL;

/// The one string boundary: an exact lowercase id, else `None`.
pub fn parse(s: &str) -> Option<Agent> {
    Agent::from_wire(s)
}

/// What a permission rune gives one agent: the entries (and mode) it keeps, and the reason text when
/// it drops some.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionCarry {
    pub kept: Vec<String>,
    pub refused: Option<String>,
}

/// What an agent carries of each rune kind: `None` = carried, `Some` = the exact reason text a
/// Not Carried row shows (the `Rune `x`: <reason>; not carried` frame stays at the call site).
pub struct Carries {
    pub skill: Option<&'static str>,
    pub agent: Option<&'static str>,
    pub mcp: Option<&'static str>,
    pub model: Option<&'static str>,
    pub plugin: Option<&'static str>,
    pub output_style: Option<&'static str>,
    /// The settings file (`kind: setting`); both agents carry one.
    pub setting: Option<&'static str>,
    /// Switches the agent's own skills and plugins off from what a vault left unplaced
    /// (`bare::builtin_off`): settings keys for Claude, a config block for Codex.
    pub builtin_off: fn(&crate::bare::set_loadout::BuiltIns, &[String]) -> crate::bare::builtin_off::BuiltInWrite,
    /// Called once with an item's whole list and mode (`rune_items::map_item`), or as
    /// `(&[entry], None)` per entry and `(&[], Some(mode))` once (`set_loadout`'s post-pass).
    pub permission: fn(entries: &[String], mode: Option<&str>) -> PermissionCarry,
    /// A hook's event and matcher the agent cannot run, as the reason; `None` = carried.
    pub guard: fn(event: &str, matcher: Option<&str>) -> Option<String>,
}

impl Carries {
    /// The one kind-indexed lookup (E5): `Some(Some(reason))` when this agent does not carry the item kind,
    /// `Some(None)` when it does, and `None` for a name that is no item kind. A permission and a hook are
    /// carried per entry and event (`permission`, `guard`), so they read as carried here.
    #[cfg_attr(not(test), allow(dead_code))] // only the table test below walks the kinds through it
    pub fn of(&self, kind: &str) -> Option<Option<&'static str>> {
        Some(match kind {
            "skill" => self.skill,
            "agent" => self.agent,
            "mcp" => self.mcp,
            "model" => self.model,
            "plugin" => self.plugin,
            "output-style" => self.output_style,
            "setting" => self.setting,
            "permission" | "hook" => None,
            _ => return None,
        })
    }
}

pub struct AgentSpec {
    /// The word errors and labels use.
    pub label: &'static str,
    /// The Bare launch profile under `profiles/bare/`.
    pub profile_file: &'static str,
    /// The combination-homes folder under the Bare home, and its index file.
    pub homes_dir: &'static str,
    pub homes_index: &'static str,
    /// The launch manifest's pointer naming the agent's own home.
    pub owner_field: &'static str,
    /// A home holding any file under these keeps its transcripts and is never pruned.
    pub transcripts: &'static [&'static str],
    /// The agent's config folder in a Bare home (a `homeDirs` entry).
    pub config_dir: &'static str,
    /// The shared-login files in `config_dir`, credential first.
    pub logins: &'static [&'static str],
    /// The shared-login warnings' lead.
    pub login_lead: &'static str,
    /// The agent name a shared-login record carries.
    pub login_record: Option<&'static str>,
    /// The generator home's folder under the Bare home.
    pub gen_dir: &'static str,
    /// The agent's project instructions file name.
    pub instructions_file: &'static str,
    /// The personal-override instructions file beside it, when the agent reads one.
    pub local_instructions_file: Option<&'static str>,
    /// The agent's per-user folder under the home directory (`~/.claude`). Not `config_dir`, which is the
    /// folder inside a Bare home.
    pub user_dir: &'static str,
    /// The npm package its pack updates from (`content/packs/<id>/pack.json` `update.package`).
    pub npm_package: Option<&'static str>,
    /// The command names a shell line may start with; the first is the bare `as_str` name.
    pub commands: &'static [&'static str],
    /// The prefix of the agent's model ids, when it has one.
    pub model_prefix: Option<&'static str>,
    /// Whether a Bare spawn of this agent rides a launcher row key (`bare::admit_row_key`); a key on an
    /// agent that does not is refused.
    pub rides_row_key: bool,
    /// The session record body a Falcon adopt with no record writes (`vault::session::adopt`).
    pub adopt_body: &'static str,
    /// Whether a plain (profile-less) Rendered spawn mints a control secret; a Bare one follows `bare::ctl_for`.
    pub plain_rendered_mints: bool,
    /// The top-level keys the agent's setting rune file must hold (dotted for a TOML table): a file
    /// missing one refuses the spawn. Claude's are the keys `home::validate` compares plus the three
    /// built-in switches; Codex's are the keys `validate_codex_with` pins plus `notify` and `analytics`.
    pub setting_keys: &'static [&'static str],
    /// Reads the setting file (rune id, path, `setting_keys`) and refuses one missing a key.
    pub check_setting: fn(&str, &std::path::Path, &[&str]) -> Result<(), String>,
    /// Prepares a Raw (PTY) bare launch: the launch folder in, the folder and the launch out.
    pub raw_prepare: crate::pty::RawPrepare,
    pub carries: Carries,
}

fn claude_permission(entries: &[String], mode: Option<&str>) -> PermissionCarry {
    let mut kept = entries.to_vec();
    kept.extend(mode.map(str::to_string));
    PermissionCarry { kept, refused: None }
}

/// Codex keeps the `mcp__` entries (Flow turns them into approval args) and nothing else; the text is
/// `rune_items::map_item`'s, and for one entry or one mode alone the post-pass's rows. An `mcp__`-only
/// list with no mode refuses nothing.
fn codex_permission(entries: &[String], mode: Option<&str>) -> PermissionCarry {
    let (kept, rest): (Vec<String>, Vec<String>) = entries.iter().cloned().partition(|e| e.starts_with("mcp__"));
    let what = match (!rest.is_empty(), mode.is_some()) {
        (true, true) => Some("Codex has no per-tool list or permission mode"),
        (true, false) => Some("Codex has no per-tool list"),
        (false, true) => Some("Codex has no permission mode"),
        (false, false) if kept.is_empty() => Some("Codex has no permission mode"),
        (false, false) => None,
    };
    PermissionCarry { kept, refused: what.map(str::to_string) }
}

fn claude_guard(event: &str, matcher: Option<&str>) -> Option<String> {
    crate::bare::guards::claude_unsupported(event, matcher)
}

fn codex_guard(event: &str, matcher: Option<&str>) -> Option<String> {
    crate::bare::guards::codex_unsupported(event, matcher)
}

static CLAUDE: AgentSpec = AgentSpec {
    label: "Claude",
    profile_file: "claude.json",
    homes_dir: "claude-homes",
    homes_index: "claude-homes.json",
    owner_field: "/homes/claudeConfig",
    transcripts: &["projects"],
    config_dir: "claude-config",
    logins: &[".credentials.json"],
    login_lead: "Shared login",
    login_record: Some("claude"),
    gen_dir: "gen-claude",
    instructions_file: "CLAUDE.md",
    local_instructions_file: Some("CLAUDE.local.md"),
    user_dir: ".claude",
    npm_package: Some("@anthropic-ai/claude-code"),
    commands: &["claude", "claude.exe"],
    model_prefix: Some("claude-"),
    rides_row_key: false,
    adopt_body: "rendered",
    plain_rendered_mints: true,
    setting_keys: &[
        "autoMemoryEnabled",
        "claudeMdExcludes",
        "disableClaudeAiConnectors",
        "hooks",
        "permissions",
        "pluginConfigs",
        "statusLine",
        "syncClaudeAiPlugins",
        "syncClaudeAiSkills",
        "skillOverrides",
        "disableBundledSkills",
        "enabledPlugins",
    ],
    check_setting: crate::bare::home::check_settings_keys,
    raw_prepare: crate::pty::raw_prepare_claude,
    carries: Carries {
        skill: None,
        agent: None,
        mcp: None,
        model: None,
        plugin: None,
        output_style: None,
        setting: None,
        builtin_off: crate::bare::builtin_off::settings_keys_for,
        permission: claude_permission,
        guard: claude_guard,
    },
};

static CODEX: AgentSpec = AgentSpec {
    label: "Codex",
    profile_file: "codex.json",
    homes_dir: "codex-homes",
    homes_index: "codex-homes.json",
    owner_field: "/homes/codexHome",
    transcripts: &["sessions", "archived_sessions"],
    config_dir: "codex-home",
    logins: &["auth.json", ".credentials.json"],
    login_lead: "Shared Codex login",
    login_record: Some("codex"),
    gen_dir: "gen-codex",
    instructions_file: "AGENTS.md",
    local_instructions_file: None,
    user_dir: ".codex",
    npm_package: Some("@openai/codex"),
    commands: &["codex", "codex.exe", "codex.cmd", "codex.ps1"],
    model_prefix: None,
    rides_row_key: true,
    adopt_body: "hosted",
    plain_rendered_mints: false,
    setting_keys: &[
        "project_doc_max_bytes",
        "project_root_markers",
        "developer_instructions",
        "notify",
        "sandbox_mode",
        "suppress_unstable_features_warning",
        "cli_auth_credentials_store",
        "mcp_oauth_credentials_store",
        "skills.include_instructions",
        "windows.sandbox",
        "sandbox_workspace_write.writable_roots",
        "sandbox_workspace_write.network_access",
        "sandbox_workspace_write.exclude_tmpdir_env_var",
        "sandbox_workspace_write.exclude_slash_tmp",
        "analytics.enabled",
        "features.daemon_auto_start",
        "features.prefer_mxc",
    ],
    check_setting: crate::bare::home::check_config_keys,
    raw_prepare: crate::pty::raw_prepare_codex,
    carries: Carries {
        skill: None,
        agent: None,
        mcp: None,
        model: None,
        plugin: Some("Codex has no plugins"),
        output_style: Some("Codex has no output style"),
        setting: None,
        builtin_off: crate::bare::builtin_off::config_block,
        permission: codex_permission,
        guard: codex_guard,
    },
};

pub fn spec(a: Agent) -> &'static AgentSpec {
    match a {
        Agent::Claude => &CLAUDE,
        Agent::Codex => &CODEX,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_trips_as_str() {
        for a in ALL {
            assert_eq!(parse(a.as_str()), Some(a));
        }
    }

    #[test]
    fn a_plain_rendered_claude_mints_a_secret_and_a_plain_rendered_codex_does_not() {
        assert!(spec(Agent::Claude).plain_rendered_mints);
        assert!(!spec(Agent::Codex).plain_rendered_mints);
    }

    #[test]
    fn carries_of_knows_every_item_kind_and_no_other() {
        for a in ALL {
            for k in crate::rules::rune::ITEM_KINDS {
                assert!(spec(a).carries.of(k).is_some(), "{k}");
            }
            assert!(spec(a).carries.of("rule").is_none());
        }
    }

    #[test]
    fn commands_lead_with_the_bare_id() {
        for a in ALL {
            assert_eq!(spec(a).commands[0], a.as_str());
        }
    }

    #[test]
    fn parse_takes_only_exact_lowercase_ids() {
        assert_eq!(parse("grok"), None);
        assert_eq!(parse("Claude"), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn permission_texts_match_map_item_and_the_post_pass() {
        let list = vec!["Bash(ls)".to_string()];
        let claude = (spec(Agent::Claude).carries.permission)(&list, Some("plan"));
        assert_eq!(claude, PermissionCarry { kept: vec!["Bash(ls)".into(), "plan".into()], refused: None });
        let codex = spec(Agent::Codex).carries.permission;
        assert_eq!(codex(&list, Some("plan")).refused.as_deref(), Some("Codex has no per-tool list or permission mode"));
        assert_eq!(codex(&list, None).refused.as_deref(), Some("Codex has no per-tool list"));
        assert_eq!(codex(&[], Some("plan")).refused.as_deref(), Some("Codex has no permission mode"));
        assert_eq!(codex(&[], None).refused.as_deref(), Some("Codex has no permission mode"));
        assert!(codex(&list, Some("plan")).kept.is_empty());
    }

    #[test]
    fn codex_keeps_mcp_entries_and_refuses_the_rest() {
        let codex = spec(Agent::Codex).carries.permission;
        let mcp = vec!["mcp__x__y".to_string()];
        assert_eq!(codex(&mcp, None), PermissionCarry { kept: mcp.clone(), refused: None });
        let mixed = vec!["mcp__x__y".to_string(), "Bash(ls)".to_string()];
        let c = codex(&mixed, None);
        assert_eq!((c.kept, c.refused.as_deref()), (mcp.clone(), Some("Codex has no per-tool list")));
        assert_eq!(codex(&mcp, Some("plan")).refused.as_deref(), Some("Codex has no permission mode"));
        assert_eq!(codex(&mixed, Some("plan")).refused.as_deref(), Some("Codex has no per-tool list or permission mode"));
    }
}
