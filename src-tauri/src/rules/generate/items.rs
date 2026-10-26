//! src-tauri\src\rules\generate\items.rs — ticked local skills, agents and hooks as item runes of a generated
//! library (model R1, R5): each pick is matched against the offered local files (`import::local::discover`), never
//! taken from the request alone, and written with the L1a item header keys in its kind folder (`skills/`, `agents/`,
//! `hooks/`). A skill or agent rune names its source by `~` path; a hook rune carries its event, matcher and the
//! script paths of its `run` (never a command line). The agent never sees these files: they land as they are.

use std::path::Path;

use crate::rules::import::local::LocalFile;
use crate::rules::import::sources;
use crate::rules::import::write::quote;
use crate::rules::rune::check_id;

/// One ticked item as the frontend sends it (`RulesGenerateArgs.items`).
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct Pick {
    /// `skill`, `agent` or `hook`.
    pub kind: String,
    /// The offered file's `path`, verbatim.
    pub path: String,
}

/// A hook's trigger and scripts.
#[derive(Clone, Debug, PartialEq)]
pub struct Hook {
    pub event: String,
    pub matcher: Option<String>,
    /// Script paths, `~` form where under the home.
    pub run: Vec<String>,
}

/// One item rune to write.
#[derive(Clone, Debug, PartialEq)]
pub struct ItemSpec {
    pub id: String,
    /// `skill`, `agent` or `hook`.
    pub kind: &'static str,
    pub description: String,
    /// Skill folder or agent file, `~` form where under the home.
    pub source: Option<String>,
    pub hook: Option<Hook>,
    /// `claude` or `codex` on a hook (hooks run on one agent); `None` otherwise.
    pub agent: Option<&'static str>,
}

/// The id grammar form of `name`: lowercase, every other run of characters one `-`.
fn id_of(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// The `description:` of a file's leading `---` header, unquoted and on one line; `None` when absent.
fn header_description(text: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    let line = lines.take_while(|l| l.trim() != "---").find_map(|l| l.strip_prefix("description:"))?;
    let d = line.trim().trim_matches(|c| c == '"' || c == '\'').split_whitespace().collect::<Vec<_>>().join(" ");
    (!d.is_empty()).then(|| d.chars().take(200).collect())
}

fn stem(path: &str) -> String {
    let p = Path::new(path);
    let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if name.eq_ignore_ascii_case("SKILL") {
        p.parent().and_then(Path::file_name).map(|s| s.to_string_lossy().into_owned()).unwrap_or(name)
    } else {
        name
    }
}

/// The picks as item runes. A pick that matches no pickable offered file of its kind is an `invalid:` error; a
/// hook that carries no script path, or only an opaque Codex selection, is skipped with a warning. `taken` holds
/// the ids already used in the library (the generated text runes); item ids get `-2`, `-3` … on a clash.
pub fn resolve(picks: &[Pick], offered: &[LocalFile], home: Option<&Path>, taken: &[String]) -> Result<(Vec<ItemSpec>, Vec<String>), String> {
    let mut used: Vec<String> = taken.to_vec();
    let mut out: Vec<ItemSpec> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for p in picks {
        let kind: &'static str = match p.kind.as_str() {
            "skill" => "skill",
            "agent" => "agent",
            "hook" => "hook",
            other => return Err(format!("invalid: item kind `{other}` is not skill, agent or hook")),
        };
        let Some(f) = offered.iter().find(|f| f.kind == kind && f.pickable && f.path.eq_ignore_ascii_case(&p.path)) else {
            return Err(format!("invalid: `{}` is not an offered {kind}", p.path));
        };
        let name = stem(&f.path);
        let base = id_of(&name);
        if check_id(&base).is_err() {
            warnings.push(format!("{} `{}` not carried: its name makes no rune id", titled(kind), f.shown));
            continue;
        }
        let mut id = base.clone();
        let mut n = 2;
        while used.contains(&id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        let tilde = |s: &str| sources::tilde(Path::new(s), home);
        let spec = match kind {
            "hook" => {
                let Some(g) = f.guard.as_ref().filter(|g| g.source.is_none()) else {
                    warnings.push(format!("Hook `{}` not carried: it has no script to run", f.shown));
                    continue;
                };
                let run: Vec<String> = g.run.iter().filter(|t| t.contains(['\\', '/'])).map(|t| tilde(t)).collect();
                if run.is_empty() {
                    warnings.push(format!("Hook `{}` not carried: it has no script to run", f.shown));
                    continue;
                }
                let matcher = g.matcher.clone().filter(|m| !m.trim().is_empty());
                let description = format!("Local hook {name} on {}", g.event);
                ItemSpec {
                    id: id.clone(),
                    kind,
                    description,
                    source: None,
                    hook: Some(Hook { event: g.event.clone(), matcher, run }),
                    agent: Some(if f.agent == Some("codex") { "codex" } else { "claude" }),
                }
            }
            _ => {
                let doc = if kind == "skill" { Path::new(&f.path).join("SKILL.md") } else { Path::new(&f.path).to_path_buf() };
                let description = sources::read(&doc)
                    .ok()
                    .and_then(|t| header_description(&t))
                    .unwrap_or_else(|| format!("Local {kind} {name}"));
                ItemSpec { id: id.clone(), kind, description, source: Some(tilde(&f.path)), hook: None, agent: None }
            }
        };
        used.push(id);
        out.push(spec);
    }
    Ok((out, warnings))
}

fn titled(kind: &str) -> &'static str {
    match kind {
        "skill" => "Skill",
        "agent" => "Agent",
        _ => "Hook",
    }
}

