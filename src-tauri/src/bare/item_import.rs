//! src-tauri\src\bare\item_import.rs — the Runes view's attach: a path (skill, agent, hook, module) becomes an
//! item rune in a library under `runtime\runes\`, and nothing else. No sidecar and no set slot is written;
//! the view then adds each returned rune to its vault with a `member` edit (`rune_vault_edit`), so the
//! vault stays the only thing a session loads. Same file shapes as Add Kit (`kit.rs`).

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::Serialize;

use super::kit::{self, Dropped};
use super::set_layer::SetLayerWrite;

/// One rune the import wrote, or found already written with the same text.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ImportedRune {
    pub library: String,
    pub id: String,
    pub kind: String,
}

/// `bare_items_import`'s result: the runes to add as members, and the items left out with why.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ItemsImported {
    pub runes: Vec<ImportedRune>,
    pub dropped: Vec<Dropped>,
}

/// Every id a library already uses, from its item files' stems.
pub(super) fn used_ids(dir: &Path) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for sub in fs::read_dir(dir).into_iter().flatten().flatten().filter(|e| e.path().is_dir()) {
        for f in fs::read_dir(sub.path()).into_iter().flatten().flatten() {
            let p = f.path();
            if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("md")) {
                if let Some(s) = p.file_stem() {
                    out.insert(s.to_string_lossy().into_owned());
                }
            }
        }
    }
    out
}

pub(crate) fn import_at(imports: &Path, library: &str, layer: &SetLayerWrite, home: Option<&Path>) -> Result<ItemsImported, String> {
    let dir = kit::library_dir(imports, library)?;
    let (clean, mut dropped) = kit::check_items(layer, home);
    let mut used = used_ids(&dir);
    let mut plan: Vec<(std::path::PathBuf, String, ImportedRune)> = Vec::new();
    let mut taken = |base: &str, kind: &str, text_of: &dyn Fn(&str) -> Result<String, String>| -> Result<Option<(std::path::PathBuf, String, String)>, String> {
        let sub = if kind == "mcp" { "mcp".to_string() } else { format!("{kind}s") };
        let (mut id, mut n) = (base.to_string(), 2);
        loop {
            let text = text_of(&id)?;
            let path = dir.join(&sub).join(format!("{id}.md"));
            // The same text already filed under this id is the same rune: attach it, write nothing.
            if fs::read_to_string(&path).is_ok_and(|have| have == text) {
                return Ok(Some((path, text, id)));
            }
            if used.insert(id.clone()) {
                return Ok(Some((path, text, id)));
            }
            id = format!("{base}-{n}");
            n += 1;
        }
    };
    for (kind, base, agent, source, guard) in kit::collect_items(&clean) {
        match taken(&base, kind, &|id| kit::item_text(library, kind, id, agent, source, guard, home)) {
            Ok(Some((path, text, id))) => plan.push((path, text, ImportedRune { library: library.into(), id, kind: kind.into() })),
            Ok(None) => {}
            Err(reason) => dropped.push(Dropped { id: format!("{kind}/{base}"), reason }),
        }
    }
    if let Some(modules) = &clean.modules {
        let (catalog, _) = super::bundles::load(&crate::paths::root());
        for (module, tick) in modules {
            let Some(bundle) = catalog.bundles.get(module) else {
                dropped.push(Dropped { id: format!("module/{module}"), reason: "Unknown Module".into() });
                continue;
            };
            for mcp in &bundle.mcp {
                if tick.off.iter().any(|off| off == &format!("mcp:{}", mcp.name)) {
                    continue;
                }
                let base = kit::slug(&format!("{module}-{}", mcp.name));
                let agent = (mcp.agents.len() == 1).then(|| mcp.agents[0].as_str());
                match taken(&base, "mcp", &|id| kit::mcp_text(library, id, module, &mcp.name, agent)) {
                    Ok(Some((path, text, id))) => plan.push((path, text, ImportedRune { library: library.into(), id, kind: "mcp".into() })),
                    Ok(None) => {}
                    Err(reason) => dropped.push(Dropped { id: format!("mcp/{base}"), reason }),
                }
            }
            for item in kit::module_items(bundle, tick) {
                match taken(&item.id, item.kind, &|id| kit::item_text(library, item.kind, id, None, item.source.as_deref(), item.guard.as_ref(), home)) {
                    Ok(Some((path, text, id))) => plan.push((path, text, ImportedRune { library: library.into(), id, kind: item.kind.into() })),
                    Ok(None) => {}
                    Err(reason) => dropped.push(Dropped { id: format!("{}/{}", item.kind, item.id), reason }),
                }
            }
        }
    }
    let mut made = Vec::new();
    let result = (|| {
        for (path, text, _) in &plan {
            if path.exists() {
                continue;
            }
            fs::create_dir_all(path.parent().ok_or("Item has no folder")?).map_err(|_| "Cannot create item folder".to_string())?;
            kit::write_new(path, text)?;
            made.push(path.clone());
        }
        Ok::<(), String>(())
    })();
    if let Err(e) = result {
        for path in made {
            let _ = fs::remove_file(path);
        }
        return Err(e);
    }
    Ok(ItemsImported { runes: plan.into_iter().map(|(_, _, r)| r).collect(), dropped })
}

/// Imports the items of `layer` as item runes in `library` (the Runes view's attach); see the module header.
#[tauri::command]
pub fn bare_items_import(library: String, layer: SetLayerWrite) -> Result<ItemsImported, String> {
    import_at(&crate::paths::rune_imports_dir(), &library, &layer, crate::paths::home().as_deref())
}
