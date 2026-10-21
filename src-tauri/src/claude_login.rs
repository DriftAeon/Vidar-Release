//! `claude auth login` for a Rendered Claude tab's own home (the Not Logged In pill's login card,
//! `src\panels\rendered\claude-login.ts`).
//!
//! The login runs in its own console window: `claude auth login --help` (2.1.300) lists no
//! non-interactive flag or env, and whether it finishes without a TTY (browser callback only) or
//! falls back to a pasted code was not verifiable without a live login. A console works either
//! way: the browser callback completes on its own, and a code prompt or a printed URL has a
//! terminal to land in. A profiled (bare) tab's login runs under the env its own spawn gets
//! (`bare::login_env`: the allowlist plus the profile overlay, so the home dirs move into the Bare
//! home and no inherited credential var rides along), checked to land in the config dir
//! `bare::claude_dir::claude_dir_for` resolves; a default tab keeps Vidar's own env (the default
//! home). One login per tab; Cancel ends it. The command resolves when the process exits, and the
//! card re-checks `claude auth status` then.
//!
//! Started with CreateProcessW, not std's Command: std hands the child Vidar's own std handles
//! whenever Vidar has any (a dev console, a redirected log), and a console child given those
//! writes there instead of into its new window. It starts suspended and joins a kill-on-close
//! root-only Job Object (`proc_job::Job::root_only`) before it runs, so Cancel, the cap, a closed
//! tab or Vidar's exit ends claude.exe. Its children break away silently: a browser `auth login`
//! starts (and every tab the user opens in it) is the user's and outlives the login either way.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// A login left waiting on the browser this long is ended: nothing else would reap it.
const LOGIN_CAP: Duration = Duration::from_secs(15 * 60);
const POLL: Duration = Duration::from_millis(250);

/// How a login ended. `cancelled`: Cancel (or a second Log In) ended it; `timedOut`: the cap.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoginExit {
    pub code: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
}

/// The login's whole env for this profile's home: `None` = the default home, Vidar's own env
/// (`inherited`) unchanged; `bare` = the profile's spawn env (`build`, `bare::login_env`), whose
/// `CLAUDE_CONFIG_DIR` must be the resolved config dir and must already exist (the first Bare
/// launch creates it with its private ACL; a login never does). Any other profile is refused,
/// never sent to the default home. Sorted by upper-cased name, as CreateProcessW wants.
pub(crate) fn login_env(
    profile: Option<&str>,
    inherited: Vec<(OsString, OsString)>,
    resolve: impl FnOnce(Option<&str>) -> Option<PathBuf>,
    exists: impl FnOnce(&Path) -> bool,
    build: impl FnOnce(&str, Vec<(OsString, OsString)>) -> Result<crate::bare::Env, String>,
) -> Result<Vec<(OsString, OsString)>, String> {
    let Some(p) = profile else { return Ok(sorted(inherited)) };
    let dir = resolve(Some(p)).ok_or_else(|| format!("No Claude home for the {p:?} profile; login refused"))?;
    if !exists(&dir) {
        return Err(format!("The {p:?} home is not created yet ({}); start the tab once, then log in", dir.display()));
    }
    let env = build(p, inherited)?;
    let set = env.get("CLAUDE_CONFIG_DIR").map(upper);
    if set != Some(upper(dir.as_os_str())) {
        return Err(format!("The {p:?} profile does not set CLAUDE_CONFIG_DIR to {}; login refused", dir.display()));
    }
    Ok(sorted(env.iter().map(|(k, v)| (k.to_os_string(), v.to_os_string()))))
}

fn upper(s: &OsStr) -> Vec<u16> {
    s.encode_wide().map(|c| if (b'a' as u16..=b'z' as u16).contains(&c) { c - 32 } else { c }).collect()
}

/// Sorted by upper-cased name (Windows names are case-insensitive), as CreateProcessW wants.
fn sorted(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    let mut vars: Vec<(OsString, OsString)> = vars.into_iter().collect();
    vars.sort_by_key(|(k, _)| upper(k));
    vars
}

