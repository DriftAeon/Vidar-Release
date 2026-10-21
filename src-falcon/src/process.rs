//! Falcon's Windows child-process ownership: create suspended, assign the
//! kill-on-close Job, then resume. Vidar's `agent.rs` spawns normally and
//! assigns afterwards, accepting a small window in which a child could fork
//! before the Job exists. Falcon is the durable host, so it closes that window
//! instead of documenting it.
//!
//! That ordering is why this is a direct `CreateProcessW` wrapper rather than
//! `std::process::Command`: resuming a suspended child needs the initial thread
//! handle, and `std::process::Child` exposes only the process handle.
//! `ChildExt::main_thread_handle()` would supply it, but it is unstable —
//! compile-checked against rustc 1.98.0 (E0658,
//! `windows_process_extensions_main_thread_handle`, tracking issue 96723).
//!
//! Inherited handles are restricted to exactly the three child pipe ends with
//! `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, so a concurrent spawn elsewhere in the
//! process cannot leak a handle into this child.

use std::{
    collections::BTreeMap,
    ffi::{c_void, OsString},
    mem::size_of,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        mpsc::{sync_channel, RecvTimeoutError},
        Arc, Mutex, TryLockError,
    },
    time::{Duration, Instant},
};

use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            DuplicateHandle, SetHandleInformation, DUPLICATE_SAME_ACCESS, HANDLE, HANDLE_FLAGS,
            HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{ReadFile, WriteFile},
        System::{
            Environment::{FreeEnvironmentStringsW, GetEnvironmentStringsW},
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Pipes::CreatePipe,
            Threading::{
                CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetCurrentThread,
                GetExitCodeProcess, InitializeProcThreadAttributeList, ResumeThread,
                TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW,
                CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
                LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
                STARTUPINFOW,
            },
            IO::CancelSynchronousIo,
        },
    },
};

use crate::security::{win_error, OwnedHandle};

/// Bytes of one child stdout line before the line is dropped with a marker.
/// Matches Vidar's `agent.rs` cap so a Falcon-hosted session cannot accept a
/// frame the current renderer would have refused.
pub const LINE_CAP: usize = 8 * 1024 * 1024;
const PIPE_BUFFER: u32 = 64 * 1024;
const STOP_GRACE: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(20);

/// How long [`Child::write_line`] waits for a line to reach the pipe before it
/// abandons the write. A child that is reading its stdin drains 64 KiB the
/// moment the write lands, so anything near this bound means the child has
/// stopped reading. Kept well under the caller's command timeout in
/// `claude.rs` so a stuck write is reported as a write problem rather than as
/// a silent command.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long [`Child::close_stdin`] keeps retrying a blocked write.
#[allow(dead_code)] // close_stdin is only called from this module's own tests
const CLOSE_GRACE: Duration = Duration::from_secs(1);
/// How long a close waits for an in-flight write to land before cancelling it.
/// A child that is reading its stdin finishes a line in microseconds, so this
/// only ever cancels a write that is already stuck — cancelling eagerly would
/// truncate a healthy line and hand the sidecar half a JSON frame.
const WRITE_SETTLE: Duration = Duration::from_millis(500);
/// Abandoned writer threads stay parked in `WriteFile` until the child reads
/// or the Job kills it, so new writes are refused once this many are queued.
/// Well above any real concurrency: the stdin mutex serialises writes anyway.
const MAX_PENDING_WRITES: usize = 16;

// Lifecycle of one stdin write, as seen by the caller and its writer thread.
const WRITE_PENDING: u8 = 0;
const WRITE_ACTIVE: u8 = 1;
const WRITE_DONE: u8 = 2;
const WRITE_ABANDONED: u8 = 3;

/// Environment names scrubbed from every hosted child. Mirrors Vidar's
/// `pty::SCRUBBED_ENV` reasoning: Falcon may itself be launched from inside an
/// agent's tool shell, and the hosted CLI must not inherit that conversation's
/// markers.
pub const SCRUBBED_ENV: &[&str] = &[
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "ANTHROPIC_API_KEY",
    "VIDAR_TAB",
    "VIDAR_TAB_NAME",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "VIDAR_CTL_TOKEN",
    // When set, the CLI's applyFlagSettings refuses effort changes ("overrides effort for this session"), breaking the live effort picker.
    "CLAUDE_CODE_EFFORT_LEVEL",
    // Re-added per child by `claude.rs::spawn_request` only when the spawn
    // carries one; never inherited from Falcon's own environment.
    "VIDAR_CTL_SECRET",
    // Mirrors `src-tauri/src/pty.rs` SCRUBBED_ENV. A Falcon started from a
    // hosted session carries that session's id; a child must not claim it.
    // `claude.rs::spawn_request` re-adds the child's own id.
    "FALCON_SESSION",
    "NO_COLOR",
    "TERM",
    "COLORTERM",
    "VIDAR_ROOT",
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
];

