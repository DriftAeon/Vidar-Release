//! Windows Job Object with kill-on-close: owns a child's whole process TREE, so killing
//! a launcher also ends what it started. Needed because `.venv\Scripts\python.exe` is a
//! launcher stub that runs the real interpreter as its own child: `Child::kill` ends only
//! the stub, and the interpreter kept the inherited pipes (and the mic) open. `JobChild` is used by bang.rs, listen*.rs, speak.rs, stt_warm.rs, mcp.rs,
//! codex_threads.rs and gitrun.rs (every git call: gitreview.rs, changes.rs); agent.rs (codex tree) and flow.rs use the raw `Job`. claude_login.rs uses a
//! root-only `Job` (`Job::root_only`, silent breakaway): its own CreateProcessW child starts
//! suspended and joins before it runs, and whatever that child spawns (the browser) stays out.
//!
//! Job-owned children (`JobChild`) start suspended, join the job, then resume. Toolhelp
//! recovers the sole initial thread because std's Child exposes only the process handle.
//! Ambiguous thread snapshots and assignment/resume failures kill and reap the suspended
//! child.
//!
//! Accepted race for raw `Job` users (agent.rs, flow.rs): the child is spawned, then
//! assigned. A grandchild created in the microseconds between CreateProcess and
//! AssignProcessToJobObject escapes the job; node and the venv stub both need far longer
//! than that before they spawn anything. They keep that window until they move to
//! `JobChild`.

use std::ops::{Deref, DerefMut};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, ExitStatus};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD,
};
use windows::Win32::System::Threading::{
    GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

fn spawn_suspended(cmd: &mut Command, flags: u32) -> std::io::Result<Child> {
    cmd.creation_flags(flags | CREATE_SUSPENDED.0);
    let result = cmd.spawn();
    cmd.creation_flags(flags);
    result
}

fn resume_initial_thread(child: &Child) -> Result<(), String> {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
        .map_err(|e| e.to_string())?;
    let snap = unsafe { OwnedHandle::from_raw_handle(snap.0) };
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut tid = None;
    unsafe { Thread32First(HANDLE(snap.as_raw_handle()), &mut entry) }
        .map_err(|e| e.to_string())?;
    loop {
        if entry.th32OwnerProcessID == child.id() {
            if tid.replace(entry.th32ThreadID).is_some() {
                return Err("suspended child has multiple threads".into());
            }
        }
        if let Err(e) = unsafe { Thread32Next(HANDLE(snap.as_raw_handle()), &mut entry) } {
            if e.code() != windows::core::HRESULT::from_win32(18) {
                return Err(e.to_string());
            }
            break;
        }
    }
    let tid = tid.ok_or("suspended child has no initial thread")?;
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION, false, tid) }
        .map_err(|e| e.to_string())?;
    let thread = unsafe { OwnedHandle::from_raw_handle(thread.0) };
    let handle = HANDLE(thread.as_raw_handle());
    if unsafe { GetProcessIdOfThread(handle) } != child.id() {
        return Err("initial thread changed process".into());
    }
    match unsafe { ResumeThread(handle) } {
        1 => Ok(()),
        u32::MAX => Err(std::io::Error::last_os_error().to_string()),
        count => Err(format!("unexpected initial thread suspend count: {count}")),
    }
}

// OwnedHandle supplies Send/Sync and closes exactly once without unsafe impls.
pub(crate) struct Job(OwnedHandle);

impl Job {
    pub(crate) fn new() -> Result<Self, String> {
        Self::with_breakaway(false)
    }

    /// `breakaway`: JOB_OBJECT_LIMIT_BREAKAWAY_OK, so a grandchild spawned with
    /// CREATE_BREAKAWAY_FROM_JOB leaves this job (and survives its close); nothing leaves
    /// silently. speak.rs needs it: speak.py's Kokoro sidecar and adapter_job's `lms server
    /// start` outlive the run on purpose. Probed:
    /// with it, explicit-breakaway grandchildren of the venv stub survived the close and plain
    /// ones died; without it, both died.
    pub(crate) fn with_breakaway(breakaway: bool) -> Result<Self, String> {
        Self::with_limits(if breakaway {
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
        } else {
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        })
    }

