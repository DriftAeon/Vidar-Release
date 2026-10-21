//! Is a registered host the process it claims to be? Pid, creation time and
//! image checks, against a connected pipe or the registry's own pid.

use std::path::Path;

// Only the host-launch/identity-check paths below need these (`bind_server_
// identity`, `host_alive`, `process_creation_identity`, `process_image`),
// all `#[cfg(not(falcon_shell))]`.
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::QueryFullProcessImageNameW;
use windows::Win32::{
    Foundation::FILETIME,
    System::{
        Pipes::GetNamedPipeServerProcessId,
        Threading::{
            GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

use super::FalconRegistry;

// `process_creation_identity`/`process_image` feed `bind_server_identity` and
// `host_alive`, both Vidar-only (the shell build connects to a host, it never
// launches or health-checks one).
#[cfg(not(falcon_shell))]
pub(super) fn process_creation_identity(process: HANDLE) -> Result<u64, String> {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user)
            .map_err(|error| format!("process times: {error}"))?;
    }
    Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

#[cfg(not(falcon_shell))]
fn process_image(process: HANDLE) -> Result<String, String> {
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .map_err(|error| format!("process image: {error}"))?;
    }
    String::from_utf16(&buffer[..length as usize]).map_err(|error| error.to_string())
}

/// The same three checks the CLI probe makes before trusting a reply
/// (`src-falcon\src\ipc.rs::bind_server_identity`, ipc.rs:377-410): the pipe's
/// server process id matches the registry, that pid's own creation time
/// matches (so a reused pid is never mistaken for the registered process),
/// and its image path matches. Ported rather than called: this file is the
/// same source compiled into both crates via `#[path]`
/// (`src-falcon\src\main.rs:12-13`), so it cannot reach into `src-falcon`'s
/// private `ipc` module from the `src-tauri` build. Called from
/// `activation_request` and `Connection::open` (before the attach secret is
/// sent), Vidar-only; the shell build calls `ipc.rs`'s copy instead.
#[cfg(not(falcon_shell))]
pub(super) fn bind_server_identity(pipe: &std::fs::File, registry: &FalconRegistry) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    let pipe_handle = HANDLE(pipe.as_raw_handle());

    let mut server_pid = 0u32;
    unsafe {
        GetNamedPipeServerProcessId(pipe_handle, &mut server_pid)
            .map_err(|error| format!("server pid: {error}"))?;
    }
    if server_pid != registry.pid {
        return Err(format!(
            "connected server PID {server_pid} != registry PID {}",
            registry.pid
        ));
    }

    let process = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, server_pid)
            .map_err(|error| format!("open server process: {error}"))?
    };
    let result = (|| {
        let created = process_creation_identity(process)?;
        if created != registry.process_created_100ns {
            return Err("connected server creation identity does not match registry".to_string());
        }
        let image = process_image(process)?;
        let expected = std::fs::canonicalize(&registry.executable)
            .map_err(|error| format!("canonicalize registered executable: {error}"))?;
        let actual = std::fs::canonicalize(&image)
            .map_err(|error| format!("canonicalize connected executable: {error}"))?;
        if actual != expected {
            return Err(format!(
                "connected server image {} != {}",
                actual.display(),
                expected.display()
            ));
        }
        Ok(())
    })();
    unsafe {
        let _ = CloseHandle(process);
    }
    result
}

/// Is a registered host still the process it claims to be? The same three
/// checks `bind_server_identity` makes on a connected pipe, run directly
/// against the registry's own `pid` — no connection needed, so this is cheap
/// enough to call before every fresh open (`Falcon::control`).
#[cfg(not(falcon_shell))]
pub(super) fn host_alive(registry: &FalconRegistry) -> bool {
    let process =
        match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, registry.pid) } {
            Ok(process) => process,
            Err(_) => return false,
        };
    let alive = (|| -> Option<()> {
        let created = process_creation_identity(process).ok()?;
        if created != registry.process_created_100ns {
            return None;
        }
        let image = process_image(process).ok()?;
        let name = Path::new(&image).file_name()?.to_str()?;
        if !name.eq_ignore_ascii_case("falcon.exe") {
            return None;
        }
        Some(())
    })()
    .is_some();
    unsafe {
        let _ = CloseHandle(process);
    }
    alive
}
