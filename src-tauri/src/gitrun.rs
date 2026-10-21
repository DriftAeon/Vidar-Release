// The one `git` runner shared by the review document (gitreview.rs) and the
// Changes commands (changes.rs): argument arrays, no shell, no pager, no
// external diff, no terminal prompts, no console window, a timeout and an
// output cap per call, optional stdin bytes. git runs in its own kill-on-close
// job (`proc_job::JobChild`), so a timeout ends the whole tree: the cmd\git
// wrapper, hooks, remote helpers, the credential manager, askpass, pinentry.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::proc_job::JobChild;

const STDERR_CAP: u64 = 64 * 1024;
/// Inherited repo overrides that would point git away from `cwd`.
const REPO_ENV: [&str; 5] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"];

#[derive(Debug)]
pub(crate) struct GitOut {
    pub text: String,
    /// stderr, trimmed (hook output lands here: git sends hook stdout to stderr)
    pub stderr: String,
    pub truncated: bool,
}

pub(crate) struct GitOpts<'a> {
    pub timeout: Duration,
    /// stdout bytes kept; the rest is drained and dropped
    pub cap: usize,
    /// written to the child's stdin, then stdin is closed; None = null stdin
    pub stdin: Option<&'a [u8]>,
    /// GIT_LITERAL_PATHSPECS=1: paths after `--` are never globs or magic
    pub literal_pathspecs: bool,
    /// GIT_CEILING_DIRECTORIES: repo discovery stops at this folder (never climbs into or past it)
    pub ceiling: Option<&'a Path>,
    /// GIT_CONFIG_GLOBAL on this child only: the file `--global` reads (the identity tests' seam)
    pub global_config: Option<&'a Path>,
}

impl GitOpts<'_> {
    pub(crate) fn read(timeout: Duration, cap: usize) -> GitOpts<'static> {
        GitOpts { timeout, cap, stdin: None, literal_pathspecs: true, ceiling: None, global_config: None }
    }
}

/// Run git with the fixed safety arguments. Err on a non-zero exit (stderr,
/// trimmed; stdout when stderr is empty), a timeout (names the verb and the
/// limit) or a missing git.
pub(crate) fn git(cwd: &Path, args: &[&str], opts: &GitOpts) -> Result<GitOut, String> {
    let verb = args.first().copied().unwrap_or("");
    let (code, out) = run(cwd, args, opts)?;
    if code != Some(0) {
        if !out.stderr.is_empty() { return Err(out.stderr); }
        let out_text = out.text.trim().to_string();
        let shown = code.map_or("no exit code".to_string(), |c| format!("exit code {c}"));
        return Err(if out_text.is_empty() { format!("git {verb} failed ({shown})") } else { out_text });
    }
    Ok(out)
}

/// `git` without the exit-status check: Ok((exit code, output)) whenever git
/// ran to the end; Err only for a spawn failure or a timeout.
pub(crate) fn run(cwd: &Path, args: &[&str], opts: &GitOpts) -> Result<(Option<i32>, GitOut), String> {
    let verb = args.first().copied().unwrap_or("");
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.pager=cat", "-c", "diff.external=", "--no-optional-locks"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_EXTERNAL_DIFF")
        .stdin(if opts.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for k in REPO_ENV { cmd.env_remove(k); }
    if opts.literal_pathspecs {
        cmd.env("GIT_LITERAL_PATHSPECS", "1");
    } else {
        cmd.env_remove("GIT_LITERAL_PATHSPECS");
    }
    if let Some(p) = opts.ceiling {
        cmd.env("GIT_CEILING_DIRECTORIES", p);
    }
    if let Some(p) = opts.global_config {
        cmd.env("GIT_CONFIG_GLOBAL", p);
    }
    // JobChild owns the creation flags (CREATE_NO_WINDOW, started suspended until it joins)
    let mut child = JobChild::spawn(&mut cmd).map_err(|e| format!("git not runnable: {e}"))?;
    let in_thread = match (opts.stdin, child.stdin.take()) {
        (Some(bytes), Some(mut pipe)) => {
            let bytes = bytes.to_vec();
            // dropping the pipe at the end of the thread closes the child's stdin
            Some(thread::spawn(move || { let _ = pipe.write_all(&bytes); }))
        }
        _ => None,
    };
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let cap = opts.cap;
    // drain both pipes on threads so a big diff can't deadlock the child; keep
    // stdout up to the cap and discard the rest (the child still finishes)
    let out_thread = thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if kept.len() + n <= cap { kept.extend_from_slice(&chunk[..n]); } else { truncated = true; }
                }
            }
        }
        (kept, truncated)
    });
    let err_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stderr).take(STDERR_CAP).read_to_end(&mut buf);
        // keep draining past the cap so a chatty hook can't block on a full pipe
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        buf
    });
    let started = Instant::now();
    let waited: Result<std::process::ExitStatus, String> = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) => {
                if started.elapsed() > opts.timeout {
                    break Err(format!("git {verb} timed out after {}s", opts.timeout.as_secs()));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => break Err(format!("git wait failed: {e}")),
        }
    };
    // ends the job (every process git started) on every path, not only a timeout:
    // a hook's leftover background process holding stdout would otherwise keep the
    // reader threads below from reaching EOF. Drop would end the job anyway.
    child.kill();
    let _ = child.wait();
    // joined on every path: a timeout leaks no thread
    if let Some(t) = in_thread { let _ = t.join(); }
    let out_joined = out_thread.join();
    let err_joined = err_thread.join();
    let status = waited?;
    let (kept, truncated) = out_joined.map_err(|_| "stdout reader panicked")?;
    let err = err_joined.map_err(|_| "stderr reader panicked")?;
    let err_text = String::from_utf8_lossy(&err).trim().to_string();
    Ok((status.code(), GitOut { text: String::from_utf8_lossy(&kept).into_owned(), stderr: err_text, truncated }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitrun_version_runs() {
        let out = git(Path::new("."), &["--version"], &GitOpts::read(Duration::from_secs(15), 4096)).unwrap();
        assert!(out.text.starts_with("git version"), "{}", out.text);
    }

    #[test]
    fn gitrun_stdin_reaches_the_child() {
        let opts = GitOpts { timeout: Duration::from_secs(15), cap: 4096, stdin: Some(b"hello"), literal_pathspecs: true, ceiling: None, global_config: None };
        let out = git(Path::new("."), &["hash-object", "--stdin"], &opts).unwrap();
        // `printf hello | git hash-object --stdin`
        assert_eq!(out.text.trim(), "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
    }

    #[test]
    fn gitrun_failure_names_the_error() {
        let err = git(Path::new("."), &["rev-parse", "--verify", "refs/heads/no-such-branch-vidar"], &GitOpts::read(Duration::from_secs(15), 4096)).unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn a_ceiling_stops_repo_discovery() {
        let base = std::env::temp_dir().join(format!("vidar-ceiling-{}", std::process::id()));
        let sub = base.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        git(&base, &["init", "-q"], &GitOpts::read(Duration::from_secs(15), 4096)).unwrap();
        let found = run(&sub, &["rev-parse", "--git-dir"], &GitOpts::read(Duration::from_secs(15), 4096)).unwrap();
        // git ignores a ceiling equal to the cwd itself; it must be a strict ancestor
        let ceiled = GitOpts { ceiling: Some(&base), ..GitOpts::read(Duration::from_secs(15), 4096) };
        let stopped = run(&sub, &["rev-parse", "--git-dir"], &ceiled).unwrap();
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(found.0, Some(0));
        assert_ne!(stopped.0, Some(0));
    }
}
