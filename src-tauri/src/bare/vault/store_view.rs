//! src-tauri\src\bare\vault\store_view.rs — the Runes View read of a vault (`view_runes`, `blank_view`): a child of
//! `store`, so it reaches the store's private readers. Writes nothing.

use crate::bare::vault::store::*;

impl Store {
    /// Drift of `v` as read (a session's earlier revision carries its own pins); empty unless locked.
    pub fn view_drift(&self, v: &Vault) -> Result<Vec<RuneRef>, String> {
        if v.locked_utc.is_none() {
            return Ok(Vec::new());
        }
        self.drift_of(v)
    }

    /// The runes `v` loads, as the Runes View draws them: each runeset's slots in order, its
    /// `<?recall?>` members after them (sorted by id), then the one-offs, each once. `from_rev` reads the
    /// bodies and snapshots copied into `revs/<hash>/` (a locked vault, or a session's earlier
    /// revision); otherwise the libraries. Writes nothing. Item runes come back redacted; a missing copy
    /// or a file that does not parse is left out with a warning that names only its ref. The third list is
    /// what the vault holds switched off (never loaded), so Modify can draw them off: a copy's
    /// `recall-off` and `slot-off` members, then `Vault::off`; a body missing from the revision is read
    /// from its library.
    #[allow(clippy::type_complexity)]
    /// `agent` keeps only the Vidar Runeset members that fit it (`None` filters nothing).
    pub fn view_runes(&self, v: &Vault, from_rev: bool, drift: &[RuneRef], agent: Option<crate::agent_spec::Agent>) -> Result<(Vec<crate::bare::vault::ViewRune>, Vec<String>, Vec<crate::bare::vault::ViewRune>), String> {
        self.view_of(v, from_rev, drift, agent, false)
    }

    /// The Runes View of a new vault for `agent` (`rune_vault_read` with no id): the Vidar Runeset alone, no
    /// optional slot on, rendered by `view_of` as a fresh `create_at` vault would be. Nothing is written.
    pub fn blank_view(&self, agent: Option<crate::agent_spec::Agent>) -> Result<crate::bare::vault::VaultView, String> {
        let (copy, _) = crate::bare::vault::vidar::reserved_copy(now());
        let vault = Vault {
            version: 1,
            id: "blank".into(),
            name: String::new(),
            created_utc: copy.copied_utc.clone(),
            from: None,
            runesets: vec![copy],
            runes: Vec::new(),
            locked_utc: None,
            locked_by: None,
            hash: "0".repeat(12),
            pins: BTreeMap::new(),
            off: Vec::new(),
            off_sets: Vec::new(),
        };
        let (runes, warnings, off) = self.view_of(&vault, false, &[], agent, true)?;
        Ok(crate::bare::vault::VaultView { vault, drift: Vec::new(), runes, warnings, off })
    }