fn env_block(vars: &[(OsString, OsString)]) -> Vec<u16> {
    let mut block = Vec::new();
    for (k, v) in vars {
        block.extend(k.encode_wide());
        block.push(b'=' as u16);
        block.extend(v.encode_wide());
        block.push(0);
    }
    if vars.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

mod win {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        CreateProcessW, GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_NEW_CONSOLE,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
    };

    use crate::proc_job::Job;

    /// The login process; dropping it closes the handle, not the process (the job ends it).
    pub struct Proc(OwnedHandle);

    impl Proc {
        fn h(&self) -> HANDLE {
            HANDLE(self.0.as_raw_handle())
        }
        /// `None` while it runs; `Some(code)` once it exited (`None` code if unreadable).
        pub fn exited(&self) -> Option<Option<i32>> {
            // SAFETY: the handle is owned by `self` and open for its lifetime.
            if unsafe { WaitForSingleObject(self.h(), 0) } != WAIT_OBJECT_0 {
                return None;
            }
            let mut code = 0u32;
            // SAFETY: as above; `code` is a live out-param.
            let ok = unsafe { GetExitCodeProcess(self.h(), &mut code) }.is_ok();
            Some(ok.then_some(code as i32))
        }
        pub fn kill(&self) {
            // SAFETY: as above. A process that already exited makes TerminateProcess fail, ignored.
            unsafe {
                let _ = TerminateProcess(self.h(), 1);
                let _ = WaitForSingleObject(self.h(), 2000);
            }
        }
    }

    /// `"<program>" auth login` in a new console, no handles inherited, no std handles passed. It
    /// starts suspended and runs only once it is in `job`, so the process itself cannot escape it.
    pub fn spawn(program: &Path, env: &[u16], job: &Job) -> Result<Proc, String> {
        use std::os::windows::ffi::OsStrExt;
        let app: Vec<u16> = program.as_os_str().encode_wide().chain(Some(0)).collect();
        let line = format!("\"{}\" auth login", program.display());
        let mut line_w: Vec<u16> = line.encode_utf16().chain(Some(0)).collect();
        let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
        let mut info = PROCESS_INFORMATION::default();
        // SAFETY: every pointer is to a live, NUL-terminated local buffer for the call's duration;
        // `info` is a stack out-param whose thread handle is closed and process handle owned below.
        unsafe {
            CreateProcessW(
                PCWSTR(app.as_ptr()),
                Some(PWSTR(line_w.as_mut_ptr())),
                None,
                None,
                false,
                CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                Some(env.as_ptr() as *const core::ffi::c_void),
                PCWSTR::null(),
                &startup,
                &mut info,
            )
            .map_err(|e| format!("Could not start claude auth login: {}", e.message()))?;
            let proc = Proc(OwnedHandle::from_raw_handle(info.hProcess.0));
            let joined = job.assign_handle(proc.h());
            let resumed = joined.is_ok() && ResumeThread(info.hThread) != u32::MAX;
            let _ = CloseHandle(info.hThread);
            if !resumed {
                let _ = TerminateProcess(proc.h(), 1);
                return Err(match joined {
                    Err(e) => format!("Could not start claude auth login: {e}"),
                    Ok(()) => "Could not start claude auth login: the process did not resume".to_string(),
                });
            }
            Ok(proc)
        }
    }
}

/// A started login: its process and the job that owns its tree.
struct Login {
    proc: win::Proc,
    job: crate::proc_job::Job,
}

impl Login {
    /// Ends the whole tree and waits briefly for the process. Never called under the map lock.
    fn kill(self) {
        self.job.terminate();
        self.proc.kill();
    }
}

/// A tab's login slot. Reserved (`login: None`) before the spawn, so a Cancel that lands while
/// the process is starting removes the slot and the run ends what it started.
struct Running {
    id: u64,
    login: Option<Login>,
}

fn running() -> &'static Mutex<HashMap<String, Running>> {
    static MAP: OnceLock<Mutex<HashMap<String, Running>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Polls the tab's login until it exits, is replaced or cancelled (its entry gone), or hits the cap.
fn wait_for(tab: &str, id: u64) -> LoginExit {
    let deadline = Instant::now() + LOGIN_CAP;
    loop {
        // the lock is held only to read or take the slot; a kill or release runs after it drops
        let (done, exit) = {
            let mut map = running().lock().unwrap_or_else(|e| e.into_inner());
            let Some(r) = map.get(tab).filter(|r| r.id == id) else {
                return LoginExit { code: None, cancelled: true, timed_out: false };
            };
            match r.login.as_ref().and_then(|l| l.proc.exited()) {
                Some(code) => (map.remove(tab), LoginExit { code, cancelled: false, timed_out: false }),
                None if Instant::now() >= deadline => (map.remove(tab), LoginExit { code: None, cancelled: false, timed_out: true }),
                None => (None, LoginExit { code: None, cancelled: false, timed_out: false }),
            }
        };
        if let Some(login) = done.and_then(|r| r.login) {
            if exit.timed_out { login.kill() } else { login.job.release() }
            return exit;
        }
        std::thread::sleep(POLL);
    }
}