    /// Kill-on-close plus JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: only the process assigned to the
    /// job is in it, and everything that process spawns starts outside it. claude_login.rs needs
    /// it: `claude auth login` dies with Vidar, Cancel, the cap or a closed tab, but a browser it
    /// started (and every tab the user opened since) is the user's and outlives it.
    pub(crate) fn root_only() -> Result<Self, String> {
        Self::with_limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)
    }

    fn with_limits(flags: JOB_OBJECT_LIMIT) -> Result<Self, String> {
        // None security attributes makes this handle non-inheritable: children
        // must not keep the last job handle alive after Vidar's forced exit.
        let handle = unsafe { CreateJobObjectW(None, None) }.map_err(|e| e.to_string())?;
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle.0) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = flags;
        unsafe {
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
            )
        }
        .map_err(|e| e.to_string())?;
        Ok(job)
    }

    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }

    pub(crate) fn assign(&self, child: &Child) -> Result<(), String> {
        self.assign_handle(HANDLE(child.as_raw_handle()))
    }

    /// `assign` for a process started without std (claude_login.rs: CreateProcessW, suspended).
    pub(crate) fn assign_handle(&self, process: HANDLE) -> Result<(), String> {
        unsafe { AssignProcessToJobObject(self.handle(), process) }.map_err(|e| e.to_string())
    }

    /// Closes the job WITHOUT killing what is left in it: kill-on-close is cleared first. For a
    /// tree whose root exited normally and whose survivors are the user's (a browser the login
    /// opened). If clearing fails the close still kills them, as a plain drop would.
    pub(crate) fn release(self) {
        let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let _ = unsafe {
            SetInformationJobObject(
                self.handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
            )
        };
    }

    /// Kills every process in the job now. Dropping the job does the same (kill-on-close);
    /// this is for callers that must know the tree is gone before they go on.
    pub(crate) fn terminate(&self) {
        let _ = unsafe { TerminateJobObject(self.handle(), 1) };
    }
}

/// A child spawned into its own job (or, from `spawn_breakaway_or_plain` only, without one).
/// Derefs to `Child` for the pipes and `try_wait`/`wait`; its own `kill` shadows `Child::kill`
/// and ends the whole tree. Dropping it ends the tree too.
///
/// Known gap, kept on purpose: the Deref also reaches `Child::kill`
/// through an explicit `(*child).kill()`, `Child::kill(&mut child)` or a `&mut Child` taken
/// from it, which ends only the first process and leaves the tree. Method syntax
/// (`child.kill()`) always picks the inherent `JobChild::kill`, and no caller takes a
/// `&mut Child` out. Replacing the Deref with accessors means touching every caller's pipe
/// access (`listen.rs` takes stdin/stdout/stderr through it), so that waits for a pass over
/// listen.rs.
pub(crate) struct JobChild {
    child: Child,
    job: Option<Job>,
}

impl JobChild {
    /// Spawns a hidden child into a fresh job before it runs. This constructor owns the
    /// creation flags (CREATE_NO_WINDOW); use the breakaway constructor for explicit flags.
    pub(crate) fn spawn(cmd: &mut Command) -> Result<Self, String> {
        Self::spawn_io(cmd).map_err(|e| e.to_string())
    }

    /// Retains spawn's io error kind so `.cmd` callers can retry only NotFound.
    pub(crate) fn spawn_io(cmd: &mut Command) -> std::io::Result<Self> {
        let job = Job::new().map_err(|e| std::io::Error::other(format!("Create Job: {e}")))?;
        let child = spawn_suspended(cmd, CREATE_NO_WINDOW.0)?;
        Self::assigned(child, job).map_err(std::io::Error::other)
    }

