//! src-tauri\src\bare\layer.rs — rune set refs built into a payload (Bare slice 1, W1). No launcher
//! row is read here (D1, run 2026-10-25-rune-vault): callers pass the refs; a `{ set }` ref resolves through `rulesLibrary`,
//! a `{ library, set }` ref through the import library `runtime\runes\<library>\` (onboarding D8).
//! Refs build in ref order through `build::build_in`; a repeated ref is built once, and a slot
//! whose rune id and body an earlier library already rendered is dropped from a later library's
//! set, with a warning (the same id with another body is another rule and stays). The built text fills `{{sets}}`
//! in the profile's `setsPayload`, gains a fresh marker and is written to
//! `<home>\layer\payload-<hash12>.md` under the home lock. Any failure refuses the spawn (BR3): a
//! library name outside the id grammar, with no folder or one resolving outside the import folder,
//! an unknown, tombstoned or non-set rune,
//! an empty build, a user-profile path in the text, or an unreadable vidar.json. No sets: nothing
//! here runs and `layer\` is never made. A Codex Bare spawn builds the same way from its own
//! `setsPayload` (the skills listing alone through `build_text_payload` when the row has no sets)
//! and hands the text to Codex as `developerInstructions` on `thread/start` or a `--profile` file, uncapped.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::home::{self, HomeLock};
use crate::rules::{build, context::RenderCtx, library::Library, rune::{self, Rune, State}};

/// One entry of a row's `sets`: an absent `library` means `rulesLibrary`.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SetRef {
    #[serde(default)]
    pub library: Option<String>,
    pub set: String,
}

/// What a row key resolves to: its sets in order and the config's `rulesLibrary`.
#[derive(Debug, Default)]
pub struct RowSets {
    pub sets: Vec<SetRef>,
    pub rules_library: Option<String>,
}

/// The library name a `rulesLibrary` folder goes by in a vault or a set ref: the folder's own name.
pub(crate) fn library_name(rel: &str) -> String {
    Path::new(rel).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| rel.to_string())
}

/// A built row payload, written under the home's `layer\`.
pub struct BuiltPayload {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
    pub marker: String,
    pub sets: Vec<String>,
    pub warnings: Vec<String>,
}

/// Builds `row`'s sets into `template` (the profile's `setsPayload` text) and writes the result
/// to `<home>\layer\payload-<hash12>.md`, hash12 the file's own SHA-256 prefix. Takes the caller's
/// `HomeLock` (it is not reentrant, so this never locks). Nothing is written unless every check
/// passes; a file already holding the same bytes is left as it is. `carried` is the guard file names
/// the home carries: a rune claiming an `enforced-by` file outside it is dropped with a warning.
/// Since run 2026-10-25-rune-vault (L2a) no spawn builds from a row: the vault's text renders in
/// `set_loadout::resolve_vault` and goes through `build_text_payload`. Kept for the set-render tests.
#[cfg(test)]
pub fn build_payload(_lock: &HomeLock, root: &Path, home_dir: &Path, template: &str, row: &RowSets, guard: &home::Guard, carried: &[String]) -> Result<BuiltPayload, String> {
    let ctx = RenderCtx::bare(carried.iter().cloned().collect());
    let (filled, ids, warnings) = row_text(template, row, &ctx, &|r| library_dir(root, row, r))?;
    let (path, bytes, marker) = write_filled(root, home_dir, &filled, guard)?;
    Ok(BuiltPayload { path, bytes, marker, sets: ids, warnings })
}

/// Where a ref's library folder is found; the spawn passes `library_dir`.
pub(crate) type Resolve<'a> = dyn Fn(&SetRef) -> Result<PathBuf, String> + 'a;

/// `template` with the copied skills listing folded in after `{{sets}}` (Codex; the listing rides after the
/// sets, before the marker); `template` as is when there is no listing.
pub(crate) fn with_skills(template: &str, skills: &str) -> String {
    if skills.is_empty() {
        template.to_string()
    } else {
        template.replace("{{sets}}", &format!("{{{{sets}}}}\n\n{}", skills.trim_end()))
    }
}

