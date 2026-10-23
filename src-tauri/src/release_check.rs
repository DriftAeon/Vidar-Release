//! src-tauri\src\release_check.rs — notify-only update check for Vidar and its packs. Fetches the
//! one release index (`tests/fixtures/release-index.json` is its fixture, `tools/release/pack-index.mjs`
//! builds it) from a fixed release asset through `net::https::get_public`, and says what is newer.
//! Nothing here downloads an asset, installs, or writes state: the frontend owns state through
//! `read_state`/`patch_state`.
//!
//! Wire format (Rust ↔ TS, `src/ipc.ts` `check_release`):
//! - Call: `check_release({ skip, seen })`. `skip` is `vidarUpdate.skip` (a core version the user
//!   skipped) or null; `seen` maps pack id → `packUpdates.seen.<id>` (the highest release seen).
//! - Reply, tagged by `status`:
//!   - `{ status: "ok", core, packs, blocked, seen }`. `core` is `{ installed, version, page, asset }`
//!     when the index's core is newer than this build (`installed`) and not the skipped version, else
//!     null; `asset` is `{ url, sha256 }` for this build's release set, null in a dev build or an
//!     unlisted set. `packs` is `[{ id, label, installed, release, page }]`: per installed
//!     pack-updatable pack, the newest entry whose `requires` accepts this core, above the installed
//!     `release` (`installed`, null when the pack.json has none) and not below `seen`; `page` is the
//!     entry's release tag page. `blocked` is `[{ id, label, installed, release, reason }]` with
//!     reason "Pack Needs Update: Needs Vidar Update" when only entries this core cannot take are
//!     newer. Every `page` is a tag page of this repo or empty (the card disables Open Release for
//!     an empty one). `seen` is the map the frontend writes back: per pack id, the release of the
//!     offered entry or the incoming `seen`, whichever is higher; a blocked entry never raises it.
//!   - `{ status: "offline" | "notPublished" | "error", reason }`: no connection or a timeout; a
//!     404 (no index published yet); anything else. `reason` is one sentence-case sentence.
//! - Rollback refusal: an entry below `seen` is never offered, so an older index cannot walk a pack
//!   back. An entry equal to `seen` is still offered until it is installed or skipped.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::modules::compat::{check_pack_compat, Semver, CORE_CONTRACT};
use crate::net::https::{get_public, Limits};
use crate::net::SendError;

// The one host and repo every URL below derives from (macros, so `concat!` can build the consts).
macro_rules! host {
    () => {
        "github.com"
    };
}
macro_rules! repo {
    () => {
        "/DriftAeon/Vidar-Release"
    };
}
const HOST: &str = host!();
/// The fixed asset on the repo `src/build-stamp/stamp.ts` `RELEASES_URL` names.
const INDEX_PATH: &str = concat!(repo!(), "/releases/download/index/index.json");
/// A release page the card may link: only this prefix passes, anything else becomes an empty page.
const TAG_PAGE: &str = concat!("https://", host!(), repo!(), "/releases/tag/");
/// The only shape a pack asset URL may take: `<this><tag>/<file>`.
const DOWNLOAD_PREFIX: &str = concat!("https://", host!(), repo!(), "/releases/download/");
const LIMITS: Limits = Limits { cap: 1024 * 1024, body_deadline: Duration::from_secs(15) };
/// Packs that carry no compiled code; a test pins this to `tools/release/pack-index.mjs`.
const PACK_UPDATABLE: [&str; 6] = ["gemini", "pi", "agent-profiles", "codex-profiles", "voice-stock", "gateways"];
const NEEDS_VIDAR_UPDATE: &str = "Pack Needs Update: Needs Vidar Update";

#[derive(Debug, Deserialize)]
struct Index {
    core: CoreEntry,
    /// Per pack id, a list of entries; a value that is not an array is skipped in `decide`.
    #[serde(default)]
    packs: BTreeMap<String, Value>,
}

