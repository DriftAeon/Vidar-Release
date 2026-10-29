//! src-tauri\src\bare\copies_codex.rs — the Codex side of `copies.rs`: a Codex home's sync, its ledger as a
//! spawn would start from it, and the read-only skills listing. Split from copies.rs (module-size line).

use super::*;

/// The pre-W2 Codex ledger, `<home>\layer\codex-copies.json`: read once to seed a Codex home's own
/// ledger, never moved or written.
pub(super) const LEDGER: &str = "codex-copies.json";

/// A Codex home's sync (`sync_home`), returning the listing read from the installed copies
/// (`installed_listing`) in plan order instead of the folder names.
pub fn sync_codex(_lock: &HomeLock, home_dir: &Path, codex_home: &Path, plan: Plan, delete_gone: bool) -> (Vec<Listed>, Vec<String>) {
    let order = listed_order(&plan);
    let (ledger, mut warnings) = sync_dir(Agent::Codex, home_dir, codex_home, plan, delete_gone);
    let listed = installed_listing(&codex_home.join("skills"), &order, &ledger, &mut warnings);
    (listed, warnings)
}

/// A Codex home's ledger as a spawn would start from it, read-only: its own, else the seed.
fn codex_ledger_now(home_dir: &Path, codex_home: &Path) -> Ledger {
    let own = codex_home.join(HOME_LEDGER);
    match exists(&own) {
        true => read_ledger(&own).unwrap_or_default(),
        false => home_ledger_from_legacy(Agent::Codex, home_dir, codex_home).unwrap_or_default(),
    }
}

/// The listing a Codex spawn with no runesets would carry now, read-only (no lock, no sync, no ledger
/// write): the built-in skill, then whatever the empty resolve gives for Codex (`set_loadout::resolve`),
/// each listed only when the installed copy still matches the ledger, as after a sync.
pub fn listing_now(config: &Path, home_dir: &Path, codex_home: &Path) -> String {
    let root = crate::paths::root();
    let user_home = super::super::set_layer::user_home();
    let env = ResolveEnv { root: &root, config, home: home_dir, user_home: user_home.as_deref() };
    let (loadout, _) = super::super::set_loadout::resolve(&env, Agent::Codex, &[]);
    let order = listed_order(&plan_for(Agent::Codex, &codex_skills_in(&root, &loadout.skills), &[], Some(home_dir)));
    let ledger = codex_ledger_now(home_dir, codex_home);
    listing(&installed_listing(&codex_home.join("skills"), &order, &ledger, &mut Vec::new()))
}
