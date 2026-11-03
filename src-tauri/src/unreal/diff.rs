//! Changed-asset property diff for the Changes panel, read through Rider's `get_asset_properties`.
//!
//! Read-only. Each side of the comparison (index blob, HEAD blob or working file) is copied to a
//! temp file named like the asset, read by Rider with the project root as `rootFolder`, then the
//! temp copy is deleted. The project root is found by walking up from the asset file itself, never
//! from the Changes cwd. Only git is run (no `git lfs`, no network); an LFS pointer is resolved
//! from the local object store when the object is there and its sha256 matches.

use super::asset::{inside, parse_props, rider_args, AssetProp, Rider};
use super::discover::uprojects_in;
use crate::gitrun::{git, git_bytes, GitOpts};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const GIT_WAIT: Duration = Duration::from_secs(10);
const BLOB_WAIT: Duration = Duration::from_secs(60);
const BLOB_CAP: usize = 256 * 1024 * 1024;
const UP_LEVELS: usize = 16;
const LFS_HEAD: &[u8] = b"version https://git-lfs.github.com/spec/v1";

const N_ADDED: &str = "Added";
const N_DELETED: &str = "Deleted";
const N_CONFLICT: &str = "Conflicted";
const N_COMPLEX: &str = "Complex Properties Not Shown";
const N_LFS_OLD: &str = "Old Version Is in LFS, Not Local";
const N_LFS_NEW: &str = "New Version Is in LFS, Not Local";
const N_OLD_UNREAD: &str = "Rider Could Not Read the Old Version";
const N_NEW_UNREAD: &str = "Rider Could Not Read the New Version";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffStatus {
    Changed,
    NoChanges,
    /// No verdict: a side could not be read, the row is conflicted, or nothing readable on either side.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffRow {
    pub name: String,
    #[serde(rename = "typeName")]
    pub type_name: String,
    /// None = the property is missing on that side.
    pub old: Option<String>,
    pub new: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UnrealAssetDiff {
    pub status: DiffStatus,
    pub rows: Vec<DiffRow>,
    pub notes: Vec<String>,
}

// ---------- input ----------

/// Repo-relative path as git status gives it: no leading slash, no `..`, no colon, an asset file.
fn check_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Asset Path Refused: Empty".into());
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err("Asset Path Refused: Absolute Paths Are Not Allowed".into());
    }
    if path.contains(':') {
        return Err("Asset Path Refused: Drive and Stream Names Are Not Allowed".into());
    }
    if path.split(['/', '\\']).any(|c| c == "..") {
        return Err("Asset Path Refused: Parent Folders Are Not Allowed".into());
    }
    let ext = Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase());
    if !matches!(ext.as_deref(), Some("uasset") | Some("umap")) {
        return Err("Asset Path Refused: Not a uasset or umap File".into());
    }
    Ok(())
}

/// The folder holding the `.uproject` nearest above the asset file.
fn project_root(file: &Path) -> Option<PathBuf> {
    file.ancestors().skip(1).take(UP_LEVELS).find(|d| !uprojects_in(d).is_empty()).map(Path::to_path_buf)
}

// ---------- git sides ----------

enum Side {
    Absent,
    Bytes(Vec<u8>),
    /// Present but unreadable here (an LFS object that is not local); carries the note.
    Unavailable(&'static str),
}

fn is_pointer(b: &[u8]) -> bool {
    b.len() <= 1024 && b.starts_with(LFS_HEAD)
}

fn pointer_oid(b: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(b);
    text.lines().find_map(|l| l.strip_prefix("oid sha256:")).map(str::trim).filter(|o| o.len() == 64 && o.bytes().all(|c| c.is_ascii_hexdigit())).map(str::to_lowercase)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|x| format!("{x:02x}")).collect()
}

