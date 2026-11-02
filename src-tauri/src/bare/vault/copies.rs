//! src-tauri\src\bare\vault\copies.rs — per-start copies of a vault (runes Q1 = a). A vault pick
//! never shares a vault: it starts `copy-<yymmdd>-<hhmmss>-<4 hex>`, drafted from the source's state, the
//! source's name and `from` naming the source at its hash. A copy shares its source's hash (content only).
//! The startup sweep deletes copies nothing uses; legacy `custom-*` vaults no session or pre-pick names go too.
//! Child module of `store` (the writer, drafts and vault folders stay private to it).

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{now, writer, Store};
use crate::bare::vault::{RuneRef, SetSource, Vault, VaultFrom};

/// A copy this young is never swept: a launch may be between its record and its first message.
const SWEEP_AFTER_MS: u64 = 24 * 60 * 60 * 1000;

/// `2026-10-31T12:31:00Z` as epoch milliseconds (civil to days, Hinnant).
fn utc_ms(s: &str) -> Option<u64> {
    let n: Vec<i64> = s.trim_end_matches('Z').split(['-', 'T', ':']).map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let [y, m, d, hh, mm, ss] = n[..] else { return None };
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from((days * 86_400 + hh * 3_600 + mm * 60 + ss) * 1000).ok()
}

/// `copy-<yymmdd>-<hhmmss>-<4 hex>` for the stamp `utc` (`2026-10-31T12:31:00Z`); `salt` varies the hex.
fn copy_id_at(utc: &str, salt: u64) -> String {
    use sha2::{Digest, Sha256};
    let digits: String = utc.chars().filter(char::is_ascii_digit).collect();
    let (date, time) = (digits.get(2..8).unwrap_or("000000"), digits.get(8..14).unwrap_or("000000"));
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let seed = format!("{nanos}-{salt}-{}-{:?}", std::process::id(), std::thread::current().id());
    let hex: String = Sha256::digest(seed.as_bytes()).iter().take(2).map(|b| format!("{b:02x}")).collect();
    format!("copy-{date}-{time}-{hex}")
}

static SALT: AtomicU64 = AtomicU64::new(0);

impl Store {
    /// A fresh vault drafted from `from` (at `at`, else its current hash) plus the picks not already in it.
    #[cfg(test)]
    pub(crate) fn start_copy(&self, from: &str, at: Option<&str>, runesets: &[SetSource], runes: &[RuneRef]) -> Result<Vault, String> {
        self.start_copy_in(from, at, runesets, runes, false)
    }

    /// A fresh unnamed vault with nothing but the Vidar Runeset at index 0 (no optional slot on), then the given
    /// runesets and runes in order (`vault::create_at` with no name and no `from`).
    pub(crate) fn start_blank(&self, runesets: &[SetSource], runes: &[RuneRef]) -> Result<Vault, String> {
        let _w = writer();
        let mut d = super::Draft { sets: Vec::new(), runes: Vec::new(), off: Vec::new(), off_sets: Vec::new() };
        let ops: Vec<super::Op> = runesets.iter().cloned().map(super::Op::AddRuneset).chain(runes.iter().cloned().map(super::Op::AddRune)).collect();
        self.apply(&mut d, &ops)?;
        d.reserve_vidar();
        self.write_copy("New Vault", None, d)
    }

    /// `start_copy`; `reserve` puts the Vidar Runeset at index 0 when the source has none (a vault `create_at` makes).
    pub(crate) fn start_copy_in(&self, from: &str, at: Option<&str>, runesets: &[SetSource], runes: &[RuneRef], reserve: bool) -> Result<Vault, String> {
        let _w = writer();
        let current = self.get(from)?;
        let hash = at.map(str::to_string).unwrap_or_else(|| current.hash.clone());
        let src = self.load_at(from, &hash)?;
        let mut d = self.draft_of(&self.state_dir(&src, &hash)?, &src)?;
        let ops: Vec<super::Op> = runesets.iter().cloned().map(super::Op::AddRuneset).chain(runes.iter().cloned().map(super::Op::AddRune)).collect();
        self.apply(&mut d, &ops)?;
        if reserve {
            d.reserve_vidar();
        }
        self.write_copy(&src.name, Some(VaultFrom::Vault { vault: from.to_string(), hash }), d)
    }

