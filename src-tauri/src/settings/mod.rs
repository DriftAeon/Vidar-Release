//! src-tauri\src\settings\mod.rs — wiring only (module-boundary rule): the
//! typed shape lives in `schema`, the generic-tree read-modify-write in
//! `store`, `configVersion` migrations in `migrate`. `config.rs` keeps the
//! `#[tauri::command]` entry points at their original path so main.rs's
//! registration and the TS command names don't change.

pub mod commands;
pub mod migrate;
pub mod schema;
pub mod state;
pub mod store;
pub mod switches;
