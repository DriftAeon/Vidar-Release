//! src-tauri\src\bare\home.rs — the Vidar agent home: where it lives, its
//! private ACL, the per-home lock, and the settings generated into it from the profile template.
//!
//! Location (D2b): `%LOCALAPPDATA%\Vidar\homes\<install-root-key>`, the key being the Falcon host's
//! root suffix. `LOCALAPPDATA` is read from the env, never a known-folder API (the S5b audit saw
//! vidar.exe open the real `AppData\Local` despite the env redirect, NOTES 18:4x), so a sandbox's
//! redirected LOCALAPPDATA keeps its homes inside the sandbox. Every consumer resolves the home
//! through `resolve`; tools/lib/agent-env.mjs `resolveHome` is the byte-identical JS twin.
//!
//! ACL: on the trial machine every candidate folder inherits Modify for `CodexSandboxUsers` and
//! unresolved SIDs, so a missing `homes\` is created with a protected DACL (inheritance broken)
//! granting only the current user, SYSTEM and Administrators, then read back. An existing folder
//! whose DACL holds anyone else is refused, never re-ACLed: the user decides (NOTES 18:5x).
//! Win32 (`windows` crate, `Win32_Security` + `Win32_Storage_FileSystem`, both already enabled):
//! `CreateDirectoryW` with a `SECURITY_ATTRIBUTES` built by `InitializeAcl`/`AddAccessAllowedAceEx`/
//! `SetSecurityDescriptorControl(SE_DACL_PROTECTED)`, so the folder never exists with the inherited
//! ACL even for an instant; `GetFileSecurityW` + `GetAce` + `EqualSid` for the read-back.

use std::fs::{File, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::codex_mcp::{self, Tables as McpTables};

/// The pure placement (`home_path.rs`), shared by `#[path]` with the Falcon shell.
pub use super::home_path::resolve_for;

/// This install's home. `LOCALAPPDATA` comes from the process env, never a known-folder API (the
/// sandbox redirects it into its fake profile; the S5b audit saw known-folder calls escape).
pub fn resolve() -> Result<PathBuf, String> {
    let lad = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(|| "LOCALAPPDATA is unset or not absolute; the bare home cannot be placed".to_string())?;
    Ok(resolve_for(&crate::paths::root(), &lad))
}

/// Refuses a home under a sync client's root: credentials would leave the machine.
pub fn refuse_sync_root(home: &Path) -> Result<(), String> {
    let h = norm(&home.to_string_lossy());
    for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(root) = std::env::var_os(var).map(|v| norm(&v.to_string_lossy())).filter(|r| !r.is_empty()) {
            if h == root || h.starts_with(&format!("{}\\", root.trim_end_matches('\\'))) {
                return Err(format!("Bare home {} sits under {var}; refused (sync roots carry credentials off the machine)", home.display()));
            }
        }
    }
    Ok(())
}

/// Creates `homes\` private when missing, refuses it when its DACL is wider, then creates `dirs`
/// under it (they inherit the private DACL) and checks each the same way.
pub fn prepare_dirs(home: &Path, dirs: &[String]) -> Result<(), String> {
    refuse_sync_root(home)?;
    if !home.exists() {
        if let Some(parent) = home.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Bare home parent {}: {e}", parent.display()))?;
        }
        acl::create_private_dir(home, &[])?;
    }
    let caps = super::codex_caps::cap_sids(home);
    acl::check_private_allowing(home, &caps)?;
    for d in dirs {
        let p = home.join(d);
        std::fs::create_dir_all(&p).map_err(|e| format!("Bare home folder {}: {e}", p.display()))?;
        acl::check_private_allowing(&p, &caps)?;
    }
    probe_writable(home)
}

/// Create, replace and delete a probe file in the home as the normal user.
fn probe_writable(home: &Path) -> Result<(), String> {
    let p = home.join(".vidar-probe");
    let step = |what: &str, r: std::io::Result<()>| r.map_err(|e| format!("Bare home {} is not writable ({what}): {e}", home.display()));
    step("create", std::fs::write(&p, b"a"))?;
    step("replace", std::fs::write(&p, b"b"))?;
    step("delete", std::fs::remove_file(&p))
}

/// Held while a launch generates into the home. An exclusive (share-mode 0) open of
/// `<home>\.vidar-lock`: a second opener gets a sharing violation and waits, and the OS releases
/// the lock if Vidar dies, so a crash never leaves a stale lock behind.
pub struct HomeLock {
    _file: File,
}

pub const LOCK_WAIT: Duration = Duration::from_secs(5);

pub fn lock(home: &Path, wait: Duration) -> Result<HomeLock, String> {
    let path = home.join(".vidar-lock");
    let deadline = Instant::now() + wait;
    loop {
        match OpenOptions::new().read(true).write(true).create(true).share_mode(0).open(&path) {
            Ok(f) => return Ok(HomeLock { _file: f }),
            // ERROR_SHARING_VIOLATION (32): another launch holds it.
            Err(e) if e.raw_os_error() == Some(32) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25))
            }
            Err(e) => return Err(format!("Bare home lock {}: {e}", path.display())),
        }
    }
}

/// What generated files must not hold (beyond the root and home themselves): Vidar's own
/// `USERPROFILE` and the account name.
pub struct Guard {
    pub user_profile: Option<String>,
    pub username: Option<String>,
}

impl Guard {
    pub fn from_vidar_env() -> Guard {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Guard { user_profile: get("USERPROFILE"), username: get("USERNAME") }
    }
}

/// Lowercase, backslashes, and an MSYS drive path (`/c/Users/...`, at the start or after a
/// separator such as a space or quote) read as `c:\Users\...`, so the profile compare catches it.
pub(crate) fn norm(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 4);
    let mut i = 0;
    while i < b.len() {
        let starts = i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b"._-~/\\:".contains(&b[i - 1]));
        if starts && b[i] == b'/' && b.get(i + 1).is_some_and(u8::is_ascii_alphabetic) && b.get(i + 2) == Some(&b'/') {
            out.push(b[i + 1] as char);
            out.push_str(":\\");
            i += 3;
            continue;
        }
        let c = s[i..].chars().next().unwrap_or_default();
        out.push(c);
        i += c.len_utf8();
    }
    out.replace('/', "\\").to_lowercase()
}

/// `{{root}}` and `{{home}}` substituted in every string of the template.
fn substitute(v: &mut Value, root: &str, home: &str) {
    match v {
        Value::String(s) => *s = s.replace("{{root}}", root).replace("{{home}}", home),
        Value::Array(a) => a.iter_mut().for_each(|x| substitute(x, root, home)),
        Value::Object(o) => o.values_mut().for_each(|x| substitute(x, root, home)),
        _ => {}
    }
}

fn strings<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
    match v {
        Value::String(s) => out.push(s),
        Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
        Value::Object(o) => {
            for (k, x) in o {
                out.push(k);
                strings(x, out);
            }
        }
        _ => {}
    }
}

/// `needle` (case-insensitive) in `hay` as a whole word with a `\` or `/` right next to it on at
/// least one side: a path position, so ordinary words (`exit quill`, `a-quill-b`) never match.
fn has_token(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let (hay, needle) = (hay.to_lowercase(), needle.to_lowercase());
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let sep = |c: Option<char>| matches!(c, Some('\\' | '/'));
    hay.match_indices(needle.as_str()).any(|(i, m)| {
        let (prev, next) = (hay[..i].chars().next_back(), hay[i + m.len()..].chars().next());
        !word(prev) && !word(next) && (sep(prev) || sep(next))
    })
}

/// The parsed-back file: same top-level keys as the template, hook events still arrays of
/// matcher objects, no placeholder left, no user-profile path or username
/// outside the root and home paths.
pub fn validate(generated: &Value, template: &Value, root: &str, home: &str, guard: &Guard) -> Result<(), String> {
    let (Some(g), Some(t)) = (generated.as_object(), template.as_object()) else {
        return Err("Bare settings: not a JSON object".into());
    };
    let mut gk: Vec<&String> = g.keys().collect();
    let mut tk: Vec<&String> = t.keys().collect();
    gk.sort();
    tk.sort();
    if gk != tk {
        return Err("Bare settings: keys differ from the template".into());
    }
    if let Some(hooks) = g.get("hooks") {
        let ok = hooks.as_object().is_some_and(|h| {
            h.values().all(|ev| {
                ev.as_array().is_some_and(|m| m.iter().all(|x| x.get("hooks").is_some_and(Value::is_array)))
            })
        });
        if !ok {
            return Err("Bare settings: every hook event must be an array of matchers".into());
        }
    }
    let mut all = Vec::new();
    strings(generated, &mut all);
    guard_strings(&all, root, home, guard, "Bare settings")
}

/// No placeholder left, and no user-profile path or account name outside the root and home paths,
/// in any of `all` (a generated file's keys and string values).
pub(super) fn guard_strings(all: &[&str], root: &str, home: &str, guard: &Guard, label: &str) -> Result<(), String> {
    let (root, home) = (norm(root), norm(home));
    let profile = guard.user_profile.as_deref().map(norm);
    let user = guard.username.as_deref().map(str::to_lowercase);
    for s in all {
        if s.contains("{{") {
            return Err(format!("{label}: unsubstituted placeholder in {s:?}"));
        }
        let mut rest = norm(s);
        for p in [&root, &home] {
            if !p.is_empty() {
                rest = rest.replace(p.as_str(), "<path>");
            }
        }
        if profile.as_ref().is_some_and(|p| rest.contains(p.as_str())) {
            return Err(format!("{label}: holds the user-profile path"));
        }
        if user.as_ref().is_some_and(|u| has_token(&rest, u)) {
            return Err(format!("{label}: holds the account name"));
        }
    }
    Ok(())
}

/// One imported rune brick through the payload's own guard (onboarding D7): `username: None`, as
/// `layer::build_payload` calls it, with the real root and home strings so Bare-home paths pass.
/// Refuses a `{{` placeholder or a user-profile path, as the payload build would.
#[allow(dead_code)] // the onboarding importer (W2) calls it per brick
pub(crate) fn guard_brick(body: &str, root: &str, home: &str, guard: &Guard) -> Result<(), String> {
    let no_name = Guard { user_profile: guard.user_profile.clone(), username: None };
    guard_strings(&[body], root, home, &no_name, "Rune brick")
}

/// Template -> substituted, guard copies appended (`guards.rs`) -> temp file + rename -> read back and validated; any failure refuses.
#[cfg(test)]
pub fn generate_settings(template_path: &Path, target: &Path, root: &Path, home: &Path, guard: &Guard, hooks: &[super::guards::HookEntry]) -> Result<(), String> {
    generate_settings_with(template_path, target, root, home, guard, hooks, &SettingsExtras::default())
}

/// What a launch's sets add to the baseline settings.json (fold W2 L2a; `Loadout.permissions` and
/// `Loadout.output_style`): rules appended to `permissions.allow` / `.ask` (no duplicates), the
/// set's permission mode as `permissions.defaultMode`, its output style as top-level `outputStyle`.
#[derive(Debug, Default, Clone)]
pub struct SettingsExtras {
    pub allow: Vec<String>,
    pub ask: Vec<String>,
    pub mode: Option<String>,
    pub output_style: Option<super::rune_items::OutputStyle>,
    /// The vault's model rune, as top-level `model` (the session's default model).
    pub model: Option<String>,
}

/// `generate_settings` plus a launch's `extras`. The file is written only when its bytes differ;
/// it is always read back and validated (the template's keys plus `outputStyle` when one is set).
pub fn generate_settings_with(
    template_path: &Path,
    target: &Path,
    root: &Path,
    home: &Path,
    guard: &Guard,
    hooks: &[super::guards::HookEntry],
    extras: &SettingsExtras,
) -> Result<(), String> {
    let text = crate::fsx::read_text(template_path).map_err(|e| format!("Bare settings template {}: {e}", template_path.display()))?;
    let mut template: Value = serde_json::from_str(crate::fsx::strip_bom(&text))
        .map_err(|e| format!("Bare settings template {}: {e}", template_path.display()))?;
    let (root_s, home_s) = (root.to_string_lossy().into_owned(), home.to_string_lossy().into_owned());
    let mut generated = template.clone();
    substitute(&mut generated, &root_s, &home_s);
    super::guards::append(&mut generated, hooks)?;
    apply_extras(&mut generated, extras)?;
    // A body-carrying style's file beside the settings (`<config dir>\output-styles\<id>.md`), when its bytes differ.
    // Every other `*.md` there is a previous launch's style and goes, but only inside the Bare home.
    if let Some(dir) = target.parent().map(|d| d.join("output-styles")) {
        super::rune_items::OutputStyle::sync_dir(extras.output_style.as_ref(), &dir, home)?;
    }
    if let (Some(style), Some(t)) = (&extras.output_style, template.as_object_mut()) {
        t.insert("outputStyle".into(), Value::String(style.name.clone()));
    }
    if let (Some(m), Some(t)) = (&extras.model, template.as_object_mut()) { t.insert("model".into(), Value::String(m.clone())); }
    let bytes = serde_json::to_vec_pretty(&generated).map_err(|e| e.to_string())?;
    if std::fs::read(target).ok().as_deref() != Some(bytes.as_slice()) {
        crate::fsx::atomic_write(target, &bytes).map_err(|e| format!("Bare settings {}: {e}", target.display()))?;
    }
    let back = crate::fsx::read_text(target).map_err(|e| format!("Bare settings read-back {}: {e}", target.display()))?;
    let back: Value = serde_json::from_str(&back).map_err(|e| format!("Bare settings read-back {}: {e}", target.display()))?;
    validate(&back, &template, &root_s, &home_s, guard)
}