/// What a child's env is built from before `SpawnRequest.env` is laid over it. `SCRUBBED_ENV`
/// leaves either base.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EnvBase {
    /// Falcon's own env (every default spawn).
    #[default]
    Inherit,
    /// Only the names `contracts/agent-env.json` allows, plus the `=X:` entries, of Falcon's env
    /// (`src-tauri/src/bare/env.rs`, mounted as `bare_env`): a profiled (bare) spawn. Its
    /// overlay arrives in `env`.
    Allowlist,
}

#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub env_base: EnvBase,
}

/// A live hosted child plus the Job that owns its whole tree.
pub struct Child {
    pid: u32,
    #[allow(dead_code)] // only read via the created_100ns() accessor, itself test-only
    created_100ns: u64,
    process: OwnedHandle,
    /// Never held across a blocking call, so `terminate_tree` can always take
    /// it. That is the invariant that keeps Job termination reachable.
    job: Mutex<Option<OwnedHandle>>,
    stdin: Arc<Stdin>,
    stopping: AtomicBool,
}

/// The parent end of the child's stdin, plus the bookkeeping that stops a
/// blocked write from stranding a close.
///
/// Why the `Arc`: a writer thread can outlive its `Child`. A write into a full
/// pipe stays inside `WriteFile` until the child reads or the Job kills it, and
/// the caller is allowed to walk away long before that — so the mutex the
/// writer is holding must not be freed underneath it.
struct Stdin {
    /// `None` once stdin is closed. A writer thread holds this across a
    /// blocking `WriteFile`; every other path uses [`Stdin::try_close`], which
    /// never waits.
    handle: Mutex<Option<OwnedHandle>>,
    /// A real (duplicated) handle to the thread currently inside `WriteFile`,
    /// so a stop can cancel that I/O rather than wait for it. Only ever held
    /// for the length of a store, never across a blocking call.
    writer: Mutex<Option<OwnedHandle>>,
    /// Writer threads that have not finished, including abandoned ones.
    in_flight: AtomicUsize,
}

/// What a [`Child::write_line_status`] call actually achieved.
///
/// The distinction matters because Falcon cannot un-send bytes: a caller that
/// is told "not written" may retry, and a caller that is told anything else
/// must not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteStatus {
    /// Every byte of the line, newline included, reached the pipe.
    Written,
    /// Nothing was written and nothing will be. The write was rejected, or it
    /// was abandoned before `WriteFile` was reached, or the first `WriteFile`
    /// failed with no bytes accepted. Safe to report as a definite failure.
    NotWritten(String),
    /// The write started and neither finished nor failed within its deadline,
    /// or it failed part way through. Bytes may already be in the pipe and the
    /// child may already have acted on them. Never a definite failure; never
    /// retry it.
    PossiblyDelivered(String),
}

impl WriteStatus {
    #[allow(dead_code)] // asserted on by this module's own tests only
    pub fn is_written(&self) -> bool {
        matches!(self, WriteStatus::Written)
    }

    /// True when the bytes definitely never reached the child.
    #[allow(dead_code)] // asserted on by this module's own tests only
    pub fn is_definite_failure(&self) -> bool {
        matches!(self, WriteStatus::NotWritten(_))
    }

    #[allow(dead_code)] // asserted on by this module's own tests only
    pub fn message(&self) -> Option<&str> {
        match self {
            WriteStatus::Written => None,
            WriteStatus::NotWritten(why) | WriteStatus::PossiblyDelivered(why) => Some(why),
        }
    }
}

/// The parent ends of the child's output pipes, handed to reader threads.
pub struct ChildOutput {
    pub stdout: PipeReader,
    pub stderr: PipeReader,
}

pub struct PipeReader(OwnedHandle);

impl PipeReader {
    /// Blocking read. `Ok(0)` means the child closed its end.
    pub fn read(&self, buffer: &mut [u8]) -> Result<usize, String> {
        let mut read = 0u32;
        let result = unsafe { ReadFile(self.0.handle(), Some(buffer), Some(&mut read), None) };
        match result {
            Ok(()) => Ok(read as usize),
            // A closed write end is end-of-stream, not a failure.
            Err(error) if is_pipe_ended(&error) => Ok(0),
            Err(error) => Err(win_error(error)),
        }
    }

