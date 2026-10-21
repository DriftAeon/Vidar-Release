//! src-tauri\src\job.rs — the Windows Job Object that owns a child-process tree (rune generator plan D6/E4).
//! Moved out of `flow/child.rs` so Flow and the rune generator share one: a `Job` has kill-on-close set, so
//! dropping it ends every process assigned to it, and `terminate` ends them at once without waiting for the drop.
//! `agent.rs` and `proc_job.rs` keep their own copies; this one is Flow's, behaviour unchanged.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::Child;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(crate) struct Job(OwnedHandle);

impl Job {
    pub(crate) fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(None, None) }.map_err(|e| e.to_string())?;
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle.0) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
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
        unsafe { AssignProcessToJobObject(self.handle(), HANDLE(child.as_raw_handle())) }.map_err(|e| e.to_string())
    }

    /// Ends every process in the job now (exit code 1). The job stays usable until dropped.
    pub(crate) fn terminate(&self) {
        let _ = unsafe { TerminateJobObject(self.handle(), 1) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn terminate_ends_an_assigned_child() {
        let job = Job::new().unwrap();
        let mut child = Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap();
        job.assign(&child).unwrap();
        assert!(child.try_wait().unwrap().is_none(), "child should be running");
        job.terminate();
        let start = Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait().unwrap() {
                break s;
            }
            assert!(start.elapsed() < Duration::from_secs(10), "child survived terminate");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status.code(), Some(1));
    }

    #[test]
    fn dropping_the_job_kills_the_child() {
        let job = Job::new().unwrap();
        let mut child = Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap();
        job.assign(&child).unwrap();
        drop(job);
        let start = Instant::now();
        while child.try_wait().unwrap().is_none() {
            assert!(start.elapsed() < Duration::from_secs(10), "kill-on-close did not end the child");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
