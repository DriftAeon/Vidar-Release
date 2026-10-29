//! Rack view of the focused Codex tab's MCP configuration.

use tauri::AppHandle;

use crate::codex_config::{self, CodexConfig, CodexMcp, Home};

use super::{codex_server, McpRack, McpServer};

fn server_from(config: CodexMcp) -> McpServer {
    codex_server(
        config.name,
        "codex".into(),
        config.transport,
        config.target,
        config.args,
        config.env_keys,
        None,
        Some(!config.enabled),
    )
}

fn rack_from(home: Home, read: Result<Option<CodexConfig>, String>) -> McpRack {
    match home {
        Home::NotRunning => McpRack {
            servers: vec![],
            notes: vec!["No Codex home for this profile".into()],
        },
        Home::Default(None) => McpRack {
            servers: vec![],
            notes: vec!["No user home found".into()],
        },
        Home::Live(_) | Home::Profile(_) | Home::Default(Some(_)) => match read {
            Ok(Some(config)) => McpRack {
                servers: config.mcp_servers.into_iter().map(server_from).collect(),
                notes: vec![],
            },
            Ok(None) => McpRack {
                servers: vec![],
                notes: vec!["No Codex config.toml".into()],
            },
            Err(error) => McpRack {
                servers: vec![],
                notes: vec![error],
            },
        },
    }
}

/// Async on a blocking thread: resolves the Codex home and reads its config.toml, so a slow or
/// unreachable share must not stall Tauri's main thread (as read_codex_loadout).
#[tauri::command]
pub async fn read_codex_mcp_servers(
    app: AppHandle,
    tab: Option<String>,
    falcon_session: Option<String>,
    profile: Option<String>,
    row: Option<String>,
) -> Result<McpRack, String> {
    tauri::async_runtime::spawn_blocking(move || read_codex_mcp_servers_row_now(&app, tab, falcon_session, profile, row))
        .await
        .map_err(|e| e.to_string())
}

pub(super) fn read_codex_mcp_servers_now(app: &AppHandle, tab: Option<String>, profile: Option<String>) -> McpRack {
    read_codex_mcp_servers_row_now(app, tab, None, profile, None)
}

fn read_codex_mcp_servers_row_now(app: &AppHandle, tab: Option<String>, falcon_session: Option<String>, profile: Option<String>, row: Option<String>) -> McpRack {
    read_codex_mcp_servers_home(codex_config::home_for_row(app, tab.as_deref(), falcon_session.as_deref(), profile.as_deref(), row.as_deref()))
}

fn read_codex_mcp_servers_home(home: Home) -> McpRack {
    let read = match &home {
        Home::Live(path) | Home::Profile(path) | Home::Default(Some(path)) => {
            codex_config::read(path)
        }
        Home::NotRunning | Home::Default(None) => Ok(None),
    };
    rack_from(home, read)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn selected_row_home_supplies_mcp_servers() {
        let path = std::env::temp_dir().join(format!("vidar-codex-mcp-row-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let legacy = path.join("legacy");
        let picked = path.join("picked");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::write(legacy.join("config.toml"), "[mcp_servers.legacy]\ncommand = 'legacy'\n").unwrap();
        std::fs::write(picked.join("config.toml"), "[mcp_servers.picked]\ncommand = 'picked'\n").unwrap();
        let home = codex_config::resolve_row(
            None, Some("bare"), Some("codex-rendered-bare"),
            |_| Ok(legacy.clone()),
            |_, row| {
                assert_eq!(row, "codex-rendered-bare");
                Ok(picked.clone())
            },
            None,
        );
        let rack = read_codex_mcp_servers_home(home);
        assert_eq!(rack.servers.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["picked"]);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn maps_stdio_and_http_servers_and_disabled_state() {
        let config = CodexConfig {
            mcp_servers: vec![
                CodexMcp {
                    name: "local".into(),
                    transport: "stdio".into(),
                    target: "node".into(),
                    args: vec!["server.mjs".into()],
                    env_keys: vec!["TOKEN".into()],
                    cwd: Some("ignored".into()),
                    enabled: false,
                },
                CodexMcp {
                    name: "remote".into(),
                    transport: "http".into(),
                    target: "https://example.test/mcp".into(),
                    args: vec![],
                    env_keys: vec![],
                    cwd: None,
                    enabled: true,
                },
            ],
            ..Default::default()
        };
        let rack = rack_from(Home::Live(PathBuf::from("live-home")), Ok(Some(config)));
        assert!(rack.notes.is_empty());
        assert_eq!(rack.servers.len(), 2);
        let local = &rack.servers[0];
        assert_eq!(
            (
                &local.name[..],
                &local.scope[..],
                &local.transport[..],
                &local.target[..]
            ),
            ("local", "codex", "stdio", "node")
        );
        assert_eq!(local.args, ["server.mjs"]);
        assert_eq!(local.env_keys, ["TOKEN"]);
        assert_eq!(local.project, None);
        assert_eq!(local.disabled, Some(true));
        let remote = &rack.servers[1];
        assert_eq!(
            (&remote.transport[..], &remote.target[..]),
            ("http", "https://example.test/mcp")
        );
        assert_eq!(remote.disabled, Some(false));
    }

    #[test]
    fn notes_cover_unavailable_homes_and_read_outcomes() {
        let missing = || Ok(None);
        assert_eq!(
            rack_from(Home::NotRunning, missing()).notes,
            ["No Codex home for this profile"]
        );
        assert_eq!(
            rack_from(Home::Default(None), missing()).notes,
            ["No user home found"]
        );
        for home in [
            Home::Live(PathBuf::from("live-home")),
            Home::Profile(PathBuf::from("profile-home")),
            Home::Default(Some(PathBuf::from("user-home"))),
        ] {
            assert_eq!(rack_from(home, missing()).notes, ["No Codex config.toml"]);
        }
        assert_eq!(
            rack_from(
                Home::Live(PathBuf::from("live-home")),
                Err("reader error".into())
            )
            .notes,
            ["reader error"]
        );
    }
}
