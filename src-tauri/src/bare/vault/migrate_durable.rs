//! Persistent backup and interruption recovery for Rune Vault migration.

use super::*;
use serde::{Deserialize, Serialize};

fn copy_into(backup: &Path, src: &Path, rel: &Path, listed: &mut Vec<String>) -> Result<(), String> {
    if !src.is_file() {
        return Ok(());
    }
    let dst = backup.join(rel);
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("backup {}: {e}", parent.display()))?;
    }
    std::fs::copy(src, &dst).map_err(|e| format!("backup {} -> {}: {e}", src.display(), dst.display()))?;
    listed.push(rel.to_string_lossy().replace('\\', "/"));
    Ok(())
}

fn copy_tree(backup: &Path, src: &Path, rel: &Path, listed: &mut Vec<String>) -> Result<(), String> {
    let rd = match std::fs::read_dir(src) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("backup {}: {e}", src.display())),
    };
    for e in rd {
        let e = e.map_err(|e| format!("backup {}: {e}", src.display()))?;
        let p = e.path();
        let r = rel.join(e.file_name());
        let ty = e.file_type().map_err(|e| format!("backup {}: {e}", p.display()))?;
        if ty.is_symlink() || (!ty.is_file() && !ty.is_dir()) {
            return Err(format!("backup {}: unsupported file type", p.display()));
        }
        if ty.is_dir() {
            copy_tree(backup, &p, &r, listed)?;
        } else {
            copy_into(backup, &p, &r, listed)?;
        }
    }
    Ok(())
}

pub(super) fn backup_dir(env: &Env) -> PathBuf {
    crate::paths::migrations_dir_in(env.root).join(format!("vault-{}", env.stamp))
}

/// Copies changed files and each entire renamed library before any write; returns the folder and list.
pub(super) fn backup(env: &Env, plan: &Plan) -> Result<(PathBuf, Vec<String>), String> {
    let dir = backup_dir(env);
    std::fs::create_dir_all(&dir).map_err(|e| format!("backup {}: {e}", dir.display()))?;
    let mut listed = Vec::new();
    copy_into(&dir, env.config, Path::new(env.config.file_name().ok_or("config path has no file name")?), &mut listed)?;
    copy_into(&dir, &crate::paths::legacy_rune_gen_index_in(env.root), Path::new("gen-index.json"), &mut listed)?;
    let imports = crate::paths::rune_imports_dir_in(env.root);
    for lib in libraries(env) {
        for set in files_in(&imports.join(&lib).join("sets"), ".layer.json") {
            let rel = PathBuf::from(format!("libraries/{lib}/sets/{set}.layer.json"));
            copy_into(&dir, &set_layer::sidecar_path(&imports.join(&lib), &set), &rel, &mut listed)?;
        }
    }
    for (l, s, _) in plan.set_edits() {
        copy_into(&dir, &l.set_md(s), &PathBuf::from(format!("libraries/{}/sets/{s}.md", l.old)), &mut listed)?;
    }
    for r in &plan.renames {
        if !imports.join(&r.from).is_dir() {
            return Err(format!("backup: generated library {} is missing", r.from));
        }
        copy_tree(&dir, &imports.join(&r.from), &PathBuf::from(format!("libraries/{}", r.from)), &mut listed)?;
    }
    copy_tree(&dir, &crate::paths::legacy_rune_overrides_dir_in(env.root), Path::new("overrides"), &mut listed)?;
    for f in &plan.fixes {
        let id = &f.vault.id;
        copy_tree(&dir, &crate::paths::rune_vaults_dir_in(env.root).join(id), &PathBuf::from(format!("vaults/{id}")), &mut listed)?;
    }
    if let Some(h) = env.home_dir {
        for a in [Agent::Claude, Agent::Codex] {
            let f = agent_homes::index_file(a, h);
            let name = f.file_name().map(PathBuf::from).unwrap_or_default();
            copy_into(&dir, &f, &Path::new("homes").join(name), &mut listed)?;
        }
    }
    write_plan_txt(&dir, plan, &listed, "planned")?;
    Ok((dir, listed))
}

pub(super) fn write_plan_txt(dir: &Path, plan: &Plan, listed: &[String], state: &str) -> Result<(), String> {
    let mut text = format!("state: {state}\n");
    for l in listed {
        text.push_str(&format!("backup {l}\n"));
    }
    for l in plan.lines() {
        text.push_str(&l);
        text.push('\n');
    }
    std::fs::write(dir.join("plan.txt"), text).map_err(|e| format!("backup plan: {e}"))
}

/// Write-ahead record: backup contents and planned creations are enough to reverse a process
/// interruption even after a library has moved and the in-memory undo journal is gone.
#[derive(Serialize, Deserialize)]
pub(super) struct Recovery {
    pub(super) stamp: String,
    pub(super) committed: bool,
    pub(super) config_existed: bool,
    pub(super) renames: Vec<(String, String)>,
    pub(super) vaults: Vec<String>,
    pub(super) runes: Vec<(String, String)>,
    pub(super) homes: Vec<String>,
    /// Existing vaults the run rewrote (agent split of a mixed runeset); restored from the backup.
    #[serde(default)]
    pub(super) fixes: Vec<String>,
}

pub(super) fn recovery_file(root: &Path) -> PathBuf {
    crate::paths::migrations_dir_in(root).join("vault-recovery.json")
}

pub(super) fn save_recovery(root: &Path, record: &Recovery) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
    crate::fsx::atomic_write(&recovery_file(root), &bytes)
}