/// The folder an item kind's runes sit in.
pub fn folder(kind: &str) -> &'static str {
    match kind {
        "skill" => "skills",
        "agent" => "agents",
        _ => "hooks",
    }
}

/// One item rune file, scoped to `library`. Block keys (`run`) are written as block lists.
pub fn item_text(s: &ItemSpec, library: &str) -> String {
    let mut h = format!("---\nname: {}\nkind: {}\nscope: [{library}]\nstate: active\n", s.id, s.kind);
    if let Some(a) = s.agent {
        h.push_str(&format!("agent: {a}\n"));
    }
    if let Some(src) = &s.source {
        h.push_str(&format!("source: {}\n", quote(src)));
    }
    if let Some(hk) = &s.hook {
        h.push_str(&format!("event: {}\n", quote(&hk.event)));
        if let Some(m) = &hk.matcher {
            h.push_str(&format!("matcher: {}\n", quote(m)));
        }
        h.push_str("run:\n");
        for r in &hk.run {
            h.push_str(&format!("  - {}\n", quote(r)));
        }
    }
    h.push_str(&format!("description: {}\n---\n", quote(&s.description)));
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::import::local::Guard;

    fn offered(kind: &'static str, path: &str) -> LocalFile {
        LocalFile {
            path: path.into(),
            shown: path.into(),
            kind,
            library: None,
            section: None,
            scope: "global",
            ticked: true,
            pickable: true,
            reason: None,
            guard: None,
            codex_supported: None,
            agent: None,
            hosted: None,
            url: None,
        }
    }

    #[test]
    fn picks_become_parseable_item_runes_with_tilde_sources() {
        let home = Path::new(r"C:\Users\u");
        let mut hook = offered("hook", r"C:\Users\u\.claude\hooks\guard-cwd.mjs");
        hook.guard = Some(Guard {
            event: "PreToolUse".into(),
            matcher: Some("Bash".into()),
            run: vec!["node".into(), r"C:\Users\u\.claude\hooks\guard-cwd.mjs".into()],
            source: None,
        });
        let files = vec![offered("skill", r"C:\Users\u\.claude\skills\My_Skill"), offered("agent", r"C:\Users\u\.claude\agents\hound.md"), hook];
        let picks: Vec<Pick> = files.iter().map(|f| Pick { kind: f.kind.into(), path: f.path.clone() }).collect();
        let (items, warnings) = resolve(&picks, &files, Some(home), &["hound".to_string()]).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["my-skill", "hound-2", "guard-cwd"]);
        for i in &items {
            let text = item_text(i, "gen-0a1b2c3d");
            let r = crate::rules::rune::parse(&text).unwrap_or_else(|e| panic!("{e}\n{text}"));
            assert_eq!(r.kind, i.kind);
            assert!(!text.contains(r"C:\Users\u"), "{text}");
        }
        let hook = items.iter().find(|i| i.kind == "hook").unwrap();
        assert_eq!(hook.hook.as_ref().unwrap().run, [r"~\.claude\hooks\guard-cwd.mjs"]);
        assert_eq!(hook.agent, Some("claude"));
        assert_eq!(items[0].source.as_deref(), Some(r"~\.claude\skills\My_Skill"));
    }

    #[test]
    fn an_unoffered_pick_is_refused_and_a_scriptless_hook_is_skipped() {
        let files = vec![offered("skill", r"C:\a\s")];
        let bad = [Pick { kind: "skill".into(), path: r"C:\b\s".into() }];
        assert!(resolve(&bad, &files, None, &[]).unwrap_err().starts_with("invalid:"));
        let wrong_kind = [Pick { kind: "mcp".into(), path: r"C:\a\s".into() }];
        assert!(resolve(&wrong_kind, &files, None, &[]).unwrap_err().starts_with("invalid:"));
        let hook = offered("hook", r"C:\h\x.mjs");
        let (items, warnings) = resolve(&[Pick { kind: "hook".into(), path: hook.path.clone() }], &[hook], None, &[]).unwrap();
        assert!(items.is_empty() && warnings.len() == 1, "{warnings:?}");
    }

    #[test]
    fn descriptions_come_from_the_file_header() {
        assert_eq!(header_description("---\nname: x\ndescription: \"Find  things\"\n---\nbody").as_deref(), Some("Find things"));
        assert_eq!(header_description("no header"), None);
    }
}
