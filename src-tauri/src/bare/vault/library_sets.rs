//! src-tauri\src\bare\vault\library_sets.rs — the runesets the Rune Library groups by (`rune_vault_library_runes`
//! `.runesets`): every active, untombstoned set rune in the libraries a vault can use, with the refs of its members
//! (slot lines, then `<?recall?>` members of its own library whose scope it meets, as resolve takes them). A set
//! marked for another agent is left out, as `Store::library_runes` leaves out its runes. `fixed` marks a runeset
//! Delete Runeset refuses: one of the Vidar library or the rules library. Reads only.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use crate::rules::rune::State;

use super::store::Store;
use super::RuneRef;

/// One library runeset and its members, in body order.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryRuneset {
    pub library: String,
    pub set: String,
    pub members: Vec<RuneRef>,
    /// Delete Runeset refuses it (the Vidar library or the rules library).
    pub fixed: bool,
}

/// Whether `library` is one Delete Rune and Delete Runeset refuse: the Vidar library or the rules library
/// (`rulesLibrary` in vidar.json, by its folder name). Only an import library's runes and sets can go.
pub(crate) fn fixed(root: &Path, library: &str) -> bool {
    library == crate::bare::layer::VIDAR_LIBRARY || {
        let mut ignored = Vec::new();
        crate::bare::set_loadout::rules_library(&crate::paths::config_path_in(root), &mut ignored)
            .is_some_and(|rel| crate::bare::layer::library_name(&rel) == library)
    }
}

impl Store {
    /// The Rune Library's runesets for `agent`, libraries in `library_names` order and sets by id within each.
    /// A library that does not open is skipped here (`library_runes` warns for it).
    pub fn library_runesets(&self, agent: &str) -> Vec<LibraryRuneset> {
        let mut out = Vec::new();
        let agent = crate::agent_spec::parse(agent);
        for name in self.library_names() {
            let Ok(lib) = self.library(&name) else { continue };
            let fixed = fixed(self.root(), &name);
            let all = lib.all_runes().0;
            let mut sets: Vec<_> = all
                .iter()
                .map(|(r, _)| r)
                .filter(|r| r.kind == "set" && r.state == State::Active && lib.tombstone(&r.id).is_none() && r.fits(agent, None))
                .collect();
            sets.sort_by(|a, b| a.id.cmp(&b.id));
            sets.dedup_by(|a, b| a.id == b.id);
            for set in sets {
                let (mut seen, mut members) = (HashSet::new(), Vec::new());
                for line in set.body.lines() {
                    if line.trim() == "<?recall?>" {
                        let mut recall: Vec<&str> = all
                            .iter()
                            .map(|(r, _)| r)
                            .filter(|r| r.kind != "set" && r.activate == "recall" && r.state == State::Active && r.meets(&set.scope) && lib.tombstone(&r.id).is_none())
                            .map(|r| r.id.as_str())
                            .collect();
                        recall.sort();
                        for id in recall {
                            if seen.insert(format!("{name}/{id}")) {
                                members.push(RuneRef { library: name.clone(), id: id.to_string() });
                            }
                        }
                    } else if let Some((l, id)) = crate::bare::layer::slot_in(line, &name) {
                        if seen.insert(format!("{l}/{id}")) {
                            members.push(RuneRef { library: l.to_string(), id: id.to_string() });
                        }
                    }
                }
                out.push(LibraryRuneset { library: name.clone(), set: set.id.clone(), members, fixed });
            }
        }
        out
    }
}
