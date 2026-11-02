//! src-tauri\src\bare\vault\vidar.rs — the Vidar Runeset (library `vidar`, set `vidar`) every Rune Vault
//! carries at index 0. Membership lives in the shipped set `sets/vidar.md` of the Vidar library; the
//! vault's copy `sets/vidar--vidar.md` lists only the optional slots the user turned on. `members` is the
//! one function that answers which slots are on (a required one always, an optional one when the copy lists
//! it or an on slot `needs` it, transitively), so an unlocked vault resolves the shipped set live and a
//! rune added to the set after create appears with no op. Reads only; `Store` writes the copy through `toggle`.

use std::path::Path;

use crate::agent_spec::Agent;
use crate::bare::layer::{is_vidar_library, slot_in, VIDAR_LIBRARY, VIDAR_SET};
use crate::rules::library::Library;
use crate::rules::rune::{self, Rune, Surface};

use super::{content_sha, RuneRef, RunesetCopy, SetSource};

/// Delete/Remove Runeset on the reserved set.
pub(crate) const STAYS: &str = "The Vidar Runeset stays in every Rune Vault.";
/// A slot-off or remove on a required rune.
pub(crate) const REQUIRED: &str = "Vidar needs this rune to run.";

/// One slot of the Vidar Runeset, in set order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Slot {
    pub id: String,
    /// `required-by: vidar` on the rune: always on, never removable.
    pub required: bool,
    pub on: bool,
    /// The name of the first on slot that `needs` this one; `None` when none does.
    pub needed_by: Option<String>,
}

pub(crate) fn source() -> SetSource {
    SetSource { library: VIDAR_LIBRARY.into(), set: VIDAR_SET.into() }
}

/// Whether `s` is the reserved `vidar/vidar`.
pub(crate) fn is_reserved(s: &SetSource) -> bool {
    s.library == VIDAR_LIBRARY && s.set == VIDAR_SET
}

const HEAD: &str = "---\nname: vidar\nkind: set\nscope: [global]\ndescription: The optional slots of the Vidar Runeset this vault turned on\n---\n";

/// A copy with no optional slot on.
pub(crate) fn empty_copy() -> Vec<u8> {
    HEAD.as_bytes().to_vec()
}

/// The member list a lock freezes into `revs/<hash>/sets/vidar--vidar.md`: one `<?rune id?>` line per id, in order.
pub(crate) fn locked_list(ids: &[String]) -> Vec<u8> {
    let mut out = empty_copy();
    for id in ids {
        out.extend_from_slice(format!("<?rune {id}?>\n").as_bytes());
    }
    out
}

/// Whether a pin key (`<library>/<id>`) belongs to the Vidar library: such pins never report drift.
pub(crate) fn is_vidar_key(key: &str) -> bool {
    key.strip_prefix(VIDAR_LIBRARY).is_some_and(|r| r.starts_with('/'))
}

/// The refusal for a locked vault whose frozen Vidar Runeset (the list file as `vidar`, or a member body) is gone.
pub(crate) fn unreadable(id: &str) -> String {
    format!("Vidar Runeset rune `{id}` is unreadable; spawn refused.")
}

/// The reserved set's copy record and bytes for a vault being written (`now` is its `copiedUtc`).
pub(crate) fn reserved_copy(now: String) -> (RunesetCopy, Vec<u8>) {
    let bytes = empty_copy();
    let src = source();
    (RunesetCopy { file: format!("sets/{}--{}.md", src.library, src.set), source: src, copied_utc: now, source_hash: content_sha(&bytes) }, bytes)
}

/// The in-memory blank vault a probe launches on (`LaunchOpts.blank_vault`): the Vidar Runeset alone, no optional
/// slot on, so `members` yields the required slots only. Id `blank-<agent>` is its Codex or Claude home key.
/// Never stored or locked; `Store::resolve_at` reads it without touching disk.
pub(crate) fn blank_vault(agent: Agent) -> super::Vault {
    let (copy, bytes) = reserved_copy(crate::runlog::utc_stamp());
    let hash = super::vault_hash(&[(copy.source.clone(), content_sha(&bytes))], &[]);
    super::Vault {
        version: 1,
        id: format!("blank-{}", agent.as_str()),
        name: String::new(),
        created_utc: copy.copied_utc.clone(),
        from: None,
        runesets: vec![copy],
        runes: Vec::new(),
        locked_utc: None,
        locked_by: None,
        hash,
        pins: Default::default(),
        off: Vec::new(),
        off_sets: Vec::new(),
    }
}

