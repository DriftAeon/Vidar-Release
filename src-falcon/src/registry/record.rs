//! The registry record Falcon publishes at `bridge\falcon\runtime\registry.json`.
//!
//! A leaf: serde only, no `crate::` references, because Vidar's client
//! (`src-tauri/src/falcon.rs`) compiles this file too by `#[path]` and
//! reads the record the host wrote with this exact type.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FalconRegistry {
    pub schema_version: u32,
    pub activation_endpoint: String,
    pub session_endpoint: String,
    pub pid: u32,
    pub process_created_100ns: u64,
    pub executable: String,
    pub profile_directory: String,
    pub protocol_min: u32,
    pub protocol_max: u32,
    /// Advisory discovery only. Negotiation is still authoritative.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_agents: Vec<String>,
    pub bundle_id: String,
    pub attach_secret: String,
}
