//! vidar.json `jira` (plan § D3): `{ "site": "https://<name>.atlassian.net", "jql": "..." }` and
//! nothing else. Email and token live in the credential (`vault.rs`), so copies and zips of the
//! install folder carry neither. `validate_settings` is the `patch_settings` validator and runs
//! again at request time, since vidar.json is hand- and agent-editable.

use std::path::Path;

use serde_json::Value;

pub const JQL_MAX_CHARS: usize = 2000;
const SITE_PREFIX: &str = "https://";
const SITE_SUFFIX: &str = ".atlassian.net";
const LABEL_MAX: usize = 63;

/// The settings as a request reads them: `site` is validated, `jql` may be blank (default JQL).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JiraSettings {
    pub site: Option<String>,
    pub jql: String,
}

/// `^https://[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$` on the raw string: no uppercase, port,
/// path, query, userinfo, trailing dot, extra label or punycode (`xn--`) label.
pub fn validate_site(site: &str) -> Result<(), String> {
    let refuse = || Err("jira.site must be https://<name>.atlassian.net".to_string());
    let Some(label) = site.strip_prefix(SITE_PREFIX).and_then(|rest| rest.strip_suffix(SITE_SUFFIX)) else {
        return refuse();
    };
    let b = label.as_bytes();
    // The pattern alone admits `xn--`; § D3 and the B1 test refuse punycode labels too.
    let ok = (1..=LABEL_MAX).contains(&b.len())
        && !label.starts_with("xn--")
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
    if ok {
        Ok(())
    } else {
        refuse()
    }
}

/// The host of a site `validate_site` accepts.
pub fn site_host(site: &str) -> Result<&str, String> {
    validate_site(site)?;
    Ok(&site[SITE_PREFIX.len()..])
}

fn validate_jql(jql: &str) -> Result<(), String> {
    if jql.chars().count() > JQL_MAX_CHARS {
        return Err(format!("jira.jql must be at most {JQL_MAX_CHARS} characters"));
    }
    if jql.chars().any(char::is_control) {
        return Err("jira.jql must not contain control characters".into());
    }
    Ok(())
}

/// The `patch_settings` validator. A blank or whitespace-only string passes so `clear_on_empty`
/// can remove the key (validation runs before the clear).
pub fn validate_settings(v: &Value) -> Result<(), String> {
    if let Some(s) = v.as_str() {
        return if s.trim().is_empty() { Ok(()) } else { Err("jira must be an object or blank".into()) };
    }
    let obj = v.as_object().ok_or("jira must be an object or blank")?;
    if let Some(key) = obj.keys().find(|k| *k != "site" && *k != "jql") {
        return Err(format!("jira takes only site and jql, not \"{key}\""));
    }
    if let Some(site) = obj.get("site") {
        validate_site(site.as_str().ok_or("jira.site must be a string")?)?;
    }
    if let Some(jql) = obj.get("jql") {
        validate_jql(jql.as_str().ok_or("jira.jql must be a string")?)?;
    }
    Ok(())
}

/// `jira` out of a parsed vidar.json root, validated. Absent or blank is the default (no site).
pub fn settings_from_root(root: &Value) -> Result<JiraSettings, String> {
    let Some(v) = root.get("jira") else { return Ok(JiraSettings::default()) };
    validate_settings(v)?;
    let field = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Ok(JiraSettings { site: field("site"), jql: field("jql").unwrap_or_default() })
}

/// Reads `jira` from the vidar.json at `path`; a missing file is the default.
pub fn read_settings_at(path: &Path) -> Result<JiraSettings, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(JiraSettings::default()),
        Err(e) => return Err(format!("vidar.json read error: {e}")),
    };
    let root: Value = serde_json::from_str(crate::settings::store::strip_bom(&text))
        .map_err(|e| format!("vidar.json parse error: {e}"))?;
    settings_from_root(&root)
}

pub fn read_settings() -> Result<JiraSettings, String> {
    read_settings_at(&crate::paths::config_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BAD_SITES: [&str; 16] = [
        "https://Example.atlassian.net",
        "https://example.atlassian.net.",
        "https://xn--exmple-cua.atlassian.net",
        "https://example.atlassian.net.evil.com",
        "https://example.atlassian.net:443",
        "https://example.atlassian.net/",
        "https://example.atlassian.net/jira",
        "https://example.atlassian.net?x=1",
        "https://user@example.atlassian.net",
        "https://a.b.atlassian.net",
        "https://-example.atlassian.net",
        "http://example.atlassian.net",
        "https://.atlassian.net",
        "https://evil.example",
        "example.atlassian.net",
        " https://example.atlassian.net",
    ];

    #[test]
    fn site_outside_atlassian_net_is_refused() {
        for good in ["https://example.atlassian.net", "https://a.atlassian.net", "https://my-team-9.atlassian.net"] {
            assert!(validate_site(good).is_ok(), "{good}");
            assert!(validate_settings(&json!({ "site": good })).is_ok(), "{good}");
        }
        let long = format!("https://{}.atlassian.net", "a".repeat(64));
        assert!(validate_site(&long).is_err());
        assert!(validate_site(&format!("https://{}.atlassian.net", "a".repeat(63))).is_ok());
        for bad in BAD_SITES {
            assert!(validate_site(bad).is_err(), "{bad}");
            assert!(validate_settings(&json!({ "site": bad })).is_err(), "{bad}");
            assert!(settings_from_root(&json!({ "jira": { "site": bad } })).is_err(), "{bad}");
        }
        assert_eq!(site_host("https://example.atlassian.net").unwrap(), "example.atlassian.net");
    }

    #[test]
    fn settings_with_a_token_or_email_key_are_refused() {
        let site = "https://example.atlassian.net";
        for key in ["token", "email", "Site", "url"] {
            let v = json!({ "site": site, key: "x" });
            assert!(validate_settings(&v).is_err(), "{key}");
        }
        assert!(validate_settings(&json!({ "site": site, "jql": "project = DEMO" })).is_ok());
        assert!(validate_settings(&json!({ "site": 1 })).is_err());
        assert!(validate_settings(&json!(["site"])).is_err());
        assert!(validate_settings(&json!("https://example.atlassian.net")).is_err());
        assert!(validate_settings(&json!({ "jql": "a\u{7}b" })).is_err());
        assert!(validate_settings(&json!({ "jql": "a\nb" })).is_err());
        assert!(validate_settings(&json!({ "jql": "é".repeat(JQL_MAX_CHARS) })).is_ok());
        assert!(validate_settings(&json!({ "jql": "a".repeat(JQL_MAX_CHARS + 1) })).is_err());
    }

    #[test]
    fn blank_settings_value_is_accepted() {
        for blank in ["", " ", "\t \n"] {
            assert!(validate_settings(&json!(blank)).is_ok(), "{blank:?}");
        }
        assert_eq!(settings_from_root(&json!({})).unwrap(), JiraSettings::default());
        let got = settings_from_root(&json!({ "jira": { "site": "https://example.atlassian.net" } })).unwrap();
        assert_eq!(got.site.as_deref(), Some("https://example.atlassian.net"));
        assert_eq!(got.jql, "");
    }
}
