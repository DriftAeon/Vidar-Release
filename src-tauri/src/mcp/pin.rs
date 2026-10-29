// Unpinned package-runner rule, shared by the rack listing and other spawners.

// ---- unpinned package runners ----
//
// Listing spawns the configured command. A package runner (`npx -y srv`, `uvx pkg`) with no
// exact version downloads and runs whatever the registry serves today, every time the rack
// lists it, so the rack refuses those before spawning. `cmd /c <runner> ...` is unwrapped, and
// every package value counts (`-p`, `--with`), not only the first. Pinned forms: `name@1.2.3`
// (npm runners), `name==1.2.3` or `name@1.2.3` (uvx, uv tool run, pipx run). Every other
// command is spawned as before.

/// `(label, args after the runner, python-style specs)` when `command` is a package runner.
fn package_runner<'a>(command: &str, args: &'a [String]) -> Option<(&'static str, &'a [String], bool)> {
    let stem = runner_stem(command);
    let sub = |i: usize, word: &str| args.get(i).is_some_and(|a| a == word);
    match stem.as_str() {
        "npx" => Some(("npx", args, false)),
        "pnpx" => Some(("pnpx", args, false)),
        "bunx" => Some(("bunx", args, false)),
        "uvx" => Some(("uvx", args, true)),
        "pnpm" if sub(0, "dlx") => Some(("pnpm dlx", &args[1..], false)),
        "yarn" if sub(0, "dlx") => Some(("yarn dlx", &args[1..], false)),
        "npm" if sub(0, "exec") || sub(0, "x") => Some(("npm exec", &args[1..], false)),
        "bun" if sub(0, "x") => Some(("bun x", &args[1..], false)),
        "pipx" if sub(0, "run") => Some(("pipx run", &args[1..], true)),
        "uv" if sub(0, "tool") && sub(1, "run") => Some(("uv tool run", &args[2..], true)),
        _ => None,
    }
}

/// Lowercased file name of `command` without a `.cmd`/`.exe`/`.bat`/`.ps1` suffix.
fn runner_stem(command: &str) -> String {
    let file = command.rsplit(['\\', '/']).next().unwrap_or(command).to_ascii_lowercase();
    let stem = [".cmd", ".exe", ".bat", ".ps1"].iter().find_map(|x| file.strip_suffix(x)).unwrap_or(&file);
    stem.to_string()
}

/// Every package spec a runner will fetch: each package-flag value (npm family `--package`/`-p`/
/// `--spec`; python family `--from`/`--spec`, where `-p` is `--python`), each `--with`/`-w` value
/// (python family), and the first positional argument when no package flag is given. Scanning
/// stops at the first positional: what follows belongs to the server. Other value-taking
/// options are skipped with their value.
fn runner_packages(rest: &[String], python: bool) -> Vec<&str> {
    let pkg_flags: &[&str] = if python { &["--from", "--spec"] } else { &["--package", "-p", "--spec"] };
    let with_flags: &[&str] = if python { &["--with", "-w"] } else { &[] };
    let valued = |a: &str| matches!(a, "--registry" | "--index-url" | "--call" | "-c") || (python && matches!(a, "--python" | "-p"));
    let mut pkgs = Vec::new();
    let mut has_flag = false;
    let mut i = 0;
    while i < rest.len() {
        let a = rest[i].as_str();
        if let Some((flag, value)) = a.split_once('=').filter(|(f, _)| f.starts_with('-')) {
            if pkg_flags.contains(&flag) {
                has_flag = true;
                pkgs.push(value);
            } else if with_flags.contains(&flag) {
                pkgs.push(value);
            }
        } else if pkg_flags.contains(&a) {
            has_flag = true;
            if let Some(v) = rest.get(i + 1) {
                pkgs.push(v.as_str());
            }
            i += 1;
        } else if with_flags.contains(&a) {
            if let Some(v) = rest.get(i + 1) {
                pkgs.push(v.as_str());
            }
            i += 1;
        } else if valued(a) {
            i += 1;
        } else if a == "--" {
            if !has_flag {
                pkgs.extend(rest.get(i + 1).map(String::as_str));
            }
            break;
        } else if !a.starts_with('-') {
            if !has_flag {
                pkgs.push(a);
            }
            break;
        }
        i += 1;
    }
    pkgs
}

/// A PEP 440-ish exact version: starts with a digit, no operators, tags or wildcards.
fn python_version(v: &str) -> bool {
    v.bytes().next().is_some_and(|b| b.is_ascii_digit()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b".+!-_".contains(&b))
}

/// `1.2.3`, optionally `-pre` / `+build`; no ranges, tags or wildcards.
fn exact_semver(v: &str) -> bool {
    let core = v.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && v.bytes().all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
}

fn spec_pinned(spec: &str, python: bool) -> bool {
    if python {
        if let Some((name, v)) = spec.split_once("==") {
            return !name.is_empty() && python_version(v.strip_prefix('=').unwrap_or(v));
        }
        // uvx accepts `pkg@1.2.3`; `@latest` fails the digit-first test
        return match spec.rfind('@').filter(|&i| i > 0) {
            Some(i) => python_version(&spec[i + 1..]),
            None => false,
        };
    }
    // `@scope/name@1.2.3`: the version is after the last `@` that isn't the scope's
    match spec.rfind('@').filter(|&i| i > 0) {
        Some(i) => exact_semver(&spec[i + 1..]),
        None => false,
    }
}