    /// For a child whose descendants must be able to break away (speak.rs: the Kokoro
    /// process outlives the run). Creates the child with CREATE_BREAKAWAY_FROM_JOB on top of
    /// `flags`, so it leaves whatever job Vidar itself is in, then assigns it to a fresh job
    /// that allows explicit breakaway: its descendants are in that job alone, so they can
    /// leave it. `Ok((child, true))`.
    ///
    /// When Vidar's own job forbids breakaway (CreateProcess: access denied; `falcon/host_launch.rs` meets
    /// the same), no descendant could ever leave, and a per-run job would kill the warm
    /// process with every run (a cold start per Speak). So the child is spawned plainly with
    /// `flags`, in no job of ours: `Ok((child, false))`. It and its descendants then live in
    /// Vidar's job, and `kill` ends only the first process.
    pub(crate) fn spawn_breakaway_or_plain(cmd: &mut Command, flags: u32) -> Result<(Self, bool), String> {
        if let Some(c) = Self::spawn_breakaway(cmd, flags)? {
            return Ok((c, true));
        }
        let child = cmd.spawn().map_err(|e| e.to_string())?;
        Ok((Self { child, job: None }, false))
    }

    /// The first half of `spawn_breakaway_or_plain`: `Ok(None)` when Vidar's job forbids
    /// breakaway, with nothing spawned and `cmd` left at `flags`, so the caller picks its own
    /// fallback (speak.rs: warm Kokoro outside any job of ours, then the run in a plain job).
    pub(crate) fn spawn_breakaway(cmd: &mut Command, flags: u32) -> Result<Option<Self>, String> {
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        const ERROR_ACCESS_DENIED: i32 = 5;
        let job = Job::with_breakaway(true).map_err(|e| format!("Create Job: {e}"))?;
        match spawn_suspended(cmd, flags | CREATE_BREAKAWAY_FROM_JOB) {
            Ok(child) => Self::assigned(child, job).map(Some),
            Err(e) if e.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
                cmd.creation_flags(flags);
                Ok(None)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn assigned(mut child: Child, job: Job) -> Result<Self, String> {
        let setup = job.assign(&child).map_err(|e| format!("Assign Job: {e}"))
            .and_then(|_| resume_initial_thread(&child).map_err(|e| format!("Resume Job Child: {e}")));
        if let Err(e) = setup {
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
        Ok(Self { child, job: Some(job) })
    }

    /// Terminates the job (the stub and everything it started), then the child itself in
    /// case the job call failed or there is no job. Errors are swallowed: the child may
    /// already be gone.
    pub(crate) fn kill(&mut self) {
        if let Some(job) = &self.job {
            job.terminate();
        }
        let _ = self.child.kill();
    }

    pub(crate) fn wait(&mut self) -> std::io::Result<ExitStatus> {
        self.child.wait()
    }
}

impl Drop for JobChild {
    fn drop(&mut self) {
        self.kill();
        let _ = self.child.wait();
    }
}

impl Deref for JobChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}

impl DerefMut for JobChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::Duration;
    use windows::Win32::Foundation::WAIT_OBJECT_0;
    use windows::Win32::System::JobObjects::IsProcessInJob;
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    const ROLE: &str = "VIDAR_PROC_JOB_ROLE";
    const HELPER: &str = "proc_job::tests::role_helper";

    fn self_cmd(role: &str) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([HELPER, "--exact", "--nocapture", "--test-threads=1"]).env(ROLE, role);
        cmd
    }

    /// Not a test on its own: a no-op unless re-run by `startup_grandchild_joins_job_and_drop_closes_pipe`.
    /// "stub" plays the venv launcher (spawns a grandchild on the same stdout, reports its
    /// pid, then waits on it); "grandchild" plays the interpreter and just lives.
    #[test]
    fn role_helper() {
        use std::io::Write;
        match std::env::var(ROLE).as_deref() {
            Ok("stub") => {
                let mut gc = self_cmd("grandchild").stdin(Stdio::null()).spawn().unwrap();
                // io::stdout, not println!: libtest captures the macro, not the handle.
                let mut out = std::io::stdout();
                writeln!(out, "GRANDCHILD_PID={}", gc.id()).unwrap();
                out.flush().unwrap();
                let _ = gc.wait();
            }
            Ok("grandchild") => std::thread::sleep(Duration::from_secs(60)),
            _ => {}
        }
    }