/// Reserves the tab's slot for a new login, handing back the one it replaces (to be ended).
fn reserve(tab: &str, id: u64) -> Option<Running> {
    running().lock().unwrap_or_else(|e| e.into_inner()).insert(tab.to_string(), Running { id, login: None })
}

/// Puts the started login in its slot; hands it back when the slot is gone (a Cancel or a newer
/// login took it while the process was starting), so the caller ends it.
fn fill(tab: &str, id: u64, login: Login) -> Result<(), Login> {
    let mut map = running().lock().unwrap_or_else(|e| e.into_inner());
    match map.get_mut(tab).filter(|r| r.id == id) {
        Some(r) => {
            r.login = Some(login);
            Ok(())
        }
        None => Err(login),
    }
}

/// Drops the slot this run reserved, when it still holds it (a failed start).
fn unreserve(tab: &str, id: u64) {
    let mut map = running().lock().unwrap_or_else(|e| e.into_inner());
    if map.get(tab).is_some_and(|r| r.id == id) {
        map.remove(tab);
    }
}

fn start(profile: Option<&str>) -> Result<Login, String> {
    let env = login_env(
        profile,
        std::env::vars_os().collect(),
        crate::bare::claude_dir::claude_dir_for,
        Path::is_dir,
        |p, inherited| crate::bare::login_env(p, inherited),
    )?;
    let program = crate::deps::claude_exe().ok_or_else(|| "Claude Code was not found; install it, then log in".to_string())?;
    let job = crate::proc_job::Job::root_only()?;
    let proc = win::spawn(&program, &env_block(&env), &job)?;
    Ok(Login { proc, job })
}

/// Runs `claude auth login` against the tab's home and resolves when it exits. A login already
/// running for this tab is ended first (it resolves as cancelled).
#[tauri::command]
pub async fn claude_login_run(tab: String, profile: Option<String>) -> Result<LoginExit, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = next_id();
        if let Some(login) = reserve(&tab, id).and_then(|r| r.login) {
            login.kill();
        }
        let login = match start(profile.as_deref()) {
            Ok(l) => l,
            Err(e) => {
                unreserve(&tab, id);
                return Err(e);
            }
        };
        if let Err(login) = fill(&tab, id, login) {
            login.kill();
            return Ok(LoginExit { code: None, cancelled: true, timed_out: false });
        }
        Ok(wait_for(&tab, id))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ends the tab's login, starting or running; `false` when there was none. The tab's dispose