    /// Read complete `\n`-terminated lines until the child closes its end,
    /// handing each to `on_line`. A line longer than [`LINE_CAP`] is dropped
    /// and reported through `on_overflow` rather than growing without bound.
    pub fn for_each_line(
        &self,
        mut on_line: impl FnMut(&str),
        mut on_overflow: impl FnMut(usize),
    ) -> Result<(), String> {
        // Invariant: `dropped > 0` means this line already exceeded the cap, so
        // `pending` is empty and every further byte is counted and discarded
        // until the newline that ends it. The check has to run when a segment is
        // appended, not only on a chunk's tail — a line can cross the cap exactly
        // at a chunk boundary and would otherwise be emitted whole.
        let mut pending: Vec<u8> = Vec::new();
        let mut dropped = 0usize;
        let mut chunk = vec![0u8; PIPE_BUFFER as usize];
        loop {
            let read = self.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            let mut rest = &chunk[..read];
            while let Some(index) = rest.iter().position(|byte| *byte == b'\n') {
                let (line, tail) = rest.split_at(index);
                rest = &tail[1..];
                append_segment(&mut pending, &mut dropped, line);
                if dropped > 0 {
                    on_overflow(dropped);
                    dropped = 0;
                } else {
                    let text = String::from_utf8_lossy(trim_cr(&pending)).into_owned();
                    pending.clear();
                    if !text.is_empty() {
                        on_line(&text);
                    }
                }
            }
            append_segment(&mut pending, &mut dropped, rest);
        }
        // A final line with no trailing newline is still a line.
        if dropped > 0 {
            on_overflow(dropped);
        } else if !pending.is_empty() {
            let text = String::from_utf8_lossy(trim_cr(&pending)).into_owned();
            if !text.is_empty() {
                on_line(&text);
            }
        }
        Ok(())
    }
}

fn append_segment(pending: &mut Vec<u8>, dropped: &mut usize, segment: &[u8]) {
    if *dropped > 0 {
        *dropped += segment.len();
    } else if pending.len() + segment.len() > LINE_CAP {
        *dropped = pending.len() + segment.len();
        pending.clear();
    } else {
        pending.extend_from_slice(segment);
    }
}

fn trim_cr(line: &[u8]) -> &[u8] {
    match line.split_last() {
        Some((b'\r', rest)) => rest,
        _ => line,
    }
}

impl Child {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// PID plus creation time. A PID alone is reusable by Windows, so every
    /// later "is this still my child" check compares the pair.
    #[allow(dead_code)] // only called from this module's own tests
    pub fn created_100ns(&self) -> u64 {
        self.created_100ns
    }

    #[allow(dead_code)] // parked: no caller yet, production or test
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Write one JSON line to the child's stdin, bounded by [`WRITE_TIMEOUT`].
    ///
    /// Signature and meaning unchanged: `Ok(())` means the whole line reached
    /// the pipe, `Err` means it did not — but `Err` now covers two cases the
    /// caller may want to tell apart. Use [`Child::write_line_status`] for
    /// that.
    #[allow(dead_code)] // only called from this module's own tests; production uses write_line_status
    pub fn write_line(&self, line: &str) -> Result<(), String> {
        match self.write_line_status(line) {
            WriteStatus::Written => Ok(()),
            WriteStatus::NotWritten(why) | WriteStatus::PossiblyDelivered(why) => Err(why),
        }
    }

    /// [`Child::write_line`] with the delivery question answered: see
    /// [`WriteStatus`].
    pub fn write_line_status(&self, line: &str) -> WriteStatus {
        self.write_line_within(line, WRITE_TIMEOUT)
    }

    /// [`Child::write_line_status`] with an explicit deadline.
    pub fn write_line_within(&self, line: &str, timeout: Duration) -> WriteStatus {
        if self.stopping.load(Ordering::SeqCst) {
            return WriteStatus::NotWritten("child is stopping".into());
        }
        if line.len() > LINE_CAP {
            return WriteStatus::NotWritten(format!(
                "line of {} bytes exceeds {LINE_CAP}",
                line.len()
            ));
        }
        let mut payload = Vec::with_capacity(line.len() + 1);
        payload.extend_from_slice(line.as_bytes());
        payload.push(b'\n');
        self.stdin.write(payload, timeout)
    }

