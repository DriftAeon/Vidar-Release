//! Who is on the other end of a pipe, and what that peer may do (security H3).
//!
//! The attach secret in registry.json proves only "same user": every agent the
//! user runs can read it, and the bus client needs it (`tools/bus/bus-client.mjs`).
//! So the secret still gates the connection, and the role comes from the pipe
//! peer, decided by the server at negotiate:
//!
//! - **Full**: the host's own process (the Falcon shell is an in-process client,
//!   `main.rs`), or a process whose image is exactly `<root>\vidar.exe` or
//!   `<root>\src-tauri\target\{release,debug}\vidar.exe`. Exact, by path
//!   components: anything "under the root" would admit
//!   `runtime\worktrees\x\vidar.exe`, which an agent can write. On a smoke
//!   root under the temp directory, `--admit-probe` adds the host's own
//!   falcon.exe (and any `--admit-image`) to that list; see
//!   [`PeerPolicy::admit_probe`].
//! - **Bus**: everyone else. Subscribe and Publish only, never the `ctl.*`
//!   request stream (it carries other tabs' ctl tokens and secrets), never the
//!   Vidar slot, and on the activation pipe only `ping`.

use std::path::{Path, PathBuf};

use windows::Win32::{
    Foundation::HANDLE,
    System::{
        Pipes::GetNamedPipeClientProcessId,
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

use crate::{
    ipc::{process_creation_identity, process_image},
    protocol::Op,
    security::{win_error, OwnedHandle},
};

/// What a connection may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Full,
    Bus,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Full => "full",
            Role::Bus => "bus",
        }
    }
}

/// The images that earn the full role, fixed at host start from the Vidar root.
#[derive(Clone, Debug, Default)]
pub struct PeerPolicy {
    vidar_images: Vec<PathBuf>,
}

impl PeerPolicy {
    /// `<root>\vidar.exe` and `<root>\src-tauri\target\{release,debug}\vidar.exe`,
    /// the root canonicalized first so a junctioned root still matches the
    /// image path Windows reports. The debug build is the dev Vidar
    /// (`npm run tauri dev`). Any process able to write `src-tauri\target` can
    /// also write Vidar's source, so admitting cargo output adds no actor
    /// beyond that one.
    pub fn for_root(root: &Path) -> Self {
        let root = canonical(root);
        let target = root.join("src-tauri").join("target");
        Self {
            vidar_images: vec![
                root.join("vidar.exe"),
                target.join("release").join("vidar.exe"),
                target.join("debug").join("vidar.exe"),
            ],
        }
    }