/// Whether `v` is a `blank_vault` (never on disk).
pub(crate) fn is_blank(v: &super::Vault) -> bool {
    v.id.starts_with("blank-") && v.from.is_none() && v.runes.is_empty() && v.locked_utc.is_none()
}

/// The shipped set's runes in set order (any agent, any surface); empty when the library or set is absent.
fn shipped(root: &Path) -> Vec<Rune> {
    let Ok(lib) = Library::open(&crate::paths::rune_vidar_dir_in(root)) else { return Vec::new() };
    if lib.tombstone(VIDAR_SET).is_some() {
        return Vec::new();
    }
    let Some(set) = lib.entry(VIDAR_SET).ok().flatten().filter(|e| e.kind == "set").and_then(|e| lib.load(&e).ok()) else { return Vec::new() };
    let mut out: Vec<Rune> = Vec::new();
    for (l, id) in set.body.lines().filter_map(|l| slot_in(l, VIDAR_LIBRARY)) {
        if !is_vidar_library(l) || out.iter().any(|r| r.id == id) || lib.tombstone(id).is_some() {
            continue;
        }
        if let Some(r) = lib.entry(id).ok().flatten().and_then(|e| lib.load(&e).ok()) {
            out.push(r);
        }
    }
    out
}

/// The body of a set copy (header stripped, CR dropped).
fn body_of(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).replace('\r', "");
    rune::parse(&text).map(|r| r.body).unwrap_or(text)
}

/// The slot ids a copy lists, in file order.
fn listed(bytes: &[u8]) -> Vec<String> {
    body_of(bytes).lines().filter_map(|l| slot_in(l, VIDAR_LIBRARY)).filter(|(l, _)| is_vidar_library(l)).map(|(_, id)| id.to_string()).collect()
}

/// The Vidar Runeset's slots in set order that fit `agent` and `surface` (`None` filters nothing), each with
/// whether it is on for the copy `copy` (see the module doc) and which on slot needs it. A `needs` naming
/// a slot that does not fit is ignored.
pub(crate) fn members(root: &Path, copy: &[u8], agent: Option<Agent>, surface: Option<Surface>) -> Vec<Slot> {
    let runes: Vec<Rune> = shipped(root).into_iter().filter(|r| r.fits(agent, surface)).collect();
    let listed = listed(copy);
    let mut on: Vec<bool> = runes.iter().map(|r| r.required_by_vidar() || listed.contains(&r.id)).collect();
    loop {
        let mut grew = false;
        for i in 0..runes.len() {
            if !on[i] {
                continue;
            }
            for n in &runes[i].needs {
                if let Some(j) = runes.iter().position(|r| &r.id == n) {
                    if !on[j] {
                        on[j] = true;
                        grew = true;
                    }
                }
            }
        }
        if !grew {
            break;
        }
    }
    runes
        .iter()
        .enumerate()
        .map(|(j, r)| Slot {
            id: r.id.clone(),
            required: r.required_by_vidar(),
            on: on[j],
            needed_by: if on[j] { (0..runes.len()).find(|&i| i != j && on[i] && runes[i].needs.contains(&r.id)).map(|i| runes[i].id.clone()) } else { None },
        })
        .collect()
}

/// Whether `id` is a required slot of the shipped set.
pub(crate) fn is_required(root: &Path, id: &str) -> bool {
    shipped(root).iter().any(|r| r.id == id && r.required_by_vidar())
}

/// The set body an unlocked vault resolves and views for `copy`: one `<?rune id?>` line per on slot, in set order.
pub(crate) fn live_body(root: &Path, copy: &[u8]) -> String {
    members(root, copy, None, None).into_iter().filter(|s| s.on).map(|s| format!("<?rune {}?>\n", s.id)).collect()
}