/// The text a spawn encodes for `row`, read-only (no home lock, nothing written): `template` (listing already
/// folded in by `with_skills`) with the built sets filled in, CRs dropped and the marker not yet added, then the
/// row's set ids and the build warnings. The spawn (`build_payload`) and the rune generator's size check both
/// call it, so the cross-library slot dedupe and the refusals are one path.
pub(crate) fn row_text(template: &str, row: &RowSets, ctx: &RenderCtx, resolve: &Resolve) -> Result<(String, Vec<String>, Vec<String>), String> {
    let slots = template.matches("{{sets}}").count();
    if slots != 1 {
        return Err(format!("Bare sets payload template holds {{{{sets}}}} {slots} times, not once; Bare spawn refused"));
    }
    let (sets_text, ids, warnings) = build_sets(row, ctx, resolve)?;
    if sets_text.trim().is_empty() {
        return Err(format!("Rune sets {} built empty; Bare spawn refused", ids.join(", ")));
    }
    Ok((template.replace('\r', "").replace("{{sets}}", sets_text.trim_end()), ids, warnings))
}

/// A Codex Bare payload with no rune sets: `template`'s `{{sets}}` filled with `text` (the skills
/// listing), marked and written to `<home>\layer\` as `build_payload` writes a built one.
pub fn build_text_payload(_lock: &HomeLock, root: &Path, home_dir: &Path, template: &str, text: &str, guard: &home::Guard) -> Result<BuiltPayload, String> {
    let slots = template.matches("{{sets}}").count();
    if slots != 1 {
        return Err(format!("Bare sets payload template holds {{{{sets}}}} {slots} times, not once; Bare spawn refused"));
    }
    let (path, bytes, marker) = write_filled(root, home_dir, &template.replace('\r', "").replace("{{sets}}", text.trim_end()), guard)?;
    Ok(BuiltPayload { path, bytes, marker, sets: Vec::new(), warnings: Vec::new() })
}

/// Marks a filled template and writes it to `<home>\layer\payload-<hash12>.md` (the caller holds
/// the home lock): the path, the bytes and the marker.
fn write_filled(root: &Path, home_dir: &Path, filled: &str, guard: &home::Guard) -> Result<(PathBuf, Vec<u8>, String), String> {
    // Body as `payload_marker` hashes it: CRs dropped, LF-joined lines plus a final LF.
    let body: String = filled.trim_end().lines().map(|l| format!("{l}\n")).collect();
    let marker = format!("VIDAR-PAYLOAD-{}", build::hash12(body.as_bytes()));
    let text = format!("{body}{marker}\n");
    let (got, expected) = super::payload_marker(&text)?;
    if got != expected {
        return Err(format!("Bare payload marker {got} does not match {expected}; Bare spawn refused"));
    }
    let (root_s, home_s) = (root.to_string_lossy(), home_dir.to_string_lossy());
    let no_name = home::Guard { user_profile: guard.user_profile.clone(), username: None };
    home::guard_strings(&[text.as_str()], &root_s, &home_s, &no_name, "Bare row payload").map_err(|e| format!("{e}; Bare spawn refused"))?;

    let bytes = text.into_bytes();
    let layer = home_dir.join("layer");
    std::fs::create_dir_all(&layer).map_err(|e| format!("Bare layer {}: {e}; Bare spawn refused", layer.display()))?;
    let path = layer.join(format!("payload-{}.md", build::hash12(&bytes)));
    // Content-addressed: a file of this name with these bytes is already the payload.
    if std::fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
        crate::fsx::atomic_write(&path, &bytes).map_err(|e| format!("Bare row payload {}: {e}; Bare spawn refused", path.display()))?;
    }
    Ok((path, bytes, marker))
}