#[derive(Debug, Deserialize)]
struct CoreEntry {
    version: String,
    page: String,
    #[serde(default)]
    assets: BTreeMap<String, Asset>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Asset {
    url: String,
    sha256: String,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct CoreOffer {
    installed: String,
    version: String,
    page: String,
    asset: Option<Asset>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct PackOffer {
    id: String,
    label: String,
    installed: Option<String>,
    release: String,
    page: String,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct PackBlocked {
    id: String,
    label: String,
    installed: Option<String>,
    release: String,
    reason: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CheckReply {
    Ok { core: Option<CoreOffer>, packs: Vec<PackOffer>, blocked: Vec<PackBlocked>, seen: BTreeMap<String, String> },
    Offline { reason: String },
    NotPublished { reason: String },
    Error { reason: String },
}

/// An installed pack: its `release` (None before packs carried one) and its display label.
#[derive(Debug, Clone)]
struct Installed {
    release: Option<String>,
    label: String,
}

fn installed_pack(id: &str) -> Option<Installed> {
    let text = std::fs::read_to_string(crate::paths::packs_dir().join(id).join("pack.json")).ok()?;
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let label = v.pointer("/ui/label").and_then(Value::as_str).unwrap_or(id).to_string();
    Some(Installed { release: v.get("release").and_then(Value::as_str).map(str::to_string), label })
}

/// A page from the index, kept only when it is a tag page of this repo; anything else is empty
/// (the card disables Open Release for an empty page).
fn pin_page(page: &str) -> String {
    match page.strip_prefix(TAG_PAGE) {
        Some(tag) if !tag.is_empty() => page.to_string(),
        _ => String::new(),
    }
}

/// The release tag page for an asset URL (`<DOWNLOAD_PREFIX><tag>/<file>` → `<TAG_PAGE><tag>`),
/// so a row links a page rather than starting a download. Any other shape gives an empty page.
fn asset_page(url: &str) -> String {
    let Some(rest) = url.strip_prefix(DOWNLOAD_PREFIX) else { return String::new() };
    match rest.split_once('/') {
        Some((tag, file)) if !tag.is_empty() && !file.is_empty() => format!("{TAG_PAGE}{tag}"),
        _ => String::new(),
    }
}

fn parse_index(body: &[u8]) -> Result<Index, String> {
    let text = std::str::from_utf8(body).map_err(|_| "The release index is not text.".to_string())?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| "The release index could not be read.".to_string())
}

fn release_of(entry: &Value) -> Option<(Semver, String)> {
    let text = entry.get("release")?.as_str()?;
    Semver::parse(text).map(|v| (v, text.to_string()))
}

/// Everything the index offers this core, given what is installed and what was seen before.
fn decide(
    index: &Index,
    version: &str,
    set: Option<&str>,
    skip: Option<&str>,
    seen: &BTreeMap<String, String>,
    installed: &dyn Fn(&str) -> Option<Installed>,
) -> CheckReply {
    let this = Semver::parse(version);
    let core = match (Semver::parse(&index.core.version), &this) {
        (Some(latest), Some(this)) if latest > *this && skip != Some(index.core.version.as_str()) => Some(CoreOffer {
            installed: version.to_string(),
            version: index.core.version.clone(),
            page: pin_page(&index.core.page),
            asset: set.and_then(|s| index.core.assets.get(s)).cloned(),
        }),
        _ => None,
    };

    let mut packs = Vec::new();
    let mut blocked = Vec::new();
    let mut seen_out = seen.clone();
    for id in PACK_UPDATABLE {
        let Some(entries) = index.packs.get(id).and_then(Value::as_array) else { continue };
        let mut entries: Vec<(Semver, String, &Value)> =
            entries.iter().filter_map(|e| release_of(e).map(|(v, t)| (v, t, e))).collect();
        entries.sort_by(|a, b| b.0.cmp(&a.0));
        let floor_seen = seen.get(id).and_then(|s| Semver::parse(s));
        let Some(pack) = installed(id) else { continue };
        let floor_installed = pack.release.as_deref().and_then(Semver::parse);
        let candidates: Vec<&(Semver, String, &Value)> = entries
            .iter()
            .filter(|(v, _, _)| floor_installed.as_ref().is_none_or(|i| v > i))
            .filter(|(v, _, _)| floor_seen.as_ref().is_none_or(|s| v >= s))
            .collect();
        let accepted = candidates.iter().find(|(_, _, e)| check_pack_compat(e, version, CORE_CONTRACT).is_ok());
        if let Some((top, text, entry)) = accepted {
            // An entry with no url has nothing to open: no row, and nothing marked seen.
            if let Some(url) = entry.get("url").and_then(Value::as_str) {
                // `seen` rises only from an offered entry, never from one this core cannot take.
                if floor_seen.as_ref().is_none_or(|s| top > s) {
                    seen_out.insert(id.to_string(), text.clone());
                }
                packs.push(PackOffer {
                    id: id.to_string(),
                    label: pack.label,
                    installed: pack.release,
                    release: text.clone(),
                    page: asset_page(url),
                });
            }
        } else if let Some((_, text, _)) = candidates.first() {
            blocked.push(PackBlocked {
                id: id.to_string(),
                label: pack.label,
                installed: pack.release,
                release: text.clone(),
                reason: NEEDS_VIDAR_UPDATE.to_string(),
            });
        }
    }
    CheckReply::Ok { core, packs, blocked, seen: seen_out }
}

fn reply_for(fetched: Result<crate::net::Reply, SendError>, decide_with: impl FnOnce(&Index) -> CheckReply) -> CheckReply {
    match fetched {
        Ok(r) if r.status == 200 => match parse_index(&r.body) {
            Ok(index) => decide_with(&index),
            Err(reason) => CheckReply::Error { reason },
        },
        Ok(r) if r.status == 404 => CheckReply::NotPublished { reason: "No release index is published yet.".into() },
        Ok(r) => CheckReply::Error { reason: format!("GitHub answered with status {}.", r.status) },
        Err(SendError::Connect(_) | SendError::Timeout) => CheckReply::Offline { reason: "Vidar could not reach GitHub.".into() },
        Err(SendError::OverCap) => CheckReply::Error { reason: "The release index is too large.".into() },
        Err(SendError::Io(m)) => CheckReply::Error { reason: format!("The request failed: {m}.") },
    }
}

#[tauri::command]
pub async fn check_release(skip: Option<String>, seen: Option<BTreeMap<String, String>>) -> Result<CheckReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let seen = seen.unwrap_or_default();
        let set = crate::build_stamp::release_set();
        reply_for(get_public(HOST, INDEX_PATH, LIMITS), |index| {
            decide(index, crate::build_stamp::VERSION, set.as_deref(), skip.as_deref(), &seen, &installed_pack)
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::Reply;

    const FIXTURE: &str = include_str!("../../tests/fixtures/release-index.json");

    fn fixture() -> Index {
        parse_index(FIXTURE.as_bytes()).unwrap()
    }

    fn all_installed(release: Option<&'static str>) -> impl Fn(&str) -> Option<Installed> {
        move |id: &str| Some(Installed { release: release.map(str::to_string), label: format!("L-{id}") })
    }

    fn ok(r: CheckReply) -> (Option<CoreOffer>, Vec<PackOffer>, Vec<PackBlocked>, BTreeMap<String, String>) {
        match r {
            CheckReply::Ok { core, packs, blocked, seen } => (core, packs, blocked, seen),
            other => panic!("not ok: {other:?}"),
        }
    }

    #[test]
    fn parses_the_fixture() {
        let i = fixture();
        assert_eq!(i.core.version, "0.2.0");
        assert!(i.core.page.ends_with("/releases/tag/vidar-v0.2.0"));
        assert_eq!(i.core.assets.len(), 2);
        assert_eq!(i.packs["gemini"].as_array().unwrap().len(), 2);
        assert_eq!(i.packs["voice-stock"].as_array().unwrap().len(), 1);
        assert!(i.packs.keys().all(|id| PACK_UPDATABLE.contains(&id.as_str())));
        assert!(parse_index(b"not json").is_err());
    }

    #[test]
    fn pack_updatable_matches_pack_index_tool() {
        // Read at run time, not include_str!: a test-only read is no compile-time input of the build.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/release/pack-index.mjs");
        // The public export drops tools/release/, so there is nothing to compare against there.
        let Ok(tool) = std::fs::read_to_string(&path) else { return };
        let line = tool.lines().find(|l| l.contains("export const PACK_UPDATABLE")).unwrap();
        let ids: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
        assert_eq!(ids, PACK_UPDATABLE);
    }

    #[test]
    fn core_offer_when_newer_with_set_asset() {
        let (core, ..) = ok(decide(&fixture(), "0.1.0", Some("claude-codex"), None, &BTreeMap::new(), &all_installed(None)));
        let core = core.unwrap();
        assert_eq!(core.version, "0.2.0");
        assert!(core.asset.unwrap().url.ends_with("Vidar-claude-codex-0.2.0.zip"));
        // A dev build (no set) or an unlisted set: offer without an asset.
        let (core, ..) = ok(decide(&fixture(), "0.1.0", None, None, &BTreeMap::new(), &all_installed(None)));
        assert_eq!(core.unwrap().asset, None);
        let (core, ..) = ok(decide(&fixture(), "0.1.0", Some("nope"), None, &BTreeMap::new(), &all_installed(None)));
        assert_eq!(core.unwrap().asset, None);
        // Same or newer core: no offer.
        for v in ["0.2.0", "0.3.0"] {
            assert_eq!(ok(decide(&fixture(), v, None, None, &BTreeMap::new(), &all_installed(None))).0, None);
        }
    }

    #[test]
    fn skipped_core_version_is_not_offered() {
        let (core, ..) = ok(decide(&fixture(), "0.1.0", None, Some("0.2.0"), &BTreeMap::new(), &all_installed(None)));
        assert_eq!(core, None);
        let (core, ..) = ok(decide(&fixture(), "0.1.0", None, Some("0.1.5"), &BTreeMap::new(), &all_installed(None)));
        assert!(core.is_some());
    }

    #[test]
    fn newest_accepted_pack_entry_is_offered() {
        // Core 0.2.0: gemini 1.1.0 accepts it; 1.0.0 (maxCore 0.1.9) does not.
        let (_, packs, blocked, _) = ok(decide(&fixture(), "0.2.0", None, None, &BTreeMap::new(), &all_installed(None)));
        let gemini = packs.iter().find(|p| p.id == "gemini").unwrap();
        assert_eq!(gemini.release, "1.1.0");
        assert_eq!(gemini.label, "L-gemini");
        assert_eq!(gemini.page, "https://github.com/DriftAeon/Vidar-Release/releases/tag/pack-gemini-v1.1.0");
        assert!(blocked.is_empty());
        // Core 0.1.0: 1.1.0 needs 0.2.0, so the older accepted 1.0.0 is offered.
        let (_, packs, _, _) = ok(decide(&fixture(), "0.1.0", None, None, &BTreeMap::new(), &all_installed(None)));
        assert_eq!(packs.iter().find(|p| p.id == "gemini").unwrap().release, "1.0.0");
        // Installed at or above the newest: nothing.
        let (_, packs, blocked, _) = ok(decide(&fixture(), "0.2.0", None, None, &BTreeMap::new(), &all_installed(Some("1.1.0"))));
        assert!(packs.iter().all(|p| p.id != "gemini") && blocked.iter().all(|b| b.id != "gemini"));
        // Not installed: never offered.
        let none = |_: &str| None;
        let (_, packs, blocked, _) = ok(decide(&fixture(), "0.2.0", None, None, &BTreeMap::new(), &none));
        assert!(packs.is_empty() && blocked.is_empty());
    }

    #[test]
    fn newer_entry_this_core_cannot_take_is_blocked() {
        let (_, packs, blocked, _) = ok(decide(&fixture(), "0.1.0", None, None, &BTreeMap::new(), &all_installed(Some("1.0.0"))));
        assert!(packs.is_empty());
        let ids: Vec<&str> = blocked.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["gemini", "voice-stock"]);
        assert_eq!(blocked[0].release, "1.1.0");
        assert_eq!(blocked[0].reason, "Pack Needs Update: Needs Vidar Update");
    }

    #[test]
    fn seen_rises_only_from_offered_entries() {
        // Core 0.1.0, gemini 0.9.0 installed; the index has 1.0.0 (ok) and 1.1.0 (needs core 0.2.0).
        let installed = all_installed(Some("0.9.0"));
        let (_, packs, _, seen) = ok(decide(&fixture(), "0.1.0", None, None, &BTreeMap::new(), &installed));
        assert_eq!(packs.iter().find(|p| p.id == "gemini").unwrap().release, "1.0.0");
        // Launch 1 records the offered 1.0.0, not the blocked 1.1.0.
        assert_eq!(seen["gemini"], "1.0.0");
        // Launch 2 on the same core still offers 1.0.0.
        let (_, packs, _, seen2) = ok(decide(&fixture(), "0.1.0", None, None, &seen, &installed));
        assert_eq!(packs.iter().find(|p| p.id == "gemini").unwrap().release, "1.0.0");
        assert_eq!(seen2["gemini"], "1.0.0");
        // After a core update, 1.1.0 is offered and seen rises to it.
        let (_, packs, blocked, seen3) = ok(decide(&fixture(), "0.2.0", None, None, &seen2, &installed));
        assert_eq!(packs.iter().find(|p| p.id == "gemini").unwrap().release, "1.1.0");
        assert!(blocked.iter().all(|b| b.id != "gemini"));
        assert_eq!(seen3["gemini"], "1.1.0");
        // Nothing offered and only a blocked entry: seen is not written for it.
        let (_, packs, blocked, seen4) = ok(decide(&fixture(), "0.1.0", None, None, &BTreeMap::new(), &all_installed(Some("1.0.0"))));
        assert!(packs.is_empty() && blocked.iter().any(|b| b.id == "gemini"));
        assert!(seen4.is_empty());
    }

    #[test]
    fn rollback_below_seen_is_refused_and_seen_never_lowers() {
        // Seen 1.1.0 earlier: on core 0.1.0, 1.0.0 would be accepted but sits below seen.
        let seen = BTreeMap::from([("gemini".to_string(), "1.1.0".to_string())]);
        let (_, packs, blocked, seen_out) = ok(decide(&fixture(), "0.1.0", None, None, &seen, &all_installed(None)));
        assert!(packs.iter().all(|p| p.id != "gemini"));
        assert_eq!(blocked.iter().find(|b| b.id == "gemini").unwrap().release, "1.1.0");
        assert_eq!(seen_out["gemini"], "1.1.0");
        // Seen equal to the newest accepted entry: still offered.
        let (_, packs, _, _) = ok(decide(&fixture(), "0.2.0", None, None, &seen, &all_installed(None)));
        assert_eq!(packs.iter().find(|p| p.id == "gemini").unwrap().release, "1.1.0");
        // A higher seen is never lowered.
        let high = BTreeMap::from([("gemini".to_string(), "9.0.0".to_string())]);
        let (_, packs, _, seen_out) = ok(decide(&fixture(), "0.2.0", None, None, &high, &all_installed(None)));
        assert_eq!(seen_out["gemini"], "9.0.0");
        assert!(packs.iter().all(|p| p.id != "gemini"));
    }

    #[test]
    fn pack_with_a_non_array_value_is_skipped_and_the_rest_survive() {
        let body = FIXTURE.replace("\"voice-stock\": [", "\"voice-stock\": 7, \"pi\": [").replace("\"gemini\": [", "\"gemini\": [");
        let index = parse_index(body.as_bytes()).unwrap();
        let (core, packs, ..) = ok(decide(&index, "0.1.0", None, None, &BTreeMap::new(), &all_installed(None)));
        assert!(core.is_some());
        assert!(packs.iter().any(|p| p.id == "gemini"));
        assert!(packs.iter().all(|p| p.id != "voice-stock"));
    }

    #[test]
    fn pack_entry_without_a_url_gets_no_row() {
        let body = FIXTURE.replace("\"url\": \"https://github.com/DriftAeon/Vidar-Release/releases/download/pack-voice-stock-v1.0.1/pack-voice-stock-1.0.1.zip\",", "");
        let index = parse_index(body.as_bytes()).unwrap();
        let (_, packs, blocked, seen) = ok(decide(&index, "0.2.0", None, None, &BTreeMap::new(), &all_installed(None)));
        assert!(packs.iter().all(|p| p.id != "voice-stock") && blocked.iter().all(|b| b.id != "voice-stock"));
        assert!(!seen.contains_key("voice-stock"));
        assert!(packs.iter().any(|p| p.id == "gemini"));
    }

    #[test]
    fn core_page_is_pinned_to_this_repo() {
        let (core, ..) = ok(decide(&fixture(), "0.1.0", None, None, &BTreeMap::new(), &all_installed(None)));
        assert_eq!(core.unwrap().page, "https://github.com/DriftAeon/Vidar-Release/releases/tag/vidar-v0.2.0");
        let body = FIXTURE.replace(
            "https://github.com/DriftAeon/Vidar-Release/releases/tag/vidar-v0.2.0",
            "https://evil.example/DriftAeon/Vidar-Release/releases/tag/vidar-v0.2.0",
        );
        let index = parse_index(body.as_bytes()).unwrap();
        let (core, ..) = ok(decide(&index, "0.1.0", None, None, &BTreeMap::new(), &all_installed(None)));
        assert_eq!(core.unwrap().page, "");
        for bad in [
            "https://github.com/Other/Repo/releases/tag/v1",
            "http://github.com/DriftAeon/Vidar-Release/releases/tag/v1",
            "https://github.com/DriftAeon/Vidar-Release/releases/tag/",
            "https://github.com/DriftAeon/Vidar-Release/releases/download/index/index.json",
            "",
        ] {
            assert_eq!(pin_page(bad), "", "{bad}");
        }
    }

    #[test]
    fn fetch_outcomes_map_to_statuses() {
        let reply = |status: u16, body: &[u8]| Ok(Reply { status, retry_after: None, body: body.to_vec() });
        let never = |_: &Index| panic!("no decision");
        assert!(matches!(reply_for(reply(404, b""), never), CheckReply::NotPublished { .. }));
        assert!(matches!(reply_for(reply(500, b""), never), CheckReply::Error { .. }));
        assert!(matches!(reply_for(reply(200, b"<html>"), never), CheckReply::Error { .. }));
        assert!(matches!(reply_for(Err(SendError::Timeout), never), CheckReply::Offline { .. }));
        assert!(matches!(reply_for(Err(SendError::Connect("x".into())), never), CheckReply::Offline { .. }));
        assert!(matches!(reply_for(Err(SendError::Io("redirect to evil.example refused".into())), never), CheckReply::Error { .. }));
        let r = reply_for(reply(200, FIXTURE.as_bytes()), |i| decide(i, "0.1.0", None, None, &BTreeMap::new(), &|_| None));
        assert!(matches!(r, CheckReply::Ok { core: Some(_), .. }));
    }

    #[test]
    fn wire_shape_is_tagged_camel_case() {
        let v = serde_json::to_value(CheckReply::NotPublished { reason: "r".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "status": "notPublished", "reason": "r" }));
        let v = serde_json::to_value(decide(&fixture(), "0.2.0", None, None, &BTreeMap::new(), &|_| None)).unwrap();
        assert_eq!(v["status"], "ok");
        assert!(v["core"].is_null());
    }

    #[test]
    fn asset_page_links_the_tag() {
        let good = "https://github.com/DriftAeon/Vidar-Release/releases/download/t-v1/x.zip";
        assert_eq!(asset_page(good), "https://github.com/DriftAeon/Vidar-Release/releases/tag/t-v1");
        // Off-host asset, other repo, and off-shape assets give an empty page.
        for bad in [
            "https://example.com/DriftAeon/Vidar-Release/releases/download/t-v1/x.zip",
            "https://github.com/o/r/releases/download/t-v1/x.zip",
            "https://github.com/DriftAeon/Vidar-Release/releases/download/t-v1",
            "https://github.com/DriftAeon/Vidar-Release/releases/download//x.zip",
            "https://github.com/DriftAeon/Vidar-Release/releases/download/t-v1/",
            "https://example.com/x.zip",
            "",
        ] {
            assert_eq!(asset_page(bad), "", "{bad}");
        }
    }
}
