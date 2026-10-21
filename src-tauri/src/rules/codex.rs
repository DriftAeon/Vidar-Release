//! src-tauri\src\rules\codex.rs — Codex consumption of a built file: TOML basic-string encoding for
//! `-c developer_instructions=<value>`, the Classic library rule `choose` (inline up to 12,000 encoded chars,
//! else a `--profile` file in CODEX_HOME), and the Rendered Codex app-server argv with B2 re-validation.
//! Bare Codex has no cap: Rendered sends `developerInstructions` on `thread/start`, Raw uses a `--profile` file.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::build::{built_dir, is_hash12};

/// Encoded chars at or below which `-c` is used, and the TOML basic-string encoder: one copy,
/// in `bare/codex_payload.rs`, which Falcon mounts too.
pub use crate::bare::codex_payload::{encode_toml_string, INLINE_LIMIT};

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "mode")]
pub enum CodexRules {
    #[serde(rename = "c")]
    C { value: String },
    #[serde(rename = "profile")]
    Profile { name: String },
}

/// `<CODEX_HOME>`, else `%USERPROFILE%\.codex`.
pub fn codex_home() -> Option<PathBuf> {
    codex_home_from(std::env::var_os("CODEX_HOME"), crate::paths::home())
}

/// The pure form of `codex_home`: a non-empty `CODEX_HOME` value wins, else `<home>\.codex`.
pub fn codex_home_from(codex_home_env: Option<std::ffi::OsString>, home: Option<PathBuf>) -> Option<PathBuf> {
    match codex_home_env.filter(|v| !v.is_empty()) {
        Some(h) => Some(PathBuf::from(h)),
        None => home.map(|h| h.join(".codex")),
    }
}

/// The length rule over the built text. A profile is written only on the long branch.
pub fn choose(text: &str, hash: &str, codex_home: Option<&Path>) -> Result<CodexRules, String> {
    let value = encode_toml_string(text);
    if value.chars().count() <= INLINE_LIMIT {
        return Ok(CodexRules::C { value });
    }
    let home = codex_home.ok_or("Codex home is not set; cannot write a rules profile")?;
    std::fs::create_dir_all(home).map_err(|e| format!("Codex home is not writable: {e}"))?;
    let name = format!("vidar-rules-{hash}");
    let body = format!("developer_instructions = {value}\n");
    let file = home.join(format!("{name}.config.toml")); // the name carries the content hash
    if !file.is_file() {
        crate::fsx::atomic_write(&file, body.as_bytes())?;
    }
    Ok(CodexRules::Profile { name })
}

/// B2: the path must canonicalise to a `<hash12>.md` directly under the built dir.
/// Returns the canonical path and the hash.
pub fn validate_built(file: &str, built: &Path) -> Result<(PathBuf, String), String> {
    let canon = Path::new(file).canonicalize().map_err(|e| format!("rules file {file}: {e}"))?;
    let root = built.canonicalize().map_err(|e| format!("rules folder is not readable: {e}"))?;
    if canon.parent() != Some(root.as_path()) {
        return Err("rules file is outside the built rules folder".into());
    }
    let hash = canon
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_suffix(".md"))
        .filter(|h| is_hash12(h))
        .ok_or("rules file name is not a built <hash12>.md")?
        .to_string();
    Ok((canon, hash))
}

/// Extra argv for `codex app-server`: `-c developer_instructions=<value>` or `--profile <name>`.
pub fn appserver_args_in(file: &str, built: &Path, codex_home: Option<&Path>) -> Result<Vec<String>, String> {
    let (path, hash) = validate_built(file, built)?;
    let text = crate::fsx::read_text(&path).map_err(|e| format!("rules file is not readable: {e}"))?;
    Ok(match choose(&text, &hash, codex_home)? {
        CodexRules::C { value } => vec!["-c".into(), format!("developer_instructions={value}")],
        CodexRules::Profile { name } => vec!["--profile".into(), name],
    })
}