    /// Writes `d` as a new `copy-*` vault (the caller holds the writer).
    fn write_copy(&self, name: &str, from: Option<VaultFrom>, d: super::Draft) -> Result<Vault, String> {
        let stamp = now();
        for _ in 0..16 {
            let id = copy_id_at(&stamp, SALT.fetch_add(1, Ordering::Relaxed));
            if !self.vault_dir(&id)?.exists() {
                return self.write(&id, name, stamp, from, d);
            }
        }
        Err("no free copy id".into())
    }

    /// Startup: sweep unused copies, then clean legacy `custom-*` vaults. Each step fails closed alone.
    pub(crate) fn sweep_startup(&self, home_dir: Option<&Path>) -> Vec<String> {
        let mut lines = Vec::new();
        for r in [self.sweep_copies(home_dir, crate::fsx::now_ms()), self.clean_legacy_custom(home_dir)] {
            match r {
                Ok(gone) => lines.extend(gone.into_iter().map(|id| format!("removed {id}"))),
                Err(e) => lines.push(format!("vault sweep skipped: {e}")),
            }
        }
        lines
    }

    /// The ids every session record and the launcher pre-pick name. Any unreadable file aborts: a record
    /// that cannot be read might name the vault about to go.
    fn named(&self) -> Result<HashSet<String>, String> {
        let mut named = crate::bare::vault::session::named_vaults(&self.root)?;
        let defaults = crate::bare::vault::defaults_file(&self.root);
        if defaults.exists() {
            let d: crate::bare::vault::Defaults = crate::fsx::read_json(&defaults).map_err(|e| format!("{}: {e}", defaults.display()))?;
            named.extend(d.last_vault.into_values());
        }
        Ok(named)
    }

    /// Deletes `copy-*` vaults that are unlocked, named by no session record or pre-pick, and older than 24 h.
    /// Returns the ids removed.
    pub(crate) fn sweep_copies(&self, home_dir: Option<&Path>, now_ms: u64) -> Result<Vec<String>, String> {
        self.remove_where(home_dir, "copy-", |v, named| {
            v.locked_utc.is_none() && !named.contains(&v.id) && utc_ms(&v.created_utc).is_some_and(|c| now_ms.saturating_sub(c) >= SWEEP_AFTER_MS)
        })
    }

    /// Deletes legacy `custom-*` vaults no session record or pre-pick names and whose home holds no transcript;
    /// the named ones, and those a thread resumes on, stay.
    pub(crate) fn clean_legacy_custom(&self, home_dir: Option<&Path>) -> Result<Vec<String>, String> {
        self.remove_where(home_dir, "custom-", |v, named| {
            !named.contains(&v.id) && !home_dir.is_some_and(|h| crate::bare::agent_homes::vault_home_has_transcripts(h, &v.id))
        })
    }

    fn remove_where(&self, home_dir: Option<&Path>, prefix: &str, doomed: impl Fn(&Vault, &HashSet<String>) -> bool) -> Result<Vec<String>, String> {
        let _w = writer();
        let named = self.named()?;
        let mut gone = Vec::new();
        for l in self.list()?.into_iter().filter(|l| !l.template && l.id.starts_with(prefix)) {
            let Ok(v) = self.get(&l.id) else { continue };
            if !doomed(&v, &named) {
                continue;
            }
            let dir = self.vault_dir(&v.id)?;
            if std::fs::remove_dir_all(&dir).is_ok() {
                gone.push(v.id.clone());
            }
        }
        if let Some(home) = home_dir.filter(|_| !gone.is_empty()) {
            if let Ok(lock) = crate::bare::home::lock(home, std::time::Duration::from_secs(2)) {
                for id in &gone {
                    for a in crate::agent_spec::ALL {
                        crate::bare::agent_homes::remove_vault_home(a, &lock, home, id);
                    }
                }
            }
        }
        Ok(gone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stamp_reads_as_epoch_milliseconds_and_the_id_carries_it() {
        assert_eq!(utc_ms("1970-01-02T00:00:01Z"), Some(86_401_000));
        assert_eq!(utc_ms("2026-10-31T12:31:00Z"), Some(1_793_449_860_000));
        let id = copy_id_at("2026-10-31T12:31:00Z", 1);
        assert!(id.starts_with("copy-261031-123100-") && id.len() == "copy-261031-123100-".len() + 4, "{id}");
        assert!(crate::rules::rune::check_id(&id).is_ok());
    }
}