    /// Close stdin. The sidecar treats EOF as "finish and exit", so this is the
    /// first half of a graceful stop and is also what a planned detach uses.
    ///
    /// Bounded and best effort: a write blocked in `WriteFile` owns the handle
    /// until it returns, so this cancels that write and retries for up to
    /// [`CLOSE_GRACE`] instead of waiting on the mutex. `false` means stdin is
    /// still open — the caller's remaining lever is [`Child::terminate_tree`].
    #[allow(dead_code)] // only called from this module's own tests
    pub fn close_stdin(&self) -> bool {
        let started = Instant::now();
        let deadline = started + CLOSE_GRACE;
        loop {
            if started.elapsed() >= WRITE_SETTLE {
                self.stdin.cancel_write();
            }
            if self.stdin.try_close() {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            std::thread::sleep(POLL.min(remaining));
        }
    }

    /// `Some(code)` once the root process has exited.
    pub fn try_wait(&self) -> Option<i32> {
        let waited = unsafe { WaitForSingleObject(self.process.handle(), 0) };
        if waited != WAIT_OBJECT_0 {
            return None;
        }
        let mut code = 0u32;
        match unsafe { GetExitCodeProcess(self.process.handle(), &mut code) } {
            Ok(()) => Some(code as i32),
            Err(_) => Some(-1),
        }
    }

    /// Terminate the Job, removing the root and every descendant. Dropping the
    /// handle afterwards keeps kill-on-close as the backstop for a failed
    /// explicit termination.
    pub fn terminate_tree(&self) {
        if let Some(job) = lock(&self.job).take() {
            let _ = unsafe { TerminateJobObject(job.handle(), 1) };
            drop(job);
        }
    }

    /// Graceful first: close stdin, wait up to five seconds for the root to
    /// exit, then terminate the Job regardless — a root that exited cleanly may
    /// still have left descendants behind.
    pub fn stop(&self) -> Option<i32> {
        self.stopping.store(true, Ordering::SeqCst);
        let started = Instant::now();
        let deadline = started + STOP_GRACE;
        let mut code;
        loop {
            // Never wait on the stdin mutex here. A write into a pipe the child
            // has stopped draining holds it until the child reads or the Job
            // below kills the child — waiting for it would make graceful close
            // depend on the very child it is trying to close. Give a write in
            // progress [`WRITE_SETTLE`] to land, then cancel it; take the
            // handle whenever it is free, and carry on either way.
            if started.elapsed() >= WRITE_SETTLE {
                self.stdin.cancel_write();
            }
            self.stdin.try_close();
            code = self.try_wait();
            if code.is_some() {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            std::thread::sleep(POLL.min(remaining));
        }
        self.terminate_tree();
        if code.is_none() {
            let _ = unsafe { TerminateProcess(self.process.handle(), 1) };
            code = self.try_wait();
        }
        code
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        // Non-blocking on purpose: a drop must never park behind a write the
        // child is refusing to read. Terminating the Job unblocks that write,
        // and the last `Arc<Stdin>` — often the writer thread's — closes the
        // handle.
        self.stdin.cancel_write();
        self.stdin.try_close();
        self.terminate_tree();
    }
}

impl Stdin {
    fn new(handle: OwnedHandle) -> Self {
        Self {
            handle: Mutex::new(Some(handle)),
            writer: Mutex::new(None),
            in_flight: AtomicUsize::new(0),
        }
    }

    /// Write `payload` on a thread the caller can abandon.
    ///
    /// The tradeoff: a thread per write costs a spawn (tens of microseconds
    /// against a command round trip measured in seconds) and can leak one
    /// parked thread per stuck child, but it needs no change to how the pipes
    /// are created. Overlapped I/O would bound the write without a thread, but
    /// `CreatePipe` only makes synchronous handles — the stdin pipe would have
    /// to become a named pipe with a guessable name and a connect race to win,
    /// which trades a bounded thread leak for a security question. The parked
    /// thread is self-healing: terminating the Job closes the child's read end,
    /// `WriteFile` returns `ERROR_BROKEN_PIPE`, and the thread unwinds.
    fn write(self: &Arc<Self>, payload: Vec<u8>, timeout: Duration) -> WriteStatus {
        if self.in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_PENDING_WRITES {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return WriteStatus::NotWritten(format!(
                "{MAX_PENDING_WRITES} stdin writes are already queued; the child is not reading stdin"
            ));
        }
        let state = Arc::new(AtomicU8::new(WRITE_PENDING));
        let (sender, receiver) = sync_channel::<WriteStatus>(1);
        let worker_stdin = Arc::clone(self);
        let worker_state = Arc::clone(&state);
        let spawned = std::thread::Builder::new()
            .name("falcon-stdin".into())
            .spawn(move || {
                let status = worker_stdin.write_blocking(&payload, &worker_state);
                worker_stdin.in_flight.fetch_sub(1, Ordering::SeqCst);
                // The caller may already have walked away; that is the point.
                let _ = sender.send(status);
            });
        if let Err(error) = spawned {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return WriteStatus::NotWritten(format!("start stdin writer: {error}"));
        }
        match receiver.recv_timeout(timeout) {
            Ok(status) => status,
            Err(RecvTimeoutError::Timeout) => {
                match state.swap(WRITE_ABANDONED, Ordering::SeqCst) {
                    // The writer never reached `WriteFile`, and now never will:
                    // it re-checks this state under the handle lock.
                    WRITE_PENDING => WriteStatus::NotWritten(format!(
                        "stdin write never started within {:?}; an earlier write is still blocked",
                        timeout
                    )),
                    // It finished as the deadline passed; its answer is better
                    // than a guess, and it is already on its way down the channel.
                    WRITE_DONE => receiver
                        .recv_timeout(POLL)
                        .unwrap_or(WriteStatus::PossiblyDelivered(
                            "stdin write finished at the deadline without reporting".into(),
                        )),
                    _ => WriteStatus::PossiblyDelivered(format!(
                        "stdin write did not finish within {timeout:?}; bytes may already be in the pipe"
                    )),
                }
            }
            Err(RecvTimeoutError::Disconnected) => WriteStatus::PossiblyDelivered(
                "stdin writer ended without reporting an outcome".into(),
            ),
        }
    }

    /// Runs on the writer thread. Everything past the handle lock can park
    /// indefinitely — by design, since the caller is bounded instead.
    fn write_blocking(&self, payload: &[u8], state: &AtomicU8) -> WriteStatus {
        let handle = lock(&self.handle);
        let Some(stdin) = handle.as_ref() else {
            return WriteStatus::NotWritten("child stdin is closed".into());
        };
        if state
            .compare_exchange(
                WRITE_PENDING,
                WRITE_ACTIVE,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            // Abandoned while this thread queued for the handle. Writing now
            // would deliver a line the caller has already been told was not
            // written, so the claim has to stay true.
            return WriteStatus::NotWritten("stdin write abandoned before it started".into());
        }
        self.set_writer(current_thread_handle());
        let result = write_all(stdin.handle(), payload);
        self.set_writer(None);
        let _ =
            state.compare_exchange(WRITE_ACTIVE, WRITE_DONE, Ordering::SeqCst, Ordering::SeqCst);
        match result {
            Ok(()) => WriteStatus::Written,
            // Nothing was accepted: a broken pipe on the first chunk, or a
            // cancellation that beat the first byte.
            Err((0, why)) => {
                WriteStatus::NotWritten(format!("stdin write failed with nothing written: {why}"))
            }
            Err((written, why)) => WriteStatus::PossiblyDelivered(format!(
                "stdin write failed after {written} of {} bytes: {why}",
                payload.len()
            )),
        }
    }

    /// Close stdin if nothing is writing. Never waits; `true` once the handle
    /// is gone.
    fn try_close(&self) -> bool {
        match self.handle.try_lock() {
            Ok(mut handle) => {
                handle.take();
                true
            }
            Err(TryLockError::Poisoned(error)) => {
                error.into_inner().take();
                true
            }
            Err(TryLockError::WouldBlock) => false,
        }
    }

    /// Ask Windows to abort a `WriteFile` parked on a full pipe, so a graceful
    /// close can still reach the child. Best effort: `ERROR_NOT_FOUND` only
    /// means the writer is not in the kernel at this instant, and every caller
    /// polls.
    fn cancel_write(&self) {
        let writer = match self.writer.try_lock() {
            Ok(writer) => writer,
            Err(TryLockError::Poisoned(error)) => error.into_inner(),
            Err(TryLockError::WouldBlock) => return,
        };
        if let Some(thread) = writer.as_ref() {
            let _ = unsafe { CancelSynchronousIo(thread.handle()) };
        }
    }

    fn set_writer(&self, thread: Option<OwnedHandle>) {
        *lock(&self.writer) = thread;
    }
}

/// A real handle to the calling thread. `GetCurrentThread` returns a
/// pseudo-handle that only means "me" in the thread that asked, which is no use
/// to the thread doing the cancelling.
fn current_thread_handle() -> Option<OwnedHandle> {
    let mut duplicate = HANDLE::default();
    let copied = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            GetCurrentThread(),
            GetCurrentProcess(),
            &mut duplicate,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    };
    match copied {
        Ok(()) => Some(OwnedHandle::new(duplicate)),
        // Cancellation is an optimisation; the Job kill is the guarantee.
        Err(_) => None,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // Poison must not disable best-effort process cleanup.
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// Create the child suspended, assign its kill-on-close Job, then resume.
///
/// Failure at any point before resume terminates and closes the partly built
/// child, so this never returns a running process that the Job does not own.
#[cfg(test)]
pub fn spawn(request: &SpawnRequest) -> Result<(Child, ChildOutput), String> {
    spawn_recording(request).map(|(child, output, _)| (child, output))
}

/// [`spawn`], also returning the names (never values) of the env the child was given, taken from
/// the same snapshot that built its block. A profiled session reports them (`env_names`).
pub fn spawn_recording(request: &SpawnRequest) -> Result<(Child, ChildOutput, Vec<String>), String> {
    if !request.program.is_file() {
        return Err(format!("program not found: {}", request.program.display()));
    }
    if !request.cwd.is_dir() {
        return Err(format!("cwd is not a directory: {}", request.cwd.display()));
    }

    let job = create_job()?;
    let (stdin_read, stdin_write) = pipe()?;
    let (stdout_read, stdout_write) = pipe()?;
    let (stderr_read, stderr_write) = pipe()?;
    // Only the child ends may cross the process boundary.
    no_inherit(stdin_write.handle())?;
    no_inherit(stdout_read.handle())?;
    no_inherit(stderr_read.handle())?;

    let inherited = [
        stdin_read.handle(),
        stdout_write.handle(),
        stderr_write.handle(),
    ];
    let mut attributes = AttributeList::new(1)?;
    attributes.set_handle_list(&inherited)?;

    let startup = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: size_of::<STARTUPINFOEXW>() as u32,
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: stdin_read.handle(),
            hStdOutput: stdout_write.handle(),
            hStdError: stderr_write.handle(),
            ..Default::default()
        },
        lpAttributeList: attributes.list,
    };

    let mut command_line = command_line(&request.program, &request.args);
    // One snapshot builds both the block the child gets and the names the session reports.
    let entries = environment_entries(request.env_base, current_environment(), &request.env);
    let env_names: Vec<String> = entries.values().map(|(name, _)| name.to_string_lossy().into_owned()).collect();
    let environment = block_from_entries(entries);
    let program = wide(request.program.as_os_str());
    let cwd = wide(request.cwd.as_os_str());
    let mut information = PROCESS_INFORMATION::default();

    unsafe {
        CreateProcessW(
            PCWSTR(program.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            true,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            Some(environment.as_ptr().cast::<c_void>()),
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo as *const STARTUPINFOW,
            &mut information,
        )
        .map_err(|error| format!("create {}: {}", request.program.display(), win_error(error)))?;
    }
    // Keep the attribute list and its handle array alive across the call.
    drop(attributes);

    let process = OwnedHandle::new(information.hProcess);
    let thread = OwnedHandle::new(information.hThread);
    // The child owns its ends now; a retained parent copy would keep stdout
    // open forever and the reader would never see end-of-stream.
    drop(stdin_read);
    drop(stdout_write);
    drop(stderr_write);

    // Nothing has run yet, so a failure here leaves no descendants to miss.
    let failed = |why: String| -> String {
        unsafe {
            let _ = TerminateProcess(process.handle(), 1);
        }
        why
    };
    unsafe { AssignProcessToJobObject(job.handle(), process.handle()) }
        .map_err(|error| failed(format!("assign job: {}", win_error(error))))?;
    let created_100ns = crate::ipc::process_creation_identity(process.handle())
        .map_err(|error| failed(format!("child creation identity: {error}")))?;

    if unsafe { ResumeThread(thread.handle()) } == u32::MAX {
        return Err(failed(format!(
            "resume child: {}",
            win_error(windows::core::Error::from_win32())
        )));
    }

    Ok((
        Child {
            pid: information.dwProcessId,
            created_100ns,
            process,
            job: Mutex::new(Some(job)),
            stdin: Arc::new(Stdin::new(stdin_write)),
            stopping: AtomicBool::new(false),
        },
        ChildOutput {
            stdout: PipeReader(stdout_read),
            stderr: PipeReader(stderr_read),
        },
        env_names,
    ))
}

fn create_job() -> Result<OwnedHandle, String> {
    // `None` attributes make the handle non-inheritable: a hosted child must
    // not hold the last reference to the Job that is meant to kill it.
    let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|error| format!("create job: {}", win_error(error)))?;
    let job = OwnedHandle::new(handle);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job.handle(),
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(limits).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .map_err(|error| format!("set job limits: {}", win_error(error)))?;
    Ok(job)
}

fn pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: true.into(),
    };
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    unsafe {
        CreatePipe(&mut read, &mut write, Some(&attributes), PIPE_BUFFER)
            .map_err(|error| format!("create pipe: {}", win_error(error)))?;
    }
    if read == INVALID_HANDLE_VALUE || write == INVALID_HANDLE_VALUE {
        return Err("create pipe returned an invalid handle".into());
    }
    Ok((OwnedHandle::new(read), OwnedHandle::new(write)))
}