pub fn appserver_args(file: &str) -> Result<Vec<String>, String> {
    appserver_args_in(file, &built_dir(&crate::paths::rules_dir()), codex_home().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let t = std::env::temp_dir().join(format!("vidar-rules-codex-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        t
    }

    /// Decoder for the subset the encoder emits; stands in for a TOML parser (not a dependency).
    fn decode(enc: &str) -> String {
        let inner = enc.strip_prefix('"').and_then(|s| s.strip_suffix('"')).expect("quoted");
        let mut out = String::new();
        let mut it = inner.chars();
        while let Some(c) = it.next() {
            if c != '\\' {
                assert!(c != '"' && c != '\n' && c != '\r', "unescaped {c:?}");
                out.push(c);
                continue;
            }
            match it.next().unwrap() {
                '\\' => out.push('\\'),
                '"' => out.push('"'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                'u' => {
                    let hex: String = it.by_ref().take(4).collect();
                    out.push(char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap());
                }
                other => panic!("unknown escape \\{other}"),
            }
        }
        out
    }

    #[test]
    fn toml_encoding_round_trips() {
        let src = "say \"hi\"\nC:\\path\\to\r\n\ttab \"\"\" triple\u{1}end é";
        let enc = encode_toml_string(src);
        assert_eq!(
            enc,
            "\"say \\\"hi\\\"\\nC:\\\\path\\\\to\\r\\n\\ttab \\\"\\\"\\\" triple\\u0001end é\""
        );
        assert_eq!(decode(&enc), src);
        assert_eq!(encode_toml_string(""), "\"\"");
    }

    #[test]
    fn length_rule_switches_to_profile() {
        let home = scratch("home");
        let short = "a".repeat(INLINE_LIMIT - 2); // 2 quote chars bring it to exactly the limit
        assert_eq!(
            choose(&short, "abcdef012345", Some(&home)).unwrap(),
            CodexRules::C { value: encode_toml_string(&short) }
        );
        assert!(!home.join("vidar-rules-abcdef012345.config.toml").exists());
        let long = "a".repeat(INLINE_LIMIT - 1);
        assert_eq!(
            choose(&long, "abcdef012345", Some(&home)).unwrap(),
            CodexRules::Profile { name: "vidar-rules-abcdef012345".into() }
        );
        let profile = std::fs::read_to_string(home.join("vidar-rules-abcdef012345.config.toml")).unwrap();
        assert_eq!(profile, format!("developer_instructions = {}\n", encode_toml_string(&long)));
        // escapes count toward the limit: 6,000 quotes encode to 12,000 chars plus 2 quotes
        let quotes = "\"".repeat(6_000);
        assert!(matches!(choose(&quotes, "abcdef012345", Some(&home)), Ok(CodexRules::Profile { .. })));
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn existing_profile_is_not_rewritten() {
        let home = scratch("profile-keep");
        let file = home.join("vidar-rules-abcdef012345.config.toml");
        std::fs::write(&file, "sentinel").unwrap();
        let long = "a".repeat(INLINE_LIMIT);
        assert!(matches!(choose(&long, "abcdef012345", Some(&home)), Ok(CodexRules::Profile { .. })));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "sentinel");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn appserver_rules_file_outside_built_dir_refused() {
        let t = scratch("appserver");
        let built = t.join("built");
        std::fs::create_dir_all(&built).unwrap();
        let good = built.join("0123456789ab.md");
        std::fs::write(&good, "rule text\n").unwrap();
        let args = appserver_args_in(good.to_str().unwrap(), &built, None).unwrap();
        assert_eq!(args, vec!["-c".to_string(), "developer_instructions=\"rule text\\n\"".to_string()]);

        let outside = t.join("0123456789ab.md");
        std::fs::write(&outside, "x").unwrap();
        assert!(appserver_args_in(outside.to_str().unwrap(), &built, None).is_err());
        let dotdot = built.join("..").join("0123456789ab.md");
        assert!(appserver_args_in(dotdot.to_str().unwrap(), &built, None).is_err());
        let badname = built.join("notahash.md");
        std::fs::write(&badname, "x").unwrap();
        assert!(appserver_args_in(badname.to_str().unwrap(), &built, None).is_err());
        assert!(appserver_args_in(built.join("missing000000.md").to_str().unwrap(), &built, None).is_err());
        std::fs::remove_dir_all(&t).unwrap();
    }
}