fn apply_extras(settings: &mut Value, extras: &SettingsExtras) -> Result<(), String> {
    let obj = settings.as_object_mut().ok_or("Bare settings: not a JSON object")?;
    if !extras.allow.is_empty() || !extras.ask.is_empty() || extras.mode.is_some() {
        let perms = obj.entry("permissions").or_insert_with(|| serde_json::json!({}));
        let perms = perms.as_object_mut().ok_or("Bare settings: permissions is not an object")?;
        for (key, add) in [("allow", &extras.allow), ("ask", &extras.ask)] {
            if add.is_empty() {
                continue;
            }
            let list = perms.entry(key).or_insert_with(|| Value::Array(Vec::new()));
            let list = list.as_array_mut().ok_or_else(|| format!("Bare settings: permissions.{key} is not a list"))?;
            for rule in add {
                if !list.iter().any(|v| v.as_str() == Some(rule.as_str())) {
                    list.push(Value::String(rule.clone()));
                }
            }
        }
        if let Some(mode) = &extras.mode {
            perms.insert("defaultMode".into(), Value::String(mode.clone()));
        }
    }
    if let Some(style) = &extras.output_style {
        obj.insert("outputStyle".into(), Value::String(style.name.clone()));
    }
    if let Some(m) = &extras.model { obj.insert("model".into(), Value::String(m.clone())); }
    Ok(())
}

/// A value of the TOML subset the Codex template uses: basic strings, integers, booleans and
/// one-line arrays of those.
#[derive(Debug, Clone, PartialEq)]
pub enum Toml {
    Str(String),
    Int(i64),
    Bool(bool),
    Array(Vec<Toml>),
}

/// `table.key` (or `key` before the first header) -> value, in file order.
pub type TomlDoc = Vec<(String, Toml)>;

pub use super::home_toml::toml_escape;

fn bare_key(k: &str) -> bool {
    !k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn skip_ws(c: &mut std::iter::Peekable<std::str::Chars>) {
    while c.peek().is_some_and(|ch| *ch == ' ' || *ch == '\t') {
        c.next();
    }
}

fn toml_value(c: &mut std::iter::Peekable<std::str::Chars>) -> Result<Toml, String> {
    skip_ws(c);
    match c.peek().copied() {
        Some('"') => {
            c.next();
            let mut s = String::new();
            loop {
                match c.next().ok_or("unterminated string")? {
                    '"' => return Ok(Toml::Str(s)),
                    '\\' => match c.next().ok_or("unterminated escape")? {
                        '\\' => s.push('\\'),
                        '"' => s.push('"'),
                        'n' => s.push('\n'),
                        'r' => s.push('\r'),
                        't' => s.push('\t'),
                        'b' => s.push('\u{8}'),
                        'f' => s.push('\u{c}'),
                        e @ ('u' | 'U') => {
                            let n = if e == 'u' { 4 } else { 8 };
                            let hex: String = (0..n).filter_map(|_| c.next()).collect();
                            let v = u32::from_str_radix(&hex, 16).map_err(|_| format!("bad \\{e} escape"))?;
                            s.push(char::from_u32(v).ok_or("bad unicode escape")?);
                        }
                        e => return Err(format!("unknown escape \\{e}")),
                    },
                    ch if (ch as u32) < 0x20 && ch != '\t' => return Err("control character in a string".into()),
                    ch => s.push(ch),
                }
            }
        }
        Some('[') => {
            c.next();
            let mut items = Vec::new();
            loop {
                skip_ws(c);
                if c.peek() == Some(&']') {
                    c.next();
                    return Ok(Toml::Array(items));
                }
                items.push(toml_value(c)?);
                skip_ws(c);
                match c.next() {
                    Some(',') => {}
                    Some(']') => return Ok(Toml::Array(items)),
                    _ => return Err("array: expected , or ]".into()),
                }
            }
        }
        Some(ch) if ch == 't' || ch == 'f' => {
            let word: String = std::iter::from_fn(|| c.next_if(|x| x.is_ascii_alphabetic())).collect();
            match word.as_str() {
                "true" => Ok(Toml::Bool(true)),
                "false" => Ok(Toml::Bool(false)),
                w => Err(format!("unknown value {w:?}")),
            }
        }
        Some(ch) if ch == '-' || ch == '+' || ch.is_ascii_digit() => {
            let num: String = std::iter::from_fn(|| c.next_if(|x| *x == '-' || *x == '+' || x.is_ascii_digit())).collect();
            num.parse().map(Toml::Int).map_err(|_| format!("bad integer {num:?}"))
        }
        _ => Err("unsupported value".into()),
    }
}

/// A header after its `[`: dotted parts, each a bare key, a `'literal'` or a `"basic"` string (the
/// decoded text joins the table name). `None` for anything else, `[[array]]` tables included. A `.`
/// inside a quoted part is refused (the joined name would read as a different table) except as the
/// second part of a `projects` header or the third of a `hooks.state` one, where it is a path.
fn table_header(rest: &str) -> Option<String> {
    let mut c = rest.chars().peekable();
    let mut parts: Vec<String> = Vec::new();
    let dotted_ok = |parts: &[String], s: &str| {
        !s.contains('.') || (parts.len() == 1 && parts[0] == "projects") || (parts.len() == 2 && parts[0] == "hooks" && parts[1] == "state")
    };
    loop {
        skip_ws(&mut c);
        match c.peek().copied()? {
            '"' => match toml_value(&mut c).ok()? {
                Toml::Str(s) if dotted_ok(&parts, &s) => parts.push(s),
                _ => return None,
            },
            '\'' => {
                c.next();
                let mut s = String::new();
                loop {
                    match c.next()? {
                        '\'' => break,
                        ch if (ch as u32) < 0x20 && ch != '\t' => return None,
                        ch => s.push(ch),
                    }
                }
                if !dotted_ok(&parts, &s) {
                    return None;
                }
                parts.push(s);
            }
            _ => {
                let word: String = std::iter::from_fn(|| c.next_if(|x| x.is_ascii_alphanumeric() || *x == '_' || *x == '-')).collect();
                if !bare_key(&word) {
                    return None;
                }
                parts.push(word);
            }
        }
        skip_ws(&mut c);
        match c.next()? {
            '.' => {}
            ']' => break,
            _ => return None,
        }
    }
    skip_ws(&mut c);
    match c.peek() {
        None | Some('#') => Some(parts.join(".")),
        _ => None,
    }
}

/// Parses the TOML subset of the generated config.toml: comment lines, `[table]` and dotted
/// `[a.b.c]` headers (every part a bare key, a literal or a basic string) and one-line `key = value`
/// pairs. Anything else is an error, so the parse-back refuses what it cannot read rather than
/// guessing.
pub fn parse_toml_lite(text: &str) -> Result<TomlDoc, String> {
    let mut table = String::new();
    let mut doc = TomlDoc::new();
    for (n, raw) in text.lines().enumerate() {
        let at = |e: String| format!("line {}: {e}", n + 1);
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            match table_header(rest) {
                Some(t) => table = t,
                None => return Err(at(format!("unsupported table header {line:?}"))),
            }
            continue;
        }
        let (key, value) = line.split_once('=').ok_or_else(|| at("expected key = value".into()))?;
        let key = key.trim();
        if !bare_key(key) {
            return Err(at(format!("unsupported key {key:?}")));
        }
        let mut c = value.chars().peekable();
        let v = toml_value(&mut c).map_err(at)?;
        skip_ws(&mut c);
        if c.peek().is_some_and(|ch| *ch != '#') {
            return Err(at("trailing text after the value".into()));
        }
        let full = if table.is_empty() { key.to_string() } else { format!("{table}.{key}") };
        if doc.iter().any(|(k, _)| *k == full) {
            return Err(at(format!("duplicate key {full}")));
        }
        doc.push((full, v));
    }
    Ok(doc)
}

/// `{{name}}` tokens replaced in one pass (a value is never re-scanned); unknown names are kept,
/// so the guard refuses them.
fn fill_placeholders(text: &str, values: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("{{") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        match after.find("}}").map(|j| (&after[..j], j)) {
            Some((name, j)) if values.iter().any(|(n, _)| *n == name) => {
                out.push_str(&values.iter().find(|(n, _)| *n == name).unwrap().1);
                rest = &after[j + 2..];
            }
            _ => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The vidar-drive server's `env_vars`, by name only: the in-process tab's control token, and the
/// session id and secret Falcon pushes for a hosted tab (`tools/control/client.mjs` reads either).
pub const CTL_ENV_VARS: &[&str] = &["VIDAR_CTL_TOKEN", "FALCON_SESSION", "VIDAR_CTL_SECRET"];

/// The parsed-back Codex config: the template's keys exactly, the isolation keys at their bare
/// values, `developer_instructions` = the payload, `notify`
/// ending in the repo's `tools\desks\codex-notify.ps1` by absolute path, and no user-profile path
/// or username outside the root and home paths. `pwsh` is the absolute pwsh Vidar resolved for
/// `notify` (Codex runs notify outside its sandbox, with the bare `Path` that no longer holds the
/// Store alias); it is often the per-user alias, so that exact argv entry is exempt from the guard.
#[cfg(test)]
pub fn validate_codex(doc: &TomlDoc, template: &TomlDoc, root: &Path, home: &Path, pwsh: &Path, payload: &str, guard: &Guard) -> Result<(), String> {
    validate_codex_for(doc, template, root, home, pwsh, payload, guard, None, &McpTables::default())
}

/// A folder path compared by text: trimmed, `\\?\` stripped, `/` to `\`, trailing `\` dropped,
/// lowercased. A drive root comes out as `c:`. Shared by `refuse_profile_cwd` and the trust key.
pub fn norm_cwd(p: &str) -> String {
    let p = p.trim().trim_start_matches(r"\\?\").replace('/', "\\");
    p.trim_end_matches('\\').to_lowercase()
}

/// The launch folder as Codex's `[projects]` key: `norm_cwd` with a drive root keeping its `\`.
/// `None` for an empty folder (no entry is written).
pub fn trusted_project_key(cwd: &str) -> Option<String> {
    let mut k = norm_cwd(cwd);
    if k.len() == 2 && k.ends_with(':') {
        k.push('\\');
    }
    (!k.is_empty()).then_some(k)
}

/// The `[projects.<key>]` table the launch folder's trust rides in: a TOML literal key, or a basic
/// string with escapes when the path holds a `'` or a control character.
pub(crate) fn trusted_project_table(key: &str) -> String {
    let literal = !key.chars().any(|c| c == '\'' || (c as u32) < 0x20 || c as u32 == 0x7f);
    let k = if literal { format!("'{key}'") } else { format!("\"{}\"", toml_escape(key)) };
    format!("[projects.{k}]\ntrust_level = \"trusted\"\n")
}

/// `validate_codex` with the launch folder's trust entry: `trusted` is `trusted_project_key`'s
/// output. When given, the doc holds exactly one `projects.<trusted>.trust_level = "trusted"` and no
/// other `projects.*` key; when `None`, any `projects.*` key refuses. Test-only: the generator
/// validates through `validate_codex_with`.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub fn validate_codex_for(doc: &TomlDoc, template: &TomlDoc, root: &Path, home: &Path, pwsh: &Path, payload: &str, guard: &Guard, trusted: Option<&str>, mcp: &McpTables) -> Result<(), String> {
    validate_codex_with(doc, template, root, home, pwsh, payload, guard, trusted, mcp, &HookTrust::default())
}

/// Trust records for Vidar's own Codex hooks (`codex_hooks.rs`): `hooks_json` is the file every key
/// must name (`<hooks.json path>:<snake_event>:<group>:<handler>`, Codex's key shape), `entries` the
/// `(key, currentHash)` pairs `hooks/list` reported for it. A repo's own `.codex/hooks.json` never
/// gets here: its keys name another file.
#[derive(Default, Clone, Copy)]
pub struct HookTrust<'a> {
    pub hooks_json: Option<&'a Path>,
    pub entries: &'a [(String, String)],
}

impl HookTrust<'_> {
    /// The `hooks.state.<key>.trusted_hash` pairs these records write, each checked first: the key
    /// names `hooks_json` (case-insensitive) and the hash is `sha256:<64 hex>`.
    fn pairs(&self) -> Result<Vec<(String, Toml)>, String> {
        if self.entries.is_empty() {
            return Ok(Vec::new());
        }
        let file = self.hooks_json.ok_or("hook trust without its hooks.json")?;
        let prefix = format!("{}:", file.to_string_lossy()).to_lowercase();
        self.entries
            .iter()
            .map(|(k, h)| {
                let lk = k.to_lowercase();
                if !lk.starts_with(&prefix) || lk[prefix.len()..].contains(['\\', '/']) {
                    return Err(format!("hook trust key {k:?} does not name {}", file.display()));
                }
                let hex = h.strip_prefix("sha256:").unwrap_or_default();
                if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(format!("hook trust hash {h:?} for {k:?} is not sha256:<hex>"));
                }
                Ok((format!("hooks.state.{k}.trusted_hash"), Toml::Str(h.clone())))
            })
            .collect()
    }

    /// The `[hooks.state."<key>"]` tables, in entry order.
    fn tables(&self) -> String {
        self.entries.iter().map(|(k, h)| format!("\n[hooks.state.\"{}\"]\ntrusted_hash = \"{}\"\n", toml_escape(k), toml_escape(h))).collect()
    }
}