/// A ref's library folder: `rulesLibrary` (under the root) when the ref names none, else
/// `runtime\runes\<library>\`, the name passing the rune id grammar and the folder existing and,
/// canonical, sitting under the canonical import folder (a junction pointing out refuses).
pub(crate) fn library_dir(root: &Path, row: &RowSets, r: &SetRef) -> Result<PathBuf, String> {
    let Some(name) = r.library.as_deref() else {
        let rel = row.rules_library.as_deref().ok_or("Rune sets need rulesLibrary in vidar.json; Bare spawn refused")?;
        return Ok(root.join(rel));
    };
    // `stock` is reserved for the shipped stock library, as `tools/runes/lint.mjs` maps it.
    if name == "stock" {
        return Ok(crate::paths::rune_stock_dir_in(root));
    }
    if rune::check_id(name).is_err() {
        return Err(format!(
            "Rune set {:?} names library {name:?}, which is not a library name (lowercase letters, digits and single hyphens); Bare spawn refused",
            r.set
        ));
    }
    let base = crate::paths::rune_imports_dir_in(root);
    let rel = base.strip_prefix(root).unwrap_or(&base).join(name);
    let none = || format!("Rune set {:?} names library {name:?}, which has no folder at {}; Bare spawn refused", r.set, rel.display());
    let dir = base.join(name).canonicalize().map_err(|_| none())?;
    if !dir.is_dir() {
        return Err(none());
    }
    if !base.canonicalize().is_ok_and(|b| dir.starts_with(b)) {
        return Err(format!(
            "Rune set {:?} names library {name:?}, whose folder {} resolves outside {}; Bare spawn refused",
            r.set,
            rel.display(),
            base.strip_prefix(root).unwrap_or(&base).display()
        ));
    }
    Ok(dir)
}

/// A library by name, as a vault names it (run 2026-10-25-rune-vault, L2a; the vault store's resolver):
/// `stock` is the shipped stock library; any other name is `runtime\runes\<name>\` when that folder
/// exists (kit, `gen-*`; canonical and inside the import folder, as `library_dir`), else the library
/// vidar.json's `rulesLibrary` names by its folder name (`library_name`).
pub(crate) fn library_dir_named(root: &Path, name: &str) -> Result<PathBuf, String> {
    rune::check_id(name).map_err(|e| format!("library {name:?}: {e}"))?;
    if name == "stock" {
        return Ok(crate::paths::rune_stock_dir_in(root));
    }
    let base = crate::paths::rune_imports_dir_in(root);
    if base.join(name).exists() {
        let dir = base.join(name).canonicalize().map_err(|_| format!("library {name:?} has no folder"))?;
        if !dir.is_dir() || !base.canonicalize().is_ok_and(|b| dir.starts_with(b)) {
            return Err(format!("library {name:?} resolves outside the imports folder"));
        }
        return Ok(dir);
    }
    let config = crate::paths::config_path_in(root);
    let mut ignored = Vec::new();
    match super::set_loadout::rules_library(&config, &mut ignored) {
        Some(rel) if library_name(&rel) == name => Ok(root.join(rel)),
        _ => Err(format!("library {name:?} has no folder")),
    }
}

/// A ref's library as messages name it.
fn label(name: Option<&str>) -> &str {
    name.unwrap_or("rulesLibrary")
}

