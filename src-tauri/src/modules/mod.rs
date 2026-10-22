//! src-tauri\src\modules\mod.rs — the module registry (docs/reference/modules.md, contract
//! v1 in contracts/modules.json). Core declarations come from the contract's `core[]`;
//! packs from `paths::packs_dir()\*\pack.json` (`scan`), each validated by `manifest`.
//! A pack that fails a rule is a `broken` row, never an error. Gateway declarations are
//! pinned on first sight in the voice slots pin store; a later change reads Broken
//! "Changed Since Pinned".
//!
//! A gateway module is trusted (listed in `modules`) only when its pin matched or its
//! first-sight pin was persisted in this `modules_list` call; a failed record reads Broken
//! "Pin Not Recorded". `modules_list` then writes the gateway snapshot (`snapshot`).
//!
//! IPC: `modules_list` (records first-sight pins), `module_art {id}` (PNG bytes) and
//! `module_trust_current {folder}` (re-pins a pack broken by "Changed Since Pinned").
//! `pack_deps` feeds deps.rs the active packs' `deps[]` (read-only: records no pins).
//! A release set beside the exe (`set`) leaves its excluded non-core modules out of every listing.

mod manifest;
mod scan;
mod set;
mod snapshot;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;

use manifest::Contract;
use scan::Scan;

const CONTRACT_JSON: &str = include_str!("../../../contracts/modules.json");

/// Cap on an icon read for `module_art`.
const MAX_ART_BYTES: u64 = 1024 * 1024;

fn contract() -> &'static Contract {
    static C: OnceLock<Contract> = OnceLock::new();
    // The contract is compiled in and a test parses it, so a failure here is a build defect.
    C.get_or_init(|| Contract::parse(CONTRACT_JSON).expect("contracts/modules.json parses"))
}

/// Longest user-set module name in code points (`limits.nameChars`), for the `moduleNames` validator.
pub(crate) fn name_chars() -> usize {
    contract().limits.name_chars
}

/// The contract's module id shape, for the `moduleNames` validator.
pub(crate) fn id_ok(id: &str) -> bool {
    manifest::id_ok(id)
}

fn pins_path() -> PathBuf {
    crate::paths::voice_slots_dir().join("pins.json")
}

/// The registry now. `record` stores first-sight gateway pins and rewrites the gateway
/// snapshot (only `modules_list` does). Read-only, a first-sight gateway is left out of
/// `modules` (`Scan::pending`), so it reaches no execution consumer.
fn list(record: bool) -> Scan {
    list_in(&crate::paths::packs_dir(), &pins_path(), &crate::paths::gateway_snapshot_path(), record)
}

fn list_in(packs: &Path, pins: &Path, snap: &Path, record: bool) -> Scan {
    let store = crate::voice_slots::pins::load(pins);
    let mut out = scan::scan(packs, contract(), &crate::deps::catalog_claims(), &store);
    // Before settle: a set-excluded gateway records no pin and joins no snapshot.
    if let Some(s) = set::current() {
        s.apply(&mut out);
    }
    if record {
        out.settle(|p| crate::voice_slots::pins::record(pins, p, false));
        if let Err(reason) = snapshot::write_or_withdraw(snap, &out) {
            // Fails closed: the old file is removed, so no launch runs on trust withdrawn since.
            eprintln!("modules: gateway snapshot not written: {reason}");
        }
    }
    out
}

/// Trust Current for the gateway pack in `folder`: only a pack broken by `Changed Since
/// Pinned` alone (`Scan::changed`) is re-pinned, from its declaration as scanned now. Any
/// other state is refused; those packs have to be fixed in the pack. The registry is then
/// listed with recording, so the gateway snapshot is rewritten.
fn trust_current_in(packs: &Path, pins: &Path, snap: &Path, folder: &str) -> Result<Scan, String> {
    let mut now = scan::scan(packs, contract(), &crate::deps::catalog_claims(), &crate::voice_slots::pins::load(pins));
    if let Some(s) = set::current() {
        s.apply(&mut now);
    }
    let Some((id, pin)) = now.changed.get(folder) else {
        return Err(format!("Pack {folder} Is Not Changed Since Pinned"));
    };
    crate::voice_slots::pins::record(pins, vec![(scan::pin_key(id), pin.clone())], true)?;
    Ok(list_in(packs, pins, snap, true))
}

/// Settings › Dependencies: Trust Current on a gateway pack row. Returns the new registry.
#[tauri::command]
pub async fn module_trust_current(folder: String) -> Result<Scan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        trust_current_in(&crate::paths::packs_dir(), &pins_path(), &crate::paths::gateway_snapshot_path(), &folder)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The registry now, read-only: records no gateway pins (for Rust callers such as a Flow run).
/// Gateway modules in it are trusted (pin matched); first-sight ones are not listed.
pub fn listed() -> Scan {
    list(false)
}