/// calls it too (claude-login.ts), so a closed tab leaves no login window behind.
#[tauri::command]
pub fn claude_login_cancel(tab: String) -> bool {
    let slot = running().lock().unwrap_or_else(|e| e.into_inner()).remove(&tab);
    let had = slot.is_some();
    if let Some(login) = slot.and_then(|r| r.login) {
        login.kill();
    }
    had
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    const HOME: &str = r"C:\L\Vidar\homes\k";

    fn no_build(_: &str, _: Vec<(OsString, OsString)>) -> Result<crate::bare::Env, String> {
        panic!("no profile env built")
    }

    /// The real builder over the repo's own `profiles/bare/claude.json`, homed at `HOME`.
    fn real_build(p: &str, inherited: Vec<(OsString, OsString)>) -> Result<crate::bare::Env, String> {
        crate::bare::login_env_with(p, &crate::paths::root(), Path::new(HOME), inherited)
    }

    fn get<'a>(env: &'a [(OsString, OsString)], name: &str) -> Option<&'a OsStr> {
        env.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_os_str())
    }

    #[test]
    fn default_home_keeps_the_inherited_env() {
        let inherited = os(&[("Path", r"C:\bin"), ("CLAUDE_CONFIG_DIR", r"C:\x")]);
        let env = login_env(None, inherited, |_| panic!("no home resolved for the default"), |_| panic!("nothing checked"), no_build).unwrap();
        assert_eq!(env, os(&[("CLAUDE_CONFIG_DIR", r"C:\x"), ("Path", r"C:\bin")]));
    }

    /// A Bare login runs under the tab's own spawn env: the home dirs moved into the Bare home,
    /// the credential vars and the user's own config dir gone, the allowlist riding through.
    #[test]
    fn bare_login_env_moves_the_home_and_drops_credentials() {
        let inherited = os(&[
            ("Path", r"C:\bin"),
            ("SystemRoot", r"C:\Windows"),
            ("USERPROFILE", r"C:\Users\u"),
            ("APPDATA", r"C:\Users\u\AppData\Roaming"),
            ("claude_config_dir", r"C:\Users\u\.claude"),
            ("ANTHROPIC_API_KEY", "sk-x"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "tok"),
        ]);
        let dir = PathBuf::from(HOME).join("claude-config");
        let want = dir.clone();
        let env = login_env(Some("bare"), inherited, move |p| { assert_eq!(p, Some("bare")); Some(dir) }, |d| d == want, real_build).unwrap();
        assert_eq!(get(&env, "CLAUDE_CONFIG_DIR"), Some(OsStr::new(r"C:\L\Vidar\homes\k\claude-config")));
        assert_eq!(get(&env, "USERPROFILE"), Some(OsStr::new(r"C:\L\Vidar\homes\k\user-home")));
        assert_eq!(get(&env, "APPDATA"), Some(OsStr::new(r"C:\L\Vidar\homes\k\user-home\AppData\Roaming")));
        assert_eq!(get(&env, "TEMP"), Some(OsStr::new(r"C:\L\Vidar\homes\k\user-home\AppData\Local\Temp")));
        assert_eq!(get(&env, "HOMEDRIVE"), Some(OsStr::new("C:")));
        assert!(get(&env, "ANTHROPIC_API_KEY").is_none() && get(&env, "CLAUDE_CODE_OAUTH_TOKEN").is_none());
        assert_eq!(get(&env, "Path"), Some(OsStr::new(r"C:\bin")));
        let names: Vec<Vec<u16>> = env.iter().map(|(k, _)| upper(k)).collect();
        assert!(names.windows(2).all(|w| w[0] <= w[1]), "sorted by upper-cased name");
    }

    #[test]
    fn bare_home_not_created_is_refused() {
        let err = login_env(Some("bare"), Vec::new(), |_| Some(PathBuf::from(r"C:\nowhere\claude-config")), |_| false, no_build).unwrap_err();
        assert!(err.contains("not created yet"), "{err}");
    }

    #[test]
    fn unknown_profile_is_refused_not_defaulted() {
        let err = login_env(Some("zzz"), Vec::new(), |_| None, |_| panic!("nothing checked"), no_build).unwrap_err();
        assert!(err.contains("zzz"), "{err}");
        let err = crate::bare::login_env_with("zzz", &crate::paths::root(), Path::new(HOME), Vec::new()).err().unwrap();
        assert!(err.contains("zzz"), "{err}");
    }

    /// A built env whose config dir is not the resolved one is refused, never run.
    #[test]
    fn a_config_dir_elsewhere_is_refused() {
        let err = login_env(Some("bare"), Vec::new(), |_| Some(PathBuf::from(r"C:\other\claude-config")), |_| true, real_build).unwrap_err();
        assert!(err.contains("does not set CLAUDE_CONFIG_DIR"), "{err}");
    }

    /// A Cancel that lands while the process is starting takes the reserved slot: the run then
    /// finds it gone and ends what it started. A newer login's reserve does the same.
    #[test]
    fn cancel_during_start_takes_the_reserved_slot() {
        assert!(reserve("race-tab", 7).is_none());
        assert!(claude_login_cancel("race-tab".into()), "a starting login counts as running");
        assert!(!running().lock().unwrap().contains_key("race-tab"));
        unreserve("race-tab", 7); // nothing left to drop
        assert!(reserve("race-tab", 8).is_none());
        assert!(reserve("race-tab", 9).is_some_and(|r| r.id == 8 && r.login.is_none()));
        unreserve("race-tab", 8); // not ours any more: kept
        assert!(running().lock().unwrap().get("race-tab").is_some_and(|r| r.id == 9));
        unreserve("race-tab", 9);
        assert!(!running().lock().unwrap().contains_key("race-tab"));
    }

    #[test]
    fn env_block_is_double_nul_terminated() {
        let block = env_block(&os(&[("A", "1")]));
        assert_eq!(block, "A=1\0\0".encode_utf16().collect::<Vec<_>>());
        assert_eq!(env_block(&[]), vec![0, 0]);
    }

    #[test]
    fn cancel_with_nothing_running_is_false() {
        assert!(!claude_login_cancel("no-such-tab".into()));
    }

    #[test]
    fn exit_serializes_camel_case() {
        let j = serde_json::to_string(&LoginExit { code: Some(0), cancelled: false, timed_out: false }).unwrap();
        assert_eq!(j, r#"{"code":0,"cancelled":false,"timedOut":false}"#);
    }
}
