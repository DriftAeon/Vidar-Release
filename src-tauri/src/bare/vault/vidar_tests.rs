//! src-tauri\src\bare\vault\vidar_tests.rs — the Vidar Runeset every vault carries: live membership, the
//! reserved slot, the blank view and the store refusals.

use std::path::{Path, PathBuf};

use super::store::{EditMode, Op, Store};
use super::{vidar, MemberEdit, RuneRef, SetSource};
use crate::agent_spec::Agent;

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("vidar-vidar-set-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
    fn root(&self) -> &Path {
        &self.0
    }
    /// A file under the Vidar library.
    fn put(&self, rel: &str, text: &str) {
        let path = crate::paths::rune_vidar_dir_in(self.root()).join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    fn rune(&self, id: &str, extra: &str) {
        self.put(&format!("rules/{id}.md"), &format!("---\nname: {id}\nkind: rule\nscope: [global]\n{extra}description: d\n---\nBody of {id}.\n"));
    }
    fn set(&self, ids: &[&str]) {
        let lines: String = ids.iter().map(|i| format!("<?rune {i}?>\n")).collect();
        self.put("sets/vidar.md", &format!("---\nname: vidar\nkind: set\nscope: [global]\ndescription: d\n---\n{lines}"));
    }
    fn store(&self) -> Store {
        Store::open(self.root())
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// core (required), late-less set: gate, drive (codex), allow (needs drive).
fn fx(tag: &str) -> Tmp {
    let t = Tmp::new(tag);
    t.rune("core", "required-by: vidar\n");
    t.rune("gate", "");
    t.rune("drive", "agent: codex\n");
    t.rune("allow", "needs: [drive]\n");
    t.set(&["core", "gate", "drive", "allow"]);
    t
}

fn vref(id: &str) -> RuneRef {
    RuneRef { library: "vidar".into(), id: id.into() }
}

fn member(id: &str, on: bool) -> Op {
    Op::Member(MemberEdit { library: "vidar".into(), runeset: "vidar".into(), rune: vref(id), on })
}

fn create(t: &Tmp, name: &str) -> super::Vault {
    super::create_at(t.root(), Some(name.into()), None, &[], &[]).unwrap()
}

fn copy_of(t: &Tmp, v: &super::Vault) -> Vec<u8> {
    t.store().copy_bytes(v, &v.runesets[0]).unwrap()
}

fn on_ids(t: &Tmp, v: &super::Vault) -> Vec<String> {
    vidar::members(t.root(), &copy_of(t, v), None, None).into_iter().filter(|s| s.on).map(|s| s.id).collect()
}

fn resolved(t: &Tmp, id: &str) -> Vec<String> {
    t.store().resolve(id).unwrap().runes.into_iter().map(|r| r.id).collect()
}

fn edit(t: &Tmp, id: &str, ops: &[Op]) -> Result<super::Vault, String> {
    t.store().edit(id, ops, EditMode::Unlocked)
}

#[test]
fn a_required_rune_added_to_the_set_after_create_appears_with_no_op() {
    let t = fx("late");
    let v = create(&t, "Live");
    assert_eq!(resolved(&t, &v.id), vec!["core"]);
    t.rune("late", "required-by: vidar\n");
    t.set(&["core", "late", "gate", "drive", "allow"]);
    assert_eq!(resolved(&t, &v.id), vec!["core", "late"]);
    assert_eq!(t.store().get(&v.id).unwrap().hash, v.hash, "the vault itself did not change");
}

#[test]
fn members_keep_set_order_and_pass_the_fits_check() {
    let t = fx("fits");
    let all = |a: Option<Agent>| vidar::members(t.root(), &vidar::empty_copy(), a, None).into_iter().map(|s| s.id).collect::<Vec<_>>();
    assert_eq!(all(None), vec!["core", "gate", "drive", "allow"]);
    assert_eq!(all(Some(Agent::Claude)), vec!["core", "gate", "allow"], "a codex-only slot is left out for claude");
    let v = create(&t, "Fits");
    assert_eq!(v.runesets[0].source, vidar::source());
    assert_eq!(on_ids(&t, &v), vec!["core"]);
}

#[test]
fn the_blank_view_equals_the_view_of_a_fresh_create() {
    let t = fx("blank");
    let blank = t.store().blank_view(None).unwrap();
    let v = super::create_at(t.root(), Some("Fresh".into()), None, &[], &[]).unwrap();
    let fresh = super::read_view(&t.store(), Some(&v.id), None).unwrap();
    let json = |x: &super::VaultView| serde_json::to_value((&x.runes, &x.off, &x.warnings, &x.drift)).unwrap();
    assert_eq!(json(&blank), json(&fresh));
    assert_eq!(blank.vault.runesets.iter().map(|c| c.source.clone()).collect::<Vec<_>>(), vec![vidar::source()]);
    assert!(!crate::paths::rune_vaults_dir_in(t.root()).join("blank").exists(), "the blank view writes nothing");
    let none = super::read_view(&t.store(), None, None).unwrap();
    assert_eq!(json(&none), json(&blank));
    let claude = t.store().blank_view(Some(Agent::Claude)).unwrap();
    assert!(!claude.off.iter().any(|r| r.id == "drive"), "an agent filter leaves a codex-only slot out of the off list");
}

#[test]
fn a_required_slot_refuses_removal() {
    let t = fx("required");
    let v = create(&t, "Req");
    assert_eq!(edit(&t, &v.id, &[member("core", false)]).unwrap_err(), "Vidar needs this rune to run.");
    assert_eq!(edit(&t, &v.id, &[Op::RemoveRune(vref("core"))]).unwrap_err(), "Vidar needs this rune to run.");
    assert_eq!(
        edit(&t, &v.id, &[Op::RemoveRuneset(vidar::source())]).unwrap_err(),
        "The Vidar Runeset stays in every Rune Vault."
    );
    assert_eq!(on_ids(&t, &t.store().get(&v.id).unwrap()), vec!["core"]);
}

#[test]
fn turning_on_a_needing_slot_turns_on_what_it_needs_and_off_leaves_it_on() {
    let t = fx("needs");
    let v = create(&t, "Needs");
    let v = edit(&t, &v.id, &[member("allow", true)]).unwrap();
    assert_eq!(on_ids(&t, &v), vec!["core", "drive", "allow"]);
    // an on slot that another on slot needs cannot go off
    assert_eq!(edit(&t, &v.id, &[member("drive", false)]).unwrap_err(), "Needed by allow.");
    let view = super::read_view(&t.store(), Some(&v.id), None).unwrap();
    let row = |id: &str| view.runes.iter().find(|r| r.id == id).unwrap();
    assert_eq!(row("drive").needed_by.as_deref(), Some("allow"));
    assert_eq!(row("allow").needed_by, None);
    // turning the needing slot off leaves the needed one on
    let v = edit(&t, &v.id, &[member("allow", false)]).unwrap();
    assert_eq!(on_ids(&t, &v), vec!["core", "drive"]);
    assert_eq!(resolved(&t, &v.id), vec!["core", "drive"]);
    // and now it can go off too
    let v = edit(&t, &v.id, &[member("drive", false)]).unwrap();
    assert_eq!(on_ids(&t, &v), vec!["core"]);
    let view = super::read_view(&t.store(), Some(&v.id), None).unwrap();
    assert!(view.off.iter().any(|r| r.id == "drive") && view.off.iter().any(|r| r.id == "allow"), "off slots stay listed off");
}

#[test]
fn a_tab_read_draws_only_its_agents_members_live_and_locked() {
    let t = fx("tab-agent");
    t.rune("mine", "agent: claude\nrequired-by: vidar\n");
    t.set(&["core", "mine", "gate", "drive", "allow"]);
    let v = edit(&t, &create(&t, "Tab").id, &[member("allow", true)]).unwrap();
    let ids = |view: &super::VaultView| {
        let mut all: Vec<String> = view.runes.iter().chain(view.off.iter()).map(|r| r.id.clone()).collect();
        all.sort();
        all
    };
    let read = |hash: Option<&str>, a: Option<Agent>| super::read_view_for(&t.store(), Some(&v.id), hash, a).unwrap();
    assert_eq!(ids(&read(None, Some(Agent::Claude))), vec!["allow", "core", "gate", "mine"], "a claude tab draws no codex-only member");
    assert_eq!(ids(&read(None, Some(Agent::Codex))), vec!["allow", "core", "drive", "gate"], "a codex tab draws no claude-only member");
    assert_eq!(ids(&read(None, None)), vec!["allow", "core", "drive", "gate", "mine"], "no agent filters nothing");
    let locked = t.store().lock(&v.id, super::LockedBy::Button, &v.hash).unwrap();
    let on = |a: Agent| read(Some(&locked.hash), Some(a)).runes.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
    assert_eq!(on(Agent::Claude), vec!["core", "mine", "allow"], "a locked list read for claude drops the codex-only member");
    assert_eq!(on(Agent::Codex), vec!["core", "drive", "allow"], "a locked list read for codex drops the claude-only member");
}

#[test]
fn a_needs_the_copy_does_not_list_still_turns_the_slot_on() {
    let t = fx("transitive");
    let v = create(&t, "Trans");
    // a copy hand-listing `allow` alone: `drive` is on because `allow` needs it
    let copy = String::from_utf8(vidar::empty_copy()).unwrap() + "<?rune allow?>\n";
    let slots = vidar::members(t.root(), copy.as_bytes(), None, None);
    let on: Vec<_> = slots.iter().filter(|s| s.on).map(|s| s.id.as_str()).collect();
    assert_eq!(on, vec!["core", "drive", "allow"]);
    assert_eq!(slots.iter().find(|s| s.id == "drive").unwrap().needed_by.as_deref(), Some("allow"));
    assert_eq!(on_ids(&t, &v), vec!["core"]);
}

#[test]
fn a_need_is_met_only_by_runes_that_fit_the_agent() {
    let t = fx("needs-fit");
    // `allow` needs `drive`, a Codex rune: for Claude `drive` does not fit, so it is no slot, is not turned on
    // and names no needer, while `allow` itself stays on as listed
    let copy = String::from_utf8(vidar::empty_copy()).unwrap() + "<?rune allow?>\n";
    let claude = vidar::members(t.root(), copy.as_bytes(), Some(Agent::Claude), None);
    assert!(claude.iter().all(|s| s.id != "drive"), "a rune that does not fit is not a slot");
    assert_eq!(claude.iter().filter(|s| s.on).map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["core", "allow"]);
    assert!(claude.iter().all(|s| s.needed_by.is_none()));
    // for Codex `drive` fits, so the same need turns it on
    let codex = vidar::members(t.root(), copy.as_bytes(), Some(Agent::Codex), None);
    assert_eq!(codex.iter().find(|s| s.id == "drive").map(|s| (s.on, s.needed_by.clone())), Some((true, Some("allow".to_string()))));
}

#[test]
fn add_runeset_keeps_the_vidar_runeset_at_index_zero() {
    let t = fx("order");
    let lib = crate::paths::rune_imports_dir_in(t.root()).join("mine");
    std::fs::create_dir_all(lib.join("sets")).unwrap();
    std::fs::create_dir_all(lib.join("rules")).unwrap();
    std::fs::write(lib.join("rules/one.md"), "---\nname: one\nkind: rule\nscope: [global]\ndescription: d\n---\nOne.\n").unwrap();
    std::fs::write(lib.join("sets/base.md"), "---\nname: base\nkind: set\nscope: [global]\ndescription: d\n---\n<?rune one?>\n").unwrap();
    let mine = SetSource { library: "mine".into(), set: "base".into() };
    let v = super::create_at(t.root(), Some("Order".into()), None, &[mine.clone()], &[]).unwrap();
    let sources = |v: &super::Vault| v.runesets.iter().map(|c| c.source.clone()).collect::<Vec<_>>();
    assert_eq!(sources(&v), vec![vidar::source(), mine.clone()]);
    let w = create(&t, "Order Two");
    let w = edit(&t, &w.id, &[Op::AddRuneset(mine.clone())]).unwrap();
    assert_eq!(sources(&w), vec![vidar::source(), mine.clone()]);
    // adding it again, or the reserved set itself, moves nothing
    let w = edit(&t, &w.id, &[Op::AddRuneset(mine.clone()), Op::AddRuneset(vidar::source())]).unwrap();
    assert_eq!(sources(&w), vec![vidar::source(), mine]);
    assert_eq!(resolved(&t, &w.id), vec!["core", "one"]);
}

#[test]
fn create_from_a_vault_copies_its_optional_state_as_is() {
    let t = fx("from");
    let v = create(&t, "Source");
    let v = edit(&t, &v.id, &[member("gate", true)]).unwrap();
    let from = super::VaultFrom::Vault { vault: v.id.clone(), hash: v.hash.clone() };
    let copy = super::create_at(t.root(), None, Some(from), &[], &[]).unwrap();
    assert_eq!(copy.runesets.len(), 1);
    assert_eq!(on_ids(&t, &copy), vec!["core", "gate"]);
}

#[test]
fn delete_in_the_vidar_library_refuses() {
    let t = fx("delete");
    let e = crate::bare::library_delete::delete_in(t.root(), "vidar", "vidar").unwrap_err();
    assert!(e.contains("not an imported library"), "{e}");
    let e = crate::bare::library_delete::delete_in(t.root(), "vidar", "gate").unwrap_err();
    assert!(e.contains("not an imported library"), "{e}");
    assert!(crate::paths::rune_vidar_dir_in(t.root()).join("sets/vidar.md").is_file());
    assert!(super::library_sets::fixed(t.root(), "vidar"));
    assert!(!super::library_sets::fixed(t.root(), "mine"));
    let sets = t.store().library_runesets("claude");
    assert_eq!(sets.iter().find(|s| s.library == "vidar" && s.set == "vidar").map(|s| s.fixed), Some(true));
}

// ---- the locked path ----

use super::LockedBy;

const CORE_NEW: &str = "---\nname: core\nkind: rule\nscope: [global]\nrequired-by: vidar\ndescription: d\n---\nNew body.\n";

fn lock(t: &Tmp, v: &super::Vault) -> super::Vault {
    t.store().lock(&v.id, LockedBy::Button, &v.hash).unwrap()
}

fn bodies(t: &Tmp, id: &str) -> Vec<(String, String)> {
    t.store().resolve(id).unwrap().runes.into_iter().map(|r| (r.id, r.body)).collect()
}

fn rev_of(t: &Tmp, v: &super::Vault) -> PathBuf {
    crate::paths::rune_vaults_dir_in(t.root()).join(&v.id).join("revs").join(&v.hash)
}

#[test]
fn a_locked_vault_keeps_the_members_and_bodies_it_locked_with() {
    let t = fx("locked");
    let locked = lock(&t, &create(&t, "Frozen"));
    assert!(locked.pins.contains_key("vidar/core"));
    let other = create(&t, "Fresh");
    t.rune("late", "required-by: vidar\n");
    t.set(&["core", "late", "gate", "drive", "allow"]);
    t.put("rules/core.md", CORE_NEW);
    let old = bodies(&t, &locked.id);
    assert_eq!(old.iter().map(|(i, _)| i.as_str()).collect::<Vec<_>>(), vec!["core"]);
    assert!(old[0].1.contains("Body of core."));
    let new = bodies(&t, &other.id);
    assert_eq!(new.iter().map(|(i, _)| i.as_str()).collect::<Vec<_>>(), vec!["core", "late"]);
    assert!(new[0].1.contains("New body."));
    assert!(t.store().drift(&locked.id).unwrap().iter().all(|r| r.library != "vidar"), "no vidar drift");
}

#[test]
fn a_missing_frozen_body_or_list_refuses_resolve() {
    let t = fx("gone");
    let locked = lock(&t, &create(&t, "Frozen"));
    let rev = rev_of(&t, &locked);
    let body = rev.join("runes/vidar/core.md");
    let kept = std::fs::read(&body).unwrap();
    std::fs::remove_file(&body).unwrap();
    assert_eq!(t.store().resolve(&locked.id).unwrap_err(), "Vidar Runeset rune `core` is unreadable; spawn refused.");
    std::fs::write(&body, kept).unwrap();
    std::fs::remove_file(rev.join("sets/vidar--vidar.md")).unwrap();
    assert_eq!(t.store().resolve(&locked.id).unwrap_err(), "Vidar Runeset rune `vidar` is unreadable; spawn refused.");
}

#[test]
fn lock_writes_the_body_it_resolved_over_an_older_rev_file() {
    let t = fx("s1");
    let v = create(&t, "Frozen");
    assert!(bodies(&t, &v.id)[0].1.contains("Body of core."));
    t.put("rules/core.md", CORE_NEW);
    let locked = lock(&t, &v);
    assert!(bodies(&t, &locked.id)[0].1.contains("New body."));
    let rev = std::fs::read_to_string(rev_of(&t, &locked).join("runes/vidar/core.md")).unwrap();
    assert!(rev.contains("New body."));
}

#[test]
fn the_locked_member_order_is_the_members_order() {
    let t = fx("order");
    t.rune("zeta", "required-by: vidar\n");
    t.rune("alpha", "required-by: vidar\n");
    t.set(&["zeta", "core", "alpha"]);
    let v = create(&t, "Frozen");
    let want: Vec<String> = vidar::members(t.root(), &copy_of(&t, &v), None, None).into_iter().filter(|s| s.on).map(|s| s.id).collect();
    assert_eq!(want, vec!["zeta", "core", "alpha"]);
    let locked = lock(&t, &v);
    assert_eq!(resolved(&t, &locked.id), want);
}

#[test]
fn lock_refuses_a_required_member_with_no_body_and_drops_an_optional_one() {
    let t = fx("lock-unreadable");
    let v = edit(&t, &create(&t, "Frozen").id, &[member("gate", true)]).unwrap();
    let copy = copy_of(&t, &v);
    let body = |id: &str| super::store::ResolvedRune { library: "vidar".into(), id: id.into(), body: "b".into(), recall: false };
    // `lock` freezes what `frozen_members` returns; a resolve that lost `core` refuses it
    let e = vidar::frozen_members(t.root(), &copy, &[body("gate")]).unwrap_err();
    assert_eq!(e, "Vidar Runeset rune `core` is unreadable; spawn refused.");
    // an optional member whose body is gone is dropped
    let kept: Vec<String> = vidar::frozen_members(t.root(), &copy, &[body("core")]).unwrap().into_iter().map(|r| r.id.clone()).collect();
    assert_eq!(kept, vec!["core"]);
    assert!(t.store().lock(&v.id, super::LockedBy::Button, &v.hash).is_ok());
}

#[test]
fn the_blank_vault_resolves_as_a_fresh_blank_vault_does_and_is_never_stored() {
    let t = fx("blank-vault");
    let opts = crate::bare::LaunchOpts { blank_vault: true, ..Default::default() };
    let blank = crate::bare::launch_row::vault_for(t.root(), &opts, crate::bare::agent_homes::Agent::Codex).unwrap().unwrap();
    assert_eq!(blank.id, "blank-codex");
    assert!(blank.locked_utc.is_none());
    assert!(t.store().list().unwrap().is_empty(), "the blank vault is in memory only");
    let fresh = create(&t, "Fresh");
    let (a, b) = (t.store().resolve_at(&blank).unwrap(), t.store().resolve(&fresh.id).unwrap());
    assert_eq!(a.runes.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["core"], "the required members resolve");
    assert_eq!(a.runes, b.runes, "the probe's config equals a fresh blank vault's");
    assert_eq!(t.store().list().unwrap().len(), 1);
    assert!(t.store().create("Blank Codex", None, &[], &[]).is_err(), "blank- ids are reserved");
}

/// The shipped Vidar Runeset, read from the repo's own library.
fn shipped_store() -> Store {
    Store::open(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
}

#[test]
fn the_blank_view_marks_required_text_runes_and_lists_vidar_context_codex_for_codex_only() {
    let store = shipped_store();
    let claude = store.blank_view(Some(Agent::Claude)).unwrap();
    let id = claude.runes.iter().find(|r| r.id == "bare-identity").expect("bare-identity is a member");
    assert!(id.required, "a required text rune carries required");
    assert!(!claude.runes.iter().chain(claude.off.iter()).any(|r| r.id == "vidar-context-codex"));
    let codex = store.blank_view(Some(Agent::Codex)).unwrap();
    assert!(!codex.runes.iter().any(|r| r.id == "vidar-context-codex"), "optional, so unticked");
    assert!(codex.off.iter().any(|r| r.id == "vidar-context-codex"));
    assert!(!codex.runes.iter().chain(codex.off.iter()).any(|r| r.id == "vidar-context-rendered"));
}

#[test]
fn the_codex_identity_text_carries_no_control_cli() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let text = std::fs::read_to_string(crate::paths::rune_vidar_dir_in(root).join("rules/bare-identity-codex.md")).unwrap();
    assert!(!text.contains("vidar.mjs"));
}