    /// `--admit-probe`: on a smoke root under the temp directory, also give the
    /// full role to `images` (the host's own falcon.exe, so its `--probe` and
    /// `--session-probe` clients can drive it, plus any `--admit-image`).
    /// Anywhere else the flag is ignored: a host on the real install must never
    /// let a falcon.exe peer act as Vidar (`--session-probe` runs any op list).
    /// `temp` is `std::env::temp_dir()` in the host; a parameter for tests. It
    /// follows TEMP/TMP, which the caller controls, so it is not the only gate:
    /// a root holding `contracts\paths.json` (every real install root has it,
    /// `src-tauri/src/paths.rs`; smoke roots never do) is refused too.
    /// Returns the line to log either way.
    pub fn admit_probe(&mut self, root: &Path, temp: &Path, images: &[PathBuf]) -> String {
        let root = canonical(root);
        let temp = canonical(temp);
        if !is_under(&root, &temp) {
            return format!(
                "falcon: --admit-probe ignored: root {} is not under the temp directory {}",
                root.display(),
                temp.display()
            );
        }
        if root.join("contracts").join("paths.json").exists() {
            return format!(
                "falcon: --admit-probe ignored: root {} holds contracts\\paths.json, so it is an install root",
                root.display()
            );
        }
        let images: Vec<PathBuf> = images.iter().map(|image| canonical(image)).collect();
        let line = format!(
            "falcon: --admit-probe honoured on temp root {}: full role also for {}",
            root.display(),
            images
                .iter()
                .map(|image| image.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
        self.vidar_images.extend(images);
        line
    }

    /// No image earns the full role; only the in-process client does (tests).
    #[cfg(test)]
    pub fn none() -> Self {
        Self::default()
    }

    /// Identify the client of a connected server pipe. `connected_at` is the
    /// FILETIME taken right after the connect completed: a process created
    /// later cannot be the one that opened the pipe, which is how a PID reused
    /// between the connect and this check is caught. The process handle stays
    /// open in the returned [`Peer`], so the PID cannot be reused while the
    /// connection lives. Every failure is the bus role, never full.
    pub fn identify(&self, pipe: HANDLE, connected_at: u64) -> Peer {
        let mut pid = 0u32;
        if let Err(error) = unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } {
            return Peer::bus(0, format!("client pid unavailable: {}", win_error(error)));
        }
        if pid == std::process::id() {
            return Peer {
                pid,
                role: Role::Full,
                detail: "in-process".into(),
                _process: None,
            };
        }
        let process = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(process) => OwnedHandle(process),
            Err(error) => return Peer::bus(pid, format!("open process: {}", win_error(error))),
        };
        match process_creation_identity(process.0) {
            Ok(created) if created <= connected_at => {}
            Ok(_) => return Peer::bus(pid, "process created after the connection (pid reuse)".into()),
            Err(error) => return Peer::bus(pid, format!("creation time: {error}")),
        }
        let image = match process_image(process.0) {
            Ok(image) => image,
            Err(error) => return Peer::bus(pid, format!("image: {error}")),
        };
        let resolved = canonical(Path::new(&image));
        let role = if self.admits_image(&resolved) {
            Role::Full
        } else {
            Role::Bus
        };
        Peer {
            pid,
            role,
            detail: image,
            _process: Some(process),
        }
    }

    fn admits_image(&self, image: &Path) -> bool {
        self.vidar_images
            .iter()
            .any(|allowed| same_path(image, allowed))
    }
}

/// One connection's peer, held for the connection's life.
pub struct Peer {
    pub pid: u32,
    pub role: Role,
    /// The image path, or why the peer fell to the bus role.
    pub detail: String,
    /// Kept open so the peer's PID is not reused while connected.
    _process: Option<OwnedHandle>,
}

impl Peer {
    fn bus(pid: u32, detail: String) -> Self {
        Self {
            pid,
            role: Role::Bus,
            detail,
            _process: None,
        }
    }
}

/// The FILETIME (100 ns since 1601, UTC) for now, the unit `GetProcessTimes`
/// reports creation in.
pub fn filetime_now() -> u64 {
    const UNIX_EPOCH_AS_FILETIME: u64 = 116_444_736_000_000_000;
    let since_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    UNIX_EPOCH_AS_FILETIME + (since_unix.as_nanos() / 100) as u64
}

/// Equal by path components, case-insensitive, with a `\\?\` (or `\\?\UNC\`)
/// prefix stripped. A path holding `..` never matches: canonical paths have
/// none, and resolving one here would be guessing.
pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    match (components(a), components(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// `path` lies strictly inside `dir`, by the same component rules as
/// [`same_path`]: `Temp2` is not under `Temp`, and `Temp` itself is not.
pub(crate) fn is_under(path: &Path, dir: &Path) -> bool {
    match (components(path), components(dir)) {
        (Some(path), Some(dir)) => path.len() > dir.len() && path.starts_with(&dir),
        _ => false,
    }
}

/// `std::fs::canonicalize`, or the path as given when it cannot resolve.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn components(path: &Path) -> Option<Vec<String>> {
    let text = path.to_string_lossy();
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.into_owned()
    };
    let mut parts = Vec::new();
    if text.starts_with(r"\\") {
        parts.push(r"\\".to_string());
    }
    for part in text.split(['\\', '/']) {
        match part {
            "" | "." => continue,
            ".." => return None,
            // ASCII-only fold: NTFS does not equate U+212A (Kelvin) with `k`.
            part => parts.push(part.to_ascii_lowercase()),
        }
    }
    (!parts.is_empty()).then_some(parts)
}

