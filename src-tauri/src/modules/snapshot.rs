//! src-tauri\src\modules\snapshot.rs — the approved gateway snapshot (`contracts/paths.json`
//! `gatewaySnapshot`, docs/reference/modules.md § Gateway snapshot). Written by
//! `modules_list` and `module_trust_current` after the pin step, from the trusted gateway modules only (`Scan::modules`).
//! The gateway launcher (`tools/vendor/vendor-prepare.ps1`) takes its launch values from
//! this file and refuses an id that is absent or whose `pack.json` hash differs.
//!
//! Holds names only: built from declarations, never from the environment.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use super::scan::Scan;

const VERSION: u32 = 1;

#[derive(Serialize)]
struct Snapshot<'a> {
    version: u32,
    gateways: Vec<Entry<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry<'a> {
    id: &'a str,
    pack: &'a str,
    pack_sha256: &'a str,
    base_url: &'a str,
    key_var: &'a str,
    model: &'a str,
    env: BTreeMap<&'a str, &'a str>,
}

/// The snapshot bytes for the trusted gateway modules of `scan`, in registry order.
pub fn render(scan: &Scan) -> Vec<u8> {
    let gateways = scan
        .modules
        .iter()
        .filter_map(|m| {
            let g = m.decl.agent.as_ref()?.gateway.as_ref()?;
            Some(Entry {
                id: &m.decl.id,
                pack: m.folder.as_deref()?,
                pack_sha256: m.pack_sha256.as_deref()?,
                base_url: &g.base_url,
                key_var: &g.key_var,
                model: &g.model,
                env: g.env.iter().flatten().map(|(k, v)| (k.as_str(), v.as_str())).collect(),
            })
        })
        .collect();
    let mut bytes = serde_json::to_vec_pretty(&Snapshot { version: VERSION, gateways }).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}

/// Writes the snapshot to `path` (atomic: unique tmp, then rename), even when it lists no
/// gateway. Unchanged bytes skip the write. `Ok(true)` means the file was written. Production
/// writes go through `write_or_withdraw`.
#[cfg(test)]
pub fn write(path: &Path, scan: &Scan) -> Result<bool, String> {
    write_with(path, scan, crate::fsx::atomic_write)
}

/// `write` that fails closed: when the new snapshot cannot be written, the old file is
/// removed, because it may list a gateway whose trust has since been withdrawn (a damaged
/// pins.json, a newly claimed keyVar), and the launcher refuses when there is no file.
/// A failed write is retried once after `RETRY_DELAY` (a transient lock on the file, such as
/// a scanner or the launcher reading it) before the old file is withdrawn.
pub fn write_or_withdraw(path: &Path, scan: &Scan) -> Result<bool, String> {
    write_or_withdraw_with(path, scan, crate::fsx::atomic_write)
}

const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

fn write_or_withdraw_with(path: &Path, scan: &Scan, mut put: impl FnMut(&Path, &[u8]) -> Result<(), String>) -> Result<bool, String> {
    let written = write_with(path, scan, &mut put).or_else(|first| {
        eprintln!("modules: gateway snapshot write failed, retrying once: {first}");
        std::thread::sleep(RETRY_DELAY);
        write_with(path, scan, &mut put)
    });
    withdraw_on_error(path, written)
}

fn withdraw_on_error(path: &Path, written: Result<bool, String>) -> Result<bool, String> {
    if written.is_err() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("modules: old gateway snapshot not removed: {}: {e}", path.display()),
        }
    }
    written
}

fn write_with(path: &Path, scan: &Scan, put: impl FnOnce(&Path, &[u8]) -> Result<(), String>) -> Result<bool, String> {    let bytes = render(scan);
    if std::fs::read(path).is_ok_and(|old| old == bytes) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    put(path, &bytes)?;
    Ok(true)
}

#[cfg(test)]
pub fn write_failing_for_test(path: &Path, scan: &Scan) -> Result<bool, String> {
    write_or_withdraw_with(path, scan, |_, _| Err("disk full".into()))
}

/// `write_or_withdraw` whose writer fails `failures` times, then writes for real.
#[cfg(test)]
pub fn write_failing_n_for_test(path: &Path, scan: &Scan, failures: usize) -> Result<bool, String> {
    let mut left = failures;
    write_or_withdraw_with(path, scan, |p, b| {
        if left > 0 {
            left -= 1;
            return Err("locked".into());
        }
        crate::fsx::atomic_write(p, b)
    })
}
