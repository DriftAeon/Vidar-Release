//! The Notion tab's read-only backend (docs/projects/notion/plan.md § D1, § D2, § D5, § IPC).
//! Every command reads the credential first (absent → `unset`, no send), then validates its
//! arguments (bad → `endpoint`, no send), then takes a pacer turn, then sends. The token lives
//! in a `net::Secret` from the credential read to the header block and is never formatted.

pub mod api;
pub mod commands;
pub mod pace;
pub mod parse;
pub mod props;
pub mod transport;
pub mod vault;
