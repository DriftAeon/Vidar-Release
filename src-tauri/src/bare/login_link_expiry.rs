//! Narrow, bounded reader for Claude's credential expiry. Never expose file bytes or parse errors.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;

const LIMIT: u64 = 64 * 1024;

#[derive(Deserialize)]
struct Credentials {
    #[serde(rename = "claudeAiOauth")]
    oauth: OAuth,
}

#[derive(Deserialize)]
struct OAuth {
    #[serde(rename = "expiresAt")]
    expires_at: u64,
}

pub(super) fn read(path: &Path) -> Option<u64> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(LIMIT).read_to_end(&mut bytes).ok()?;
    let credentials: Credentials = serde_json::from_slice(&bytes).ok()?;
    Some(credentials.oauth.expires_at)
}
