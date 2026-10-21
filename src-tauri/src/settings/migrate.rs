//! src-tauri\src\settings\migrate.rs — `configVersion` migrations.
//! Absent on disk means version 0 (the shape before this field existed);
//! `CURRENT_VERSION` is the schema version this build understands.
//! Migrations run one version step at a time in order over the *untyped*
//! JSON tree, before `config.rs`'s typed deserialize — a step can rename or
//! restructure a key that the current schema doesn't model under its old
//! name, which a `&mut VidarConfig` step could never do. A step returns
//! `Some(line)` only when it actually changed the tree's shape — that line
//! is a real notice, surfaced by `load()` in config.rs through
//! `ConfigResult::notice` (main.ts, next to the existing `#config-error`
//! banner, styled neutrally). A step that only bumps the version number (no
//! shape change, like v0->v1) returns `None`: nothing to tell the user, so
//! no line on every boot.
//!
//! Scope note: this only mutates the in-memory `serde_json::Value` tree that
//! `load()` deserializes from. It does not itself write the tree back to
//! vidar.json; `load()` persists the whole migrated tree once (via
//! `settings::store::with_config_root_at`) when `configVersion` actually
//! changed, so a no-op step's version bump lands on disk on the next boot
//! after this one and does not need to be re-run indefinitely.

use serde_json::Value;

pub const CURRENT_VERSION: u32 = 2;

/// One migration step: from `index` (0-based, so step 0 takes v0 -> v1) to
/// the next version, mutating the raw JSON tree in place. Returns
/// `Some(line)` describing a real shape change, `None` when the step is a
/// no-op (version bump only).
type Migration = fn(&mut Value) -> Option<String>;

const MIGRATIONS: &[Migration] = &[v0_to_v1, v1_to_v2];

fn v0_to_v1(_root: &mut Value) -> Option<String> {
    // No shape change: v1's only addition is `configVersion` itself. The
    // table exists so the next real migration (a rename, a restructure) has
    // an ordered slot instead of an ad hoc `if` in `load()`.
    None
}

/// The C1 layout move (its launch migration was removed 2026-10-18): an `agents[].cwd` of
/// `{vidar}\bridge\…` now lives at `{vidar}\runtime\bridge\…`. The falcon dir under it is left out: it
/// stays legacy until its own gate.
fn v1_to_v2(root: &mut Value) -> Option<String> {
    let agents = root.get_mut("agents")?.as_array_mut()?;
    let mut n = 0;
    for agent in agents {
        let Some(cwd) = agent.get("cwd").and_then(Value::as_str) else { continue };
        if let Some(new) = runtime_cwd(cwd) {
            agent["cwd"] = Value::from(new);
            n += 1;
        }
    }
    (n > 0).then(|| format!("Moved {n} agent folder(s) from bridge\\ to runtime\\bridge\\"))
}

/// `{vidar}\bridge` or `{vidar}\bridge\<rest>` (either separator) -> the runtime shape. The token
/// is case-sensitive, as `expandVidarPath` expands only `{vidar}`; the path after it is not.
/// (Matched as whole `{vidar}\bridge` prefixes so no bare layout literal lands here for the
/// paths-contract scan.)
fn runtime_cwd(cwd: &str) -> Option<String> {
    const TOKEN: &str = "{vidar}";
    const LEGACY: &str = "{vidar}\\bridge";
    let norm = cwd.replace('/', "\\");
    if !norm.starts_with(TOKEN) || !norm.get(TOKEN.len()..LEGACY.len())?.eq_ignore_ascii_case(&LEGACY[TOKEN.len()..]) {
        return None;
    }
    let tail = &norm[LEGACY.len()..];
    if !(tail.is_empty() || tail.starts_with('\\')) {
        return None;
    }
    let first = tail.trim_start_matches('\\').split('\\').next().unwrap_or("");
    if first.eq_ignore_ascii_case("falcon") {
        return None;
    }
    let sep = &cwd[TOKEN.len()..TOKEN.len() + 1];
    Some(format!("{TOKEN}{sep}runtime{}", &cwd[TOKEN.len()..]))
}

/// Reads `configVersion` off the raw tree. Absent is version 0. A value that
/// isn't a plain non-negative integer — a string (some editors round-trip
/// numbers as strings), a float, garbage — is also treated as 0 rather than
/// failing the caller's typed parse; the field is `Option<u32>` in the
/// schema and a stray string there would otherwise refuse the whole config.
fn version_of(root: &Value) -> u32 {
    match root.get("configVersion") {
        Some(Value::Number(n)) => n.as_u64().and_then(|v| u32::try_from(v).ok()).unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse::<u32>().unwrap_or(0),
        _ => 0,
    }
}

/// Runs every migration between `from` and `target_version`, in order, then
/// stamps a plain-integer `configVersion` onto `root` — even when no step
/// ran, so a non-numeric on-disk value (see `version_of`) is normalised
/// before the typed deserialize that follows. A version already at or ahead
/// of `target_version` is left at its own number rather than migrated
/// backward, but is still written back as a number.
fn migrate_with(root: &mut Value, table: &[Migration], target_version: u32) -> Vec<String> {
    let from = version_of(root);
    let mut log = Vec::new();
    let final_version = if from >= target_version {
        from
    } else {
        for step in &table[from as usize..target_version as usize] {
            if let Some(line) = step(root) {
                log.push(line);
            }
        }
        target_version
    };
    if let Some(obj) = root.as_object_mut() {
        obj.insert("configVersion".into(), Value::from(final_version));
    }
    log
}