/// Every ref built in ref order and joined as `build::build` joins one library's ids (trimmed
/// parts, a blank line between, a final LF): the text, the row's sets (`<library>/<set>`, or the
/// bare set id for `rulesLibrary`), the warnings. Build errors are collected across refs, so one
/// refusal names them all.
fn build_sets(row: &RowSets, ctx: &RenderCtx, resolve: &Resolve) -> Result<(String, Vec<String>, Vec<String>), String> {
    let mut libs: Vec<(Option<&str>, Library)> = Vec::new();
    let mut done: Vec<&SetRef> = Vec::new();
    // Rune id -> the library (by ref name) whose set rendered it first.
    let mut placed: Vec<(String, Option<&str>, Option<String>)> = Vec::new();
    let (mut parts, mut ids, mut warnings, mut errors) = (Vec::<String>::new(), Vec::new(), Vec::new(), Vec::new());
    for r in &row.sets {
        ids.push(match &r.library {
            Some(l) => format!("{l}/{}", r.set),
            None => r.set.clone(),
        });
        if done.contains(&r) {
            continue;
        }
        done.push(r);
        let name = r.library.as_deref();
        let i = match libs.iter().position(|(n, _)| *n == name) {
            Some(i) => i,
            None => {
                let lib = Library::open(&resolve(r)?).map_err(|e| format!("Rune sets: {e}; Bare spawn refused"))?;
                libs.push((name, lib));
                libs.len() - 1
            }
        };
        let lib = &libs[i].1;
        if let Ok(Some(entry)) = lib.entry(&r.set) {
            if entry.kind != "set" {
                return Err(format!("Rune {:?} is a {}, not a set; Bare spawn refused", r.set, entry.kind));
            }
        }
        let set = load_set(lib, &r.set);
        let mut sub = ctx.clone();
        // Libraries the set's `<?rune lib/id?>` slots name, resolved as a ref naming them would be.
        for m in set.as_ref().map(|(_, slots)| slots.as_slice()).unwrap_or_default() {
            if let Some((Some(other), _)) = split_slot(m) {
                if !sub.libraries.contains_key(other) {
                    let dir = resolve(&SetRef { library: Some(other.to_string()), set: r.set.clone() })?;
                    sub.libraries.insert(other.to_string(), dir);
                }
            }
        }
        for m in set.as_ref().map(|(_, slots)| slots.as_slice()).unwrap_or_default() {
            // Same id and same body is one rule held twice; the same id with another body is another rule.
            let body = member(lib, &sub, m).map(|r| r.body);
            if let Some((_, by, _)) = placed.iter().find(|(id, by, b)| id == m && *by != name && *b == body) {
                if sub.skip.insert(m.clone()) {
                    warnings.push(format!(
                        "`{m}` in {} set `{}` was dropped: {} already placed it",
                        label(name),
                        r.set,
                        label(*by)
                    ));
                }
            }
        }
        match build::build_in(lib, std::slice::from_ref(&r.set), &sub) {
            Ok(b) => {
                warnings.extend(b.warnings);
                let text = String::from_utf8_lossy(&b.bytes).replace('\r', "");
                if !text.trim().is_empty() {
                    parts.push(text.trim().to_string());
                }
            }
            Err(f) => errors.extend(f.errors),
        }
        for m in set.map(|(s, slots)| rendered(lib, &s, &slots, &sub)).unwrap_or_default() {
            let body = member(lib, &sub, &m).map(|r| r.body);
            if !placed.iter().any(|(id, _, b)| *id == m && *b == body) {
                placed.push((m, name, body));
            }
        }
    }
    if !errors.is_empty() {
        return Err(format!("Rune sets failed to build: {}; Bare spawn refused", errors.join("; ")));
    }
    let text = if parts.is_empty() { String::new() } else { parts.join("\n\n") + "\n" };
    Ok((text, ids, warnings))
}

/// The slot token a set line holds, by the README slot grammar (`set.rs` `slot`): the whole token, so
/// a cross-library slot reads `lib/id` and never equals a bare id. `slot_ref` splits it.
pub(crate) fn slot_id(line: &str) -> Option<&str> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    let rest = ["- ", "* "]
        .iter()
        .find_map(|p| line.strip_prefix(p))
        .or_else(|| (digits > 0).then(|| line[digits..].strip_prefix(". ")).flatten())
        .unwrap_or(line);
    let id = rest.strip_prefix("<?rune ")?.strip_suffix("?>")?;
    (!id.is_empty() && !id.contains(|c: char| c.is_whitespace() || "?<>".contains(c))).then_some(id)
}

/// A slot token as (library, id): `lib/id` names library `lib`, a bare id is the set's own library
/// (`None`). `None` for any other shape (an empty part, a second `/`). Names are not checked here:
/// the resolver refuses a library or id outside the rune id grammar (twin of `render.mjs` `slotRef`).
pub(crate) fn split_slot(token: &str) -> Option<(Option<&str>, &str)> {
    match token.split_once('/') {
        None => Some((None, token)),
        Some((lib, id)) if !lib.is_empty() && !id.is_empty() && !id.contains('/') => Some((Some(lib), id)),
        Some(_) => None,
    }
}

/// The slot on a set line as (library, id), per `split_slot`.
pub(crate) fn slot_ref(line: &str) -> Option<(Option<&str>, &str)> {
    split_slot(slot_id(line)?)
}

