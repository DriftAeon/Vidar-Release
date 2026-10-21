//! Process facts for the "pull an external Claude session in" path.
//!
//! Everything here is read-only inspection. Two questions get answered:
//! is the pid named in a registry file still the *same* process (liveness +
//! pid-reuse guard by exact creation time), and who is above it (the shell to
//! kill, the host that owns the window, and whether Vidar itself is an
//! ancestor). The kill lives in pty.rs next to kill_pty's.

use std::collections::HashMap;

use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, STILL_ACTIVE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// One row of the process table: parent pid and lowercase exe basename.
#[derive(Clone, Debug)]
pub struct ProcRow {
    pub parent: u32,
    pub exe: String,
}

/// pid -> (parent, exe) for every process, one snapshot. Cheap (a few ms) and
/// consistent within itself, which a series of per-pid lookups would not be.
pub fn snapshot() -> HashMap<u32, ProcRow> {
    let mut map = HashMap::new();
    // SAFETY: plain Win32 calls with a correctly sized PROCESSENTRY32W.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return map };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let exe = String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase();
                map.insert(entry.th32ProcessID, ProcRow { parent: entry.th32ParentProcessID, exe });
                if Process32NextW(snap, &mut entry).is_err() { break; }
            }
        }
        let _ = CloseHandle(snap);
    }
    map
}

/// Creation time as a FILETIME u64, or None when the process is gone or not
/// ours to query. This is the value Claude Code stores as `procStart`, so an
/// exact compare tells a reused pid from the original.
pub fn creation_time(pid: u32) -> Option<u64> {
    let h = open(pid)?;
    let mut created = FILETIME::default();
    let (mut exit, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: valid handle from OpenProcess; out-params are stack FILETIMEs.
    let ok = unsafe { GetProcessTimes(h.0, &mut created, &mut exit, &mut kernel, &mut user).is_ok() };
    ok.then(|| ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

/// True while the process has not exited. A pid alone can't say this — it can
/// be reused the moment the original exits — so pair with `creation_time`.
pub fn is_alive(pid: u32) -> bool {
    let Some(h) = open(pid) else { return false };
    let mut code = 0u32;
    // SAFETY: valid handle; out-param is a stack u32.
    unsafe { GetExitCodeProcess(h.0, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32 }
}

/// Lowercase exe basename via the process handle (authoritative, unlike the
/// snapshot name which is what the creator passed).
pub fn image_name(pid: u32) -> Option<String> {
    let full = image_path(pid)?;
    full.rsplit(['\\', '/']).next().map(|s| s.to_ascii_lowercase())
}

/// Full Win32 image path via the process handle, as the OS reports it.
pub fn image_path(pid: u32) -> Option<String> {
    let h = open(pid)?;
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: valid handle; buffer/len pair describes `buf`.
    unsafe { QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).ok()? };
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// Ancestors of `pid`, nearest first, from one snapshot. Stops at the root or
/// on a cycle (pid reuse can make the table loop).
pub fn ancestors(map: &HashMap<u32, ProcRow>, pid: u32) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut cur = pid;
    while let Some(row) = map.get(&cur) {
        if row.parent == 0 || row.parent == cur || out.iter().any(|(p, _)| *p == row.parent) || out.len() > 32 {
            break;
        }
        let exe = map.get(&row.parent).map(|r| r.exe.clone()).unwrap_or_default();
        out.push((row.parent, exe));
        cur = row.parent;
    }
    out
}

/// First descendant of `root` (any depth, one snapshot) whose exe basename is
/// exactly `needle` (lowercase, e.g. "codex.exe"). Depth-first (stack), which
/// is fine — existence is the question, not distance; bounded and cycle-safe
/// like `ancestors`. Exact match on purpose: `node.exe` hosts many things, a
/// substring would too (review, risk 3). The snapshot's name is the executable
/// file name per ToolHelp docs; `image_name` would be authoritative but costs a
/// handle per candidate — acceptable trade for a yes/no.
pub fn descendant_named(map: &HashMap<u32, ProcRow>, root: u32, needle: &str) -> Option<u32> {
    let mut frontier = vec![root];
    let mut seen = std::collections::HashSet::from([root]);
    while let Some(cur) = frontier.pop() {
        if seen.len() > 256 {
            break;
        }
        for (pid, row) in map {
            if row.parent == cur && *pid != cur && seen.insert(*pid) {
                if row.exe == needle {
                    return Some(*pid);
                }
                frontier.push(*pid);
            }
        }
    }
    None
}

struct Owned(HANDLE);
impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: handle came from OpenProcess and is closed exactly once.
        unsafe { let _ = CloseHandle(self.0); }
    }
}

fn open(pid: u32) -> Option<Owned> {
    // SAFETY: plain Win32 call; a failure returns Err, never a dangling handle.
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok().map(Owned) }
}
