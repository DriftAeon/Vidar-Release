//! The Falcon host's machine-global names (two pipes, one mutex), per Vidar folder.
//!
//! Named pipes and `Local\` mutexes are per logon, not per folder, so fixed names
//! let a second Vidar install's host take the endpoints of the first. Each name
//! carries a suffix derived from the Vidar root: one folder, one host.
//!
//! Only the host (`src-falcon/src/main.rs`) derives these; it publishes the pipe
//! names in its `registry.json`, and every client (Vidar's `falcon/connection.rs`
//! and `host_launch.rs`, the host's own `--probe`, `tools/bus/bus-client.mjs`,
//! `tools/falcon/*.ps1`) reads them from there. Mounted by `#[path]` in both crates
//! (`falcon.rs` and the shell's `main.rs`) so the derivation is tested on both sides.

// Vidar never calls this outside its tests; the shell uses all of it.
#![allow(dead_code)]

use std::path::Path;

/// The three names one host owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostNames {
    pub activation_endpoint: String,
    pub session_endpoint: String,
    pub host_mutex: String,
}

/// Names for the host serving the Vidar folder `root`.
pub fn for_root(root: &Path) -> HostNames {
    let suffix = root_suffix(root);
    HostNames {
        activation_endpoint: format!(r"\\.\pipe\vidar-falcon-activation-v1-{suffix}"),
        session_endpoint: format!(r"\\.\pipe\vidar-falcon-session-proof-v1-{suffix}"),
        host_mutex: format!(r"Local\VidarFalconHostV1-{suffix}"),
    }
}

/// 16 lowercase hex digits: FNV-1a 64 over the normalised root. Stable across
/// builds and toolchains (std's `DefaultHasher` is not).
pub fn root_suffix(root: &Path) -> String {
    format!("{:016x}", fnv1a_64(normalise(root).as_bytes()))
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Canonicalised when the folder exists (resolves `..`, 8.3 names, junctions),
/// the path as given otherwise; then without the `\\?\` prefix, with `\`
/// separators, no trailing separator, lowercased.
fn normalise(root: &Path) -> String {
    let resolved = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let text = resolved.to_string_lossy().replace('/', "\\");
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text
    };
    text.trim_end_matches('\\').to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vidar-host-names-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create scratch root");
        dir
    }

    #[test]
    fn same_root_in_any_spelling_gets_the_same_names() {
        let root = scratch("Same");
        let text = root.to_string_lossy().into_owned();
        let base = for_root(&root);
        for variant in [
            text.to_uppercase(),
            text.to_lowercase(),
            format!("{text}\\"),
            format!("{text}/"),
            text.replace('\\', "/"),
        ] {
            assert_eq!(for_root(Path::new(&variant)), base, "variant {variant}");
        }
        // A folder that does not exist yet still folds case and the trailing slash.
        let missing = Path::new(r"C:\No\Such\Vidar-Root-For-Host-Names");
        assert_eq!(
            for_root(missing),
            for_root(Path::new(r"c:\no\such\vidar-root-for-host-names\"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn different_roots_get_different_names() {
        let one = scratch("One");
        let two = scratch("Two");
        let a = for_root(&one);
        let b = for_root(&two);
        assert_ne!(a.activation_endpoint, b.activation_endpoint);
        assert_ne!(a.session_endpoint, b.session_endpoint);
        assert_ne!(a.host_mutex, b.host_mutex);
        let _ = std::fs::remove_dir_all(&one);
        let _ = std::fs::remove_dir_all(&two);
    }

    #[test]
    fn names_are_valid_pipe_and_mutex_names() {
        let names = for_root(Path::new(r"D:\Tools\Vidar"));
        for (name, prefix) in [
            (&names.activation_endpoint, r"\\.\pipe\vidar-falcon-activation-v1-"),
            (&names.session_endpoint, r"\\.\pipe\vidar-falcon-session-proof-v1-"),
            (&names.host_mutex, r"Local\VidarFalconHostV1-"),
        ] {
            let suffix = name.strip_prefix(prefix).expect("fixed prefix");
            assert_eq!(suffix.len(), 16);
            assert!(suffix.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(!suffix.contains('\\'));
            // Pipe names cap at 256 characters; object names at MAX_PATH.
            assert!(name.len() < 256, "{name}");
        }
    }

    /// Published FNV-1a 64 test vectors: the hash is the stable one, not a lookalike.
    #[test]
    fn fnv1a_matches_the_reference_vectors() {
        assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a_64(b"foobar"), 0x8594_4171_f739_67e8);
    }
}