/// The object a pointer names, from `<common>/lfs/objects/aa/bb/<oid>`, when present and its sha256 matches.
fn lfs_object(common: &Path, pointer: &[u8]) -> Option<Vec<u8>> {
    let oid = pointer_oid(pointer)?;
    let file = common.join("lfs").join("objects").join(&oid[0..2]).join(&oid[2..4]).join(&oid);
    let data = fs::read(file).ok()?;
    (hex(&Sha256::digest(&data)) == oid).then_some(data)
}

fn common_dir(cwd: &Path) -> Option<PathBuf> {
    let out = git(cwd, &["rev-parse", "--git-common-dir"], &GitOpts::read(GIT_WAIT, 4096)).ok()?;
    let p = PathBuf::from(out.text.trim());
    Some(if p.is_absolute() { p } else { cwd.join(p) })
}

/// Bytes of a side, swapping an LFS pointer for its local object.
fn resolve_bytes(cwd: &Path, bytes: Vec<u8>, lfs_note: &'static str) -> Side {
    if !is_pointer(&bytes) {
        return Side::Bytes(bytes);
    }
    match common_dir(cwd).and_then(|c| lfs_object(&c, &bytes)) {
        Some(real) => Side::Bytes(real),
        None => Side::Unavailable(lfs_note),
    }
}

fn blob(cwd: &Path, oid: &str, lfs_note: &'static str) -> Result<Side, String> {
    let opts = GitOpts::read(BLOB_WAIT, BLOB_CAP);
    let bytes = git_bytes(cwd, &["cat-file", "blob", oid], &opts)?;
    Ok(resolve_bytes(cwd, bytes, lfs_note))
}

/// Index entries for the path: (stage-0 blob oid, any unmerged stage).
fn index_entry(cwd: &Path, rel: &str) -> Result<(Option<String>, bool), String> {
    let out = git(cwd, &["ls-files", "-s", "--", rel], &GitOpts::read(GIT_WAIT, 64 * 1024))?;
    let (mut oid, mut conflicted) = (None, false);
    for line in out.text.lines() {
        let Some((meta, _)) = line.split_once('\t') else { continue };
        let mut it = meta.split_whitespace();
        let (mode, id, stage) = (it.next(), it.next(), it.next());
        match (mode, id, stage) {
            (_, _, Some("0")) if mode != Some("160000") => oid = id.map(str::to_owned),
            (_, _, Some(s)) if s != "0" => conflicted = true,
            _ => {}
        }
    }
    Ok((oid, conflicted))
}

/// The blob oid at HEAD; None when the path is not there or the repo has no commit yet.
fn head_entry(cwd: &Path, rel: &str) -> Result<Option<String>, String> {
    let out = match git(cwd, &["ls-tree", "HEAD", "--", rel], &GitOpts::read(GIT_WAIT, 64 * 1024)) {
        Ok(o) => o,
        Err(e) if e.contains("Not a valid object name") || e.contains("unknown revision") => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(out.text.lines().find_map(|l| {
        let (meta, _) = l.split_once('\t')?;
        let mut it = meta.split_whitespace();
        let (_mode, kind, oid) = (it.next()?, it.next()?, it.next()?);
        (kind == "blob").then(|| oid.to_owned())
    }))
}

// ---------- reading a side through Rider ----------

struct TempDir {
    dir: PathBuf,
    base: PathBuf,
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
        let _ = fs::remove_dir(&self.base); // only when empty
    }
}

/// Copy the bytes to `<base>/<rand>/<name>`, ask Rider for the properties, delete the copy.
fn read_props(bytes: &[u8], name: &str, base: &Path, root: &str, rider: Rider) -> Result<Vec<AssetProp>, String> {
    let mut r = [0u8; 8];
    getrandom::fill(&mut r).map_err(|e| format!("no OS randomness: {e}"))?;
    let dir = base.join(hex(&r));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _guard = TempDir { dir: dir.clone(), base: base.to_path_buf() };
    let file = dir.join(name);
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    let v = rider("rider_get_asset_properties", rider_args(root, json!({"assetPath": file.to_string_lossy()})))?;
    Ok(parse_props(&v))
}