fn no_inherit(handle: HANDLE) -> Result<(), String> {
    unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) }
        .map_err(|error| format!("clear handle inheritance: {}", win_error(error)))
}

/// Owns the `PROC_THREAD_ATTRIBUTE_LIST` allocation and the handle array it
/// points at, so both outlive `CreateProcessW` and are released exactly once.
struct AttributeList {
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
    _buffer: Vec<usize>,
    _handles: Vec<HANDLE>,
}

impl AttributeList {
    fn new(count: u32) -> Result<Self, String> {
        let mut size = 0usize;
        // The sizing call always fails with ERROR_INSUFFICIENT_BUFFER; `size`
        // is the output that matters.
        let _ = unsafe { InitializeProcThreadAttributeList(None, count, None, &mut size) };
        if size == 0 {
            return Err(format!(
                "size attribute list: {}",
                win_error(windows::core::Error::from_win32())
            ));
        }
        // `Vec<usize>` for pointer alignment; `Vec<u8>` is only byte-aligned.
        let mut buffer = vec![0usize; size.div_ceil(size_of::<usize>())];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr().cast::<c_void>());
        unsafe {
            InitializeProcThreadAttributeList(Some(list), count, None, &mut size)
                .map_err(|error| format!("init attribute list: {}", win_error(error)))?;
        }
        Ok(Self {
            list,
            _buffer: buffer,
            _handles: Vec::new(),
        })
    }

    fn set_handle_list(&mut self, handles: &[HANDLE]) -> Result<(), String> {
        self._handles = handles.to_vec();
        unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(self._handles.as_ptr().cast::<c_void>()),
                std::mem::size_of_val(self._handles.as_slice()),
                None,
                None,
            )
            .map_err(|error| format!("set inherited handle list: {}", win_error(error)))
        }
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.list.0.is_null() {
            unsafe { DeleteProcThreadAttributeList(self.list) };
        }
    }
}