/// May a connection with `role` run `op`? Negotiate is handled before this.
/// `detail` is [`Peer::detail`] (the image path, or why the peer fell to bus),
/// named in the refusal so a legitimate client can see why.
pub fn admits(role: Role, op: &Op, detail: &str) -> Result<(), String> {
    match (role, op) {
        (Role::Full, _) => Ok(()),
        (Role::Bus, Op::Negotiate { .. } | Op::Publish { .. }) => Ok(()),
        (Role::Bus, Op::Subscribe { topics }) => topics
            .iter()
            .try_for_each(|topic| bus_may_subscribe(topic, detail)),
        (Role::Bus, op) => Err(format!(
            "{} needs the full role; this connection has the bus role ({detail})",
            op.name()
        )),
    }
}

/// A bus-role subscription may not reach the `ctl` namespace, except an exact
/// `ctl.<verb>.reply.<id>`: the reply topic the requester itself named
/// (`bus-client.mjs` `request`, a random UUID id). A pattern `p.*` matches a
/// `ctl` topic only when `p` is `ctl` or starts `ctl.` (`bus::topic_matches`),
/// so that is the whole wildcard test.
fn bus_may_subscribe(pattern: &str, detail: &str) -> Result<(), String> {
    let reserved = |topic: &str| topic == "ctl" || topic.starts_with("ctl.");
    let allowed = match pattern.strip_suffix(".*") {
        Some(prefix) => !reserved(prefix),
        None => !reserved(pattern) || is_ctl_reply(pattern),
    };
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "subscribe {pattern} needs the full role: ctl.* carries other tabs' requests ({detail})"
        ))
    }
}

fn is_ctl_reply(topic: &str) -> bool {
    let mut parts = topic.splitn(4, '.');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some("ctl"), Some(verb), Some("reply"), Some(id)) if !verb.is_empty() && !id.is_empty()
    )
}

