//! Hidden, job-owned update processes with one deadline and bounded stdout.
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const STDOUT_GRACE: Duration = Duration::from_millis(500);

pub(super) fn run(mut command: Command, deadline: Instant) -> Option<String> {
    if Instant::now() >= deadline { return None; }
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = crate::proc_job::JobChild::spawn(&mut command).ok()?;
    let stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(64 * 1024 + 1).read_to_end(&mut bytes);
        let _ = tx.send((result.is_ok() && bytes.len() <= 64 * 1024).then_some(bytes));
    });
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            _ => return None, // JobChild's drop terminates and reaps the whole tree.
        }
    }
    // The child has exited, so its stdout closes now unless a grandchild inherited the pipe;
    // wait a short grace for the reader, not the rest of the deadline.
    let grace = deadline.saturating_duration_since(Instant::now()).min(STDOUT_GRACE);
    let bytes = rx.recv_timeout(grace).ok()??;
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_updates_timeout_kills_hidden_process() {
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c", "ping -n 6 127.0.0.1 >nul"]);
        let start = Instant::now();
        assert!(run(command, start + Duration::from_millis(100)).is_none());
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn cli_updates_reads_success_and_rejects_failure() {
        let mut ok = Command::new("cmd.exe");
        ok.args(["/d", "/c", "echo 1.2.3"]);
        assert_eq!(run(ok, Instant::now() + Duration::from_secs(3)).unwrap().trim(), "1.2.3");
        let mut bad = Command::new("cmd.exe");
        bad.args(["/d", "/c", "exit /b 1"]);
        assert!(run(bad, Instant::now() + Duration::from_secs(3)).is_none());
    }
}
