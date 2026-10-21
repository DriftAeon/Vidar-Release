//! Jira Issues bench tab (docs/projects/jira/issues-tab-plan.md). `http` is the WinHTTP
//! transport behind the `Transport` seam; `api` builds the search request and maps the reply;
//! `config` validates vidar.json `jira`; `vault` keeps the token in Credential Manager;
//! `jql` composes scope plus filters into JQL; `commands` are the Tauri commands: `jira_status`,
//! `jira_connect`, `jira_disconnect`, `jira_issues`,`jira_types`, `jira_projects`, `jira_issue`,
//! `jira_comments`; `detail` reads one issue and its comments for the in-module view.

pub mod api;
pub mod commands;
pub mod config;
pub mod detail;
pub mod http;
pub mod jql;
pub mod vault;