/// The activation pipe: `ping` for anyone holding the secret; `show`, `hide`
/// and `shutdown` (forced or not) for the full role only.
pub fn activation_allowed(role: Role, command: &str, detail: &str) -> Result<(), String> {
    if role == Role::Full || command == "ping" {
        Ok(())
    } else {
        Err(format!(
            "{command} needs the full role; this connection has the bus role ({detail})"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A root on a drive letter no test machine has, so canonicalize falls
    // back to the path as given and the cases stay machine-independent.
    const ROOT: &str = r"Q:\Apps\Vidar";

    fn policy() -> PeerPolicy {
        PeerPolicy::for_root(Path::new(ROOT))
    }

    fn at(relative: &str) -> PathBuf {
        Path::new(ROOT).join(relative)
    }

    #[test]
    fn the_three_vidar_images_match_exactly() {
        let policy = policy();
        assert!(policy.admits_image(&at("vidar.exe")));
        assert!(policy.admits_image(&at(r"src-tauri\target\release\vidar.exe")));
        assert!(policy.admits_image(&at(r"src-tauri\target\debug\vidar.exe")));
    }

    #[test]
    fn a_prefix_sibling_does_not_match() {
        let policy = policy();
        assert!(!policy.admits_image(Path::new(r"Q:\Apps\Vidar-old\vidar.exe")));
        assert!(!policy.admits_image(Path::new(r"Q:\Apps\Vidarx\vidar.exe")));
        assert!(!policy.admits_image(&at("vidar.exe.bak")));
    }

    #[test]
    fn a_worktree_or_other_build_under_the_root_does_not_match() {
        let policy = policy();
        assert!(!policy.admits_image(&at(r"runtime\worktrees\x\vidar.exe")));
        assert!(!policy.admits_image(&at(
            r"runtime\worktrees\x\src-tauri\target\release\vidar.exe"
        )));
        assert!(!policy.admits_image(&at(r"src-tauri\target\debug\deps\vidar-1a2b.exe")));
        assert!(!policy.admits_image(&at(r"src-tauri\target\fast\vidar.exe")));
        assert!(!policy.admits_image(&at("falcon.exe")));
    }

    #[test]
    fn the_verbatim_prefix_is_stripped() {
        let policy = policy();
        assert!(policy.admits_image(Path::new(r"\\?\Q:\Apps\Vidar\vidar.exe")));
        assert!(same_path(
            Path::new(r"\\?\UNC\server\share\vidar.exe"),
            Path::new(r"\\server\share\vidar.exe")
        ));
        assert!(!same_path(
            Path::new(r"\\server\share\vidar.exe"),
            Path::new(r"\server\share\vidar.exe")
        ));
    }

    #[test]
    fn case_and_separators_do_not_matter_but_dot_dot_never_matches() {
        let policy = policy();
        assert!(policy.admits_image(Path::new(r"q:\apps\VIDAR\Vidar.EXE")));
        assert!(policy.admits_image(Path::new("Q:/Apps/Vidar/vidar.exe")));
        assert!(!policy.admits_image(&at(r"runtime\..\vidar.exe")));
        assert!(!PeerPolicy::none().admits_image(&at("vidar.exe")));
    }

    #[test]
    fn under_is_strict_and_by_component() {
        let temp = Path::new(r"Q:\Users\me\AppData\Local\Temp");
        assert!(is_under(Path::new(r"Q:\Users\me\AppData\Local\Temp\smoke-1"), temp));
        assert!(is_under(Path::new(r"\\?\q:\users\ME\appdata\local\temp\smoke-1"), temp));
        assert!(!is_under(temp, temp));
        assert!(!is_under(Path::new(r"Q:\Users\me\AppData\Local\Temp2\smoke-1"), temp));
        assert!(!is_under(Path::new(r"Q:\Users\me\AppData\Local\Temp\..\x"), temp));
        assert!(!is_under(Path::new(ROOT), temp));
    }

    #[test]
    fn admit_probe_is_honoured_only_on_a_temp_root() {
        let temp = Path::new(r"Q:\Temp");
        let falcon = PathBuf::from(r"Q:\Bundles\b1\falcon.exe");

        let mut real = policy();
        let line = real.admit_probe(Path::new(ROOT), temp, &[falcon.clone()]);
        assert!(line.contains("ignored"), "{line}");
        assert!(!real.admits_image(&falcon));

        let smoke_root = Path::new(r"Q:\Temp\falcon-smoke-root-1");
        let mut smoke = PeerPolicy::for_root(smoke_root);
        let test_exe = PathBuf::from(r"Q:\Apps\Vidar\src-tauri\target\debug\deps\vidar-1a2b.exe");
        let line = smoke.admit_probe(smoke_root, temp, &[falcon.clone(), test_exe.clone()]);
        assert!(line.contains("honoured"), "{line}");
        assert!(smoke.admits_image(&falcon));
        assert!(smoke.admits_image(&test_exe));
        // Still exact: a sibling of the admitted image is not admitted.
        assert!(!smoke.admits_image(Path::new(r"Q:\Bundles\b2\falcon.exe")));
    }

    #[test]
    fn admit_probe_refuses_a_root_holding_contracts_paths_json() {
        let temp = std::env::temp_dir().join(format!("falcon-peer-probe-{}", filetime_now()));
        let root = temp.join("root");
        std::fs::create_dir_all(root.join("contracts")).expect("mkdir");
        std::fs::write(root.join("contracts").join("paths.json"), "{}").expect("write");
        let falcon = PathBuf::from(r"Q:\Bundles\b1\falcon.exe");
        let mut policy = PeerPolicy::for_root(&root);
        let line = policy.admit_probe(&root, &temp, &[falcon.clone()]);
        let admitted = policy.admits_image(&falcon);
        let _ = std::fs::remove_dir_all(&temp);
        assert!(line.contains("ignored") && line.contains("paths.json"), "{line}");
        assert!(!admitted);
    }

    #[test]
    fn case_fold_is_ascii_only() {
        // U+212A KELVIN SIGN lowercases to `k` in Unicode; NTFS does not equate them.
        assert!(!same_path(Path::new("Q:\\\u{212A}\\a.exe"), Path::new(r"Q:\k\a.exe")));
        assert!(same_path(Path::new(r"Q:\K\A.exe"), Path::new(r"Q:\k\a.exe")));
    }

    const DETAIL: &str = r"Q:\Tools\agent.exe";

    fn admits(role: Role, op: &Op) -> Result<(), String> {
        super::admits(role, op, DETAIL)
    }

    fn activation_allowed(role: Role, command: &str) -> Result<(), String> {
        super::activation_allowed(role, command, DETAIL)
    }

    #[test]
    fn a_refusal_names_the_peer() {
        let error = admits(Role::Bus, &Op::List).unwrap_err();
        assert!(error.contains(DETAIL), "{error}");
        let error = admits(Role::Bus, &subscribe(&["ctl.*"])).unwrap_err();
        assert!(error.contains(DETAIL), "{error}");
        let error = activation_allowed(Role::Bus, "show").unwrap_err();
        assert!(error.contains(DETAIL), "{error}");
    }

    fn subscribe(topics: &[&str]) -> Op {
        Op::Subscribe {
            topics: topics.iter().map(|t| t.to_string()).collect(),
        }
    }

    #[test]
    fn the_bus_role_runs_only_subscribe_and_publish() {
        let publish = Op::Publish {
            topic: "ctl.wait".into(),
            id: "m".into(),
            payload: serde_json::json!({}),
            reply_to: Some("ctl.wait.reply.m".into()),
        };
        assert!(admits(Role::Bus, &publish).is_ok());
        assert!(admits(Role::Bus, &subscribe(&["ask.open"])).is_ok());
        for op in [Op::List, Op::Attach { session: "s".into() }, Op::Detach { session: "s".into() }] {
            assert!(admits(Role::Bus, &op).is_err(), "{}", op.name());
            assert!(admits(Role::Full, &op).is_ok(), "{}", op.name());
        }
    }

    #[test]
    fn the_bus_role_cannot_subscribe_to_the_ctl_stream() {
        for pattern in ["ctl.*", "ctl", "ctl.wait", "ctl.wait.*", "ctl.wait.reply.*", "ctl.reply.x"] {
            assert!(admits(Role::Bus, &subscribe(&[pattern])).is_err(), "{pattern}");
            assert!(admits(Role::Full, &subscribe(&[pattern])).is_ok(), "{pattern}");
        }
        // One bad pattern refuses the whole list.
        assert!(admits(Role::Bus, &subscribe(&["ask.open", "ctl.*"])).is_err());
        // The requester's own reply topic, and names that only look similar.
        for pattern in ["ctl.wait.reply.5b1e", "ctls.*", "control.*", "ask.*", "x.ctl.y"] {
            assert!(admits(Role::Bus, &subscribe(&[pattern])).is_ok(), "{pattern}");
        }
        assert!(admits(Role::Bus, &subscribe(&["ctl..reply.x"])).is_err());
        assert!(admits(Role::Bus, &subscribe(&["ctl.wait.reply."])).is_err());
    }

    #[test]
    fn activation_show_hide_and_shutdown_need_the_full_role() {
        assert!(activation_allowed(Role::Bus, "ping").is_ok());
        for command in ["show", "hide", "shutdown"] {
            assert!(activation_allowed(Role::Bus, command).is_err(), "{command}");
            assert!(activation_allowed(Role::Full, command).is_ok(), "{command}");
        }
    }

    #[test]
    fn the_in_process_client_is_full() {
        // A real pipe pair inside this process: the server sees its own PID.
        let endpoint = format!(r"\\.\pipe\falcon-peer-test-{}-{}", std::process::id(), filetime_now());
        let security = crate::security::UserSecurity::current_user().expect("security");
        let server = crate::ipc::create_server_full(&endpoint, &security, true, 1024, false)
            .expect("server");
        let _client = crate::ipc::connect(&endpoint).expect("client");
        let peer = PeerPolicy::none().identify(server.handle(), filetime_now());
        assert_eq!(peer.role, Role::Full);
        assert_eq!(peer.pid, std::process::id());
    }
}