/// `{modules, broken}`: core modules, then packs by folder name.
#[tauri::command]
pub async fn modules_list() -> Result<Scan, String> {
    tauri::async_runtime::spawn_blocking(|| list(true)).await.map_err(|e| e.to_string())
}

/// PNG bytes of a listed pack module's `agent.art.icon`, re-checked on read.
#[tauri::command]
pub async fn module_art(id: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || art(&id).map(tauri::ipc::Response::new))
        .await
        .map_err(|e| e.to_string())?
}

fn art(id: &str) -> Result<Vec<u8>, String> {
    let reg = list(false);
    let m = reg.modules.iter().find(|m| m.decl.id == id).ok_or_else(|| format!("No Module {id}"))?;
    let (Some(folder), Some(icon)) = (&m.folder, m.decl.agent.as_ref().and_then(|a| a.art.as_ref())) else {
        return Err(format!("Module {id} Has No Art"));
    };
    let path = manifest::icon_path(&crate::paths::packs_dir().join(folder), &icon.icon)?;
    let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len > MAX_ART_BYTES {
        return Err(format!("Art Over {} KiB", MAX_ART_BYTES / 1024));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if !manifest::is_png(&bytes) {
        return Err(format!("Art Of {id} Is Not A PNG"));
    }
    Ok(bytes)
}

/// `deps[]` of every listed pack module, in registry order (deps.rs appends them to the report's `deps`).
pub fn pack_deps() -> Vec<Value> {
    list(false).modules.into_iter().filter(|m| m.source == "pack").flat_map(|m| m.decl.deps.unwrap_or_default()).collect()
}

#[cfg(test)]
mod tests {
    use super::manifest::{id_ok, ID_PATTERN};
    use super::scan::{pin_key, scan, Broken};
    use super::*;
    use crate::voice_slots::pins::Store;
    use std::collections::BTreeMap;
    use std::path::Path;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("modules")
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-modules-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_pack(root: &Path, id: &str, text: &str) {
        std::fs::create_dir_all(root.join(id)).unwrap();
        std::fs::write(root.join(id).join("pack.json"), text).unwrap();
    }

    fn catalog() -> crate::deps::CatalogClaims {
        crate::deps::catalog_claims()
    }

    #[test]
    fn modules_contract_parses_and_pins_the_id_pattern() {
        let c = contract();
        let raw: Value = serde_json::from_str(CONTRACT_JSON).unwrap();
        assert_eq!(raw["version"], 1, "the validator implements contract v1");
        assert_eq!(c.id_pattern, ID_PATTERN, "manifest::id_ok hand-codes this pattern");
        for (id, ok) in [("a", true), ("acme-2", true), ("1acme", false), ("Acme", false), ("a_b", false), ("", false)] {
            assert_eq!(id_ok(id), ok, "{id}");
        }
        assert!(id_ok(&"a".repeat(32)) && !id_ok(&"a".repeat(33)));
        // core[] is the compiled-in set: "core" plus the contract's pack levels (ce3b86dd put
        // required-hideable and optional surfaces in it).
        let allowed = |l: &str| l == "core" || c.pack_levels.iter().any(|p| p == l);
        assert!(c.core.iter().all(|m| allowed(&m.level) && id_ok(&m.id)));
        for id in ["relay", "speak", "auto-speak", "listen"] {
            let m = c.core.iter().find(|m| m.id == id).unwrap_or_else(|| panic!("{id} is in core[]"));
            assert_eq!(m.level, "core", "{id} stays a core-level module");
        }
        // No agent is core: codex and claude are packs.
        assert!(c.core.iter().all(|m| m.kind != "agent"), "core[] declares no agent");

    }

    #[test]
    fn modules_contract_rejects_a_core_entry_with_an_unknown_kind() {
        let mut raw: Value = serde_json::from_str(CONTRACT_JSON).unwrap();
        // core[0] is a surface (no agent is core): drop its kind block so the kind is what fails.
        raw["core"][0].as_object_mut().unwrap().remove("surface");
        raw["core"][0]["kind"] = Value::String("no-such-kind".into());
        let err = Contract::parse(&raw.to_string()).unwrap_err();
        assert!(err.contains("Unknown Kind"), "{err}");
    }

    /// The shipped packs (content/packs) scan clean, Claude and Codex among them as optional agent
    /// packs, Claude's Flow script one of its owns files, Claude set up before Codex.
    #[test]
    fn modules_shipped_packs_scan_clean_with_claude() {
        let packs = crate::paths::packs_dir();
        let mut got = scan(&packs, contract(), &catalog(), &Ok(Store::default()));
        got.settle(|_| Ok(()));
        assert!(got.broken.is_empty(), "{:?}", got.broken);
        let claude = got.modules.iter().find(|m| m.decl.id == "claude").expect("claude pack listed");
        assert_eq!((claude.source, claude.decl.level.as_str()), ("pack", "optional"));
        let agent = claude.decl.agent.as_ref().unwrap();
        assert_eq!(agent.flow.as_ref().map(|f| f.script.as_str()), Some("tools/claude-sidecar.mjs"));
        let order = |id: &str| got.modules.iter().find(|m| m.decl.id == id).and_then(|m| m.decl.agent.as_ref()?.setup.as_ref()?.order);
        assert!(order("claude") < order("codex") && order("claude").is_some(), "setup picks claude before codex");
        assert!(!c_core_has("claude"), "claude is no longer a core module");
        let codex = got.modules.iter().find(|m| m.decl.id == "codex").expect("codex pack listed");
        assert_eq!((codex.source, codex.decl.level.as_str(), codex.folder.as_deref()), ("pack", "optional", Some("codex")));
        assert!(!c_core_has("codex"), "codex is no longer a core module");
    }

    fn c_core_has(id: &str) -> bool {
        contract().core.iter().any(|m| m.id == id)
    }

    /// owns paths: repo-relative files or folders only; overlap is same path or folder-holds-path.
    #[test]
    fn modules_owns_path_rules() {
        use super::manifest::{owns_overlap, owns_path_ok};
        for ok in ["tools/a.mjs", "tools/falcon/", "profiles/bare/claude.json"] {
            assert!(owns_path_ok(ok), "{ok}");
        }
        for bad in ["", "/", "/abs.mjs", "C:/x.mjs", "tools\\a.mjs", "../a", "tools/../a", "tools/./a", "tools//a", "./a"] {
            assert!(!owns_path_ok(bad), "{bad}");
        }
        assert!(owns_overlap("tools/x/", "tools/x/y.mjs") && owns_overlap("tools/x/y.mjs", "tools/x/"));
        assert!(owns_overlap("tools/x", "tools/x/") && owns_overlap("a.mjs", "a.mjs"));
        assert!(!owns_overlap("tools/x/", "tools/xy.mjs") && !owns_overlap("tools/x.mjs", "tools/x.mjsx"));
        // Windows paths are case-insensitive: two packs claiming Tools/X/ and tools/x/ overlap.
        assert!(owns_overlap("Tools/X/", "tools/x/") && owns_overlap("TOOLS/x/y.mjs", "tools/X/"));
    }

    /// Every case in tests/fixtures/modules/ reaches the README's outcome, for the README's rule.
    #[test]
    fn modules_fixtures_agree_with_readme() {
        let root = fixtures();
        let readme = std::fs::read_to_string(root.join("README.md")).unwrap();
        let rows: BTreeMap<String, String> = readme
            .lines()
            .filter_map(|l| {
                let cells: Vec<&str> = l.split('|').map(str::trim).collect();
                (cells.len() >= 4 && matches!(cells[2], "accept" | "reject")).then(|| (cells[1].to_string(), cells[2].to_string()))
            })
            .collect();
        // The rule each reject case must fail on, so a case cannot pass by failing another rule.
        let reason: BTreeMap<&str, &str> = [
            ("bad-id-folder", "Does Not Match Folder"),
            ("bad-id-pattern", "Does Not Match ^"),
            ("bad-kind-unknown", "Is Not A Kind"),
            ("bad-kind-surface", "Is Reserved In v1"),
            ("bad-baseurl-http", "baseUrl Must Start https://"),
            ("bad-keyvar-template", "Is Not ACME_API_KEY"),
            ("bad-keyvar-anthropic", "Forbidden Prefix ANTHROPIC_"),
            ("bad-env-key", "Env Key ANTHROPIC_BASE_URL"),
            ("bad-dep-text", "Text Contains %"),
            ("bad-duplicate-id", "Duplicates A Core Module"),
            ("bad-dependson-cycle", "dependsOn Cycle"),
            ("bad-profiles-runner", "profiles.runner claude Is Not In dependsOn"),
            ("bad-oversize", "Over 8192 Bytes"),
            ("bad-gateway-env", "agent.gatewayEnv Is Not a Pack Key"),
            ("bad-flow-script", "agent.flow.script tools/elsewhere.mjs Is Not One of Its owns Files"),
            ("bad-owns-dotdot", "Is Not a Repo-Relative Path"),
            ("bad-owns-overlap", "Overlaps Module"),
        ]
        .into_iter()
        .collect();
        let mut cases: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        cases.sort();
        assert_eq!(cases, rows.keys().cloned().collect::<Vec<_>>(), "case folders and README rows differ");
        for case in &cases {
            let dir = root.join(case);
            let packs: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            let mut got = scan(&dir, contract(), &catalog(), &Ok(Store::default()));
            got.settle(|_| Ok(())); // first-sight gateways count as pinned here; pins have their own tests

            if rows[case] == "accept" {
                assert!(got.broken.is_empty(), "{case}: {:?}", got.broken);
                for p in &packs {
                    assert!(got.modules.iter().any(|m| m.folder.as_deref() == Some(p)), "{case}: {p} not listed");
                }
            } else {
                assert!(got.modules.iter().all(|m| m.source == "core"), "{case}: a pack was listed");
                assert_eq!(got.broken.len(), packs.len(), "{case}: {:?}", got.broken);
                let want = reason.get(case.as_str()).unwrap_or_else(|| panic!("{case}: no expected reason"));
                for b in &got.broken {
                    assert!(b.reason.contains(want), "{case}: {}", b.reason);
                }
            }
        }
    }

    fn gateway_pack(base_url: &str) -> String {
        std::fs::read_to_string(fixtures().join("ok-gateway").join("acme").join("pack.json"))
            .unwrap()
            .replace("https://api.acme.example/anthropic", base_url)
    }

    /// First sight pins; the same declaration matches; an edited one is Changed Since Pinned.
    #[test]
    fn modules_gateway_pin_catches_a_changed_declaration() {
        let root = temp("pin");
        let packs = root.join("mod-packs");
        let store_path = root.join("pins.json");
        write_pack(&packs, "acme", &gateway_pack("https://api.acme.example/anthropic"));
        let mut first = scan(&packs, contract(), &catalog(), &crate::voice_slots::pins::load(&store_path));
        assert_eq!(first.pending.len(), 1);
        first.settle(|pins| {
            assert_eq!(pins[0].0, pin_key("acme"));
            crate::voice_slots::pins::record(&store_path, pins, false)
        });
        assert!(first.modules.iter().any(|m| m.decl.id == "acme"), "a persisted first-sight pin is trusted");
        let again = scan(&packs, contract(), &catalog(), &crate::voice_slots::pins::load(&store_path));
        assert!(again.pending.is_empty() && again.broken.is_empty());
        assert!(again.modules.iter().any(|m| m.decl.id == "acme"));
        write_pack(&packs, "acme", &gateway_pack("https://elsewhere.example/anthropic"));
        let changed = scan(&packs, contract(), &catalog(), &crate::voice_slots::pins::load(&store_path));
        let unreadable = scan(&packs, contract(), &catalog(), &Err("pins.json: damaged".into()));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(changed.broken.len(), 1);
        assert_eq!(changed.broken[0].reason, "Changed Since Pinned");
        assert!(unreadable.broken.iter().any(|b| b.folder == "acme"), "an unreadable store fails closed");
    }

    /// Whether the serialized registry offers `acme-large` to Flow (flow/env.rs routes from
    /// the `modules` array of this same serialization).
    fn routes_acme(s: &Scan) -> bool {
        let v = serde_json::to_value(s).unwrap();
        v["modules"].as_array().unwrap().iter().any(|m| m["flowModels"].as_array().is_some_and(|f| f.iter().any(|e| e["id"] == "acme-large")))
    }

    fn snapshot_ids(s: &Scan) -> Vec<String> {
        let v: Value = serde_json::from_slice(&snapshot::render(s)).unwrap();
        v["gateways"].as_array().unwrap().iter().map(|g| g["id"].as_str().unwrap().to_string()).collect()
    }

    /// A first-sight gateway is not executable read-only, and a failed record keeps it out
    /// of the snapshot and of Flow routing as a Pin Not Recorded row.
    #[test]
    fn modules_unrecorded_pin_grants_no_trust() {
        let root = temp("unrecorded");
        write_pack(&root, "acme", &gateway_pack("https://api.acme.example/anthropic"));
        let read_only = scan(&root, contract(), &catalog(), &Ok(Store::default()));
        let mut failed = scan(&root, contract(), &catalog(), &Ok(Store::default()));
        failed.settle(|_| Err("disk full".into()));
        let _ = std::fs::remove_dir_all(&root);
        assert!(!routes_acme(&read_only), "listed() must not route a first-sight gateway");
        assert!(!routes_acme(&failed));
        assert!(snapshot_ids(&failed).is_empty());
        assert_eq!(failed.broken, vec![Broken { folder: "acme".into(), reason: "Pin Not Recorded".into() }]);
    }

    /// The written snapshot lists a pinned pack with the hash of its pack.json file, and a
    /// pack Changed Since Pinned drops out of it.
    #[test]
    fn modules_snapshot_lists_only_pinned_packs() {
        use sha2::{Digest, Sha256};
        let root = temp("snapshot");
        let packs = root.join("mod-packs");
        let store_path = root.join("pins.json");
        let snap = root.join("gateways.json");
        write_pack(&packs, "acme", &gateway_pack("https://api.acme.example/anthropic"));
        let mut first = scan(&packs, contract(), &catalog(), &crate::voice_slots::pins::load(&store_path));
        first.settle(|pins| crate::voice_slots::pins::record(&store_path, pins, false));
        assert_eq!(snapshot::write(&snap, &first), Ok(true));
        assert_eq!(snapshot::write(&snap, &first), Ok(false), "unchanged bytes skip the write");
        let listed: Value = serde_json::from_slice(&std::fs::read(&snap).unwrap()).unwrap();
        let file_sha: String = Sha256::digest(std::fs::read(packs.join("acme").join("pack.json")).unwrap()).iter().map(|b| format!("{b:02x}")).collect();
        write_pack(&packs, "acme", &gateway_pack("https://elsewhere.example/anthropic"));
        let mut changed = scan(&packs, contract(), &catalog(), &crate::voice_slots::pins::load(&store_path));
        changed.settle(|pins| crate::voice_slots::pins::record(&store_path, pins, false));
        assert_eq!(snapshot::write(&snap, &changed), Ok(true));
        let after: Value = serde_json::from_slice(&std::fs::read(&snap).unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let g = &listed["gateways"][0];
        assert_eq!((listed["version"].as_u64(), g["id"].as_str(), g["pack"].as_str()), (Some(1), Some("acme"), Some("acme")));
        assert_eq!(g["packSha256"].as_str(), Some(file_sha.as_str()));
        assert_eq!((g["baseUrl"].as_str(), g["keyVar"].as_str(), g["model"].as_str()), (Some("https://api.acme.example/anthropic"), Some("ACME_API_KEY"), Some("acme-large")));
        assert_eq!(g["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "acme-small");
        assert_eq!(after, serde_json::json!({ "version": 1, "gateways": [] }));
    }

    /// Rust's real snapshot for the fixture pack (id `acme`, pack.json with a UTF-8 BOM) equals
    /// tests/fixtures/modules-golden/gateways.json byte for byte. tests/vendor-golden-snapshot.test.mjs
    /// feeds the same two files to the real vendor-prepare.ps1, so the writer and the reader pin
    /// to one file. `VIDAR_REGEN_GOLDEN=1` rewrites both golden files from ok-gateway/acme.
    #[test]
    fn modules_snapshot_matches_the_golden_file() {
        let golden = fixtures().join("..").join("modules-golden");
        let source: Value = serde_json::from_slice(&std::fs::read(fixtures().join("ok-gateway").join("acme").join("pack.json")).unwrap()).unwrap();
        let mut pack_bytes = b"\xEF\xBB\xBF".to_vec();
        pack_bytes.extend(serde_json::to_vec(&source).unwrap());
        let regen = std::env::var_os("VIDAR_REGEN_GOLDEN").is_some();
        if regen {
            std::fs::create_dir_all(golden.join("acme")).unwrap();
            std::fs::write(golden.join("acme").join("pack.json"), &pack_bytes).unwrap();
        }
        let fixture_pack = std::fs::read(golden.join("acme").join("pack.json")).expect("golden pack.json");
        assert_eq!(fixture_pack, pack_bytes, "golden pack.json is stale: rerun with VIDAR_REGEN_GOLDEN=1");
        let root = temp("golden");
        std::fs::create_dir_all(root.join("acme")).unwrap();
        std::fs::write(root.join("acme").join("pack.json"), &fixture_pack).unwrap();
        let mut s = scan(&root, contract(), &catalog(), &Ok(Store::default()));
        s.settle(|_| Ok(()));
        let _ = std::fs::remove_dir_all(&root);
        assert!(s.broken.is_empty(), "{:?}", s.broken);
        let rendered = snapshot::render(&s);
        if regen {
            std::fs::write(golden.join("gateways.json"), &rendered).unwrap();
        }
        // A CRLF checkout (core.autocrlf) can turn the golden's LF into CRLF; the snapshot is LF.
        let golden_bytes: Vec<u8> = std::fs::read(golden.join("gateways.json")).expect("golden gateways.json").into_iter().filter(|b| *b != b'\r').collect();
        assert_eq!(rendered, golden_bytes, "snapshot differs from the golden file");
    }

    /// Trust Current on a pack Changed Since Pinned lists it again, and the rewritten snapshot
    /// holds the edited values.
    #[test]
    fn modules_trust_current_relists_an_edited_pack() {
        let root = temp("trust");
        let (packs, pins, snap) = (root.join("mod-packs"), root.join("pins.json"), root.join("gateways.json"));
        write_pack(&packs, "acme", &gateway_pack("https://api.acme.example/anthropic"));
        list_in(&packs, &pins, &snap, true);
        write_pack(&packs, "acme", &gateway_pack("https://elsewhere.example/anthropic"));
        let edited = list_in(&packs, &pins, &snap, true);
        let trusted = trust_current_in(&packs, &pins, &snap, "acme");
        let written: Value = serde_json::from_slice(&std::fs::read(&snap).unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(edited.broken, vec![Broken { folder: "acme".into(), reason: "Changed Since Pinned".into() }]);
        let trusted = trusted.unwrap();
        assert!(trusted.broken.is_empty() && trusted.modules.iter().any(|m| m.decl.id == "acme"));
        assert_eq!(written["gateways"][0]["baseUrl"], "https://elsewhere.example/anthropic");
    }

    /// Trust Current refuses a pack broken for any other reason, and records no pin for it.
    #[test]
    fn modules_trust_current_refuses_a_pattern_broken_pack() {
        let root = temp("trustbad");
        let (packs, pins, snap) = (root.join("mod-packs"), root.join("pins.json"), root.join("gateways.json"));
        write_pack(&packs, "acme", &gateway_pack("https://api.acme.example/anthropic").replace(r#""model": "acme-large""#, r#""model": "-acme""#));
        let got = trust_current_in(&packs, &pins, &snap, "acme");
        let pinned = pins.exists();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(got.err().as_deref(), Some("Pack acme Is Not Changed Since Pinned"));
        assert!(!pinned);
    }

    /// A different pin already stored, recorded without overwrite, grants no trust.
    #[test]
    fn modules_kept_different_pin_grants_no_trust() {
        let root = temp("keptpin");
        let store_path = root.join("pins.json");
        let other = crate::voice_slots::pins::Pin { bytes: 1, sha256: "00".into() };
        crate::voice_slots::pins::record(&store_path, vec![(pin_key("acme"), other)], true).unwrap();
        write_pack(&root, "acme", &gateway_pack("https://api.acme.example/anthropic"));
        // Scanned against an empty store, so acme is pending; the record then meets the stored pin.
        let mut s = scan(&root, contract(), &catalog(), &Ok(Store::default()));
        s.settle(|pins| crate::voice_slots::pins::record(&store_path, pins, false));
        let _ = std::fs::remove_dir_all(&root);
        assert!(!s.modules.iter().any(|m| m.decl.id == "acme"));
        assert_eq!(s.broken, vec![Broken { folder: "acme".into(), reason: "Pin Not Recorded".into() }]);
    }

    /// The gateway runner is the contract's runner.
    #[test]
    fn modules_gateway_runner_is_the_contract_runner() {
        let reason = acme_reason("runner", |t| t.replace(r#""runner": "claude""#, r#""runner": "codex""#));
        assert_eq!(reason, "Gateway Runner codex Is Not claude");
    }

    /// One pack listing a flowModels id twice is broken.
    #[test]
    fn modules_flow_model_declared_twice_in_one_pack() {
        let reason = acme_reason("flowtwice", |t| {
            let mut v: Value = serde_json::from_str(&t).unwrap();
            let models = v["module"]["flowModels"].as_array_mut().unwrap();
            models.push(models[0].clone());
            serde_json::to_string(&v).unwrap()
        });
        assert_eq!(reason, "Flow Model acme-large Is Declared Twice");
    }

    /// A snapshot write that fails once and then succeeds is written, not withdrawn.
    #[test]
    fn modules_snapshot_write_retries_once() {
        let root = temp("retry");
        write_pack(&root, "acme", &gateway_pack("https://api.acme.example/anthropic"));
        let mut s = scan(&root, contract(), &catalog(), &Ok(Store::default()));
        s.settle(|_| Ok(()));
        let snap = root.join("gateways.json");
        let got = snapshot::write_failing_n_for_test(&snap, &s, 1);
        let written = std::fs::read(&snap).ok();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(got, Ok(true));
        assert_eq!(written, Some(snapshot::render(&s)));
    }

    /// A flowModels id declared by two packs breaks both, whatever the folder order.
    #[test]
    fn modules_duplicate_flow_model_breaks_both() {
        let root = temp("flowdup");
        let acme = gateway_pack("https://api.acme.example/anthropic");
        write_pack(&root, "acme", &acme);
        write_pack(&root, "beta", &acme.replace(r#""id": "acme""#, r#""id": "beta""#).replace("ACME_API_KEY", "BETA_API_KEY").replace("acme-key", "beta-key"));
        let s = scan(&root, contract(), &Default::default(), &Ok(Store::default()));
        let _ = std::fs::remove_dir_all(&root);
        let got: Vec<(&str, &str)> = s.broken.iter().map(|b| (b.folder.as_str(), b.reason.as_str())).collect();
        assert_eq!(
            got,
            vec![("acme", "Flow Model acme-large Is Also Declared By beta"), ("beta", "Flow Model acme-large Is Also Declared By acme")]
        );
    }

    /// flowModels without an agent.gateway has no gateway to route to.
    #[test]
    fn modules_flow_models_need_a_gateway() {
        let root = temp("flownogw");
        write_pack(
            &root,
            "acme",
            r#"{ "id": "acme", "module": { "id": "acme", "label": "Acme", "level": "optional", "kind": "agent",
                "flowModels": [{ "id": "acme-large", "label": "Acme Large", "haiku": "acme-small", "maxContext": 200000 }] } }"#,
        );
        let s = scan(&root, contract(), &Default::default(), &Ok(Store::default()));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(s.broken.len(), 1);
        assert_eq!(s.broken[0].reason, "flowModels Needs agent.gateway");
    }

    /// The broken reason of the lone `acme` pack after `edit` rewrites its pack.json text.
    fn acme_reason(name: &str, edit: impl FnOnce(String) -> String) -> String {
        let root = temp(name);
        write_pack(&root, "acme", &edit(gateway_pack("https://api.acme.example/anthropic")));
        let s = scan(&root, contract(), &Default::default(), &Ok(Store::default()));
        let _ = std::fs::remove_dir_all(&root);
        s.broken.first().map(|b| b.reason.clone()).unwrap_or_default()
    }

    /// keyVarPattern: a name the template allows but the pattern does not (`a` gives A_API_KEY).
    #[test]
    fn modules_key_var_shape_is_enforced() {
        let root = temp("kvshape");
        let text = gateway_pack("https://api.acme.example/anthropic").replace("acme", "a").replace("ACME_API_KEY", "A_API_KEY");
        write_pack(&root, "a", &text);
        let s = scan(&root, contract(), &Default::default(), &Ok(Store::default()));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(s.broken.first().map(|b| b.reason.as_str()), Some("keyVar A_API_KEY Does Not Match keyVarPattern"));
    }

    /// modelPattern on gateway.model: empty and leading `-` are rejected.
    #[test]
    fn modules_model_shape_is_enforced() {
        let empty = acme_reason("modelempty", |t| t.replace(r#""model": "acme-large""#, r#""model": """#));
        assert_eq!(empty, "Model  Does Not Match modelPattern");
        let dash = acme_reason("modeldash", |t| t.replace(r#""model": "acme-large""#, r#""model": "-acme""#));
        assert_eq!(dash, "Model -acme Does Not Match modelPattern");
    }

    /// modelPattern on every env value whose key ends in _MODEL.
    #[test]
    fn modules_env_model_shape_is_enforced() {
        let reason = acme_reason("envmodel", |t| t.replace(r#""ANTHROPIC_DEFAULT_HAIKU_MODEL": "acme-small""#, r#""ANTHROPIC_DEFAULT_HAIKU_MODEL": "bad model""#));
        assert_eq!(reason, "Model bad model Does Not Match modelPattern");
    }

    /// A pack flowModels id from the core roster would shadow a core model.
    #[test]
    fn modules_core_flow_model_id_breaks_the_pack() {
        let reason = acme_reason("coremodel", |t| t.replace(r#""id": "acme-large", "label""#, r#""id": "codex-default", "label""#));
        assert_eq!(reason, "Flow Model codex-default Is A Core Model");
    }

    /// A failed snapshot write removes the old file: trust withdrawn stays withdrawn.
    #[test]
    fn modules_failed_snapshot_write_removes_the_old_file() {
        let root = temp("withdraw");
        write_pack(&root, "acme", &gateway_pack("https://api.acme.example/anthropic"));
        let mut s = scan(&root, contract(), &catalog(), &Ok(Store::default()));
        s.settle(|_| Ok(()));
        let snap = root.join("gateways.json");
        snapshot::write(&snap, &s).unwrap();
        assert!(snap.exists());
        let none = scan(&root, contract(), &catalog(), &Err("pins.json: damaged".into()));
        assert!(snapshot::write_failing_for_test(&snap, &none).is_err());
        let gone = !snap.exists();
        let _ = std::fs::remove_dir_all(&root);
        assert!(gone);
    }

    /// A keyVar the catalog or another module's dep probes is not the gateway's to use.
    #[test]
    fn modules_claimed_key_var_is_broken() {
        let root = temp("claim");
        write_pack(&root, "acme", &gateway_pack("https://api.acme.example/anthropic"));
        let by_catalog = scan(
            &root,
            contract(),
            &crate::deps::CatalogClaims { env_names: ["ACME_API_KEY".to_string()].into(), ..Default::default() },
            &Ok(Store::default()),
        );
        write_pack(
            &root,
            "other",
            r#"{ "id": "other", "module": { "id": "other", "label": "Other", "level": "optional", "kind": "content",
                "deps": [{ "id": "other-key", "label": "Other Key", "probe": { "kind": "env", "name": "ACME_API_KEY" } }] } }"#,
        );
        let by_module = scan(&root, contract(), &Default::default(), &Ok(Store::default()));
        let _ = std::fs::remove_dir_all(&root);
        assert!(by_catalog.broken[0].reason.contains("Claimed By The Dependency Catalog"), "{:?}", by_catalog.broken);
        assert_eq!(by_module.broken.len(), 1);
        assert_eq!(by_module.broken[0].folder, "acme");
        assert!(by_module.broken[0].reason.contains("Claimed By Module other"));
    }

    /// A catalog dep id belongs to the catalog; a repeated pack dep id belongs to its first pack.
    #[test]
    fn modules_duplicate_dep_id_is_broken() {
        let root = temp("duplicate-dep-id");
        let pack = |folder: &str, dep_id: &str| {
            serde_json::json!({
                "id": folder,
                "module": {
                    "id": folder,
                    "label": folder,
                    "level": "optional",
                    "kind": contract().implicit_pack_module.kind,
                    "deps": [{
                        "id": dep_id,
                        "label": "Test Dependency",
                        "probe": { "kind": "env", "name": format!("VIDAR_{folder}_TEST_KEY") }
                    }]
                }
            })
            .to_string()
        };
        write_pack(&root, "alpha", &pack("alpha", "git"));
        write_pack(&root, "beta", &pack("beta", "shared"));
        write_pack(&root, "gamma", &pack("gamma", "shared"));

        let s = scan(&root, contract(), &catalog(), &Ok(Store::default()));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(s.broken, [
            Broken { folder: "alpha".into(), reason: "Dep Id git Duplicates The Dependency Catalog".into() },
            Broken { folder: "gamma".into(), reason: "Dep Id shared Duplicates Pack beta".into() },
        ]);
        assert!(s.modules.iter().any(|m| m.folder.as_deref() == Some("beta")));
        assert!(s.modules.iter().all(|m| m.folder.as_deref() != Some("alpha") && m.folder.as_deref() != Some("gamma")));
    }

    /// The icon resolves inside the pack and is a PNG by signature.
    #[test]
    fn modules_icon_stays_inside_the_pack() {
        let root = temp("icon");
        let pack = |icon: &str| {
            format!(
                r#"{{ "id": "art", "module": {{ "id": "art", "label": "Art", "level": "optional", "kind": "agent",
                    "agent": {{ "art": {{ "icon": "{icon}" }} }} }} }}"#
            )
        };
        std::fs::create_dir_all(root.join("art").join("img")).unwrap();
        std::fs::write(root.join("art").join("img").join("tab.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        std::fs::write(root.join("art").join("img").join("fake.png"), b"GIF89a-not-png").unwrap();
        std::fs::write(root.join("outside.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        let mut got = Vec::new();
        for icon in ["img/tab.png", "../outside.png", "img/fake.png", "C:/Windows/x.png"] {
            write_pack(&root, "art", &pack(icon));
            let s = scan(&root, contract(), &Default::default(), &Ok(Store::default()));
            got.push(s.broken.first().map(|b| b.reason.clone()));
        }
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(got[0], None);
        assert!(got[1].as_deref().is_some_and(|r| r.contains("Not A Path Inside")), "{:?}", got[1]);
        assert!(got[2].as_deref().is_some_and(|r| r.contains("Is Not A PNG")), "{:?}", got[2]);
        assert!(got[3].as_deref().is_some_and(|r| r.contains("Not A Path Inside")), "{:?}", got[3]);
    }
}