    /// `view_runes` for `agent` (the Vidar Runeset lists only the slots that fit it); `blank` reads the Vidar
    /// Runeset's copy as empty when `v` is not on disk (`blank_view`).
    #[allow(clippy::type_complexity)]
    fn view_of(&self, v: &Vault, from_rev: bool, drift: &[RuneRef], agent: Option<crate::agent_spec::Agent>, blank: bool) -> Result<(Vec<crate::bare::vault::ViewRune>, Vec<String>, Vec<crate::bare::vault::ViewRune>), String> {
        let (dir, rev) = (self.vault_dir(&v.id)?, self.rev_dir(&v.id, &v.hash)?);
        let rev = from_rev.then_some(rev.as_path());
        let drifted: HashSet<String> = drift.iter().map(RuneRef::key).collect();
        let mut libs: HashMap<String, Option<Library>> = HashMap::new();
        let mut sections: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
        let (mut out, mut seen, mut warnings, mut off) = (Vec::new(), HashSet::new(), Vec::new(), Vec::new());
        // Vidar Runeset slot id -> the on slot that needs it
        let mut needed: HashMap<String, String> = HashMap::new();
        let mut required: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut push = |set: Option<&SetSource>, lib: &str, id: &str, text: Option<String>, recall: bool, libs: &mut HashMap<String, Option<Library>>, out: &mut Vec<crate::bare::vault::ViewRune>, warnings: &mut Vec<String>| {
            let Some(text) = text else {
                warnings.push(format!("rune {lib}/{id} has no readable copy; left out"));
                return;
            };
            let section = sections.entry(lib.to_string()).or_insert_with(|| import_sections(libs.entry(lib.to_string()).or_insert_with(|| self.library(lib).ok()).as_ref())).get(id).cloned().unwrap_or_default();
            let path = libs.get(lib).and_then(|l| l.as_ref()).and_then(|l| Self::locate(l, id).ok().flatten()).map(|p| plain_path(&p)).unwrap_or_default();
            match view_rune(set, lib, id, &text, recall, section, drifted.contains(&format!("{lib}/{id}"))) {
                Some(mut r) => {
                    r.path = path;
                    out.push(r);
                }
                None => warnings.push(format!("rune {lib}/{id} does not parse; left out")),
            }
        };
        for c in &v.runesets {
            let reserved = crate::bare::vault::vidar::is_reserved(&c.source);
            let bytes = match rev {
                Some(r) => read(&r.join(&c.file)).or_else(|_| read(&dir.join(&c.file)))?,
                None if blank && reserved => crate::bare::vault::vidar::empty_copy(),
                None => read(&dir.join(&c.file))?,
            };
            let (body, scope) = set_body(&bytes);
            // the Vidar Runeset of a live vault lists the shipped set's slots that fit, on ones in the list,
            // optional ones that are not on in the off list
            let live = if reserved && rev.is_none() { Some(crate::bare::vault::vidar::members(&self.root, &bytes, agent, None)) } else { None };
            let own = c.source.library.as_str();
            let body = match &live {
                Some(slots) => slots.iter().filter(|s| s.on).map(|s| format!("<?rune {}?>\n", s.id)).collect(),
                // a locked list freezes every agent's members (vidar.rs `frozen_members`): read for one agent, it
                // keeps the ones whose frozen body fits that agent, by the same `Rune::fits`
                None if reserved && agent.is_some() => body
                    .lines()
                    .filter(|l| match slot_ref(l, own) {
                        Some((lib, id)) => self.view_body(&mut libs, rev, &lib, &id).and_then(|t| rune::parse(&t).ok()).is_none_or(|r| r.fits(agent, None)),
                        None => true,
                    })
                    .map(|l| format!("{l}\n"))
                    .collect(),
                None => body,
            };
            if let Some(slots) = &live {
                needed.extend(slots.iter().filter_map(|s| s.needed_by.clone().map(|n| (s.id.clone(), n))));
                required.extend(slots.iter().filter(|s| s.required).map(|s| s.id.clone()));
            }
            let slotted: Vec<(String, String)> = body.lines().filter_map(|l| slot_ref(l, own)).collect();
            for (lib, id) in &slotted {
                if crate::bare::vault::listed_once(&mut seen, &mut out, lib, id, &c.source) {
                    let text = self.view_body(&mut libs, rev, lib, id);
                    push(Some(&c.source), lib, id, text, false, &mut libs, &mut out, &mut warnings);
                }
            }
            if body.lines().any(|l| l == "<?recall?>") {
                let held = recall_off(&bytes);
                for (id, text) in self.view_recall(&mut libs, rev, v, own, &scope) {
                    if !held.contains(&id) && crate::bare::vault::listed_once(&mut seen, &mut out, own, &id, &c.source) {
                        push(Some(&c.source), own, &id, Some(text), true, &mut libs, &mut out, &mut warnings);
                    }
                }
                for id in &held {
                    let text = self.view_body(&mut libs, rev, own, id).or_else(|| self.view_body(&mut libs, None, own, id));
                    push(Some(&c.source), own, id, text, true, &mut libs, &mut off, &mut warnings);
                }
            }
            // slot members the copy switched off; one whose library rune is gone (Delete Rune) drops quietly
            let switched_off: Vec<(String, String)> = match &live {
                Some(slots) => slots.iter().filter(|s| !s.on).map(|s| (own.to_string(), s.id.clone())).collect(),
                None => slot_off(&bytes, own),
            };
            for (lib, id) in switched_off {
                if slotted.iter().any(|(l, i)| l == &lib && i == &id) {
                    continue;
                }
                if let Some(text) = self.view_body(&mut libs, rev, &lib, &id).or_else(|| self.view_body(&mut libs, None, &lib, &id)) {
                    push(Some(&c.source), &lib, &id, Some(text), false, &mut libs, &mut off, &mut warnings);
                }
            }
        }
        for r in &v.runes {
            if seen.insert(r.key()) {
                let text = self.view_body(&mut libs, rev, &r.library, &r.id);
                push(None, &r.library, &r.id, text, false, &mut libs, &mut out, &mut warnings);
            }
        }
        // one-offs switched off (Vault::off): listed off, never loaded; a rune gone from its library drops quietly
        for r in &v.off {
            if v.runes.contains(r) {
                continue;
            }
            if let Some(text) = self.view_body(&mut libs, rev, &r.library, &r.id).or_else(|| self.view_body(&mut libs, None, &r.library, &r.id)) {
                push(None, &r.library, &r.id, Some(text), false, &mut libs, &mut off, &mut warnings);
            }
        }
        // runesets switched off whole (Vault::off_sets): the library runeset's runes listed off under its head;
        // one gone from its library, or placed again, drops quietly
        for s in &v.off_sets {
            if v.runesets.iter().any(|c| &c.source == s) {
                continue;
            }
            let Ok((_, bytes)) = self.snapshot(s) else { continue };
            let (body, scope) = set_body(&bytes);
            let own = s.library.as_str();
            for (lib, id) in body.lines().filter_map(|l| slot_ref(l, own)) {
                if let Some(text) = self.view_body(&mut libs, None, &lib, &id) {
                    push(Some(s), &lib, &id, Some(text), false, &mut libs, &mut off, &mut warnings);
                }
            }
            if body.lines().any(|l| l == "<?recall?>") {
                for (id, text) in self.view_recall(&mut libs, None, v, own, &scope) {
                    push(Some(s), own, &id, Some(text), true, &mut libs, &mut off, &mut warnings);
                }
            }
        }
        for r in out.iter_mut().chain(off.iter_mut()) {
            if r.set.as_ref().is_some_and(crate::bare::vault::vidar::is_reserved) && crate::bare::layer::is_vidar_library(&r.library) {
                r.needed_by = needed.get(&r.id).cloned();
                r.required = required.contains(&r.id);
            }
        }
        Ok((out, warnings, off))
    }
}