    /// The startup child immediately spawns a grandchild; both must belong to our specific
    /// job. RAII cleanup must end them and close the inherited stdout pipe.
    #[test]
    fn startup_grandchild_joins_job_and_drop_closes_pipe() {
        let mut child = JobChild::spawn(self_cmd("stub").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())).unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut pid = None;
        let mut line = String::new();
        while pid.is_none() && reader.read_line(&mut line).unwrap() > 0 {
            // libtest may print "test <name> ... " on the same line first.
            pid = line.split("GRANDCHILD_PID=").nth(1).map(|p| p.trim().parse::<u32>().unwrap());
            line.clear();
        }
        let pid = pid.expect("stub never reported its grandchild");
        let gc = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .expect("grandchild alive before drop");
        let gc = unsafe { OwnedHandle::from_raw_handle(gc.0) };
        let root = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, child.id()) }.unwrap();
        let root = unsafe { OwnedHandle::from_raw_handle(root.0) };
        for process in [HANDLE(child.as_raw_handle()), HANDLE(gc.as_raw_handle())] {
            let mut in_job = Default::default();
            unsafe { IsProcessInJob(process, Some(child.job.as_ref().unwrap().handle()), &mut in_job) }.unwrap();
            assert!(in_job.as_bool(), "startup process escaped our job");
        }

        drop(child);

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut rest = Vec::new();
            let _ = tx.send(reader.read_to_end(&mut rest).is_ok());
        });
        let eof = rx.recv_timeout(Duration::from_secs(5));
        let gone = unsafe { WaitForSingleObject(HANDLE(gc.as_raw_handle()), 5000) } == WAIT_OBJECT_0;
        assert_eq!(unsafe { WaitForSingleObject(HANDLE(root.as_raw_handle()), 5000) }, WAIT_OBJECT_0);
        assert!(gone, "grandchild {pid} outlived the job");
        assert_eq!(eof, Ok(true), "stdout pipe did not reach EOF after the job was terminated");
    }

    fn limit_flags(job: &Job) -> JOB_OBJECT_LIMIT {
        use windows::Win32::System::JobObjects::QueryInformationJobObject;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(job.handle()),
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
                None,
            )
        }
        .unwrap();
        limits.BasicLimitInformation.LimitFlags
    }

    #[test]
    fn root_only_sets_kill_on_close_and_silent_breakaway() {
        let flags = limit_flags(&Job::root_only().unwrap());
        assert_eq!(flags, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK);
        assert_eq!(limit_flags(&Job::new().unwrap()), JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
    }

    /// The root joins before it runs; its grandchild starts outside the job and survives the
    /// terminate that ends the root (claude_login.rs: the browser outlives `auth login`).
    #[test]
    fn root_only_job_ends_the_root_and_leaves_its_children() {
        let job = Job::root_only().unwrap();
        let mut cmd = self_cmd("stub");
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = spawn_suspended(&mut cmd, CREATE_NO_WINDOW.0).unwrap();
        job.assign(&child).unwrap();
        resume_initial_thread(&child).unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut pid = None;
        let mut line = String::new();
        while pid.is_none() && reader.read_line(&mut line).unwrap() > 0 {
            pid = line.split("GRANDCHILD_PID=").nth(1).map(|p| p.trim().parse::<u32>().unwrap());
            line.clear();
        }
        let pid = pid.expect("stub never reported its grandchild");
        let gc = unsafe {
            OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, false, pid)
        }
        .expect("grandchild alive");
        let gc = unsafe { OwnedHandle::from_raw_handle(gc.0) };
        let in_job = |process: HANDLE| {
            let mut in_job = Default::default();
            unsafe { IsProcessInJob(process, Some(job.handle()), &mut in_job) }.unwrap();
            in_job.as_bool()
        };
        assert!(in_job(HANDLE(child.as_raw_handle())), "root is not in the job");
        let gc_in_job = in_job(HANDLE(gc.as_raw_handle()));

        job.terminate();
        let _ = child.wait();
        let survived = unsafe { WaitForSingleObject(HANDLE(gc.as_raw_handle()), 500) } != WAIT_OBJECT_0;
        let _ = unsafe { TerminateProcess(HANDLE(gc.as_raw_handle()), 1) };
        assert!(!gc_in_job, "grandchild joined the root-only job");
        assert!(survived, "grandchild {pid} died with the root");
    }
}