/// `copy` with its slot lines replaced by `ids` (optional slots only, in set order); the header stays.
fn render(root: &Path, copy: &[u8], ids: &[String]) -> Vec<u8> {
    let text = String::from_utf8_lossy(copy).replace('\r', "");
    let mut head = String::new();
    let mut lines = text.split_inclusive('\n');
    if lines.next().is_some_and(|l| l.trim_end() == "---") {
        head.push_str("---\n");
        for l in lines {
            head.push_str(l);
            if l.trim_end() == "---" {
                break;
            }
        }
    }
    if !head.ends_with("---\n") || head == "---\n" {
        head = HEAD.to_string();
    }
    let body: String = members(root, copy, None, None).into_iter().filter(|s| !s.required && ids.contains(&s.id)).map(|s| format!("<?rune {}?>\n", s.id)).collect();
    format!("{head}{body}").into_bytes()
}

/// `copy` with optional slot `rune` turned on (with every slot it `needs`, transitively, listed too, so
/// turning the needing slot off later leaves them on) or off. A required slot refuses off; an on slot some
/// other on slot needs refuses off; a slot already in the asked state leaves the bytes as they are.
pub(crate) fn toggle(root: &Path, copy: &[u8], rune: &RuneRef, on: bool) -> Result<Vec<u8>, String> {
    if !is_vidar_library(&rune.library) {
        return Err(format!("`{}` is not a rune of the Vidar library", rune.key()));
    }
    let all = members(root, copy, None, None);
    let Some(slot) = all.iter().find(|s| s.id == rune.id) else {
        return Err(format!("`{}` is not a slot of the Vidar Runeset", rune.key()));
    };
    if slot.required {
        return if on { Ok(copy.to_vec()) } else { Err(REQUIRED.into()) };
    }
    let mut ids = listed(copy);
    if on {
        if ids.contains(&rune.id) {
            return Ok(copy.to_vec());
        }
        let runes = shipped(root);
        let mut todo = vec![rune.id.clone()];
        while let Some(id) = todo.pop() {
            if ids.contains(&id) {
                continue;
            }
            ids.push(id.clone());
            todo.extend(runes.iter().filter(|r| r.id == id).flat_map(|r| r.needs.clone()));
        }
        return Ok(render(root, copy, &ids));
    }
    if !slot.on {
        return Ok(copy.to_vec());
    }
    if let Some(n) = &slot.needed_by {
        return Err(format!("Needed by {n}."));
    }
    ids.retain(|i| i != &rune.id);
    Ok(render(root, copy, &ids))
}

/// The resolved runes a lock freezes for the Vidar Runeset, in `members()` order. An optional member with no
/// body is dropped; a required one refuses the lock (`unreadable`).
pub(crate) fn frozen_members<'a>(root: &Path, copy: &[u8], resolved: &'a [super::store::ResolvedRune]) -> Result<Vec<&'a super::store::ResolvedRune>, String> {
    let mut out = Vec::new();
    for slot in members(root, copy, None, None).into_iter().filter(|s| s.on) {
        match resolved.iter().find(|r| r.library == VIDAR_LIBRARY && r.id == slot.id) {
            Some(r) => out.push(r),
            None if slot.required => return Err(unreadable(&slot.id)),
            None => {}
        }
    }
    Ok(out)
}

/// Test fixtures: a Vidar library under `root` whose set holds one required rune `core`, so a vault built
/// there opens on a non-empty Vidar Runeset. Overwrites any file already there.
#[cfg(test)]
pub(crate) fn seed_core(root: &Path) {
    let dir = crate::paths::rune_vidar_dir_in(root);
    // The two setting runes point at the repo's shipped files by absolute path, since a temp root holds none.
    let shipped = crate::paths::rune_vidar_dir_in(&crate::paths::root()).join("settings");
    let setting = |name: &str, agent: &str, file: &str| {
        format!(
            "---\nname: {name}\nkind: setting\nscope: [global]\nagent: {agent}\nrequired-by: vidar\nsource: {}\ndescription: d\n---\n",
            shipped.join(file).display()
        )
    };
    for (rel, text) in [
        ("rules/core.md", "---\nname: core\nkind: rule\nscope: [global]\nrequired-by: vidar\ndescription: d\n---\nCore.\n".to_string()),
        ("settings/claude-settings.md", setting("claude-settings", "claude", "claude-settings.json")),
        ("settings/codex-config.md", setting("codex-config", "codex", "codex-config.toml")),
        ("sets/vidar.md", "---\nname: vidar\nkind: set\nscope: [global]\ndescription: d\n---\n<?rune core?>\n<?rune claude-settings?>\n<?rune codex-config?>\n".to_string()),
    ] {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
}