/// A side after reading: absent, unreadable (the note says why) or its simple properties.
enum Read {
    Absent,
    Failed,
    Props(Vec<AssetProp>),
}

fn note(notes: &mut Vec<String>, n: &str) {
    if !notes.iter().any(|x| x == n) {
        notes.push(n.to_string());
    }
}

fn read_side(side: Side, name: &str, which: (&'static str, &'static str), base: &Path, root: &str, rider: Rider, notes: &mut Vec<String>, complex: &mut bool) -> Read {
    match side {
        Side::Absent => Read::Absent,
        Side::Unavailable(n) => {
            note(notes, n);
            Read::Failed
        }
        Side::Bytes(b) => match read_props(&b, name, base, root, rider) {
            Ok(props) => {
                let (typed, rest): (Vec<_>, Vec<_>) = props.into_iter().partition(|p| !p.type_name.is_empty());
                if !rest.is_empty() {
                    *complex = true;
                }
                Read::Props(typed)
            }
            Err(_) => {
                note(notes, which.0);
                Read::Failed
            }
        },
    }
}

// ---------- the diff ----------

pub fn diff_with(cwd: &Path, path: &str, staged: bool, rider: Rider, tmp_base: &Path) -> Result<UnrealAssetDiff, String> {
    let path = path.trim();
    check_path(path)?;
    let rel = path.replace('\\', "/");
    let file = cwd.join(&rel);
    if let (Ok(real), Ok(top)) = (fs::canonicalize(&file), fs::canonicalize(cwd)) {
        if !inside(&top, &real) {
            return Err("Asset Path Refused: Outside the Repository".into());
        }
    }
    let root = project_root(&file).ok_or("No Unreal Project Found for This Asset")?;
    let root_s = root.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let name = file.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("Asset Path Refused: Empty")?;

    let (index_oid, conflicted) = index_entry(cwd, &rel)?;
    let mut notes: Vec<String> = Vec::new();
    if conflicted {
        notes.push(N_CONFLICT.into());
        return Ok(UnrealAssetDiff { status: DiffStatus::Unknown, rows: Vec::new(), notes });
    }

    let (old, new) = if staged {
        let head = head_entry(cwd, &rel)?;
        let old = match head { Some(o) => blob(cwd, &o, N_LFS_OLD)?, None => Side::Absent };
        let new = match &index_oid { Some(o) => blob(cwd, o, N_LFS_NEW)?, None => Side::Absent };
        (old, new)
    } else {
        let old = match &index_oid { Some(o) => blob(cwd, o, N_LFS_OLD)?, None => Side::Absent };
        let new = match fs::read(&file) {
            Ok(b) => resolve_bytes(cwd, b, N_LFS_NEW),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Side::Absent,
            Err(e) => return Err(format!("Working File Unreadable: {e}")),
        };
        (old, new)
    };

    if matches!((&old, &new), (Side::Absent, Side::Absent)) {
        return Ok(UnrealAssetDiff { status: DiffStatus::Unknown, rows: Vec::new(), notes });
    }
    if matches!(old, Side::Absent) {
        note(&mut notes, N_ADDED);
    }
    if matches!(new, Side::Absent) {
        note(&mut notes, N_DELETED);
    }

    let mut complex = false;
    let old_r = read_side(old, &name, (N_OLD_UNREAD, ""), tmp_base, &root_s, rider, &mut notes, &mut complex);
    let new_r = read_side(new, &name, (N_NEW_UNREAD, ""), tmp_base, &root_s, rider, &mut notes, &mut complex);
    if complex {
        note(&mut notes, N_COMPLEX);
    }

    let none: Vec<AssetProp> = Vec::new();
    let failed = matches!(old_r, Read::Failed) || matches!(new_r, Read::Failed);
    let (old_p, new_p) = match (&old_r, &new_r) {
        (Read::Props(o), Read::Props(n)) => (o, n),
        (Read::Props(o), _) => (o, &none),
        (_, Read::Props(n)) => (&none, n),
        _ => (&none, &none),
    };
    // a failed side contributes nothing to compare: the other side's properties stand alone
    let mut rows = Vec::new();
    if !matches!(new_r, Read::Failed) || matches!(old_r, Read::Failed) {
        for n in new_p {
            match old_p.iter().find(|o| o.name == n.name) {
                Some(o) if o.value == n.value => {}
                o => rows.push(DiffRow { name: n.name.clone(), type_name: n.type_name.clone(), old: o.map(|o| o.value.clone()), new: Some(n.value.clone()) }),
            }
        }
    }
    if !matches!(new_r, Read::Failed) && !matches!(old_r, Read::Failed) {
        for o in old_p {
            if !new_p.iter().any(|n| n.name == o.name) {
                rows.push(DiffRow { name: o.name.clone(), type_name: o.type_name.clone(), old: Some(o.value.clone()), new: None });
            }
        }
    }
    let status = if failed || (old_p.is_empty() && new_p.is_empty()) {
        DiffStatus::Unknown
    } else if rows.is_empty() {
        DiffStatus::NoChanges
    } else {
        DiffStatus::Changed
    };
    Ok(UnrealAssetDiff { status, rows, notes })
}

