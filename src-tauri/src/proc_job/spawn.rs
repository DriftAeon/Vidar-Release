//! Spawn helpers shared with `proc_job.rs`: the quiet/scrubbed/exact-env command builder,
//! `spawn_into` (a child that joins a caller-owned job before it runs) and `wait_bounded`.

use std::ffi::OsStr;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, ExitStatus};
use std::time::{Duration, Instant};

use super::{resume_initial_thread, spawn_suspended, Job};

pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) trait SpawnExt {
    /// Hidden console window. For non-job spawns only: `spawn_into` owns the creation flags.
    fn quiet(&mut self) -> &mut Self;
    /// Removes every `SCRUBBED_ENV` key (agent-session markers) from the child's env.
    fn scrubbed(&mut self) -> &mut Self;
    /// The child gets exactly `vars`; std keeps the last op per key, `env_clear` drops earlier `env` calls.
    fn exact_env<I, K, V>(&mut self, vars: I) -> &mut Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>;
}

impl SpawnExt for Command {
    fn quiet(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }

    fn scrubbed(&mut self) -> &mut Self {
        for key in super::SCRUBBED_ENV {
            self.env_remove(key);
        }
        self
    }

    fn exact_env<I, K, V>(&mut self, vars: I) -> &mut Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.env_clear();
        self.envs(vars)
    }
}

/// Assigns a suspended child to `job` and resumes it. On failure the child is killed and
/// reaped; the job is left alone (it may be shared). Messages keep the `JobChild` wording.
pub(super) fn join_and_resume(mut child: Child, job: &Job) -> std::io::Result<Child> {
    let setup = job
        .assign(&child)
        .map_err(|e| format!("Assign Job: {e}"))
        .and_then(|_| resume_initial_thread(&child).map_err(|e| format!("Resume Job Child: {e}")));
    if let Err(e) = setup {
        let _ = child.kill();
        let _ = child.wait();
        return Err(std::io::Error::other(e));
    }
    Ok(child)
}

/// Spawns `cmd` hidden and suspended, assigns it to the caller's `job`, then resumes it, so
/// nothing it starts can escape. Owns the creation flags (CREATE_NO_WINDOW | CREATE_SUSPENDED).
/// Spawn errors keep their kind; assign/resume failures are `io::Error::other`. Never
/// terminates `job`.
pub(crate) fn spawn_into(cmd: &mut Command, job: &Job) -> std::io::Result<Child> {
    let child = spawn_suspended(cmd, CREATE_NO_WINDOW)?;
    join_and_resume(child, job)
}

/// Polls `try_wait` every 20 ms until the child exits (`Some`) or `deadline` passes (`None`).
/// Never kills: the caller decides what a timeout means.
pub(crate) fn wait_bounded(child: &mut Child, deadline: Instant) -> std::io::Result<Option<ExitStatus>> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(None);
        }
        std::thread::sleep((deadline - now).min(Duration::from_millis(20)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn scrubbed_sets_every_scrubbed_key_to_none() {
        let mut cmd = Command::new("cmd");
        cmd.scrubbed();
        let envs: Vec<_> = cmd.get_envs().collect();
        for key in crate::proc_job::SCRUBBED_ENV {
            assert!(envs.iter().any(|(k, v)| *k == OsStr::new(key) && v.is_none()), "{key} not scrubbed");
        }
    }

    #[test]
    fn exact_env_drops_inherited_and_earlier_vars() {
        std::env::set_var("VIDAR_EXACT_ENV_INHERITED", "inherited");
        let out = Command::new("cmd")
            .args(["/d", "/c", "set"])
            .env("VIDAR_EXACT_ENV_EARLIER", "earlier")
            .exact_env([("VIDAR_EXACT_ENV_GIVEN", "given"), ("SystemRoot", "C:\\Windows")])
            .stdin(Stdio::null())
            .quiet()
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout).to_ascii_uppercase();
        assert!(text.contains("VIDAR_EXACT_ENV_GIVEN=GIVEN"), "{text}");
        assert!(!text.contains("VIDAR_EXACT_ENV_INHERITED"), "{text}");
        assert!(!text.contains("VIDAR_EXACT_ENV_EARLIER"), "{text}");
    }

    #[test]
    fn wait_bounded_returns_none_at_deadline_for_a_live_child() {
        let mut child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .quiet()
            .spawn()
            .unwrap();
        let start = Instant::now();
        let got = wait_bounded(&mut child, start + Duration::from_millis(100)).unwrap();
        assert!(got.is_none());
        assert!(start.elapsed() >= Duration::from_millis(100));
        let _ = child.kill();
        let _ = child.wait();
    }
}
