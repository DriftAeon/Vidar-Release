use std::path::Path;
use std::process::Command;

// Exact-match only (never contains/starts_with): NTFS ADS shapes like
// "cpp:evil:$DATA" must fail the comparison.
const ALLOWED_EXTS: &[&str] = &[
    "c", "cc", "cpp", "h", "hpp", "inl", "cs", "usf", "ush", "ini", "txt", "md", "json", "ts",
    "tsx", "js", "rs", "py", "css", "html", "svg", "toml", "yaml", "yml", "xml", "uproject",
    "uplugin", "log", "csv",
];

// Path arrives from UNTRUSTED terminal output (any program can print a crafted
// path the user clicks). Defense: drive-letter-only (kills UNC/NTLM-leak), no
// colon past the drive colon (kills ADS), canonicalize + is_file, exact-match
// extension allowlist on the RESOLVED name, arg-array spawn with no shell.
// The editor comes from vidar.json (`editor`, else legacy `riderPath`; `resolve` below).
// Residual worst case: a text file opens in the configured editor.
#[tauri::command]
pub fn open_in_editor(path: String, line: u32) -> Result<(), String> {
    let bytes = path.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
    {
        return Err("not a drive-letter path".into());
    }
    if path[2..].contains(':') {
        return Err("colon in path body".into());
    }

    let cfg = crate::config::load().config;
    let (exe, arg_template, key) = resolve(cfg.editor.as_ref(), cfg.rider_path.as_deref())
        .ok_or("no editor set in vidar.json (editor.exe, or legacy riderPath)")?;
    check_exe(Path::new(&exe), key)?;
    if !arg_template.iter().any(|a| a.contains("{file}")) {
        return Err("editor.args has no element containing {file}; add one, e.g. [\"{file}\"]".into());
    }

    let canon = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canon.is_file() {
        return Err("not a file".into());
    }
    let cs = canon.to_string_lossy();
    // reserved device names (CON, NUL...) don't canonicalize to \\?\<drive>:
    let ok_prefix = cs.strip_prefix("\\\\?\\").map_or(false, |rest| {
        rest.as_bytes().first().map_or(false, |c| c.is_ascii_alphabetic())
            && rest.as_bytes().get(1) == Some(&b':')
    });
    if !ok_prefix {
        return Err("unexpected canonical form".into());
    }
    let ext = canon
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or("no extension")?;
    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Err(format!("extension .{ext} not allowed"));
    }

    // Editors may not accept the \\?\ long-path prefix — hand them the plain form.
    let plain = cs.trim_start_matches("\\\\?\\").to_string();
    // spawn, never wait: first Rider launch takes seconds
    Command::new(&exe)
        .args(expand_args(&arg_template, &plain, line))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// .exe only: Command::new on a .cmd/.bat hands the argv to cmd.exe, which re-parses it.
/// Each refusal says what to change in vidar.json.
pub(crate) fn check_exe(ep: &Path, key: &str) -> Result<(), String> {
    let ext = ep
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "cmd" || ext == "bat" {
        return Err(format!(
            "{key} points at a .{ext} launcher, which is refused; point it at the editor's own .exe \
             (for VS Code, Code.exe in its install folder, not bin\\code.cmd)"
        ));
    }
    if !ep.exists() {
        return Err(format!("{key} path does not exist: {}", ep.display()));
    }
    if !ep.is_file() || ext != "exe" {
        return Err(format!("{key} is not an .exe file: {}", ep.display()));
    }
    Ok(())
}

const RIDER_ARGS: &[&str] = &["--line", "{line}", "{file}"];
const DEFAULT_ARGS: &[&str] = &["{file}"];

/// Which editor a click launches: `editor` wins when its `exe` is non-blank; otherwise a
/// non-blank legacy `riderPath` stands in as a Rider entry; otherwise none. Returns the exe,
/// the argv template and the vidar.json key it came from (for the error text).
fn resolve(
    editor: Option<&crate::settings::schema::EditorCfg>,
    rider_path: Option<&str>,
) -> Option<(String, Vec<String>, &'static str)> {
    if let Some(e) = editor.filter(|e| !e.exe.trim().is_empty()) {
        let args = e
            .args
            .clone()
            .unwrap_or_else(|| DEFAULT_ARGS.iter().map(|s| s.to_string()).collect());
        return Some((e.exe.clone(), args, "editor.exe"));
    }
    let rider = rider_path.filter(|p| !p.trim().is_empty())?;
    Some((
        rider.to_string(),
        RIDER_ARGS.iter().map(|s| s.to_string()).collect(),
        "riderPath",
    ))
}

/// One output element per template element; `{file}`/`{line}` are replaced inside that
/// element only, in one left-to-right pass (a `{line}` inside the substituted path is left
/// alone). Nothing is joined or split, so a path with spaces or `&` stays a single argv entry.
fn expand_args(template: &[String], file: &str, line: u32) -> Vec<String> {
    let line = line.to_string();
    template
        .iter()
        .map(|arg| {
            let mut out = String::with_capacity(arg.len() + file.len());
            let mut rest = arg.as_str();
            while !rest.is_empty() {
                if let Some(r) = rest.strip_prefix("{file}") {
                    out.push_str(file);
                    rest = r;
                } else if let Some(r) = rest.strip_prefix("{line}") {
                    out.push_str(&line);
                    rest = r;
                } else {
                    let c = rest.chars().next().unwrap();
                    out.push(c);
                    rest = &rest[c.len_utf8()..];
                }
            }
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::schema::EditorCfg;

    #[test]
    fn editor_key_wins_then_rider_path_then_none() {
        let code = EditorCfg { exe: "C:\\code.exe".into(), args: Some(vec!["-g".into(), "{file}:{line}".into()]) };
        let (exe, args, key) = resolve(Some(&code), Some("C:\\rider64.exe")).unwrap();
        assert_eq!((exe.as_str(), key), ("C:\\code.exe", "editor.exe"));
        assert_eq!(args, vec!["-g", "{file}:{line}"]);

        let blank = EditorCfg { exe: " ".into(), args: None };
        let (exe, args, key) = resolve(Some(&blank), Some("C:\\rider64.exe")).unwrap();
        assert_eq!((exe.as_str(), key), ("C:\\rider64.exe", "riderPath"));
        assert_eq!(args, vec!["--line", "{line}", "{file}"]);

        assert!(resolve(None, None).is_none());
        assert!(resolve(Some(&blank), Some("")).is_none());
    }

    #[test]
    fn editor_key_is_lenient_and_never_fails_the_config() {
        use crate::settings::schema::VidarConfig;
        let c: VidarConfig =
            serde_json::from_str(r#"{"editor": "C:\\x\\Code.exe", "fontSize": 13}"#).unwrap();
        let e = c.editor.unwrap();
        assert_eq!((e.exe.as_str(), e.args.is_none()), ("C:\\x\\Code.exe", true));

        let c: VidarConfig = serde_json::from_str(r#"{"editor": 5, "fontSize": 13}"#).unwrap();
        assert!(c.editor.is_none());
        assert_eq!(c.font_size, Some(13));
    }

    #[test]
    fn args_are_substituted_per_element_never_joined() {
        let t: Vec<String> = vec!["--goto".into(), "{file}:{line}".into()];
        let file = "C:\\My Repo\\a & b {line}.rs";
        assert_eq!(
            expand_args(&t, file, 42),
            vec!["--goto".to_string(), format!("{file}:42")]
        );
    }
}
