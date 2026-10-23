//! src-tauri\src\modules\compat.rs — the core a pack says it needs. `pack.json` may carry a
//! top-level `release` (semver) and `requires` (`contract`, `minCore`, `maxCore`?); a pack whose
//! range rejects this core is a broken row with a readable reason, never deleted. Absent keys
//! mean no constraint.

use std::cmp::Ordering;

use serde_json::Value;

/// The contract version this core implements; a test pins it to `contracts/modules.json`.
pub const CORE_CONTRACT: u64 = 1;

/// A parsed `major.minor.patch[-pre][+build]`; build metadata is dropped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Semver {
    nums: [u64; 3],
    pre: Option<Vec<String>>,
}

impl Semver {
    pub fn parse(text: &str) -> Option<Semver> {
        let text = text.split('+').next()?;
        let (core, pre) = match text.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (text, None),
        };
        let mut parts = core.split('.');
        let mut nums = [0u64; 3];
        for n in nums.iter_mut() {
            let p = parts.next()?;
            if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) || (p.len() > 1 && p.starts_with('0')) {
                return None;
            }
            *n = p.parse().ok()?;
        }
        if parts.next().is_some() {
            return None;
        }
        let pre = match pre {
            None => None,
            Some(p) => {
                let ids: Vec<String> = p.split('.').map(str::to_string).collect();
                let ok = ids.iter().all(|i| !i.is_empty() && i.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
                if !ok {
                    return None;
                }
                Some(ids)
            }
        };
        Some(Semver { nums, pre })
    }
}