/// Build the command line `CommandLineToArgvW` will split back into exactly
/// `program` plus `args`. Returned NUL-terminated and mutable, because
/// `CreateProcessW` may write into the buffer it is given.
fn command_line(program: &Path, args: &[String]) -> Vec<u16> {
    let mut line = String::new();
    append_argument(&mut line, &program.to_string_lossy());
    for argument in args {
        line.push(' ');
        append_argument(&mut line, argument);
    }
    wide(line.as_ref())
}

fn append_argument(line: &mut String, argument: &str) {
    // Always quote: an unquoted empty argument would vanish, and quoting a
    // argument that needs no quotes is still parsed back identically.
    line.push('"');
    let mut backslashes = 0usize;
    for character in argument.chars() {
        match character {
            '\\' => {
                backslashes += 1;
                line.push('\\');
            }
            '"' => {
                // Backslashes before a quote are doubled, then the quote escaped.
                for _ in 0..=backslashes {
                    line.push('\\');
                }
                backslashes = 0;
                line.push('"');
            }
            other => {
                backslashes = 0;
                line.push(other);
            }
        }
    }
    // Trailing backslashes would otherwise escape the closing quote.
    for _ in 0..backslashes {
        line.push('\\');
    }
    line.push('"');
}

/// The child's environment: Falcon's own, minus [`SCRUBBED_ENV`], plus
/// `additions`. `CREATE_UNICODE_ENVIRONMENT` requires a UTF-16 block, and
/// `CreateProcessW` requires its names sorted; `BTreeMap` over the uppercased
/// name gives Windows' own case-insensitive ordering, and also places the
/// `=X:` entries first, because '=' (0x3D) sorts below 'A' (0x41).
///
/// Names beginning with '=' are Windows' per-drive current directories
/// (`=C:=C:\some\path`), and they are load-bearing, not noise: they are how a
/// bare `C:` resolves to a directory. A child that inherits its environment
/// implicitly gets them; an explicit block that drops them breaks node's
/// `realpathSync`, which fails on the `C:` component of its own main script
/// with `EISDIR` and dies before running a line.
///
/// Read through `GetEnvironmentStringsW` because it is the authoritative view
/// and always carries them. Do NOT assume `std::env::vars_os` hides them — an
/// earlier comment here claimed exactly that and it was wrong: `vars_os`
/// returns them under PowerShell and not under Git Bash, so a test built on
/// that claim passed or failed depending on which shell ran it. The original
/// defect was this function's own filter skipping such names, not `vars_os`.
///
/// `EnvBase::Allowlist` (a bare spawn) starts from the allowlisted part of that
/// view instead, built by the same `bare/env.rs` Vidar's Raw bare tab uses; the
/// `=X:` entries survive it for the reason above.
#[cfg(test)]
fn environment_block(base: EnvBase, additions: &[(String, String)]) -> Vec<u16> {
    block_from_entries(environment_entries(base, current_environment(), additions))
}

