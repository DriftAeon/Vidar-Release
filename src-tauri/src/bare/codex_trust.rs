//! The notice card's Trust Folder action for a Codex Bare tab whose launch folder the user's own
//! Codex config does not trust. A prepare registers tab id -> folder; the card asks for the offer
//! (`codex_trust_offer`) and, on a click, `codex_trust_folder` adds the folder to the user's
//! `config.toml` as a trusted project. The folder comes from the registry only, and the card's folder
//! must match it. The boundary is a user click (or a `-Debug` build's drive); no bus, Flow or mod
//! path reaches it. A tab opened afterwards loads the folder's project settings.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use super::codex_hosted::UNTRUSTED_FOLDER_WARNING;
use super::codex_user_trust::{config_trusts, plain_absolute, user_config_path};
use super::home::{norm_cwd, trusted_project_key, trusted_project_table};
use super::CodexLaunch;

/// Tab id -> the launch folder the user's Codex config does not trust.
static REGISTRY: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
/// One trust write at a time (a double click must not interleave two read-modify-writes).
static WRITING: Mutex<()> = Mutex::new(());

const NO_OFFER: &str = "Couldn't trust this folder: reopen the tab and try again";

/// Records (or, with `None`, clears) the tab's untrusted folder.
pub fn register(tab: &str, folder: Option<String>) {
    let mut m = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    match folder {
        Some(f) => m.insert(tab.to_string(), f),
        None => m.remove(tab),
    };
}

/// Drops the tab's entry (its tab closed, or the folder is now trusted).
pub fn forget(tab: &str) {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).remove(tab);
}

fn folder_of(tab: &str) -> Option<String> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner()).get(tab).cloned()
}

impl CodexLaunch {
    /// The launch folder is not trusted by the user's own Codex config.
    pub fn is_untrusted(&self) -> bool {
        self.manifest.payload.warnings.iter().any(|w| w == UNTRUSTED_FOLDER_WARNING)
    }

    /// What the in-process tab's notice area shows, as the hosted route does: the rune build's
    /// warnings and the binary/shell warning, without the untrusted-folder one (the trust offer carries it).
    pub fn bare_warnings(&self) -> Vec<String> {
        self.manifest.payload.warnings.iter().filter(|w| *w != UNTRUSTED_FOLDER_WARNING).chain(&self.manifest.binary.warning).cloned().collect()
    }
}

/// What the trust card shows for a tab: the folder and the warning text.
#[derive(serde::Serialize)]
pub struct TrustOffer {
    pub(super) folder: String,
    pub(super) text: String,
}

/// The tab's trust offer, or none when its folder is trusted or the tab is unknown.
#[tauri::command]
pub fn codex_trust_offer(id: String) -> Option<TrustOffer> {
    folder_of(&id).map(|folder| TrustOffer { folder, text: UNTRUSTED_FOLDER_WARNING.to_string() })
}

/// Trusts the folder the card showed. It must equal the registry's folder for `id`; the write goes
/// to the user's own Codex config.
#[tauri::command]
pub async fn codex_trust_folder(id: String, folder: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _one = WRITING.lock().unwrap_or_else(|e| e.into_inner());
        let Some(known) = folder_of(&id).filter(|k| norm_cwd(k) == norm_cwd(&folder)) else { return Err(NO_OFFER.to_string()) };
        let config = user_config_path().ok_or("Couldn't trust this folder: no Codex config location")?;
        trust_in(&config, &known).map_err(|e| format!("Couldn't write {}: {e}", config.display()))?;
        forget(&id);
        Ok(())
    })
    .await
    .map_err(|e| format!("trust task failed: {e}"))?
}

