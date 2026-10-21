//! Build-profile guard (audit H7).
//!
//! A build without `tauri/custom-protocol` is a Tauri dev build: it loads the UI from
//! devUrl (port 1420, bindable by any local process) under `devCsp`. Release-profile
//! exes built that way look identical to shipping ones, so two things detect them:
//! `dev_run_refused` stops one at startup, and `BUILD_INFO` embeds a marker line that
//! tools can find by scanning the exe bytes.
//!
//! `profile` in the marker is cargo's `PROFILE`, which reads only `debug` or `release`
//! for custom profiles (`fast` reports `release`); tools should judge by `optLevel`.

/// True when this exe is a Tauri dev build in an optimized profile and nobody asked
/// for it. `npm run tauri dev` is a debug build (debug_assertions on) and passes.
pub fn dev_run_refused(is_dev: bool, debug_assertions: bool, dev_run_env: Option<&str>) -> bool {
    is_dev && !debug_assertions && dev_run_env.map_or(true, |v| v.is_empty())
}

const INFO: &str = include_str!(concat!(env!("OUT_DIR"), "/build-info.txt"));
const INFO_LEN: usize = INFO.len();

/// Scanned for in the exe by tools; `#[used]` keeps it through linking.
#[used]
pub static BUILD_INFO: [u8; INFO_LEN] = {
    let src = INFO.as_bytes();
    let mut out = [0u8; INFO_LEN];
    let mut i = 0;
    while i < INFO_LEN {
        out[i] = src[i];
        i += 1;
    }
    out
};

/// Referenced from `main` so the MSVC linker (`/OPT:REF`) cannot drop the marker;
/// `#[used]` alone only survives to the object file.
pub fn keep_marker() {
    std::hint::black_box(&BUILD_INFO);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_truth_table() {
        for is_dev in [false, true] {
            for dbg in [false, true] {
                for env in [None, Some(""), Some("1")] {
                    let want = is_dev && !dbg && env.map_or(true, |v| v.is_empty());
                    assert_eq!(dev_run_refused(is_dev, dbg, env), want, "{is_dev} {dbg} {env:?}");
                }
            }
        }
        assert!(dev_run_refused(true, false, None));
        assert!(dev_run_refused(true, false, Some("")));
        assert!(!dev_run_refused(true, false, Some("1")));
        assert!(!dev_run_refused(true, true, None));
        assert!(!dev_run_refused(false, false, None));
    }

    #[test]
    fn marker_is_prefixed_json_line() {
        let s = std::str::from_utf8(&BUILD_INFO).unwrap();
        let rest = s.strip_prefix("VIDAR-BUILD-INFO ").expect("prefix");
        let json = rest.strip_suffix('\n').expect("trailing newline");
        let v: serde_json::Value = serde_json::from_str(json).expect("json");
        assert!(v["customProtocol"].is_boolean());
        assert!(v["debugAssertions"].is_boolean());
        assert!(v["optLevel"].is_string());
        assert!(v["profile"].is_string());
    }
}