impl PartialOrd for Semver {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Semver {
    fn cmp(&self, other: &Self) -> Ordering {
        self.nums.cmp(&other.nums).then_with(|| match (&self.pre, &other.pre) {
            (None, None) => Ordering::Equal,
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (Some(a), Some(b)) => {
                for (x, y) in a.iter().zip(b.iter()) {
                    let o = match (x.parse::<u64>(), y.parse::<u64>()) {
                        (Ok(x), Ok(y)) => x.cmp(&y),
                        (Ok(_), Err(_)) => Ordering::Less,
                        (Err(_), Ok(_)) => Ordering::Greater,
                        (Err(_), Err(_)) => x.cmp(y),
                    };
                    if o != Ordering::Equal {
                        return o;
                    }
                }
                a.len().cmp(&b.len())
            }
        })
    }
}

/// Checks a pack's top-level `release` and `requires` against this core.
pub fn check_pack_compat(pack: &Value, core_version: &str, core_contract: u64) -> Result<(), String> {
    if let Some(r) = pack.get("release") {
        if r.as_str().and_then(Semver::parse).is_none() {
            return Err("release Is Not A Version".into());
        }
    }
    let Some(req) = pack.get("requires") else { return Ok(()) };
    let Some(obj) = req.as_object() else {
        return Err("requires Is Not An Object".into());
    };
    if let Some(k) = obj.keys().find(|k| !matches!(k.as_str(), "contract" | "minCore" | "maxCore")) {
        return Err(format!("requires.{k} Is Not A Key"));
    }
    let Some(contract) = obj.get("contract").and_then(Value::as_u64) else {
        return Err("requires.contract Is Not A Whole Number".into());
    };
    let version_key = |key: &str| -> Result<Option<(Semver, String)>, String> {
        match obj.get(key) {
            None => Ok(None),
            Some(v) => match v.as_str().and_then(|s| Semver::parse(s).map(|p| (p, s.to_string()))) {
                Some(p) => Ok(Some(p)),
                None => Err(format!("requires.{key} Is Not A Version")),
            },
        }
    };
    let min = version_key("minCore")?;
    let Some(min) = min else {
        return Err("requires.minCore Is Missing".into());
    };
    let max = version_key("maxCore")?;
    let core = Semver::parse(core_version).ok_or_else(|| format!("Core Version {core_version} Is Not A Version"))?;
    if contract > core_contract {
        return Err("Needs Vidar Update".into());
    }
    if core < min.0 {
        return Err(format!("Needs Vidar {} or Newer", min.1));
    }
    if let Some((m, text)) = max {
        if core > m {
            return Err(format!("Built for Vidar {text} or Earlier"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(s: &str) -> Semver {
        Semver::parse(s).unwrap()
    }

    #[test]
    fn semver_ordering() {
        assert!(v("1.2.3") < v("1.2.10"));
        assert!(v("1.9.0") < v("1.10.0"));
        assert!(v("2.0.0") > v("1.99.99"));
        assert!(v("1.0.0-beta") < v("1.0.0"));
        assert!(v("1.0.0-alpha") < v("1.0.0-beta"));
        assert!(v("1.0.0-beta.2") < v("1.0.0-beta.11"));
        assert!(v("1.0.0-alpha") < v("1.0.0-alpha.1"));
        assert_eq!(v("1.0.0+build"), v("1.0.0"));
        for bad in ["", "1", "1.2", "1.2.3.4", "1.x.3", "v1.2.3", "1.2.3-", "01a.2.3"] {
            assert!(Semver::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn semver_refuses_leading_zeros() {
        for bad in ["01.2.3", "1.02.3", "1.2.03", "00.1.0"] {
            assert!(Semver::parse(bad).is_none(), "{bad}");
        }
        for good in ["0.0.0", "0.1.0", "10.20.30"] {
            assert!(Semver::parse(good).is_some(), "{good}");
        }
    }

    #[test]
    fn core_contract_matches_contract_file() {
        let c: Value = serde_json::from_str(include_str!("../../../contracts/modules.json")).unwrap();
        assert_eq!(c["version"].as_u64(), Some(CORE_CONTRACT));
    }

    #[test]
    fn absent_keys_pass() {
        assert!(check_pack_compat(&json!({ "id": "a" }), "0.5.0", 1).is_ok());
    }

    #[test]
    fn accepts_in_range() {
        let p = json!({ "release": "1.0.0", "requires": { "contract": 1, "minCore": "0.4.0", "maxCore": "0.9.0" } });
        assert!(check_pack_compat(&p, "0.5.0", 1).is_ok());
        assert!(check_pack_compat(&json!({ "requires": { "contract": 1, "minCore": "0.5.0" } }), "0.5.0", 1).is_ok());
    }

    #[test]
    fn refuses_min_core_above_core() {
        let p = json!({ "requires": { "contract": 1, "minCore": "0.6.0" } });
        assert_eq!(check_pack_compat(&p, "0.5.0", 1).unwrap_err(), "Needs Vidar 0.6.0 or Newer");
    }

    #[test]
    fn refuses_max_core_below_core() {
        let p = json!({ "requires": { "contract": 1, "minCore": "0.1.0", "maxCore": "0.4.0" } });
        assert_eq!(check_pack_compat(&p, "0.5.0", 1).unwrap_err(), "Built for Vidar 0.4.0 or Earlier");
    }

    #[test]
    fn refuses_contract_above_core() {
        let p = json!({ "requires": { "contract": 2, "minCore": "0.1.0" } });
        assert_eq!(check_pack_compat(&p, "0.5.0", 1).unwrap_err(), "Needs Vidar Update");
    }

    #[test]
    fn malformed_keys_name_the_key() {
        let cases = [
            (json!({ "release": "soon" }), "release"),
            (json!({ "release": 3 }), "release"),
            (json!({ "requires": 1 }), "requires"),
            (json!({ "requires": { "contract": "1", "minCore": "0.1.0" } }), "requires.contract"),
            (json!({ "requires": { "contract": 1 } }), "requires.minCore"),
            (json!({ "requires": { "contract": 1, "minCore": "x" } }), "requires.minCore"),
            (json!({ "requires": { "contract": 1, "minCore": "0.1.0", "maxCore": 4 } }), "requires.maxCore"),
            (json!({ "requires": { "contract": 1, "minCore": "0.1.0", "other": 1 } }), "requires.other"),
        ];
        for (p, key) in cases {
            let e = check_pack_compat(&p, "0.5.0", 1).unwrap_err();
            assert!(e.contains(key), "{p} -> {e}");
        }
    }
}
