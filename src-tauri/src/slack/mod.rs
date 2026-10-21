//! The Slack tab's read-only backend (docs/projects/slack/inbox-tab-plan.md § Rust). `api` holds the
//! request builders and search adapter, `parse` match parsing and the merge, `names` the name cache,
//! `vault` the Credential Manager entry, `hold` the rate hold and `commands` the four IPC commands.

pub mod api;
pub mod commands;
pub mod hold;
pub mod names;
pub mod parse;
pub mod vault;