pub(super) fn recover(env: &Env) -> Result<(), String> {
    let marker = recovery_file(env.root);
    if !marker.exists() { return Ok(()); }
    let record: Recovery = crate::fsx::read_json(&marker)?;
    if record.committed {
        return std::fs::remove_file(&marker).map_err(|e| format!("{}: {e}", marker.display()));
    }
    if record.stamp.is_empty() || !record.stamp.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("invalid Rune Vault recovery stamp".into());
    }
    let backup = crate::paths::migrations_dir_in(env.root).join(format!("vault-{}", record.stamp));
    if !backup.join("plan.txt").is_file() { return Err(format!("recovery backup {} is incomplete", backup.display())); }
    let imports = crate::paths::rune_imports_dir_in(env.root);
    let valid = |s: &str| rune::check_id(s).is_ok();
    if record.renames.iter().any(|(a, b)| !valid(a) || !valid(b)) || record.vaults.iter().any(|v| !valid(v)) ||
        record.runes.iter().any(|(l, r)| !valid(l) || Path::new(r).components().any(|c| !matches!(c, std::path::Component::Normal(_)))) {
        return Err("invalid Rune Vault recovery path".into());
    }
    for (old, new) in &record.renames {
        let (src, dst) = (imports.join(old), imports.join(new));
        if src.exists() && dst.exists() {
            return Err(format!("recovery found both {} and {}; manual review required", src.display(), dst.display()));
        }
    }
    for id in &record.vaults {
        let dir = crate::paths::rune_vaults_dir_in(env.root).join(id);
        if dir.exists() { std::fs::remove_dir_all(&dir).map_err(|e| format!("recovery {}: {e}", dir.display()))?; }
    }
    // A rewritten vault comes back whole from its backup copy.
    for id in &record.fixes {
        if !valid(id) { return Err("invalid Rune Vault recovery path".into()); }
        let (src, dst) = (backup.join("vaults").join(id), crate::paths::rune_vaults_dir_in(env.root).join(id));
        if !src.join("vault.json").is_file() { return Err(format!("recovery backup of vault {id} is incomplete")); }
        if dst.exists() { std::fs::remove_dir_all(&dst).map_err(|e| format!("recovery {}: {e}", dst.display()))?; }
        let mut files = Vec::new();
        collect(&src, &mut files)?;
        for f in files {
            let rel = f.strip_prefix(&src).map_err(|e| e.to_string())?;
            let to = dst.join(rel);
            if let Some(p) = to.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            std::fs::copy(&f, &to).map_err(|e| format!("recovery {}: {e}", to.display()))?;
        }
    }
    for (lib, rel) in &record.runes {
        let path = imports.join(lib).join(rel);
        if path.exists() { std::fs::remove_file(&path).map_err(|e| format!("recovery {}: {e}", path.display()))?; }
    }
    for (old, new) in &record.renames {
        let dst = imports.join(new);
        let src = imports.join(old);
        if dst.exists() { std::fs::remove_dir_all(&dst).map_err(|e| format!("recovery {}: {e}", dst.display()))?; }
        if src.exists() { std::fs::remove_dir_all(&src).map_err(|e| format!("recovery {}: {e}", src.display()))?; }
    }
    // Backed-up files restore edited sets, sidecars, full generated libraries and cleanup inputs.
    let restore = |src: &Path, dst: &Path| -> Result<(), String> {
        if let Some(parent) = dst.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        std::fs::copy(src, dst).map_err(|e| format!("recovery {}: {e}", dst.display()))?;
        Ok(())
    };
    let mut files = Vec::new();
    fn collect(dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        if !dir.exists() { return Ok(()); }
        for e in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let p = e.map_err(|e| e.to_string())?.path();
            if p.is_dir() { collect(&p, files)?; } else { files.push(p); }
        }
        Ok(())
    }
    collect(&backup.join("libraries"), &mut files)?;
    for src in files.drain(..) {
        let rel = src.strip_prefix(backup.join("libraries")).map_err(|e| e.to_string())?;
        restore(&src, &imports.join(rel))?;
    }
    let cfg = backup.join(env.config.file_name().ok_or("config path has no file name")?);
    if cfg.exists() { restore(&cfg, env.config)?; }
    else if !record.config_existed && env.config.exists() { std::fs::remove_file(env.config).map_err(|e| e.to_string())?; }
    for (src, dst) in [(backup.join("gen-index.json"), crate::paths::legacy_rune_gen_index_in(env.root))] {
        if src.exists() { restore(&src, &dst)?; }
    }
    files.clear();
    collect(&backup.join("overrides"), &mut files)?;
    for src in files {
        let rel = src.strip_prefix(backup.join("overrides")).map_err(|e| e.to_string())?;
        restore(&src, &crate::paths::legacy_rune_overrides_dir_in(env.root).join(rel))?;
    }
    if let Some(home_dir) = env.home_dir {
        for a in [Agent::Claude, Agent::Codex] {
            let dst = agent_homes::index_file(a, home_dir);
            if !record.homes.iter().any(|name| dst.file_name().is_some_and(|n| n == name.as_str())) { continue; }
            let src = backup.join("homes").join(dst.file_name().ok_or("home index has no file name")?);
            if src.exists() { restore(&src, &dst)?; }
            else if dst.exists() { std::fs::remove_file(&dst).map_err(|e| e.to_string())?; }
        }
    }
    std::fs::remove_file(&marker).map_err(|e| format!("{}: {e}", marker.display()))
}