/// Adds `folder` to the Codex config at `config` as a trusted project; the core the tests drive.
/// A folder the config already trusts is left byte for byte. Refused, with the file untouched: a
/// folder that is not a plain absolute directory, a symlinked or unparseable config, an inline
/// `projects` table, a config that changed under the edit, or a result that does not read back trusted.
pub(super) fn trust_in(config: &Path, folder: &str) -> Result<(), String> {
    let plain = plain_absolute(folder).ok_or("the folder is not a plain absolute path")?;
    if !Path::new(&plain).is_dir() {
        return Err("the folder is not an existing directory".into());
    }
    let key = trusted_project_key(&plain).ok_or("the folder is empty")?;
    if config_trusts(config, &plain) {
        return Ok(());
    }
    if std::fs::symlink_metadata(config).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("the config is a symbolic link".into());
    }
    let original: Option<Vec<u8>> = match std::fs::read(config) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !config.parent().is_some_and(Path::is_dir) {
                return Err("its folder does not exist".into());
            }
            None
        }
        Err(e) => return Err(e.to_string()),
    };
    let raw = match &original {
        Some(b) => String::from_utf8(b.clone()).map_err(|_| "the config is not UTF-8")?,
        None => String::new(),
    };
    let bom = raw.starts_with('\u{FEFF}');
    let text = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("the config does not parse ({e})"))?;
    let want = norm_cwd(&key);
    let matching: Vec<String> = match doc.get("projects") {
        None => Vec::new(),
        Some(item) if item.is_table() => item
            .as_table()
            .map(|t| t.iter().filter(|(k, _)| norm_cwd(k) == want).map(|(k, _)| k.to_string()).collect())
            .unwrap_or_default(),
        Some(_) => return Err("projects is not a table the editor can extend".into()),
    };
    let body = if matching.is_empty() {
        // Appended text: every existing byte, and its line endings, stay as they are.
        let crlf = text.contains("\r\n");
        let mut out = text.to_string();
        if !out.is_empty() {
            if !out.ends_with('\n') {
                out.push_str(if crlf { "\r\n" } else { "\n" });
            }
            out.push_str(if crlf { "\r\n" } else { "\n" });
        }
        let table = trusted_project_table(&key);
        out.push_str(&if crlf { table.replace('\n', "\r\n") } else { table });
        out
    } else {
        let projects = doc["projects"].as_table_mut().ok_or("projects is not a table")?;
        for k in &matching {
            let entry = projects.get_mut(k).and_then(|i| i.as_table_like_mut()).ok_or("a project entry is not a table")?;
            match entry.get_mut("trust_level") {
                Some(item) => {
                    let mut v = toml_edit::Value::from("trusted");
                    if let Some(old) = item.as_value() {
                        *v.decor_mut() = old.decor().clone();
                    }
                    *item = toml_edit::Item::Value(v);
                }
                None => {
                    entry.insert("trust_level", toml_edit::value("trusted"));
                }
            }
        }
        // The editor writes LF; a CRLF file gets its endings back, a mixed one is refused.
        let lf = text.matches('\n').count();
        let crlf = text.matches("\r\n").count();
        if crlf != 0 && crlf != lf {
            return Err("the config mixes line endings".into());
        }
        let edited = doc.to_string().replace("\r\n", "\n");
        if crlf != 0 { edited.replace('\n', "\r\n") } else { edited }
    };
    let mut bytes = Vec::new();
    if bom {
        bytes.extend_from_slice("\u{FEFF}".as_bytes());
    }
    bytes.extend_from_slice(body.as_bytes());
    // The edit must parse and trust the folder before anything is written.
    if crate::fsx::strip_bom(&String::from_utf8_lossy(&bytes)).parse::<toml::Table>().is_err() {
        return Err("the edited config would not parse".into());
    }
    // Re-read guard: narrows a concurrent Codex write, does not close it.
    if std::fs::read(config).ok() != original {
        return Err("the config changed while it was being edited; try again".into());
    }
    crate::fsx::atomic_write(config, &bytes)?;
    if !config_trusts(config, &plain) {
        return Err("the folder still reads as untrusted after the write".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> TempDir {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("vidar-ctrust-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            let p = PathBuf::from(std::fs::canonicalize(&p).unwrap().to_string_lossy().trim_start_matches(r"\\?\"));
            TempDir(p)
        }
        /// A project folder and a config path (not yet written) beside it.
        fn fixture(&self) -> (String, PathBuf) {
            let dir = self.0.join("Proj");
            std::fs::create_dir_all(&dir).unwrap();
            (dir.to_string_lossy().into_owned(), self.0.join("user").join("config.toml"))
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn put(p: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    #[test]
    fn codex_trust_appends_a_table_and_keeps_comments_order_and_other_tables() {
        let t = TempDir::new("append");
        let (dir, cfg) = t.fixture();
        let before = "# my config\nmodel = \"gpt\"  # pinned\n\n[projects.'c:\\other']\ntrust_level = \"trusted\" # keep\n\n[mcp_servers.x]\ncommand = \"y\"\n";
        put(&cfg, before.as_bytes());
        trust_in(&cfg, &dir).unwrap();
        let after = std::fs::read_to_string(&cfg).unwrap();
        assert!(after.starts_with(before), "{after}");
        assert!(after.contains(&trusted_project_table(&trusted_project_key(&dir).unwrap())), "{after}");
        assert!(config_trusts(&cfg, &dir));
    }

    #[test]
    fn codex_trust_flips_an_untrusted_entry_in_place() {
        let t = TempDir::new("flip");
        let (dir, cfg) = t.fixture();
        let key = dir.to_uppercase();
        let before = format!("model = \"a\"\n\n[projects.'{key}']\n# why\ntrust_level = \"untrusted\" # was off\nextra = 1\n\n[tail]\nz = 2\n");
        put(&cfg, before.as_bytes());
        trust_in(&cfg, &dir).unwrap();
        let after = std::fs::read_to_string(&cfg).unwrap();
        assert_eq!(after, before.replace("\"untrusted\"", "\"trusted\""), "{after}");
        assert_eq!(after.matches("[projects.").count(), 1);
    }

    #[test]
    fn codex_trust_edits_every_matching_entry_and_adds_a_missing_level() {
        let t = TempDir::new("many");
        let (dir, cfg) = t.fixture();
        let a = dir.to_uppercase();
        let b = dir.replace('\\', "/");
        put(&cfg, format!("[projects.'{a}']\ntrust_level = \"untrusted\"\n[projects.\"{b}\"]\nnote = 1\n").as_bytes());
        trust_in(&cfg, &dir).unwrap();
        let after = std::fs::read_to_string(&cfg).unwrap();
        assert_eq!(after.matches("trust_level = \"trusted\"").count(), 2, "{after}");
        assert!(!after.contains("untrusted"), "{after}");
    }

    #[test]
    fn codex_trust_already_trusted_leaves_the_bytes_alone() {
        let t = TempDir::new("already");
        let (dir, cfg) = t.fixture();
        let before = format!("\u{FEFF}[projects.'{dir}']\r\ntrust_level = \"trusted\"\r\n");
        put(&cfg, before.as_bytes());
        trust_in(&cfg, &dir).unwrap();
        assert_eq!(std::fs::read(&cfg).unwrap(), before.as_bytes());
    }

    #[test]
    fn codex_trust_keeps_a_bom_and_crlf_endings() {
        let t = TempDir::new("bomcrlf");
        let (dir, cfg) = t.fixture();
        let before = "\u{FEFF}model = \"a\"\r\n[x]\r\ny = 1";
        put(&cfg, before.as_bytes());
        trust_in(&cfg, &dir).unwrap();
        let after = std::fs::read(&cfg).unwrap();
        assert!(after.starts_with("\u{FEFF}model = \"a\"\r\n[x]\r\ny = 1\r\n\r\n[projects.".as_bytes()), "{}", String::from_utf8_lossy(&after));
        let text = String::from_utf8(after).unwrap();
        assert!(!text.replace("\r\n", "").contains('\n'), "a bare LF crept in");
        // The in-place route keeps the BOM too.
        let t2 = TempDir::new("bomflip");
        let (dir2, cfg2) = t2.fixture();
        put(&cfg2, format!("\u{FEFF}[projects.'{dir2}']\r\ntrust_level = \"untrusted\"\r\n").as_bytes());
        trust_in(&cfg2, &dir2).unwrap();
        assert_eq!(std::fs::read_to_string(&cfg2).unwrap(), format!("\u{FEFF}[projects.'{dir2}']\r\ntrust_level = \"trusted\"\r\n"));
    }

    #[test]
    fn codex_trust_creates_a_missing_config_only_beside_an_existing_folder() {
        let t = TempDir::new("create");
        let (dir, cfg) = t.fixture();
        assert!(trust_in(&cfg, &dir).is_err(), "no parent folder: refused");
        assert!(!cfg.exists());
        std::fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        trust_in(&cfg, &dir).unwrap();
        assert!(config_trusts(&cfg, &dir));
    }

    #[test]
    fn codex_trust_refuses_leave_the_file_untouched() {
        let t = TempDir::new("refuse");
        let (dir, cfg) = t.fixture();
        // Unparseable.
        put(&cfg, b"[projects\nbroken = =\n");
        assert!(trust_in(&cfg, &dir).is_err());
        assert_eq!(std::fs::read(&cfg).unwrap(), b"[projects\nbroken = =\n");
        // Inline projects table.
        put(&cfg, b"projects = { x = { trust_level = \"trusted\" } }\n");
        assert!(trust_in(&cfg, &dir).is_err());
        assert_eq!(std::fs::read(&cfg).unwrap(), b"projects = { x = { trust_level = \"trusted\" } }\n");
        // Not UTF-8.
        put(&cfg, &[0xff, 0xfe, 0x00]);
        assert!(trust_in(&cfg, &dir).is_err());
        assert_eq!(std::fs::read(&cfg).unwrap(), [0xff, 0xfe, 0x00]);
        // Relative, dot-dot and missing folders.
        put(&cfg, b"a = 1\n");
        for bad in ["proj", &format!("{dir}\\..\\Proj"), &format!("{dir}\\nope"), r"\\server\share\x"] {
            assert!(trust_in(&cfg, bad).is_err(), "{bad}");
        }
        assert_eq!(std::fs::read(&cfg).unwrap(), b"a = 1\n");
    }

    #[test]
    fn codex_trust_registry_holds_a_folder_per_tab_and_forgets_it() {
        register("t-reg-a", Some("C:\\a".into()));
        register("t-reg-b", Some("C:\\b".into()));
        assert_eq!(folder_of("t-reg-a").as_deref(), Some("C:\\a"));
        register("t-reg-a", None);
        assert_eq!(folder_of("t-reg-a"), None);
        forget("t-reg-b");
        assert_eq!(folder_of("t-reg-b"), None);
        assert_eq!(codex_trust_offer("t-reg-never".into()).map(|o| o.folder), None);
    }

    #[test]
    fn codex_user_trust_offer_text_is_the_warning_constant() {
        register("t-offer", Some("C:\\w".into()));
        let o = codex_trust_offer("t-offer".into()).unwrap();
        assert_eq!((o.folder.as_str(), o.text.as_str()), ("C:\\w", UNTRUSTED_FOLDER_WARNING));
        forget("t-offer");
    }
}