/// The refusal text for an unpinned package-runner command, None when it may be spawned.
pub(crate) fn unpinned_runner(command: &str, args: &[String]) -> Option<String> {
    if runner_stem(command) == "cmd" {
        // `cmd [/d] [/s] [/q] /c <command...>`: judge the wrapped command
        let mut i = 0;
        while i < args.len() {
            let a = args[i].as_str();
            if ["/d", "/s", "/q"].iter().any(|f| a.eq_ignore_ascii_case(f)) {
                i += 1;
                continue;
            }
            if a.eq_ignore_ascii_case("/c") || a.eq_ignore_ascii_case("/k") {
                let target = args.get(i + 1)?.trim_matches('"');
                if target.contains(char::is_whitespace) {
                    let mut toks = target.split_whitespace();
                    let inner = toks.next()?.trim_matches('"');
                    let mut tail: Vec<String> = toks.map(|t| t.trim_matches('"').to_string()).collect();
                    tail.extend(args[i + 2..].iter().cloned());
                    return unpinned_runner(inner, &tail);
                }
                return unpinned_runner(target, &args[i + 2..]);
            }
            return None;
        }
        return None;
    }
    let (label, rest, python) = package_runner(command, args)?;
    let pkgs = runner_packages(rest, python);
    match pkgs.iter().find(|s| !spec_pinned(s, python)) {
        Some(spec) => Some(format!("not listed: unpinned package runner ({label} {spec})")),
        None if pkgs.is_empty() => Some(format!("not listed: unpinned package runner ({label})")),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runner(cmd: &str, args: &[&str]) -> Option<String> {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        unpinned_runner(cmd, &args)
    }

    #[test]
    fn unpinned_package_runners_are_refused() {
        assert_eq!(runner("npx", &["-y", "srv"]).as_deref(), Some("not listed: unpinned package runner (npx srv)"));
        assert_eq!(runner("npx", &["-y", "srv@1.2.3"]), None);
        assert_eq!(runner("npx", &["srv@latest"]).as_deref(), Some("not listed: unpinned package runner (npx srv@latest)"));
        assert_eq!(runner("uvx", &["pkg==1.0.0"]), None);
        assert_eq!(runner("node", &["server.js"]), None);
    }

    #[test]
    fn runner_spellings_scopes_and_ranges() {
        assert!(runner("C:\\nodejs\\npx.cmd", &["-y", "srv"]).is_some());
        assert_eq!(runner("npx.cmd", &["-y", "@scope/srv@0.4.1"]), None);
        assert!(runner("npx", &["-y", "@scope/srv"]).is_some());
        assert!(runner("npx", &["srv@^1.2.3"]).is_some());
        assert_eq!(runner("pnpm", &["dlx", "srv@1.0.0"]), None);
        assert_eq!(runner("yarn", &["dlx", "srv"]).as_deref(), Some("not listed: unpinned package runner (yarn dlx srv)"));
        assert!(runner("pnpm", &["run", "srv"]).is_none());
        assert!(runner("bunx", &["srv"]).is_some());
        assert!(runner("pnpx", &["srv@1.2"]).is_some());
        assert!(runner("uvx", &["pkg"]).is_some());
        assert!(runner("uvx", &["pkg>=1.0"]).is_some());
        assert!(runner("uvx", &["pkg==1.*"]).is_some());
        assert_eq!(runner("uvx", &["--from", "pkg==2.1.0", "pkg-cli"]), None);
        assert!(runner("pipx", &["run", "pkg"]).is_some());
        assert_eq!(runner("pipx", &["run", "pkg==3.0"]), None);
        assert_eq!(runner("npx", &["-p", "srv@1.0.0", "srv-bin"]), None);
    }

    #[test]
    fn cmd_wrapper_is_unwrapped() {
        assert!(runner("cmd", &["/c", "npx", "-y", "srv"]).is_some());
        assert_eq!(runner("cmd", &["/c", "npx -y srv@1.2.3"]), None);
        assert!(runner("cmd.exe", &["/d", "/s", "/c", "npx", "-y", "srv"]).is_some());
        assert!(runner("cmd", &["/D", "/S", "/C", "\"npx -y srv\""]).is_some());
        assert_eq!(runner("cmd", &["/c", "node", "server.js"]), None);
    }

    #[test]
    fn uvx_at_pins_and_python_flags() {
        assert_eq!(runner("uvx", &["pkg@1.2.3"]), None);
        assert!(runner("uvx", &["pkg@latest"]).is_some());
        assert!(runner("uvx", &["pkg@^1.2"]).is_some());
        assert_eq!(runner("uvx", &["-p", "3.12", "pkg==1.0.0"]), None);
        assert!(runner("uvx", &["--with", "dep", "pkg==1.0.0"]).is_some());
        assert_eq!(runner("uvx", &["--with", "dep==2.0", "pkg==1.0.0"]), None);
    }

    #[test]
    fn every_package_is_judged() {
        assert_eq!(
            runner("npx", &["-p", "a@1.0.0", "-p", "b", "srv"]).as_deref(),
            Some("not listed: unpinned package runner (npx b)")
        );
    }

    #[test]
    fn more_runners_are_detected() {
        assert!(runner("npm", &["exec", "srv"]).is_some());
        assert_eq!(runner("npm", &["exec", "srv@1.2.3"]), None);
        assert!(runner("npm", &["x", "srv"]).is_some());
        assert!(runner("npm", &["run", "srv"]).is_none());
        assert!(runner("bun", &["x", "srv"]).is_some());
        assert!(runner("uv", &["tool", "run", "pkg"]).is_some());
        assert_eq!(runner("uv", &["tool", "run", "pkg==1.0.0"]), None);
        assert!(runner("uv", &["pip", "install", "pkg"]).is_none());
    }
}