/// The slot on a set line with a bare id resolved to the set's own library `own`: (library, id).
pub(crate) fn slot_in<'a>(line: &'a str, own: &'a str) -> Option<(&'a str, &'a str)> {
    let (lib, id) = slot_ref(line)?;
    Some((lib.unwrap_or(own), id))
}

/// Set `id` with its slotted member ids in body order; `None` when it is tombstoned or does not
/// load (its build then reports why).
fn load_set(lib: &Library, id: &str) -> Option<(Rune, Vec<String>)> {
    if lib.tombstone(id).is_some() {
        return None;
    }
    let set = lib.load(&lib.entry(id).ok()??).ok()?;
    // Slot tokens as written: `id` for this library, `lib/id` for another (`member` reads either).
    let slots = set.body.lines().filter_map(slot_ref).map(|(l, m)| l.map_or(m.to_string(), |l| format!("{l}/{m}"))).collect();
    Some((set, slots))
}

/// The rune a slot token names: a bare id in `lib`, `lib/id` in `ctx.libraries`; `None` when it is
/// tombstoned, absent or does not load.
fn member(lib: &Library, ctx: &RenderCtx, token: &str) -> Option<Rune> {
    let (other, id) = split_slot(token)?;
    let opened;
    let home = match other {
        None => lib,
        Some(name) => {
            opened = Library::open(ctx.libraries.get(name)?).ok()?;
            &opened
        }
    };
    if home.tombstone(id).is_some() {
        return None;
    }
    home.entry(id).ok().flatten().and_then(|e| home.load(&e).ok())
}

/// The slots of `set` that `build::build_in` renders under `ctx`: the set Active and kept, each
/// member not skipped, a live Active rule or fact that meets the set's scope and is kept.
fn rendered(lib: &Library, set: &Rune, slots: &[String], ctx: &RenderCtx) -> Vec<String> {
    if set.state != State::Active || !ctx.keeps(set) {
        return Vec::new();
    }
    let renders = |m: &String| {
        if ctx.skip.contains(m) || ctx.off.contains(m) {
            return false;
        }
        let Some(r) = member(lib, ctx, m) else { return false };
        // Item runes reach a session through the Bare mappers (`rune_items`), never as payload text.
        !matches!(r.kind.as_str(), "procedure" | "set") && !rune::is_item_kind(&r.kind) && r.state == State::Active && r.meets(&set.scope) && ctx.keeps(&r)
    };
    slots.iter().filter(|m| renders(m)).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prints where each named library resolves under `VIDAR_LIBRARY_PROOF_ROOT` (a real install;
    /// read-only). Run by hand: `--ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_real_library_paths() {
        let Some(root) = std::env::var_os("VIDAR_LIBRARY_PROOF_ROOT") else { return };
        let root = PathBuf::from(root);
        let mut names = vec!["stock".to_string()];
        let mut ignored = Vec::new();
        if let Some(rel) = super::super::set_loadout::rules_library(&crate::paths::config_path_in(&root), &mut ignored) {
            names.push(library_name(&rel));
        }
        for e in std::fs::read_dir(crate::paths::rune_imports_dir_in(&root)).into_iter().flatten().flatten() {
            if e.path().is_dir() {
                names.push(e.file_name().to_string_lossy().into_owned());
            }
        }
        for n in names {
            println!("library {n:?} -> {:?}", library_dir_named(&root, &n));
        }
    }

    #[test]
    fn a_prefixed_slot_names_its_library_and_a_bare_slot_the_sets_own() {
        assert_eq!(slot_id("- <?rune stock/gate-fact?>"), Some("stock/gate-fact"));
        assert_eq!(slot_ref("- <?rune stock/gate-fact?>"), Some((Some("stock"), "gate-fact")));
        assert_eq!(slot_ref("2. <?rune plain?>"), Some((None, "plain")));
        assert_eq!(slot_in("<?rune plain?>", "kit"), Some(("kit", "plain")));
        assert_eq!(slot_in("* <?rune stock/gate-fact?>", "kit"), Some(("stock", "gate-fact")));
        for bad in ["- <?rune /x?>", "- <?rune lib/?>", "- <?rune a/b/c?>", "- <?rune a b?>", "text"] {
            assert_eq!(slot_ref(bad), None, "{bad}");
        }
    }
}