#[tauri::command]
pub async fn unreal_asset_diff(cwd: String, path: String, staged: bool) -> Result<UnrealAssetDiff, String> {
    super::blocking("unreal_asset_diff", move || {
        let call = super::asset::live(super::proxy::proxy_url());
        let base = std::env::temp_dir().join("vidar-uasset-diff");
        diff_with(Path::new(&cwd), &path, staged, &call, &base)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vidar-udiff-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// One-shot identity for every test git call: the CI runner has none, and `git merge` refuses
    /// before merging without one (no conflict, so the conflict test saw a clean path).
    const ID: [&str; 6] = ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "core.autocrlf=false"];

    fn g(cwd: &Path, args: &[&str]) {
        let mut full = ID.to_vec();
        full.extend_from_slice(args);
        git(cwd, &full, &GitOpts::read(Duration::from_secs(30), 1 << 20)).unwrap();
    }

    /// Repo root `R` with the project one level down: R/Game/Game.uproject, R/Game/Content/.
    fn repo(tag: &str) -> PathBuf {
        let r = scratch(tag).join("R");
        fs::create_dir_all(r.join("Game").join("Content")).unwrap();
        fs::write(r.join("Game").join("Game.uproject"), "{}").unwrap();
        g(&r, &["init", "-q"]);
        r
    }

    fn put(r: &Path, name: &str, body: &str) {
        fs::write(r.join("Game").join("Content").join(name), body).unwrap();
    }

    fn p(name: &str) -> String {
        format!("Game/Content/{name}")
    }

    fn props(list: &[(&str, &str, &str)]) -> Value {
        json!({"properties": list.iter().map(|(n, t, v)| json!({"name": n, "typeName": t, "value": v})).collect::<Vec<_>>()})
    }

    /// Rider stand-in: the temp file's text picks the reply, so a wrong temp path or a deleted
    /// copy fails the read.
    fn fake(root: PathBuf, base: PathBuf) -> impl Fn(&str, Value) -> Result<Value, String> {
        move |name, args| {
            assert_eq!(name, "rider_get_asset_properties");
            assert_eq!(Path::new(args["rootFolder"].as_str().unwrap()), root, "root comes from the asset's .uproject");
            let file = PathBuf::from(args["assetPath"].as_str().unwrap());
            assert!(file.starts_with(&base), "{file:?} must sit under the temp base");
            match fs::read_to_string(&file).map_err(|e| e.to_string())?.as_str() {
                "v1" => Ok(props(&[("Speed", "float", "1"), ("Gone", "int", "5"), ("Cx", "", "{..}")])),
                "v2" => Ok(props(&[("Speed", "float", "2"), ("New", "int", "7"), ("Cx", "", "{..}")])),
                "empty" => Ok(props(&[])),
                _ => Err("Rider refused the file".into()),
            }
        }
    }

    fn run(r: &Path, path: &str, staged: bool) -> (UnrealAssetDiff, PathBuf) {
        let base = r.parent().unwrap().join("tmp").join("vidar-uasset-diff");
        let call = fake(r.join("Game"), base.clone());
        (diff_with(r, path, staged, &call, &base).unwrap(), base)
    }

    fn row(name: &str, ty: &str, old: Option<&str>, new: Option<&str>) -> DiffRow {
        DiffRow { name: name.into(), type_name: ty.into(), old: old.map(Into::into), new: new.map(Into::into) }
    }

    fn gone(base: &Path) {
        assert!(!base.exists() || fs::read_dir(base).unwrap().next().is_none(), "temp copies deleted");
    }

    #[test]
    fn changes_and_staged_diff_properties_and_clean_up() {
        let r = repo("props");
        put(&r, "BP_A.uasset", "v1");
        g(&r, &["add", "."]);
        g(&r, &["commit", "-qm", "one"]);
        put(&r, "BP_A.uasset", "v2");
        let want = vec![row("Speed", "float", Some("1"), Some("2")), row("New", "int", None, Some("7")), row("Gone", "int", Some("5"), None)];

        let (d, base) = run(&r, &p("BP_A.uasset"), false);
        assert_eq!(d.status, DiffStatus::Changed);
        assert_eq!(d.rows, want);
        assert_eq!(d.notes, vec![N_COMPLEX.to_string()]);
        gone(&base);

        g(&r, &["add", "."]);
        let (d, base) = run(&r, &p("BP_A.uasset"), true);
        assert_eq!((d.status, d.rows), (DiffStatus::Changed, want), "staged = HEAD vs index");
        gone(&base);
        let (d, _) = run(&r, &p("BP_A.uasset"), false);
        assert_eq!(d.status, DiffStatus::NoChanges, "index equals working tree");
        assert!(d.rows.is_empty());
    }

    #[test]
    fn a_missing_side_is_added_or_deleted() {
        let r = repo("addel");
        put(&r, "BP_Old.uasset", "v1");
        g(&r, &["add", "."]);
        g(&r, &["commit", "-qm", "one"]);
        put(&r, "BP_New.uasset", "v2");
        fs::remove_file(r.join("Game").join("Content").join("BP_Old.uasset")).unwrap();

        let (d, _) = run(&r, &p("BP_New.uasset"), false);
        assert_eq!(d.notes, vec![N_ADDED.to_string(), N_COMPLEX.to_string()]);
        assert_eq!(d.rows, vec![row("Speed", "float", None, Some("2")), row("New", "int", None, Some("7"))]);
        assert_eq!(d.status, DiffStatus::Changed);

        let (d, base) = run(&r, &p("BP_Old.uasset"), false);
        assert_eq!(d.notes[0], N_DELETED);
        assert_eq!(d.rows, vec![row("Speed", "float", Some("1"), None), row("Gone", "int", Some("5"), None)]);
        gone(&base);
    }

    #[test]
    fn empty_against_empty_is_unknown() {
        let r = repo("empty");
        put(&r, "BP_E.uasset", "empty");
        g(&r, &["add", "."]);
        g(&r, &["commit", "-qm", "one"]);
        let (d, _) = run(&r, &p("BP_E.uasset"), false);
        assert_eq!(d.status, DiffStatus::Unknown);
        assert!(d.rows.is_empty());
    }

    #[test]
    fn rider_refusing_the_old_copy_returns_the_new_side_with_a_note() {
        let r = repo("refuse-old");
        put(&r, "BP_R.uasset", "garbage");
        g(&r, &["add", "."]);
        g(&r, &["commit", "-qm", "one"]);
        put(&r, "BP_R.uasset", "v2");
        let (d, base) = run(&r, &p("BP_R.uasset"), false);
        assert!(d.notes.contains(&N_OLD_UNREAD.to_string()), "{:?}", d.notes);
        assert_eq!(d.status, DiffStatus::Unknown);
        assert_eq!(d.rows, vec![row("Speed", "float", None, Some("2")), row("New", "int", None, Some("7"))]);
        gone(&base);
    }

    #[test]
    fn an_lfs_pointer_reads_the_local_object_only_when_its_hash_matches() {
        let r = repo("lfs");
        let oid = hex(&Sha256::digest(b"v1"));
        put(&r, "BP_L.uasset", &format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 2\n"));
        g(&r, &["add", "."]);
        g(&r, &["commit", "-qm", "one"]);
        put(&r, "BP_L.uasset", "v2");

        let (d, _) = run(&r, &p("BP_L.uasset"), false);
        assert!(d.notes.contains(&N_LFS_OLD.to_string()), "missing object: {:?}", d.notes);
        assert_eq!(d.status, DiffStatus::Unknown);

        let obj_dir = r.join(".git").join("lfs").join("objects").join(&oid[0..2]).join(&oid[2..4]);
        fs::create_dir_all(&obj_dir).unwrap();
        fs::write(obj_dir.join(&oid), "not the content").unwrap();
        let (d, _) = run(&r, &p("BP_L.uasset"), false);
        assert!(d.notes.contains(&N_LFS_OLD.to_string()), "hash mismatch: {:?}", d.notes);

        fs::write(obj_dir.join(&oid), "v1").unwrap();
        let (d, base) = run(&r, &p("BP_L.uasset"), false);
        assert!(!d.notes.contains(&N_LFS_OLD.to_string()), "{:?}", d.notes);
        assert_eq!(d.status, DiffStatus::Changed);
        assert_eq!(d.rows[0], row("Speed", "float", Some("1"), Some("2")));
        gone(&base);
    }

    #[test]
    fn an_unmerged_path_is_conflicted_with_no_rows() {
        let r = repo("conflict");
        put(&r, "BP_C.uasset", "v1");
        g(&r, &["add", "."]);
        g(&r, &["commit", "-qm", "one"]);
        let here = git(&r, &["rev-parse", "--abbrev-ref", "HEAD"], &GitOpts::read(GIT_WAIT, 4096)).unwrap().text.trim().to_string();
        g(&r, &["switch", "-q", "-c", "side"]);
        put(&r, "BP_C.uasset", "v2");
        g(&r, &["commit", "-qam", "side"]);
        g(&r, &["switch", "-q", &here]);
        put(&r, "BP_C.uasset", "empty");
        g(&r, &["commit", "-qam", "main"]);
        let merge = [&ID[..], &["merge", "side"]].concat();
        let (code, _) = crate::gitrun::run(&r, &merge, &GitOpts::read(Duration::from_secs(30), 1 << 20)).unwrap();
        assert_eq!(code, Some(1), "the merge must stop on the conflict");
        let (d, _) = run(&r, &p("BP_C.uasset"), false);
        assert_eq!((d.status, d.rows.len(), d.notes), (DiffStatus::Unknown, 0, vec![N_CONFLICT.to_string()]));
    }

    #[test]
    fn unsafe_paths_are_refused_before_git_runs() {
        for bad in ["", "/etc/x.uasset", "\\x.uasset", "../x.uasset", "Game/../../x.uasset", "Game\\..\\x.umap", "C:x.uasset", "Game/a.uasset:s", ":(top)x.uasset", "Game/Game.uproject"] {
            assert!(check_path(bad).is_err(), "{bad:?}");
        }
        assert!(check_path("Game/Content/Maps/Hub.umap").is_ok());
        let r = repo("refusal");
        let call = |_: &str, _: Value| -> Result<Value, String> { panic!("no Rider call for a refused path") };
        let e = diff_with(&r, "../x.uasset", false, &call, &r.join("tmp")).unwrap_err();
        assert!(e.contains("Parent Folders"), "{e}");
    }
}