/// The wide `NAME=VALUE\0...\0\0` block for already-built entries (sorted by uppercased name).
fn block_from_entries(entries: BTreeMap<String, (OsString, OsString)>) -> Vec<u16> {
    let mut block: Vec<u16> = Vec::new();
    for (name, value) in entries.into_values() {
        block.extend(name.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    // An empty block still needs its terminating pair.
    block.push(0);
    block
}

/// The child's env as name -> (name, value), keyed by the uppercased name: `inherited` reduced
/// by `base`, minus [`SCRUBBED_ENV`], plus `additions`. The one builder behind both the block a
/// child gets and the names a profiled session reports ([`spawn_recording`]).
fn environment_entries(
    base: EnvBase,
    inherited: Vec<(OsString, OsString)>,
    additions: &[(String, String)],
) -> BTreeMap<String, (OsString, OsString)> {
    let source: Vec<(OsString, OsString)> = match base {
        EnvBase::Inherit => inherited,
        EnvBase::Allowlist => crate::bare_env::allowlisted(inherited)
            .iter()
            .map(|(k, v)| (k.to_os_string(), v.to_os_string()))
            .collect(),
    };
    let mut entries: BTreeMap<String, (OsString, OsString)> = BTreeMap::new();
    for (name, value) in source {
        let key = name.to_string_lossy().to_uppercase();
        entries.insert(key, (name, value));
    }
    for name in SCRUBBED_ENV {
        entries.remove(&name.to_uppercase());
    }
    for (name, value) in additions {
        entries.insert(
            name.to_uppercase(),
            (OsString::from(name), OsString::from(value)),
        );
    }
    entries
}


/// Every variable in this process's environment, including the `=X:` entries.
fn current_environment() -> Vec<(OsString, OsString)> {
    use std::os::windows::ffi::OsStringExt;

    let mut entries = Vec::new();
    let block = unsafe { GetEnvironmentStringsW() };
    if block.is_null() {
        return entries;
    }
    let mut cursor = block.0;
    unsafe {
        // The block is a run of NUL-terminated `NAME=VALUE` strings, ended by
        // an empty string (a second NUL).
        loop {
            let mut length = 0usize;
            while *cursor.add(length) != 0 {
                length += 1;
            }
            if length == 0 {
                break;
            }
            let text = std::slice::from_raw_parts(cursor, length);
            // Split on the first '=' AFTER index 0: a leading '=' belongs to
            // the name of a per-drive entry, so `=C:=C:\path` must not split
            // into an empty name.
            if let Some(split) = text.iter().skip(1).position(|unit| *unit == b'=' as u16) {
                let split = split + 1;
                entries.push((
                    OsString::from_wide(&text[..split]),
                    OsString::from_wide(&text[split + 1..]),
                ));
            }
            cursor = cursor.add(length + 1);
        }
        let _ = FreeEnvironmentStringsW(PCWSTR(block.0));
    }
    entries
}

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

/// Strip a `\\?\` verbatim prefix, when the path can be expressed without one.
///
/// `std::fs::canonicalize` always returns verbatim paths on Windows. The Win32
/// APIs accept them, so they look harmless — but they are not a normal path to
/// the programs Falcon hands them to. Node's `realpathSync` parses `\\?\C:\…`
/// as a UNC-style root and then calls `lstat` on the bare drive letter, which
/// fails with `EISDIR`; the sidecar dies before executing a line. That is the
/// failure the slice-1 live proof hit, reproduced in
/// `node_cannot_run_a_script_named_by_a_verbatim_path`.
///
/// Anything a plain path cannot express (a path over `MAX_PATH`, or a device
/// name) is returned untouched rather than silently corrupted.
pub fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    let Some(rest) = text.strip_prefix(r"\\?\") else {
        return path.to_path_buf();
    };
    let bytes = rest.as_bytes();
    let drive_qualified = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if drive_qualified && rest.len() < 260 {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Resolve a bare program name against `PATH`/`PATHEXT`.
///
/// `CreateProcessW` is given an explicit `lpApplicationName` so the child is
/// never chosen by search-order surprise at spawn time; that means Falcon does
/// the search itself, once, and records what it resolved. `std::process::
/// Command` hides this step, which is why Vidar could pass a bare "node".
pub fn find_on_path(name: &str) -> Result<PathBuf, String> {
    let direct = Path::new(name);
    if direct.is_absolute() {
        return if direct.is_file() {
            Ok(direct.to_path_buf())
        } else {
            Err(format!("program not found: {name}"))
        };
    }
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase())
        .collect();
    let has_extension = direct.extension().is_some();
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        if has_extension {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        for extension in &extensions {
            let candidate = directory.join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!("program not found on PATH: {name}"))
}

/// Write every byte, reporting how many landed if it fails. The count is what
/// separates a definite rejection from an honest "may have been delivered":
/// `WriteFile` can accept part of a buffer and then fail.
fn write_all(handle: HANDLE, buffer: &[u8]) -> Result<(), (usize, String)> {
    let mut rest = buffer;
    let mut total = 0usize;
    while !rest.is_empty() {
        let mut written = 0u32;
        if let Err(error) = unsafe { WriteFile(handle, Some(rest), Some(&mut written), None) } {
            return Err((total + written as usize, win_error(error)));
        }
        if written == 0 {
            return Err((total, "child stdin write made no progress".into()));
        }
        total += written as usize;
        rest = &rest[written as usize..];
    }
    Ok(())
}

fn is_pipe_ended(error: &windows::core::Error) -> bool {
    // ERROR_BROKEN_PIPE / ERROR_PIPE_NOT_CONNECTED as HRESULTs.
    const BROKEN: i32 = -2147024787; // 0x8007_006D
    const NOT_CONNECTED: i32 = -2147024865; // 0x8007_00E9
    matches!(error.code().0, BROKEN | NOT_CONNECTED)
}

/// Wait for the process to exit, up to `timeout`.
pub fn wait_for(child: &Child, timeout: Duration) -> Option<i32> {
    let millis = timeout.as_millis().min(u32::MAX as u128) as u32;
    let waited = unsafe { WaitForSingleObject(child.process.handle(), millis) };
    if waited == WAIT_TIMEOUT {
        return None;
    }
    child.try_wait()
}

#[cfg(test)]
mod tests;