/// `validate_codex_for` with Vidar's hook trust: the doc's `hooks.*` keys are exactly `trust`'s
/// `hooks.state."<key>".trusted_hash` pairs at their hashes (none when `trust` is empty).
#[allow(clippy::too_many_arguments)]
pub fn validate_codex_with(doc: &TomlDoc, template: &TomlDoc, root: &Path, home: &Path, pwsh: &Path, payload: &str, guard: &Guard, trusted: Option<&str>, mcp: &McpTables, trust: &HookTrust) -> Result<(), String> {
    const L: &str = "Bare Codex config";
    if !pwsh.is_absolute() {
        return Err(format!("{L}: pwsh {} is not an absolute path; spawn refused", pwsh.display()));
    }
    let pwsh_s = pwsh.to_string_lossy().into_owned();
    let proj: Vec<&(String, Toml)> = doc.iter().filter(|(k, _)| k.starts_with("projects.")).collect();
    match (trusted, proj.as_slice()) {
        (None, []) => {}
        (None, _) => return Err(format!("{L}: a projects table is not allowed; spawn refused")),
        (Some(t), [(k, v)]) if *k == format!("projects.{t}.trust_level") && *v == Toml::Str("trusted".into()) => {}
        (Some(_), _) => return Err(format!("{L}: [projects] must hold the launch folder with trust_level = \"trusted\" only; spawn refused")),
    }
    // Hook trust: Vidar's own keys at the hashes hooks/list gave, nothing else under `hooks.`.
    let mut want = trust.pairs().map_err(|e| format!("{L}: {e}; spawn refused"))?;
    let mut have: Vec<(String, Toml)> = doc.iter().filter(|(k, _)| k.starts_with("hooks.")).cloned().collect();
    want.sort_by(|a, b| a.0.cmp(&b.0));
    have.sort_by(|a, b| a.0.cmp(&b.0));
    if have != want {
        return Err(format!("{L}: hooks tables must be the trust records of Vidar's own hooks.json only; spawn refused"));
    }
    let mut gk: Vec<&String> = doc.iter().map(|(k, _)| k).filter(|k| !k.starts_with("projects.") && !k.starts_with("hooks.")).collect();
    let extra = mcp.keys();
    let mut tk: Vec<&String> = template.iter().map(|(k, _)| k).chain(extra.iter()).collect();
    gk.sort();
    tk.sort();
    if gk != tk {
        return Err(format!("{L}: keys differ from the template"));
    }
    let get = |k: &str| doc.iter().find(|(n, _)| n == k).map(|(_, v)| v);
    let pins = [
        ("project_doc_max_bytes", Toml::Int(0)),
        // [] makes the launch folder Codex's project root, so the cwd key is the one Codex checks.
        ("project_root_markers", Toml::Array(vec![])),
        ("developer_instructions", Toml::Str(payload.to_string())),
        ("skills.include_instructions", Toml::Bool(false)),
        ("windows.sandbox", Toml::Str("unelevated".into())),
        ("sandbox_mode", Toml::Str("workspace-write".into())),
        ("suppress_unstable_features_warning", Toml::Bool(true)),
        ("cli_auth_credentials_store", Toml::Str("file".into())),
        // The keyring service name has no home in it, so Bare and `~\.codex` MCP tokens would collide.
        ("mcp_oauth_credentials_store", Toml::Str("file".into())),
        ("sandbox_workspace_write.writable_roots", Toml::Array(vec![])),
        ("sandbox_workspace_write.network_access", Toml::Bool(false)),
        ("sandbox_workspace_write.exclude_tmpdir_env_var", Toml::Bool(true)),
        ("sandbox_workspace_write.exclude_slash_tmp", Toml::Bool(true)),
        ("features.daemon_auto_start", Toml::Bool(false)),
        ("features.prefer_mxc", Toml::Bool(true)),
    ];
    for (k, want) in &pins {
        if get(k) != Some(want) {
            return Err(format!("{L}: {k} must be {want:?}; spawn refused"));
        }
    }
    // notify: the template's argv with the root filled in, ending in an absolute codex-notify.ps1.
    let (root_s, home_s) = (root.to_string_lossy().into_owned(), home.to_string_lossy().into_owned());
    let want = template.iter().find(|(n, _)| n == "notify").map(|(_, v)| match v {
        Toml::Array(a) => Toml::Array(a.iter().map(|x| match x {
            Toml::Str(s) => Toml::Str(s.replace("{{root}}", &root_s).replace("{{home}}", &home_s).replace("{{pwsh}}", &pwsh_s)),
            x => x.clone(),
        }).collect()),
        x => x.clone(),
    });
    let notify_script = super::codex_caps::NOTIFY_SCRIPT;
    match get("notify") {
        Some(Toml::Array(argv))
            if Some(&Toml::Array(argv.clone())) == want.as_ref()
                && matches!(argv.last(), Some(Toml::Str(s)) if s.ends_with(notify_script) && Path::new(s).is_absolute()) => {}
        _ => return Err(format!("{L}: notify must be the template's argv ending in an absolute codex-notify.ps1")),
    }
    // The stock vidar-drive rune adds this pinned table only for vaults that carry it. Its
    // env_vars name the control identity; no token value is written into the table or argv.
    // The vault's other MCP tables are compared against exactly what the launch wrote.
    let hosted_keys = extra.clone();
    let is_hosted = |k: &String| hosted_keys.contains(k);
    if doc.iter().any(|(k, _)| k.starts_with("mcp_servers.") && !is_hosted(k)) {
        const T: &str = "mcp_servers.vidar_drive.";
        let server = format!("{root_s}\\tools\\mcp\\vidar-drive\\server.mjs");
        let mcp_pins = [
            ("command", Toml::Str("node".into())),
            ("args", Toml::Array(vec![Toml::Str(server)])),
            ("env_vars", Toml::Array(CTL_ENV_VARS.iter().map(|v| Toml::Str((*v).into())).collect())),
            ("tool_timeout_sec", Toml::Int(3700)),
        ];
        for (k, _) in doc.iter().filter(|(k, _)| k.starts_with("mcp_servers.") && !is_hosted(k)) {
            match k.strip_prefix(T) {
                Some(f) if mcp_pins.iter().any(|(n, _)| *n == f) => {}
                Some(_) => return Err(format!("{L}: {k} is not a pinned vidar_drive key; spawn refused")),
                None => return Err(format!("{L}: {k}: only mcp_servers.vidar_drive is allowed; spawn refused")),
            }
        }
        for (f, want) in &mcp_pins {
            let k = format!("{T}{f}");
            if get(&k) != Some(want) {
                return Err(format!("{L}: {k} must be {want:?}; spawn refused"));
            }
        }
    }
    codex_mcp::check(doc, mcp)?;
    let mut all: Vec<&str> = Vec::new();
    let mut instr: Vec<&str> = Vec::new();
    fn walk<'a>(v: &'a Toml, out: &mut Vec<&'a str>) {
        match v {
            Toml::Str(s) => out.push(s),
            Toml::Array(a) => a.iter().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    for (k, v) in doc {
        // The trust entry is pinned above to the launch folder, which may sit under the profile;
        // the hook trust records above to the home's hooks.json and a hash.
        if k.starts_with("projects.") || k.starts_with("hooks.") {
            continue;
        }
        all.push(k);
        // `developer_instructions` and `notify` are pinned above to repo text (the payload holds
        // whole words like `user` and `codex`; the notify path ends in `codex-notify.ps1`); only
        // their profile-path check applies, not the account name.
        if k == "notify" {
            // argv[0] is pinned above to the pwsh Vidar resolved; the rest is still checked.
            if let Toml::Array(a) = v {
                a.iter().filter(|x| !matches!(x, Toml::Str(s) if *s == pwsh_s)).for_each(|x| walk(x, &mut instr));
            }
            continue;
        }
        // The launch's MCP values are exact-compared by `codex_mcp::check` against what Vidar wrote
        // from its catalogue and the spawning env; a username inside one (a user named `notion`, a
        // `P4USER`) is not a leak. A user-profile path in one still refuses.
        let pinned = k == "developer_instructions" || hosted_keys.contains(k);
        walk(v, if pinned { &mut instr } else { &mut all });
    }
    let (root_s, home_s) = (root.to_string_lossy(), home.to_string_lossy());
    guard_strings(&all, &root_s, &home_s, guard, L)?;
    let no_name = Guard { user_profile: guard.user_profile.clone(), username: None };
    guard_strings(&instr, &root_s, &home_s, &no_name, L)
}

/// Template -> placeholders filled with TOML-escaped values -> temp file + rename over `target`
/// -> parsed back and validated. Any failure refuses the spawn; nothing falls back.
#[cfg(test)]
pub fn generate_codex_config(template_path: &Path, target: &Path, root: &Path, home: &Path, pwsh: &Path, payload: &str, guard: &Guard) -> Result<(), String> {
    generate_codex_config_for(template_path, target, root, home, pwsh, payload, guard, None, &McpTables::default())
}

/// `generate_codex_config` plus a trusted `[projects]` entry for the launch folder `cwd` (Codex
/// would otherwise ask about trusting it at every start, since this file is rewritten per launch).
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub fn generate_codex_config_for(template_path: &Path, target: &Path, root: &Path, home: &Path, pwsh: &Path, payload: &str, guard: &Guard, cwd: Option<&str>, mcp: &McpTables) -> Result<(), String> {
    generate_codex_config_with(template_path, target, root, home, pwsh, payload, guard, cwd, mcp, &HookTrust::default(), None)
}

/// `generate_codex_config_for` plus the `[hooks.state."<key>"]` trust tables of Vidar's own hooks
/// (`codex_hooks::trust`), validated by `validate_codex_with`, and the vault's model rune: a
/// top-level `model = "..."` written before the first table and mirrored into the template for the
/// key check. `None` writes nothing.
#[allow(clippy::too_many_arguments)]
pub fn generate_codex_config_with(template_path: &Path, target: &Path, root: &Path, home: &Path, pwsh: &Path, payload: &str, guard: &Guard, cwd: Option<&str>, mcp: &McpTables, trust: &HookTrust, model: Option<&str>) -> Result<(), String> {
    let text = crate::fsx::read_text(template_path).map_err(|e| format!("Bare Codex template {}: {e}", template_path.display()))?;
    let text = crate::fsx::strip_bom(&text);
    let mut template = parse_toml_lite(text).map_err(|e| format!("Bare Codex template {}: {e}", template_path.display()))?;
    if let Some(m) = model { template.push(("model".into(), Toml::Str(m.into()))); }
    // The payload's own `{{root}}` (raw; the TOML escape below covers it); other names stay, so
    // the guard refuses them.
    let payload = &fill_placeholders(payload, &[("root", root.to_string_lossy().into_owned())]);
    let trusted = cwd.and_then(trusted_project_key);
    let mut filled = fill_placeholders(
        text,
        &[
            ("payload", toml_escape(payload)),
            ("root", toml_escape(&root.to_string_lossy())),
            ("home", toml_escape(&home.to_string_lossy())),
            ("pwsh", toml_escape(&pwsh.to_string_lossy())),
        ],
    );
    // Top-level keys precede every table, so the line goes first.
    if let Some(m) = model { filled.insert_str(0, &format!("model = \"{}\"\n", toml_escape(m))); }
    if !mcp.text.is_empty() {
        if !filled.ends_with('\n') {
            filled.push('\n');
        }
        filled.push('\n');
        filled.push_str(&mcp.text);
    }
    if let Some(key) = &trusted {
        if !filled.ends_with('\n') {
            filled.push('\n');
        }
        filled.push('\n');
        filled.push_str(&trusted_project_table(key));
    }
    if !trust.entries.is_empty() {
        // Checked before the write too: a key naming any other hooks.json never lands in config.toml.
        trust.pairs().map_err(|e| format!("Bare Codex config: {e}; spawn refused"))?;
        if !filled.ends_with('\n') {
            filled.push('\n');
        }
        filled.push_str(&trust.tables());
    }
    // An identical file is left as it is (no rename, no new timestamp); it is still read back and checked.
    if std::fs::read(target).ok().as_deref() != Some(filled.as_bytes()) {
        crate::fsx::atomic_write(target, filled.as_bytes()).map_err(|e| format!("Bare Codex config {}: {e}", target.display()))?;
    }
    let back = crate::fsx::read_text(target).map_err(|e| format!("Bare Codex config read-back {}: {e}", target.display()))?;
    let doc = parse_toml_lite(&back).map_err(|e| format!("Bare Codex config read-back {}: {e}", target.display()))?;
    validate_codex_with(&doc, &template, root, home, pwsh, payload, guard, trusted.as_deref(), mcp, trust)
}

/// The Raw Codex line's built payload as a profile file: `<codex_home>\vidar-<hash12>.config.toml`
/// holding only `developer_instructions`, passed as `--profile vidar-<hash12>` (codex 0.163.0 reads
/// `--profile <name>` from `<CODEX_HOME>\<name>.config.toml`, and that value beats config.toml's static
/// payload: probed r1 2026-10-19 at 16,333 characters, no length cap). Content-addressed by the
/// text's hash12, so tabs on other rows never rewrite it. Written under the home lock, read back and
/// checked: one key, the text exact, no placeholder or user-profile path (the account name is
/// allowed, as in config.toml's `developer_instructions`). Returns the profile name.
pub fn write_codex_profile(_lock: &HomeLock, codex_home: &Path, text: &str, root: &Path, home: &Path, guard: &Guard) -> Result<String, String> {
    const L: &str = "Bare Codex profile";
    let no_name = Guard { user_profile: guard.user_profile.clone(), username: None };
    guard_strings(&[text], &root.to_string_lossy(), &home.to_string_lossy(), &no_name, L)?;
    let name = format!("vidar-{}", crate::rules::build::hash12(text.as_bytes()));
    let target = codex_home.join(format!("{name}.config.toml"));
    let body = format!("developer_instructions = \"{}\"\n", toml_escape(text));
    crate::fsx::atomic_write(&target, body.as_bytes()).map_err(|e| format!("{L} {}: {e}; Bare spawn refused", target.display()))?;
    let back = crate::fsx::read_text(&target).map_err(|e| format!("{L} read-back {}: {e}; Bare spawn refused", target.display()))?;
    let doc = parse_toml_lite(&back).map_err(|e| format!("{L} read-back {}: {e}; Bare spawn refused", target.display()))?;
    if doc != [("developer_instructions".to_string(), Toml::Str(text.to_string()))] {
        return Err(format!("{L} {}: must hold developer_instructions only, as built; Bare spawn refused", target.display()));
    }
    Ok(name)
}

/// Raises the Bare `.claude.json` seen-counters to the normal file's, so Claude's one-time notices
/// (`*UpsellSeenCount`, `*Dismissed`) a user already got in their own Claude do not return in the
/// separate Bare config dir. Reads `normal`, never writes it. Every `*UpsellSeenCount` becomes
/// max(normal, Bare); every `*Dismissed` that is true in `normal` becomes true. Other Bare keys stay;
/// a missing Bare file is created with just those keys; the write is atomic and only when a value
/// changes. `Ok(true)` when written. Any read or parse failure is an `Err` and touches nothing.
pub fn mirror_claude_seen(normal: &Path, bare: &Path) -> Result<bool, String> {
    let read = |p: &Path| -> Result<Value, String> {
        let text = crate::fsx::read_text(p).map_err(|e| format!("{}: {e}", p.display()))?;
        match serde_json::from_str::<Value>(crate::fsx::strip_bom(&text)) {
            Ok(v @ Value::Object(_)) => Ok(v),
            Ok(_) => Err(format!("{}: not a JSON object", p.display())),
            Err(e) => Err(format!("{}: {e}", p.display())),
        }
    };
    let Value::Object(from) = read(normal)? else { unreachable!() };
    let mut to = if bare.exists() { read(bare)? } else { Value::Object(Default::default()) };
    let obj = to.as_object_mut().expect("object");
    let mut changed = false;
    for (k, v) in &from {
        if k.ends_with("UpsellSeenCount") {
            let Some(n) = v.as_i64() else { continue };
            if obj.get(k).and_then(Value::as_i64).is_none_or(|have| have < n) {
                obj.insert(k.clone(), Value::from(n));
                changed = true;
            }
        } else if k.ends_with("Dismissed") && v.as_bool() == Some(true) && obj.get(k).and_then(Value::as_bool) != Some(true) {
            obj.insert(k.clone(), Value::Bool(true));
            changed = true;
        }
    }
    if changed {
        let bytes = serde_json::to_vec_pretty(&to).map_err(|e| format!("{}: {e}", bare.display()))?;
        crate::fsx::atomic_write(bare, &bytes).map_err(|e| format!("{}: {e}", bare.display()))?;
    }
    Ok(changed)
}

/// The `.claude.json` keys a set-combination home takes from the profile's own config dir
/// (`seed_claude_json`): the onboarding flags, so a new home does not rerun first-run setup.
const SEEDED_KEYS: [&str; 2] = ["hasCompletedOnboarding", "lastOnboardingVersion"];

/// Seeds a set-combination home's `.claude.json` (`combo`) from the profile's own (`legacy`), fold W2
/// L2a: each `SEEDED_KEYS` value and every project's `hasTrustDialogAccepted: true`, only where
/// `combo` lacks the key. Nothing else is read across (no account, user ID, servers or history), and
/// the file is never copied whole. A missing `legacy` seeds nothing; `Ok(true)` when written. A read
/// or parse failure is an `Err` and touches nothing.
pub fn seed_claude_json(legacy: &Path, combo: &Path) -> Result<bool, String> {
    let read = |p: &Path| -> Result<serde_json::Map<String, Value>, String> {
        let text = crate::fsx::read_text(p).map_err(|e| format!("{}: {e}", p.display()))?;
        match serde_json::from_str::<Value>(crate::fsx::strip_bom(&text)) {
            Ok(Value::Object(o)) => Ok(o),
            Ok(_) => Err(format!("{}: not a JSON object", p.display())),
            Err(e) => Err(format!("{}: {e}", p.display())),
        }
    };
    if !legacy.is_file() {
        return Ok(false);
    }
    let from = read(legacy)?;
    let mut to = if combo.exists() { read(combo)? } else { serde_json::Map::new() };
    let mut changed = false;
    for k in SEEDED_KEYS {
        if let (Some(v), false) = (from.get(k), to.contains_key(k)) {
            to.insert(k.to_string(), v.clone());
            changed = true;
        }
    }
    let trusted: Vec<&String> = from
        .get("projects")
        .and_then(Value::as_object)
        .map(|p| p.iter().filter(|(_, e)| e.get("hasTrustDialogAccepted").and_then(Value::as_bool) == Some(true)).map(|(k, _)| k).collect())
        .unwrap_or_default();
    if !trusted.is_empty() {
        let projects = to.entry("projects").or_insert_with(|| Value::Object(Default::default()));
        if let Some(projects) = projects.as_object_mut() {
            for k in trusted {
                let entry = projects.entry(k.clone()).or_insert_with(|| Value::Object(Default::default()));
                if let Some(e) = entry.as_object_mut().filter(|e| !e.contains_key("hasTrustDialogAccepted")) {
                    e.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
                    changed = true;
                }
            }
        }
    }
    if changed {
        let bytes = serde_json::to_vec_pretty(&Value::Object(to)).map_err(|e| format!("{}: {e}", combo.display()))?;
        crate::fsx::atomic_write(combo, &bytes).map_err(|e| format!("{}: {e}", combo.display()))?;
    }
    Ok(changed)
}

pub(crate) mod acl {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        AddAccessAllowedAceEx, CreateWellKnownSid, EqualSid, GetAce, GetAclInformation, GetFileSecurityW,
        GetLengthSid, GetSecurityDescriptorDacl, GetTokenInformation, InitializeAcl, InitializeSecurityDescriptor,
        SetFileSecurityW, SetSecurityDescriptorControl, SetSecurityDescriptorDacl, TokenUser, WinBuiltinAdministratorsSid,
        WinLocalSystemSid, AclSizeInformation, ACCESS_ALLOWED_ACE, ACE_FLAGS, ACE_HEADER, ACL, ACL_REVISION,
        ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SECURITY_MAX_SID_SIZE, SE_DACL_PROTECTED,
        TOKEN_QUERY, TOKEN_USER, WELL_KNOWN_SID_TYPE,
    };
    use windows::Win32::Storage::FileSystem::CreateDirectoryW;
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const FILE_ALL_ACCESS: u32 = 0x001F_01FF;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;

    /// A SID copied into DWORD-aligned storage.
    pub struct Sid(Vec<u32>);

    impl Sid {
        fn psid(&self) -> PSID {
            PSID(self.0.as_ptr() as *mut _)
        }
        fn len(&self) -> u32 {
            unsafe { GetLengthSid(self.psid()) }
        }
        unsafe fn copy_of(sid: PSID) -> Sid {
            let n = GetLengthSid(sid) as usize;
            let mut buf = vec![0u32; n.div_ceil(4)];
            std::ptr::copy_nonoverlapping(sid.0 as *const u8, buf.as_mut_ptr() as *mut u8, n);
            Sid(buf)
        }
    }

    pub fn well_known(kind: WELL_KNOWN_SID_TYPE) -> Result<Sid, String> {
        let mut n = SECURITY_MAX_SID_SIZE;
        let mut buf = vec![0u32; (n as usize).div_ceil(4)];
        unsafe { CreateWellKnownSid(kind, None, Some(PSID(buf.as_mut_ptr() as *mut _)), &mut n) }
            .map_err(|e| format!("CreateWellKnownSid: {e}"))?;
        Ok(Sid(buf))
    }

    fn current_user() -> Result<Sid, String> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|e| format!("OpenProcessToken: {e}"))?;
            let mut len = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
            let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
            let r = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr() as *mut _), len, &mut len);
            let _ = CloseHandle(token);
            r.map_err(|e| format!("GetTokenInformation: {e}"))?;
            let tu = &*(buf.as_ptr() as *const TOKEN_USER);
            Ok(Sid::copy_of(tu.User.Sid))
        }
    }

    /// The principals a home may grant: the current user, SYSTEM, Administrators.
    fn allowed() -> Result<Vec<Sid>, String> {
        Ok(vec![current_user()?, well_known(WinLocalSystemSid)?, well_known(WinBuiltinAdministratorsSid)?])
    }

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Builds a protected DACL granting full control to the allowed principals plus `extra`, each
    /// ACE carrying `flags`, and hands its security descriptor to `use_sd`.
    fn with_private_sd(extra: &[Sid], flags: ACE_FLAGS, use_sd: impl FnOnce(PSECURITY_DESCRIPTOR) -> Result<(), String>) -> Result<(), String> {
        let mut sids = allowed()?;
        sids.extend(extra.iter().map(|s| unsafe { Sid::copy_of(s.psid()) }));
        let ace_base = std::mem::size_of::<ACCESS_ALLOWED_ACE>() - std::mem::size_of::<u32>();
        let size = std::mem::size_of::<ACL>() + sids.iter().map(|s| ace_base + s.len() as usize).sum::<usize>();
        let mut acl_buf = vec![0u32; size.div_ceil(4)];
        let acl = acl_buf.as_mut_ptr() as *mut ACL;
        let mut sd = SECURITY_DESCRIPTOR::default();
        let psd = PSECURITY_DESCRIPTOR(&mut sd as *mut _ as *mut _);
        unsafe {
            InitializeAcl(acl, size as u32, ACL_REVISION).map_err(|e| format!("InitializeAcl: {e}"))?;
            for s in &sids {
                AddAccessAllowedAceEx(acl, ACL_REVISION, flags, FILE_ALL_ACCESS, s.psid()).map_err(|e| format!("AddAccessAllowedAceEx: {e}"))?;
            }
            InitializeSecurityDescriptor(psd, 1).map_err(|e| format!("InitializeSecurityDescriptor: {e}"))?;
            SetSecurityDescriptorDacl(psd, true, Some(acl), false).map_err(|e| format!("SetSecurityDescriptorDacl: {e}"))?;
            SetSecurityDescriptorControl(psd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
                .map_err(|e| format!("SetSecurityDescriptorControl: {e}"))?;
        }
        use_sd(psd)
    }

    /// Creates `dir` with a protected DACL: full control, inherited by children, for the allowed
    /// principals plus `extra` (tests only: a foreign ACE).
    pub fn create_private_dir(dir: &Path, extra: &[Sid]) -> Result<(), String> {
        with_private_sd(extra, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, |psd| {
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: psd.0,
                bInheritHandle: false.into(),
            };
            let w = wide(dir);
            unsafe { CreateDirectoryW(PCWSTR(w.as_ptr()), Some(&sa)) }.map_err(|e| format!("Bare home {}: create: {e}", dir.display()))
        })
    }

    /// Sets an existing file's DACL to an explicit protected one (the allowed principals, full
    /// control, no inherit flags), touching nothing else. Hardlinks share it: every name is set.
    pub fn set_private_file(file: &Path) -> Result<(), String> {
        with_private_sd(&[], ACE_FLAGS(0), |psd| {
            let w = wide(file);
            let info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
            match unsafe { SetFileSecurityW(PCWSTR(w.as_ptr()), info, psd) }.as_bool() {
                true => Ok(()),
                false => Err(format!("{}: cannot set its ACL: {}", file.display(), std::io::Error::last_os_error())),
            }
        })
    }

    /// Err when `dir`'s DACL is null or allows anyone beyond the allowed principals, or holds an
    /// ACE type this check does not understand. Deny ACEs only narrow access and are accepted.
    pub fn check_private(dir: &Path) -> Result<(), String> {
        check_private_allowing(dir, &[])
    }

    /// `S-1-<authority>-<sub>...` as a binary SID; None when it is not exactly that shape.
    pub fn parse_sid(text: &str) -> Option<Sid> {
        let mut parts = text.trim().split('-');
        if !parts.next()?.eq_ignore_ascii_case("S") || parts.next()? != "1" {
            return None;
        }
        let authority: u64 = parts.next()?.parse().ok().filter(|a| *a < (1u64 << 48))?;
        let subs: Vec<u32> = parts.map(|p| p.parse().ok()).collect::<Option<_>>()?;
        if subs.is_empty() || subs.len() > 15 {
            return None;
        }
        let mut bytes = vec![1u8, subs.len() as u8];
        bytes.extend_from_slice(&authority.to_be_bytes()[2..]);
        for s in &subs {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let mut buf = vec![0u32; bytes.len().div_ceil(4)];
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.as_mut_ptr() as *mut u8, bytes.len()) };
        Some(Sid(buf))
    }

    /// `check_private`, tolerating allow ACEs for the SIDs in `extra` (Codex's own sandbox
    /// capability SIDs for this home); any other principal still refuses.
    pub fn check_private_allowing(dir: &Path, extra: &[Sid]) -> Result<(), String> {
        let allowed = allowed()?;
        let w = wide(dir);
        let refuse = |why: String| {
            Err(format!(
                "Bare home {} {why}; refused. It must grant only the current user, SYSTEM and Administrators: fix or remove it yourself, Vidar never re-ACLs it",
                dir.display()
            ))
        };
        unsafe {
            let mut need = 0u32;
            let _ = GetFileSecurityW(PCWSTR(w.as_ptr()), DACL_SECURITY_INFORMATION.0, None, 0, &mut need);
            if need == 0 {
                return Err(format!("Bare home {}: cannot read its ACL", dir.display()));
            }
            let mut buf = vec![0u64; (need as usize).div_ceil(8)];
            let psd = PSECURITY_DESCRIPTOR(buf.as_mut_ptr() as *mut _);
            if !GetFileSecurityW(PCWSTR(w.as_ptr()), DACL_SECURITY_INFORMATION.0, Some(psd), need, &mut need).as_bool() {
                return Err(format!("Bare home {}: cannot read its ACL", dir.display()));
            }
            let (mut present, mut defaulted) = (windows::core::BOOL(0), windows::core::BOOL(0));
            let mut acl: *mut ACL = std::ptr::null_mut();
            GetSecurityDescriptorDacl(psd, &mut present, &mut acl, &mut defaulted).map_err(|e| format!("GetSecurityDescriptorDacl: {e}"))?;
            if !present.as_bool() || acl.is_null() {
                return refuse("has no DACL (everyone has access)".into());
            }
            let mut info = ACL_SIZE_INFORMATION::default();
            GetAclInformation(acl, &mut info as *mut _ as *mut _, std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation)
                .map_err(|e| format!("GetAclInformation: {e}"))?;
            let mut foreign = 0;
            for i in 0..info.AceCount {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                GetAce(acl, i, &mut ace).map_err(|e| format!("GetAce: {e}"))?;
                match (*(ace as *const ACE_HEADER)).AceType {
                    ACCESS_DENIED_ACE_TYPE => {}
                    ACCESS_ALLOWED_ACE_TYPE => {
                        let sid = PSID(&(*(ace as *const ACCESS_ALLOWED_ACE)).SidStart as *const u32 as *mut _);
                        if !allowed.iter().chain(extra).any(|a| EqualSid(a.psid(), sid).is_ok()) {
                            foreign += 1;
                        }
                    }
                    t => return refuse(format!("holds an ACE of type {t} this check does not read")),
                }
            }
            if foreign > 0 {
                return refuse(format!("grants access to {foreign} other principal(s)"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// A fresh folder under %TEMP% (never the real agent homes); removed on drop.
    pub(crate) struct TempDir(pub PathBuf);
    impl TempDir {
        pub fn new(tag: &str) -> TempDir {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("vidar-bare-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn guard() -> Guard {
        Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some("testuser".into()) }
    }

    fn template() -> PathBuf {
        crate::paths::root().join("profiles").join("bare").join("claude.settings.template.json")
    }

    #[test]
    fn homes_resolve_under_local_app_data_keyed_by_root() {
        let lad = Path::new(r"C:\Users\Test User\AppData\Local");
        let a = resolve_for(Path::new(r"D:\Tools\Vidar"), lad);
        assert!(a.starts_with(lad.join("Vidar").join("homes")));
        assert_eq!(a.parent().unwrap(), lad.join("Vidar").join("homes"));
        // Same root in another spelling: same home; another root: another home.
        assert_eq!(a, resolve_for(Path::new(r"d:/tools/vidar/"), lad));
        assert_ne!(a, resolve_for(Path::new(r"D:\Tools\Vidar2"), lad));
    }

    /// The JS twin (tools/lib/agent-env.mjs) must print the same paths; tests/agent-home-parity.test.mjs
    /// holds the same table.
    #[test]
    fn home_paths_match_the_js_table() {
        let lad = Path::new(r"C:\Users\Test User\AppData\Local");
        for (root, want) in [
            (r"D:\Tools\Vidar", r"C:\Users\Test User\AppData\Local\Vidar\homes\HASH"),
            (r"C:\Program Files\My Vidar\App", r"C:\Users\Test User\AppData\Local\Vidar\homes\HASH"),
            (r"E:\Mixed\Case\ViDaR", r"C:\Users\Test User\AppData\Local\Vidar\homes\HASH"),
        ] {
            let got = resolve_for(Path::new(root), lad).to_string_lossy().into_owned();
            let key = crate::falcon::host_names::root_suffix(Path::new(root));
            assert_eq!(got, want.replace("HASH", &key));
        }
        // The pinned keys (also asserted in the JS table).
        assert_eq!(crate::falcon::host_names::root_suffix(Path::new(r"D:\Tools\Vidar")), JS_KEYS[0]);
        assert_eq!(crate::falcon::host_names::root_suffix(Path::new(r"C:\Program Files\My Vidar\App")), JS_KEYS[1]);
        assert_eq!(crate::falcon::host_names::root_suffix(Path::new(r"E:\Mixed\Case\ViDaR")), JS_KEYS[2]);
    }
    const JS_KEYS: [&str; 3] = ["1c49ff625c89a9b8", "096f91e36c966a48", "161d7d325fd5bbcf"];

    #[test]
    fn a_writable_home_passes_the_probe_and_leaves_nothing() {
        let t = TempDir::new("probe");
        let home = t.0.join("agent-home");
        prepare_dirs(&home, &["claude-config".into()]).unwrap();
        assert!(!home.join(".vidar-probe").exists());
    }

    #[test]
    fn a_created_home_is_private_and_its_dirs_pass() {
        let t = TempDir::new("acl-ok");
        let home = t.0.join("agent-home");
        prepare_dirs(&home, &["claude-config".into(), "user-home/AppData/Local/Temp".into()]).unwrap();
        acl::check_private(&home).unwrap();
        acl::check_private(&home.join("user-home").join("AppData")).unwrap();
    }

    #[test]
    fn a_home_with_a_foreign_ace_refuses() {
        let t = TempDir::new("acl-foreign");
        let home = t.0.join("agent-home");
        let everyone = acl::well_known(windows::Win32::Security::WinWorldSid).unwrap();
        acl::create_private_dir(&home, &[everyone]).unwrap();
        let err = prepare_dirs(&home, &["claude-config".into()]).unwrap_err();
        assert!(err.contains("other principal"), "{err}");
        assert!(!home.join("claude-config").exists(), "refused home was still populated");
    }

    const CAP: &str = "S-1-5-21-1875670979-1622257873-1171250118-3363616505";

    /// A home whose DACL also grants `sid`, with `cap_sid` content (None = no file) in codex-home.
    fn home_granting(t: &TempDir, sid: &str, cap_sid: Option<&str>) -> PathBuf {
        let home = t.0.join("agent-home");
        acl::create_private_dir(&home, &[acl::parse_sid(sid).unwrap()]).unwrap();
        std::fs::create_dir_all(home.join("codex-home")).unwrap();
        if let Some(c) = cap_sid {
            std::fs::write(home.join("codex-home").join("cap_sid"), c).unwrap();
        }
        home
    }

    #[test]
    fn a_capability_sid_recorded_in_this_homes_cap_sid_passes() {
        let t = TempDir::new("cap-ok");
        let cap = format!(
            r#"{{"workspace":"S-1-5-21-1-2-3-4","readonly":"S-1-5-21-1-2-3-5","workspace_by_cwd":{{"c:/r":"S-1-5-21-1-2-3-6"}},"writable_root_by_path":{{"c:/h/temp":"{CAP}"}}}}"#
        );
        let home = home_granting(&t, CAP, Some(&cap));
        prepare_dirs(&home, &["codex-home".into(), "user-home/AppData/Local/Temp".into()]).unwrap();
    }

    #[test]
    fn a_set_homes_cap_sid_passes_like_the_legacy_one_and_a_bad_one_voids_only_itself() {
        let t = TempDir::new("cap-set");
        let home = home_granting(&t, CAP, None);
        let set = home.join("codex-homes").join("h1");
        std::fs::create_dir_all(&set).unwrap();
        std::fs::write(home.join("codex-homes.json"), r#"{"h1":{"sets":["lib/a"],"dir":"codex-homes/h1","lastUsed":0}}"#).unwrap();
        // Not listed in the index: no exemption.
        std::fs::create_dir_all(home.join("codex-homes").join("h2")).unwrap();
        std::fs::write(home.join("codex-homes").join("h2").join("cap_sid"), format!(r#"{{"workspace":"{CAP}"}}"#)).unwrap();
        let err = prepare_dirs(&home, &["codex-home".into()]).unwrap_err();
        assert!(err.contains("other principal"), "{err}");
        // A listed set home's own file passes; a malformed legacy file does not poison it.
        std::fs::write(set.join("cap_sid"), format!(r#"{{"writable_root_by_path":{{"c:/h/temp":"{CAP}"}}}}"#)).unwrap();
        std::fs::write(home.join("codex-home").join("cap_sid"), "not json").unwrap();
        prepare_dirs(&home, &["codex-home".into(), "codex-homes/h1".into()]).unwrap();
        // A foreign SID in the set home's file still refuses.
        std::fs::write(set.join("cap_sid"), r#"{"workspace":"S-1-5-21-1-2-3-9"}"#).unwrap();
        assert!(prepare_dirs(&home, &["codex-home".into()]).unwrap_err().contains("other principal"));
    }

    #[test]
    fn a_foreign_sid_not_in_cap_sid_still_refuses() {
        let t = TempDir::new("cap-foreign");
        let cap = r#"{"workspace":"S-1-5-21-1-2-3-4","writable_root_by_path":{"c:/h/temp":"S-1-5-21-1-2-3-9"}}"#;
        let home = home_granting(&t, CAP, Some(cap));
        let err = prepare_dirs(&home, &["codex-home".into()]).unwrap_err();
        assert!(err.contains("grants access to 1 other principal(s)"), "{err}");
    }

    #[test]
    fn a_missing_or_malformed_cap_sid_grants_no_exemption() {
        for (tag, content) in [
            ("none", None),
            ("junk", Some("not json")),
            ("bad-sid", Some(r#"{"workspace":"S-1-5-21-1-2-3-4","readonly":"nonsense"}"#)),
            ("wrong-shape", Some(r#"{"writable_root_by_path":"S-1-5-21-1875670979-1622257873-1171250118-3363616505"}"#)),
        ] {
            let t = TempDir::new(&format!("cap-{tag}"));
            // The valid SID sits in the file for "bad-sid" only through a broken sibling entry, so the whole file is void.
            let content = content.map(|c| if tag == "bad-sid" { c.replace("S-1-5-21-1-2-3-4", CAP) } else { c.to_string() });
            let home = home_granting(&t, CAP, content.as_deref());
            let err = prepare_dirs(&home, &["codex-home".into()]).unwrap_err();
            assert!(err.contains("other principal"), "{tag}: {err}");
        }
    }

    #[test]
    fn generated_settings_hold_no_user_profile_or_username() {
        let t = TempDir::new("gen");
        let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
        prepare_dirs(&home, &["claude-config".into()]).unwrap();
        let target = home.join("claude-config").join("settings.json");
        // The real guard (Vidar's own USERPROFILE and USERNAME): %TEMP% sits under the profile, so
        // this also proves the root and home paths are the only places a profile path may appear.
        generate_settings(&template(), &target, &root, &home, &Guard::from_vidar_env(), &[]).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert!(v["hooks"]["InstructionsLoaded"].is_array());
        let cmd = v["statusLine"]["command"].as_str().unwrap();
        assert_eq!(
            cmd,
            format!(
                "node \"{r}\\tools\\agent-layer\\statusline-bridge.mjs\" --root \"{r}\" --home \"{h}\"",
                r = root.display(),
                h = home.display()
            )
        );
        // And with a synthetic guard, independent of this machine.
        let template_v: Value = serde_json::from_str(&std::fs::read_to_string(template()).unwrap()).unwrap();
        validate(&v, &template_v, &root.to_string_lossy(), &home.to_string_lossy(), &guard()).unwrap();
    }

    #[test]
    fn a_profile_path_or_username_in_the_settings_refuses() {
        let t: Value = serde_json::json!({ "a": "x", "hooks": {} });
        let bad_path = serde_json::json!({ "a": r"C:\Users\TestUser\.claude\x", "hooks": {} });
        let bad_name = serde_json::json!({ "a": r"D:\other\testuser\x", "hooks": {} });
        let fine = serde_json::json!({ "a": r"D:\vidar\homes\testusers-not-a-token", "hooks": {} });
        assert!(validate(&bad_path, &t, r"D:\vidar", r"D:\vidar\homes", &guard()).unwrap_err().contains("user-profile"));
        assert!(validate(&bad_name, &t, r"D:\vidar", r"D:\vidar\homes", &guard()).unwrap_err().contains("account name"));
        validate(&fine, &t, r"D:\vidar", r"D:\vidar\homes", &guard()).unwrap();
        let unrolled = serde_json::json!({ "a": "x", "hooks": { "InstructionsLoaded": { "hooks": [] } } });
        assert!(validate(&unrolled, &t, "", "", &guard()).unwrap_err().contains("array of matchers"));
        let extra = serde_json::json!({ "a": "x", "hooks": {}, "b": 1 });
        assert!(validate(&extra, &t, "", "", &guard()).is_err());
    }

    #[test]
    fn the_account_name_is_refused_only_in_a_path_position() {
        let g = Guard { user_profile: Some(r"C:\Users\nobody-here".into()), username: Some("quill".into()) };
        let check = |s: &str| guard_strings(&[s], r"D:\vidar", r"D:\vidar\homes", &g, "t");
        for ok in ["falcon-changed-quill-check", "exit quill", r"\quills\x", "quill is fine", "a quill-b"] {
            check(ok).unwrap_or_else(|e| panic!("{ok:?}: {e}"));
        }
        for bad in [r"\\server\quill\x", "/home/quill", r"D:\quill\notes", "quill/x", r"D:\Other\QUILL"] {
            assert!(check(bad).unwrap_err().contains("account name"), "{bad:?} passed");
        }
    }

    #[test]
    fn a_forced_generation_failure_refuses() {
        let t = TempDir::new("gen-fail");
        let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
        prepare_dirs(&home, &["claude-config".into()]).unwrap();
        // Target is a directory: the rename over it fails.
        let target = home.join("claude-config").join("settings.json");
        std::fs::create_dir_all(&target).unwrap();
        assert!(generate_settings(&template(), &target, &root, &home, &guard(), &[]).is_err());
        // Template is not JSON.
        let bad = t.0.join("bad.json");
        std::fs::write(&bad, "{ not json").unwrap();
        let target2 = home.join("claude-config").join("other.json");
        assert!(generate_settings(&bad, &target2, &root, &home, &guard(), &[]).is_err());
        assert!(!target2.exists());
    }

    #[test]
    fn two_simultaneous_generations_both_succeed_under_the_lock() {
        let t = Arc::new(TempDir::new("lock"));
        let home = t.0.join("agent-home");
        prepare_dirs(&home, &["claude-config".into()]).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let runs: Vec<_> = (0..2)
            .map(|_| {
                let (t, b) = (Arc::clone(&t), Arc::clone(&barrier));
                std::thread::spawn(move || {
                    let home = t.0.join("agent-home");
                    b.wait();
                    let _l = lock(&home, LOCK_WAIT)?;
                    std::thread::sleep(Duration::from_millis(100));
                    generate_settings(&template(), &home.join("claude-config").join("settings.json"), &t.0, &home, &guard(), &[])
                })
            })
            .collect();
        for r in runs {
            r.join().unwrap().unwrap();
        }
        let back: Value = serde_json::from_str(&std::fs::read_to_string(home.join("claude-config").join("settings.json")).unwrap()).unwrap();
        assert!(back["hooks"]["InstructionsLoaded"].is_array());
    }

    fn codex_template() -> PathBuf {
        crate::paths::root().join("profiles").join("bare").join("codex.config.template.toml")
    }

    const PAYLOAD: &str = "Line one with \"quotes\" and a back\\slash.\nVIDAR-PAYLOAD-0123456789ab\n";
    /// The Store alias under the test profile: the shape `pwsh` resolves to on this machine.
    const PWSH: &str = r"C:\Users\testuser\AppData\Local\Microsoft\WindowsApps\pwsh.exe";

    fn pwsh() -> &'static Path {
        Path::new(PWSH)
    }

    #[test]
    fn the_generated_codex_config_parses_back_with_every_bare_key() {
        let t = TempDir::new("codex-gen");
        let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
        prepare_dirs(&home, &["codex-home".into()]).unwrap();
        let target = home.join("codex-home").join("config.toml");
        // The real guard: %TEMP% sits under the profile, so the root and home are the only places
        // a profile path may appear (same proof as the Claude settings test).
        generate_codex_config(&codex_template(), &target, &root, &home, pwsh(), PAYLOAD, &Guard::from_vidar_env()).unwrap();
        let doc = parse_toml_lite(&std::fs::read_to_string(&target).unwrap()).unwrap();
        let get = |k: &str| doc.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("project_doc_max_bytes"), Some(Toml::Int(0)));
        assert_eq!(get("project_root_markers"), Some(Toml::Array(vec![])));
        assert_eq!(get("developer_instructions"), Some(Toml::Str(PAYLOAD.into())), "payload round-trips, marker included");
        assert_eq!(get("windows.sandbox"), Some(Toml::Str("unelevated".into())));
        assert_eq!(get("sandbox_mode"), Some(Toml::Str("workspace-write".into())));
        assert_eq!(get("cli_auth_credentials_store"), Some(Toml::Str("file".into())));
        assert_eq!(get("sandbox_workspace_write.exclude_tmpdir_env_var"), Some(Toml::Bool(true)));
        assert_eq!(get("features.daemon_auto_start"), Some(Toml::Bool(false)));
        assert_eq!(get("features.prefer_mxc"), Some(Toml::Bool(true)));
        assert_eq!(get("suppress_unstable_features_warning"), Some(Toml::Bool(true)));
        assert_eq!(get("skills.include_instructions"), Some(Toml::Bool(false)));
        let Some(Toml::Array(argv)) = get("notify") else { panic!("notify is not an array") };
        let Some(Toml::Str(script)) = argv.last() else { panic!("notify ends in no string") };
        assert!(script.starts_with(&*root.to_string_lossy()) && script.ends_with(r"\desks\codex-notify.ps1"), "{script}");
        assert!(doc.iter().all(|(k, _)| k != "model_instructions_file"), "X6: left alone");
        // And with a synthetic guard, independent of this machine.
        let tpl = parse_toml_lite(&std::fs::read_to_string(codex_template()).unwrap()).unwrap();
        assert_eq!(argv.first(), Some(&Toml::Str(PWSH.into())), "notify starts with the resolved pwsh");
        validate_codex(&doc, &tpl, &root, &home, pwsh(), PAYLOAD, &guard()).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(!text.contains("{{"), "a placeholder survived");
        let tpl_text = std::fs::read_to_string(codex_template()).unwrap();
        assert!(tpl_text.lines().filter(|l| l.trim_start().starts_with('#')).all(|l| !l.contains("{{")), "a template comment holds a placeholder");
        println!("generated config.toml:\n{text}");
    }

    #[test]
    fn the_shipped_payload_generates_for_accounts_named_user_or_codex() {
        let payload = std::fs::read_to_string(crate::paths::root().join("profiles").join("bare").join("codex.payload.md")).unwrap();
        for name in ["user", "codex"] {
            let t = TempDir::new("codex-gen-name");
            let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
            prepare_dirs(&home, &["codex-home".into()]).unwrap();
            let target = home.join("codex-home").join("config.toml");
            let g = Guard { user_profile: Some(r"C:\Users\nobody-here".into()), username: Some(name.into()) };
            generate_codex_config(&codex_template(), &target, &root, &home, pwsh(), &payload, &g).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }

    #[test]
    fn a_codex_config_with_a_profile_path_username_or_loosened_key_refuses() {
        let (root, home) = (Path::new(r"D:\vidar"), Path::new(r"D:\vidar\runtime\homes"));
        let notify = Toml::Array(vec![Toml::Str("pwsh.exe".into()), Toml::Str(r"D:\vidar\tools\desks\codex-notify.ps1".into())]);
        let base: TomlDoc = vec![
            ("project_doc_max_bytes".into(), Toml::Int(0)),
            ("project_root_markers".into(), Toml::Array(vec![])),
            ("developer_instructions".into(), Toml::Str("p".into())),
            ("notify".into(), notify),
            ("skills.include_instructions".into(), Toml::Bool(false)),
            ("windows.sandbox".into(), Toml::Str("unelevated".into())),
            ("sandbox_mode".into(), Toml::Str("workspace-write".into())),
            ("suppress_unstable_features_warning".into(), Toml::Bool(true)),
            ("cli_auth_credentials_store".into(), Toml::Str("file".into())),
            ("mcp_oauth_credentials_store".into(), Toml::Str("file".into())),
            ("sandbox_workspace_write.writable_roots".into(), Toml::Array(vec![])),
            ("sandbox_workspace_write.network_access".into(), Toml::Bool(false)),
            ("sandbox_workspace_write.exclude_tmpdir_env_var".into(), Toml::Bool(true)),
            ("sandbox_workspace_write.exclude_slash_tmp".into(), Toml::Bool(true)),
            ("features.daemon_auto_start".into(), Toml::Bool(false)),
            ("features.prefer_mxc".into(), Toml::Bool(true)),
        ];
        validate_codex(&base, &base, root, home, pwsh(), "p", &guard()).unwrap();
        let with = |k: &str, v: Toml| -> TomlDoc { base.iter().map(|(n, x)| (n.clone(), if n == k { v.clone() } else { x.clone() })).collect() };
        // prefer_mxc missing from the generated doc: the keys differ from the template and the spawn refuses.
        let missing: TomlDoc = base.iter().filter(|(n, _)| n != "features.prefer_mxc").cloned().collect();
        assert!(validate_codex(&missing, &base, root, home, pwsh(), "p", &guard()).is_err(), "missing prefer_mxc passed");
        for (k, v) in [
            ("windows.sandbox", Toml::Str("elevated".into())),
            ("sandbox_mode", Toml::Str("danger-full-access".into())),
            ("cli_auth_credentials_store", Toml::Str("keyring".into())),
            ("cli_auth_credentials_store", Toml::Str("auto".into())),
            ("mcp_oauth_credentials_store", Toml::Str("auto".into())),
            ("mcp_oauth_credentials_store", Toml::Str("keyring".into())),
            ("sandbox_workspace_write.writable_roots", Toml::Array(vec![Toml::Str("C:\\x".into())])),
            ("sandbox_workspace_write.network_access", Toml::Bool(true)),
            ("sandbox_workspace_write.exclude_tmpdir_env_var", Toml::Bool(false)),
            ("sandbox_workspace_write.exclude_slash_tmp", Toml::Bool(false)),
            ("project_doc_max_bytes", Toml::Int(32768)),
            ("project_root_markers", Toml::Array(vec![Toml::Str(".git".into())])),
            ("features.daemon_auto_start", Toml::Bool(true)),
            ("features.prefer_mxc", Toml::Bool(false)),
            ("skills.include_instructions", Toml::Bool(true)),
            ("developer_instructions", Toml::Str("other".into())),
            ("notify", Toml::Array(vec![Toml::Str(r"C:\elsewhere\codex-notify.ps1".into())])),
        ] {
            assert!(validate_codex(&with(k, v.clone()), &base, root, home, pwsh(), "p", &guard()).is_err(), "{k} = {v:?} passed");
        }
        let p = with("developer_instructions", Toml::Str(r"see C:\Users\TestUser\.codex".into()));
        assert!(validate_codex(&p, &base, root, home, pwsh(), r"see C:\Users\TestUser\.codex", &guard()).unwrap_err().contains("user-profile"));
        // A1: the pinned payload may hold the account name as a whole word (`user`, `codex`).
        for name in ["testuser", "user", "codex"] {
            let g = Guard { user_profile: Some(r"C:\Users\testuser".into()), username: Some(name.into()) };
            let text = "You are the user's codex agent";
            let d = with("developer_instructions", Toml::Str(text.into()));
            validate_codex(&d, &base, root, home, pwsh(), text, &g).unwrap();
        }
        let mut extra = base.clone();
        extra.push(("model_instructions_file".into(), Toml::Str("x".into())));
        assert!(validate_codex(&extra, &base, root, home, pwsh(), "p", &guard()).unwrap_err().contains("keys differ"));
        // P5b: a keyring credential store is shared with the default Codex home; only "file" passes.
        let keyring = with("cli_auth_credentials_store", Toml::Str("keyring".into()));
        assert!(validate_codex(&keyring, &base, root, home, pwsh(), "p", &guard()).unwrap_err().contains("cli_auth_credentials_store"));

        // notify from a `{{pwsh}}` template: the resolved pwsh may sit under the profile (the Store
        // alias); any other profile path, a different pwsh or a relative one still refuses.
        let script = Toml::Str(r"D:\vidar\tools\desks\codex-notify.ps1".into());
        let tpl = with("notify", Toml::Array(vec![Toml::Str("{{pwsh}}".into()), script.clone()]));
        let filled = with("notify", Toml::Array(vec![Toml::Str(PWSH.into()), script.clone()]));
        validate_codex(&filled, &tpl, root, home, pwsh(), "p", &guard()).unwrap();
        let other = Path::new(r"C:\Program Files\PowerShell\7\pwsh.exe");
        assert!(validate_codex(&filled, &tpl, root, home, other, "p", &guard()).unwrap_err().contains("notify"));
        assert!(validate_codex(&filled, &tpl, root, home, Path::new("pwsh.exe"), "p", &guard()).unwrap_err().contains("absolute"));
        let leak = Toml::Array(vec![Toml::Str(PWSH.into()), Toml::Str(r"C:\Users\testuser\x".into()), script]);
        let leak_tpl = Toml::Array(vec![Toml::Str("{{pwsh}}".into()), Toml::Str(r"C:\Users\testuser\x".into()), Toml::Str(r"D:\vidar\tools\desks\codex-notify.ps1".into())]);
        assert!(validate_codex(&with("notify", leak), &with("notify", leak_tpl), root, home, pwsh(), "p", &guard()).unwrap_err().contains("user-profile"));
    }

    #[test]
    fn the_toml_reader_takes_the_subset_and_refuses_the_rest() {
        let doc = parse_toml_lite("# c\na = 0\nb = [] # trailing\n[t]\nc = \"x\\\"y\\\\z\\n\\u00e9\"\nd = [\"p\", \"q\"]\ne = false\n").unwrap();
        assert_eq!(doc[2], ("t.c".into(), Toml::Str("x\"y\\z\n\u{e9}".into())));
        assert_eq!(doc[3].1, Toml::Array(vec![Toml::Str("p".into()), Toml::Str("q".into())]));
        for bad in ["a = 'literal'", "a = \"open", "[[arr]]", "a.b = 1", "a = 1 2", "a = 1\na = 2", "a = \"\"\"x\"\"\""] {
            assert!(parse_toml_lite(bad).is_err(), "{bad:?} parsed");
        }
        let s = "q\"\\\n\r\t\u{1}";
        assert_eq!(parse_toml_lite(&format!("k = \"{}\"", toml_escape(s))).unwrap()[0].1, Toml::Str(s.into()));
    }

    #[test]
    fn a_dotted_table_header_parses_and_a_bad_part_refuses() {
        let doc = parse_toml_lite("[mcp_servers.vidar_drive]\ncommand = \"node\"\n[ a . b-c . d_1 ] # c\ne = 1\n").unwrap();
        assert_eq!(doc[0], ("mcp_servers.vidar_drive.command".into(), Toml::Str("node".into())));
        assert_eq!(doc[1], ("a.b-c.d_1.e".into(), Toml::Int(1)));
        for bad in ["[a..b]", "[a.]", "[.a]", "[a.b c]", "[a.'b' x]", "[a.'b]", "[[a.b]]", "[a.\"b]"] {
            assert!(parse_toml_lite(bad).unwrap_err().contains("unsupported table header"), "{bad:?} parsed");
        }
        // Quoted parts decode: a '#' or '.' inside one is text, not a comment or a separator.
        let q = parse_toml_lite("[p.'c:\\a#b']\nk = 1\n[p.\"x\\\\y\"] # c\nk = 2\n").unwrap();
        assert_eq!(q[0].0, "p.c:\\a#b.k");
        assert_eq!(q[1].0, "p.x\\y.k");
    }

    #[test]
    fn a_dot_inside_a_quoted_header_part_refuses_except_in_a_projects_path() {
        for bad in ["[\"mcp_servers.vidar_drive\"]", "['mcp_servers.vidar_drive']", "[mcp_servers.'a.b']", "[\"projects.x\"]", "[projects.'a'.'b.c']"] {
            assert!(parse_toml_lite(&format!("{bad}\nk = 1\n")).is_err(), "{bad:?} parsed");
        }
        let ok = parse_toml_lite("[projects.'c:\\my.repo']\ntrust_level = \"trusted\"\n").unwrap();
        assert_eq!(ok[0].0, "projects.c:\\my.repo.trust_level");
    }

    /// The generated text for `cwd`, parsed back; the `[projects]` entries it holds.
    fn trusted_entries(cwd: &str) -> Vec<(String, Toml)> {
        let t = TempDir::new("codex-trust");
        let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
        prepare_dirs(&home, &["codex-home".into()]).unwrap();
        let target = home.join("codex-home").join("config.toml");
        generate_codex_config_for(&codex_template(), &target, &root, &home, pwsh(), PAYLOAD, &guard(), Some(cwd), &McpTables::default()).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        println!("{text}");
        parse_toml_lite(&text).unwrap().into_iter().filter(|(k, _)| k.starts_with("projects.")).collect()
    }

    #[test]
    fn the_launch_folder_is_written_as_a_trusted_project() {
        let want = |p: &str| vec![(format!("projects.{p}.trust_level"), Toml::Str("trusted".into()))];
        // Plain path, lowercased; the exact text.
        assert_eq!(trusted_entries(r"C:\Dev\Apps\Vidar"), want(r"c:\dev\apps\vidar"));
        assert_eq!(trusted_project_table(r"c:\dev\apps\vidar"), "[projects.'c:\\dev\\apps\\vidar']\ntrust_level = \"trusted\"\n");
        // Forward slashes, a verbatim prefix and a doubled root all land on the one key.
        assert_eq!(trusted_entries("C:/Work/x"), want(r"c:\work\x"));
        assert_eq!(trusted_entries(r"\\?\C:\Work\x"), want(r"c:\work\x"));
        assert_eq!(trusted_entries(r"C:\\"), want(r"c:\"));
        assert_eq!(trusted_project_key(r"C:\Work\x\\"), trusted_project_key(r"c:/work/x"));
        // Spaces and mixed case.
        assert_eq!(trusted_entries(r"D:\My Stuff\RePo X"), want(r"d:\my stuff\repo x"));
        // A quote forces a basic-string key; the parsed key still equals the lowercased path.
        assert_eq!(trusted_entries(r"C:\Dev\It's Mine"), want(r"c:\dev\it's mine"));
        assert!(trusted_project_table(r"c:\dev\it's mine").starts_with("[projects.\"c:\\\\dev\\\\it's mine\"]"));
        // Trailing separators go; a drive root keeps its one; a blank folder writes nothing.
        assert_eq!(trusted_entries("C:\\Work\\"), want(r"c:\work"));
        assert_eq!(trusted_entries("C:\\"), want(r"c:\"));
        assert_eq!(trusted_project_key("  "), None);
        let none = TempDir::new("codex-trust-none");
        let (root, home) = (none.0.join("root"), none.0.join("agent-home"));
        prepare_dirs(&home, &["codex-home".into()]).unwrap();
        let target = home.join("codex-home").join("config.toml");
        generate_codex_config_for(&codex_template(), &target, &root, &home, pwsh(), PAYLOAD, &guard(), Some(""), &McpTables::default()).unwrap();
        assert!(!std::fs::read_to_string(&target).unwrap().contains("\n[projects"));
    }

    #[test]
    fn a_projects_table_beyond_the_trusted_launch_folder_refuses() {
        let (root, home) = (Path::new(r"D:\vidar"), Path::new(r"D:\vidar\runtime\homes"));
        let t = TempDir::new("codex-trust-refuse");
        let target = t.0.join("config.toml");
        generate_codex_config_for(&codex_template(), &target, root, home, pwsh(), "p", &guard(), None, &McpTables::default()).unwrap();
        let tpl = parse_toml_lite(&std::fs::read_to_string(codex_template()).unwrap()).unwrap();
        let doc = parse_toml_lite(&std::fs::read_to_string(&target).unwrap()).unwrap();
        let trust = ("projects.c:\\x.trust_level".to_string(), Toml::Str("trusted".into()));
        let run = |d: &TomlDoc, key: Option<&str>| validate_codex_for(d, &tpl, root, home, pwsh(), "p", &guard(), key, &McpTables::default());
        run(&doc, None).unwrap();
        // No launch folder given: any projects key refuses.
        let mut one = doc.clone();
        one.push(trust.clone());
        assert!(run(&one, None).unwrap_err().contains("projects"));
        // The launch folder, exactly: passes; a different folder, a missing entry, an extra key refuse.
        run(&one, Some(r"c:\x")).unwrap();
        assert!(run(&one, Some(r"c:\y")).is_err());
        assert!(run(&doc, Some(r"c:\x")).is_err());
        let mut extra = one.clone();
        extra.push(("projects.c:\\x.sandbox_mode".into(), Toml::Str("danger-full-access".into())));
        assert!(run(&extra, Some(r"c:\x")).unwrap_err().contains("trust_level"));
        let mut second = one.clone();
        second.push(("projects.c:\\z.trust_level".into(), Toml::Str("trusted".into())));
        assert!(run(&second, Some(r"c:\x")).is_err());
        let mut other = one.clone();
        other[doc.len()].1 = Toml::Str("untrusted".into());
        assert!(run(&other, Some(r"c:\x")).is_err());
        // And through the text: an extra key under the table fails the parse-back validation.
        let text = std::fs::read_to_string(&target).unwrap() + "\n[projects.'c:\\x']\ntrust_level = \"trusted\"\nextra = 1\n";
        let back = parse_toml_lite(&text).unwrap();
        assert!(validate_codex_for(&back, &tpl, root, home, pwsh(), "p", &guard(), Some(r"c:\x"), &McpTables::default()).is_err());
    }

    #[test]
    fn the_seen_counters_mirror_raises_and_never_lowers() {
        let t = TempDir::new("claude-seen");
        let (normal, bare) = (t.0.join("normal.json"), t.0.join("bare").join(".claude.json"));
        std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
        std::fs::write(&normal, r#"{"passesUpsellSeenCount":3,"otherUpsellSeenCount":3,"lowUpsellSeenCount":1,"transcriptShareDismissed":true,"offDismissed":false,"theme":"dark"}"#).unwrap();
        std::fs::write(&bare, r#"{"passesUpsellSeenCount":2,"lowUpsellSeenCount":5,"theme":"light","userID":"abc","nested":{"a":[1,2]}}"#).unwrap();
        assert!(mirror_claude_seen(&normal, &bare).unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&bare).unwrap()).unwrap();
        assert_eq!(v["passesUpsellSeenCount"], 3, "raised");
        assert_eq!(v["otherUpsellSeenCount"], 3, "added");
        assert_eq!(v["lowUpsellSeenCount"], 5, "never lowered");
        assert_eq!(v["transcriptShareDismissed"], true);
        assert!(v.get("offDismissed").is_none(), "a false flag is not copied");
        assert_eq!(v["theme"], "light", "other keys untouched");
        assert_eq!((&v["userID"], &v["nested"]), (&Value::from("abc"), &serde_json::json!({"a":[1,2]})));
        // Nothing left to change: no write.
        let before = std::fs::metadata(&bare).unwrap().modified().unwrap();
        assert!(!mirror_claude_seen(&normal, &bare).unwrap());
        assert_eq!(std::fs::metadata(&bare).unwrap().modified().unwrap(), before);
        // A missing Bare file is created with just those keys.
        let fresh = t.0.join("fresh").join(".claude.json");
        std::fs::create_dir_all(fresh.parent().unwrap()).unwrap();
        assert!(mirror_claude_seen(&normal, &fresh).unwrap());
        let f: Value = serde_json::from_str(&std::fs::read_to_string(&fresh).unwrap()).unwrap();
        assert_eq!(f, serde_json::json!({"passesUpsellSeenCount":3,"otherUpsellSeenCount":3,"lowUpsellSeenCount":1,"transcriptShareDismissed":true}));
    }

    #[test]
    fn a_malformed_or_missing_normal_claude_json_skips_the_mirror() {
        let t = TempDir::new("claude-seen-bad");
        let (normal, bare) = (t.0.join("normal.json"), t.0.join(".claude.json"));
        std::fs::write(&bare, r#"{"passesUpsellSeenCount":2}"#).unwrap();
        for text in ["{not json", "[1,2]", ""] {
            std::fs::write(&normal, text).unwrap();
            assert!(mirror_claude_seen(&normal, &bare).is_err(), "{text:?}");
        }
        assert!(mirror_claude_seen(&t.0.join("absent.json"), &bare).is_err());
        assert_eq!(std::fs::read_to_string(&bare).unwrap(), r#"{"passesUpsellSeenCount":2}"#, "Bare file untouched");
        // A malformed Bare file is never overwritten.
        std::fs::write(&normal, r#"{"passesUpsellSeenCount":3}"#).unwrap();
        std::fs::write(&bare, "{broken").unwrap();
        assert!(mirror_claude_seen(&normal, &bare).is_err());
        assert_eq!(std::fs::read_to_string(&bare).unwrap(), "{broken");
    }

    #[test]
    fn the_vidar_drive_mcp_table_is_pinned_and_any_other_refuses() {
        let (root, home) = (Path::new(r"D:\vidar"), Path::new(r"D:\vidar\runtime\homes"));
        let notify = Toml::Array(vec![Toml::Str(PWSH.into()), Toml::Str(r"D:\vidar\tools\desks\codex-notify.ps1".into())]);
        let ctl = |names: &[&str]| Toml::Array(names.iter().map(|n| Toml::Str((*n).into())).collect());
        let mut base: TomlDoc = vec![
            ("project_doc_max_bytes".into(), Toml::Int(0)),
            ("project_root_markers".into(), Toml::Array(vec![])),
            ("developer_instructions".into(), Toml::Str("p".into())),
            ("notify".into(), notify),
            ("skills.include_instructions".into(), Toml::Bool(false)),
            ("windows.sandbox".into(), Toml::Str("unelevated".into())),
            ("sandbox_mode".into(), Toml::Str("workspace-write".into())),
            ("suppress_unstable_features_warning".into(), Toml::Bool(true)),
            ("cli_auth_credentials_store".into(), Toml::Str("file".into())),
            ("mcp_oauth_credentials_store".into(), Toml::Str("file".into())),
            ("sandbox_workspace_write.writable_roots".into(), Toml::Array(vec![])),
            ("sandbox_workspace_write.network_access".into(), Toml::Bool(false)),
            ("sandbox_workspace_write.exclude_tmpdir_env_var".into(), Toml::Bool(true)),
            ("sandbox_workspace_write.exclude_slash_tmp".into(), Toml::Bool(true)),
            ("features.daemon_auto_start".into(), Toml::Bool(false)),
            ("features.prefer_mxc".into(), Toml::Bool(true)),
        ];
        let server = Toml::Array(vec![Toml::Str(r"D:\vidar\tools\mcp\vidar-drive\server.mjs".into())]);
        base.extend([
            ("mcp_servers.vidar_drive.command".into(), Toml::Str("node".into())),
            ("mcp_servers.vidar_drive.args".into(), server),
            ("mcp_servers.vidar_drive.env_vars".into(), ctl(&["VIDAR_CTL_TOKEN", "FALCON_SESSION", "VIDAR_CTL_SECRET"])),
            ("mcp_servers.vidar_drive.tool_timeout_sec".into(), Toml::Int(3700)),
        ]);
        validate_codex(&base, &base, root, home, pwsh(), "p", &guard()).unwrap();
        let with = |k: &str, v: Toml| -> TomlDoc { base.iter().map(|(n, x)| (n.clone(), if n == k { v.clone() } else { x.clone() })).collect() };
        for (k, v) in [
            ("command", Toml::Str("pwsh".into())),
            ("args", Toml::Array(vec![Toml::Str(r"C:\elsewhere\tools\mcp\vidar-drive\server.mjs".into())])),
            ("args", Toml::Array(vec![Toml::Str(r"D:\vidar\tools\mcp\vidar-drive\server.mjs".into()), Toml::Str("--x".into())])),
            ("env_vars", ctl(&["VIDAR_CTL_TOKEN", "FALCON_SESSION", "VIDAR_CTL_SECRET", "PATH"])),
            // The in-process token alone: a hosted tab would lose its control identity.
            ("env_vars", ctl(&["VIDAR_CTL_TOKEN"])),
            ("env_vars", ctl(&["VIDAR_CTL_TOKEN", "VIDAR_CTL_SECRET", "FALCON_SESSION"])),
            ("env_vars", Toml::Array(vec![])),
            ("tool_timeout_sec", Toml::Int(60)),
        ] {
            let k = format!("mcp_servers.vidar_drive.{k}");
            let d = with(&k, v.clone());
            assert!(validate_codex(&d, &d, root, home, pwsh(), "p", &guard()).unwrap_err().contains(&k), "{k} = {v:?} passed");
        }
        // A missing pinned key, an extra key in the table, or another server refuses.
        let partial: TomlDoc = base.iter().filter(|(k, _)| k != "mcp_servers.vidar_drive.tool_timeout_sec").cloned().collect();
        assert!(validate_codex(&partial, &partial, root, home, pwsh(), "p", &guard()).unwrap_err().contains("tool_timeout_sec"));
        let mut env = base.clone();
        env.push(("mcp_servers.vidar_drive.env".into(), Toml::Str("x".into())));
        assert!(validate_codex(&env, &env, root, home, pwsh(), "p", &guard()).unwrap_err().contains("not a pinned"));
        let mut other = base.clone();
        other.push(("mcp_servers.other.command".into(), Toml::Str("node".into())));
        assert!(validate_codex(&other, &other, root, home, pwsh(), "p", &guard()).unwrap_err().contains("only mcp_servers.vidar_drive"));
    }

    #[test]
    fn a_root_placeholder_in_the_payload_is_filled() {
        let t = TempDir::new("codex-gen-root");
        let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
        prepare_dirs(&home, &["codex-home".into()]).unwrap();
        let target = home.join("codex-home").join("config.toml");
        let payload = "Run {{root}}\\tools\\x.mjs.\nVIDAR-PAYLOAD-0123456789ab\n";
        generate_codex_config(&codex_template(), &target, &root, &home, pwsh(), payload, &guard()).unwrap();
        let doc = parse_toml_lite(&std::fs::read_to_string(&target).unwrap()).unwrap();
        let want = payload.replace("{{root}}", &root.to_string_lossy());
        assert_eq!(doc.iter().find(|(k, _)| k == "developer_instructions").map(|(_, v)| v.clone()), Some(Toml::Str(want)));
        // Any other name stays and the guard refuses it.
        assert!(generate_codex_config(&codex_template(), &target, &root, &home, pwsh(), "{{home}}", &guard()).unwrap_err().contains("placeholder"));
    }

    #[test]
    fn enabled_hosted_servers_are_written_and_validate_only_when_enabled() {
        let t = TempDir::new("codex-gen-hosted");
        let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
        prepare_dirs(&home, &["codex-home".into()]).unwrap();
        let target = home.join("codex-home").join("config.toml");
        let all: Vec<&codex_mcp::Hosted> = codex_mcp::HOSTED.iter().collect();
        let enabled = McpTables::hosted(&all);
        generate_codex_config_for(&codex_template(), &target, &root, &home, pwsh(), PAYLOAD, &guard(), Some(r"D:\Work"), &enabled).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(text.contains("[mcp_servers.notion]\nurl = \"https://mcp.notion.com/mcp\"\ndefault_tools_approval_mode = \"writes\"\n"), "{text}");
        let doc = parse_toml_lite(&text).unwrap();
        let tpl = parse_toml_lite(&std::fs::read_to_string(codex_template()).unwrap()).unwrap();
        let key = trusted_project_key(r"D:\Work");
        validate_codex_for(&doc, &tpl, &root, &home, pwsh(), PAYLOAD, &guard(), key.as_deref(), &enabled).unwrap();
        // The same file against a narrower enabled list: the extra table refuses.
        let err = validate_codex_for(&doc, &tpl, &root, &home, pwsh(), PAYLOAD, &guard(), key.as_deref(), &McpTables::hosted(&all[..1])).unwrap_err();
        assert!(err.contains("keys differ"), "{err}");
    }

    #[test]
    fn a_hosted_spawns_server_tables_are_written_with_their_env_and_validate() {
        use super::super::bundles::{Http, Mcp, Reads, Stdio};
        let t = TempDir::new("codex-gen-servers");
        let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
        prepare_dirs(&home, &["codex-home".into()]).unwrap();
        let target = home.join("codex-home").join("config.toml");
        let mcp = |name: &str, http: Option<&str>, args: &[&str]| Mcp {
            name: name.into(),
            http: http.map(|u| Http { url: u.into(), oauth: None }),
            stdio: http.is_none().then(|| Stdio { command: "p4mcp-server".into(), args: args.iter().map(|a| a.to_string()).collect(), env_from: vec!["P4USER".into()] }),
            agents: Vec::new(),
            reads: Reads::Names(Vec::new()),
            optional: false,
        };
        // P4USER is the account name: a value Vidar wrote from the env, not a leak.
        let env = |k: &str| (k == "P4USER").then(|| "testuser".to_string());
        let (tables, warnings) = McpTables::servers(&[mcp("proxy", Some("http://127.0.0.1:8399/mcp"), &[]), mcp("p4", None, &["--readonly"])], &env).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        generate_codex_config_for(&codex_template(), &target, &root, &home, pwsh(), PAYLOAD, &guard(), None, &tables).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(text.contains("[mcp_servers.proxy]\nurl = \"http://127.0.0.1:8399/mcp\"\ndefault_tools_approval_mode = \"writes\"\n"), "{text}");
        assert!(text.contains("[mcp_servers.p4]\ncommand = \"p4mcp-server\"\nargs = [\"--readonly\"]\ndefault_tools_approval_mode = \"writes\"\n"), "{text}");
        assert!(text.contains("[mcp_servers.p4.env]\nP4USER = \"testuser\"\n"), "{text}");
        // The same file against no tables refuses: the in-process line's config.toml holds none.
        let doc = parse_toml_lite(&text).unwrap();
        let tpl = parse_toml_lite(&std::fs::read_to_string(codex_template()).unwrap()).unwrap();
        assert!(validate_codex_for(&doc, &tpl, &root, &home, pwsh(), PAYLOAD, &guard(), None, &McpTables::default()).is_err());
        // A user-profile path in a server's args still refuses the spawn.
        let (leak, _) = McpTables::servers(&[mcp("p4", None, &[r"C:\Users\testuser\p4.cfg"])], &env).unwrap();
        let err = generate_codex_config_for(&codex_template(), &target, &root, &home, pwsh(), PAYLOAD, &guard(), None, &leak).unwrap_err();
        assert!(err.contains("user-profile"), "{err}");
    }

    #[test]
    fn a_forced_codex_generation_failure_refuses() {
        let t = TempDir::new("codex-gen-fail");
        let (root, home) = (t.0.join("root"), t.0.join("agent-home"));
        prepare_dirs(&home, &["codex-home".into()]).unwrap();
        let target = home.join("codex-home").join("config.toml");
        std::fs::create_dir_all(&target).unwrap();
        assert!(generate_codex_config(&codex_template(), &target, &root, &home, pwsh(), PAYLOAD, &guard()).is_err());
        let bad = t.0.join("bad.toml");
        std::fs::write(&bad, "a = 'not the subset'\n").unwrap();
        let target2 = home.join("codex-home").join("other.toml");
        assert!(generate_codex_config(&bad, &target2, &root, &home, pwsh(), PAYLOAD, &guard()).is_err());
        assert!(!target2.exists());
    }

    #[test]
    fn a_held_lock_makes_the_second_launch_wait_then_refuse() {
        let t = TempDir::new("lock-held");
        let _held = lock(&t.0, LOCK_WAIT).unwrap();
        let start = Instant::now();
        let err = lock(&t.0, Duration::from_millis(200)).err().expect("second lock while held");
        assert!(start.elapsed() >= Duration::from_millis(200), "did not wait");
        assert!(err.contains("lock"), "{err}");
    }
}