/// Runs `MIGRATIONS` up to `CURRENT_VERSION` over `root`. `config.rs`'s
/// `load_from` calls this on the parsed JSON tree before the typed
/// deserialize, and persists the whole tree once when `root["configVersion"]`
/// came out different from how it went in (a real step ran, or the on-disk
/// value merely needed normalising).
pub fn migrate(root: &mut Value) -> Vec<String> {
    migrate_with(root, MIGRATIONS, CURRENT_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn absent_version_is_treated_as_v0_and_migrates_to_current_with_no_log() {
        let mut root = json!({});
        let log = migrate(&mut root);
        assert_eq!(root["configVersion"], json!(CURRENT_VERSION));
        // v0 -> v1 is a no-op (no shape change): nothing to tell the user.
        assert!(log.is_empty());
    }

    #[test]
    fn already_current_runs_no_migration() {
        let mut root = json!({ "configVersion": CURRENT_VERSION });
        let log = migrate(&mut root);
        assert!(log.is_empty());
        assert_eq!(root["configVersion"], json!(CURRENT_VERSION));
    }

    #[test]
    fn a_version_ahead_of_current_is_left_alone() {
        let mut root = json!({ "configVersion": CURRENT_VERSION + 5 });
        let log = migrate(&mut root);
        assert!(log.is_empty());
        assert_eq!(root["configVersion"], json!(CURRENT_VERSION + 5));
    }

    #[test]
    fn a_string_config_version_parses_as_the_number_it_names() {
        let root = json!({ "configVersion": "1" });
        assert_eq!(version_of(&root), 1);
    }

    #[test]
    fn a_garbage_config_version_is_treated_as_zero() {
        let root = json!({ "configVersion": "not-a-number" });
        assert_eq!(version_of(&root), 0);
    }

    #[test]
    fn a_string_config_version_at_current_still_normalises_to_a_number() {
        // A prior build round-tripped configVersion as a string; the typed
        // deserialize downstream needs a number even when no step runs.
        let mut root = json!({ "configVersion": CURRENT_VERSION.to_string() });
        let log = migrate(&mut root);
        assert!(log.is_empty());
        assert_eq!(root["configVersion"], json!(CURRENT_VERSION));
    }

    #[test]
    fn v1_to_v2_moves_bridge_cwds_under_runtime() {
        let mut root = json!({ "configVersion": 1, "agents": [
            { "id": "codex", "cwd": "{vidar}\\bridge\\display" },
            { "id": "a", "cwd": "{vidar}/bridge" },
            { "id": "b", "cwd": "{vidar}\\bridge\\falcon" },
            { "id": "c", "cwd": "{vidar}\\bridges" },
            { "id": "d", "cwd": "{vidar}" },
            { "id": "e", "cwd": "D:\\work\\bridge" },
            { "id": "f" },
            { "id": "g", "cwd": "{VIDAR}\\bridge" },
            { "id": "h", "cwd": "{vidar}\\Bridge\\clips" }
        ]});
        let log = migrate(&mut root);
        assert_eq!(log.len(), 1);
        let cwds: Vec<_> = root["agents"].as_array().unwrap().iter().map(|a| a["cwd"].clone()).collect();
        assert_eq!(cwds, vec![
            json!("{vidar}\\runtime\\bridge\\display"),
            json!("{vidar}/runtime/bridge"),
            json!("{vidar}\\bridge\\falcon"),
            json!("{vidar}\\bridges"),
            json!("{vidar}"),
            json!("D:\\work\\bridge"),
            Value::Null,
            // `expandVidarPath` never expands `{VIDAR}`, so it is not ours to move.
            json!("{VIDAR}\\bridge"),
            json!("{vidar}\\runtime\\Bridge\\clips"),
        ]);
        assert_eq!(root["configVersion"], json!(2));
    }

    /// A fake rename step in a test-only table, run through the same
    /// `migrate_with` machinery `migrate()` uses — proof that a step which
    /// restructures the tree (not just a `VidarConfig` field) persists both
    /// the rename and the version bump.
    #[test]
    fn a_rename_step_persists_the_rename_and_the_version() {
        fn rename_old_key_to_new(root: &mut Value) -> Option<String> {
            let obj = root.as_object_mut()?;
            let value = obj.remove("oldKey")?;
            obj.insert("newKey".into(), value);
            Some("renamed oldKey to newKey".into())
        }

        const TEST_MIGRATIONS: &[Migration] = &[v0_to_v1, rename_old_key_to_new];

        let mut root = json!({ "oldKey": 5 });
        let log = migrate_with(&mut root, TEST_MIGRATIONS, 2);

        assert_eq!(log, vec!["renamed oldKey to newKey".to_string()]);
        assert_eq!(root["newKey"], json!(5));
        assert!(root.get("oldKey").is_none());
        assert_eq!(root["configVersion"], json!(2));
    }
}
