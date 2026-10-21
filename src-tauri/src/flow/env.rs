//! FLOW node env plan: the pure §4.4 env construction for a node's spawned CLI, plus the
//! executable resolution the spawn needs. One concern: what environment and binaries a
//! node runs with. Child lifecycle and stream handling stay in flow.rs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

// pty.rs's list: Vidar may itself run inside an agent's tool shell, and a flow node's
// spawned CLI must not inherit that conversation's markers (agent.rs uses the same list).
use crate::pty::SCRUBBED_ENV;
use crate::which::find_on_path_exact;

// ---------------------------------------------------------------------------
// §4.4 env construction — a pure function so it is unit-testable with no process,
// no registry and no real environment. `registry_lookup` stands in for the
// `reg query HKCU\Environment` read (production: `registry_value`; tests: a stub).
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct EnvPlan {
    pub remove: Vec<String>,
    pub set: Vec<(String, String)>,
}

/// What a gateway model needs, read from a module's `flowModels` entry and its
/// `agent.gateway` (modules.md). The module registry has already validated the declaration
/// (https base URL, keyVar template, env keys in the contract's `gateway.envAllowlist`); nothing here
/// re-checks it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayModel {
    pub base_url: String,
    pub key_name: String,
    pub haiku: String,
    pub model: String,
    pub max_context: String,
    pub extra: Vec<(String, String)>,
}

/// Pure: the gateway model `model` names in a serialized `modules_list` result
/// (`{modules: [...]}`), or None when no module declares it in `flowModels` or the owning
/// module has no `agent.gateway`.
pub fn gateway_model_from(registry: &serde_json::Value, model: &str) -> Option<GatewayModel> {
    for m in registry.get("modules")?.as_array()? {
        let Some(fm) = m
            .get("flowModels")
            .and_then(|f| f.as_array())
            .and_then(|f| f.iter().find(|e| e.get("id").and_then(|i| i.as_str()) == Some(model)))
        else {
            continue;
        };
        let g = m.get("agent")?.get("gateway")?;
        let text = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        return Some(GatewayModel {
            base_url: text(g, "baseUrl")?,
            key_name: text(g, "keyVar")?,
            haiku: text(fm, "haiku")?,
            model: model.to_string(),
            max_context: fm.get("maxContext")?.as_u64()?.to_string(),
            extra: g
                .get("env")
                .and_then(|e| e.as_object())
                .map(|e| e.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
                .unwrap_or_default(),
        });
    }
    None
}

/// Production lookup: the live module registry through the read-only `modules::listed`
/// (records no pins; a gateway module is listed only when its pin matched, so a first-sight
/// or changed pack routes nowhere). A serialization failure reads as "no such module".
pub(super) fn registry_gateway_model(model: &str) -> Option<GatewayModel> {
    gateway_model_from(&serde_json::to_value(crate::modules::listed()).ok()?, model)
}

// The four wired Claude-family ids (model.ts's ModelId, minus the reserved/unwired ones).
pub(super) const CLAUDE_MODELS: &[&str] = &[
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
];

/// Pure: no I/O beyond calling `registry_lookup`. Step 0/1/2/3/4 of §4.4.
/// `inherited` is Vidar's own process environment snapshot — the scrub union's
/// `ANTHROPIC_*`/`*_API_KEY` names are computed from what is actually present in
/// it, never a hardcoded guess at every vendor's key name.
pub fn build_node_env(
    model: &str,
    inherited: &HashMap<String, String>,
    registry_lookup: &dyn Fn(&str) -> Option<String>,
    gateway_lookup: &dyn Fn(&str) -> Option<GatewayModel>,
) -> Result<EnvPlan, String> {
    let mut remove: Vec<String> = SCRUBBED_ENV.iter().map(|s| s.to_string()).collect();
    for extra in [
        "VIDAR_TAB",
        "VIDAR_TAB_NAME",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        "API_TIMEOUT_MS",
        "VIDAR_SIDECAR_DUMP",
    ] {
        remove.push(extra.to_string());
    }
    for key in inherited.keys() {
        // Windows env names are case-insensitive; match the same way so
        // e.g. a mixed-case `Acme_Api_Key` is scrubbed too.
        let upper = key.to_ascii_uppercase();
        // `_API_KEY` alone misses other credential shapes — a vendor node with Bash
        // would otherwise inherit e.g. `CLAUDE_CODE_OAUTH_TOKEN` or a stray `*_TOKEN`/`*_SECRET`
        // if one were ever set in Vidar's own process env (latent today — checked this session's
        // env, only the already-scrubbed names are secret-shaped).
        if upper.starts_with("ANTHROPIC_")
            || upper.ends_with("_API_KEY")
            || upper.ends_with("_TOKEN") // covers CLAUDE_CODE_OAUTH_TOKEN too
            || upper.ends_with("_SECRET")
        {
            remove.push(key.clone());
        }
    }
    remove.sort();
    remove.dedup();

    let mut set: Vec<(String, String)> = vec![("CONTEXT_GATE".to_string(), "0".to_string())];

    if CLAUDE_MODELS.contains(&model) {
        // Step 2: no overrides for the three auth keys after the scrub — the
        // subscription login (claude.exe's own stored credentials) is what is left.
        return Ok(EnvPlan { remove, set });
    }

    // Step 3: gateway models come from a module's declaration, never from Vidar's own
    // inherited env (step 4's hard filter applies only to `inherited`).
    let vendor = gateway_lookup(model).ok_or_else(|| format!("unknown model: {model}"))?;
    let token = registry_lookup(&vendor.key_name)
        .ok_or_else(|| format!("{} not set", vendor.key_name))?;
    set.push(("ANTHROPIC_BASE_URL".to_string(), vendor.base_url));
    set.push(("ANTHROPIC_AUTH_TOKEN".to_string(), token));
    set.push(("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), vendor.haiku));
    set.push(("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(), vendor.model.clone()));
    set.push(("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), vendor.model));
    set.push(("CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(), vendor.max_context));
    // The module's own env wins over the defaults above (same keys replace, others append).
    for (k, v) in vendor.extra {
        match set.iter_mut().find(|(kk, _)| *kk == k) {
            Some(slot) => slot.1 = v,
            None => set.push((k, v)),
        }
    }
    Ok(EnvPlan { remove, set })
}

/// Reads a user-environment value from the registry through the shared parser (`winreg_env.rs`).
pub(super) fn registry_value(name: &str) -> Option<String> {
    crate::winreg_env::registry_value(name)
}

/// The exact remove-then-set order `spawn_sidecar` applies to a
/// real `Command`, pulled out so a test can assert the *final* env a vendor node
/// gets — via `Command::get_envs()`, no spawn needed — rather than just the plan's
/// own two lists, which would stay green even if this order were ever reversed.
pub(super) fn apply_env_plan(cmd: &mut Command, plan: &EnvPlan) {
    for key in &plan.remove {
        cmd.env_remove(key);
    }
    for (key, value) in &plan.set {
        cmd.env(key, value);
    }
}

// §4.3 step 1: exact-filename `.exe` resolution (never through PATHEXT, so a
// leftover `claude.cmd`/`.ps1` shim earlier on PATH is never picked — the SDK
// cannot spawn a shim directly) lives in which.rs (`find_on_path_exact`), shared with deps.rs.
// claude.exe comes from the claude pack's dep probe (`deps::claude_exe`, `.exe` entries only).

/// `Err` names what was looked for, never a value — nothing here is a secret, but the
/// habit of never interpolating anything but names/paths into an error string is
/// the same one §4.4's tests hold the env builder to.
pub(super) fn resolve_executables() -> Result<(PathBuf, PathBuf), String> {
    let node = find_on_path_exact("node.exe").ok_or("node.exe not found on PATH")?;
    let claude = crate::deps::claude_exe()
        .ok_or("Claude Code not found on PATH or at the Claude dependency's install paths")?;
    Ok((node, claude))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::{FlowNodeEventPayload, FlowRunNodeStatus};

    fn env_with(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    // ---- §4.4 env builder ----

    /// The `acme` fixture pack's module, shaped like a serialized `modules_list`.
    fn acme_registry() -> serde_json::Value {
        let pack: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/modules/ok-gateway/acme/pack.json"
        ))
        .unwrap();
        serde_json::json!({ "modules": [pack["module"].clone()] })
    }

    fn acme_lookup(model: &str) -> Option<GatewayModel> {
        gateway_model_from(&acme_registry(), model)
    }

    fn no_gateway(_: &str) -> Option<GatewayModel> {
        None
    }

    #[test]
    fn scrub_union_removes_session_markers_and_derived_keys() {
        let inherited = env_with(&[
            ("CLAUDE_CODE_SESSION_ID", "sess"),
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("ANTHROPIC_BASE_URL", "https://stale.example"),
            ("ACME_API_KEY", "acme-secret"),
            ("TYPESAFE_API_KEY", "ty-secret"),
            ("VIDAR_TAB", "abc"),
            ("VIDAR_TAB_NAME", "Amber Raptor"),
            ("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "1"),
            ("API_TIMEOUT_MS", "1"),
            ("VIDAR_SIDECAR_DUMP", "x"),
            ("UNRELATED", "keep-me"),
        ]);
        let plan = build_node_env("claude-sonnet-5", &inherited, &|_| None, &no_gateway).unwrap();
        for name in [
            "CLAUDE_CODE_SESSION_ID",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ACME_API_KEY",
            "TYPESAFE_API_KEY",
            "VIDAR_TAB",
            "VIDAR_TAB_NAME",
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
            "API_TIMEOUT_MS",
            "VIDAR_SIDECAR_DUMP",
        ] {
            assert!(plan.remove.iter().any(|r| r == name), "expected {name} scrubbed");
        }
        assert!(!plan.remove.iter().any(|r| r == "UNRELATED"));
    }

    #[test]
    fn claude_family_gets_no_auth_overrides() {
        let plan = build_node_env("claude-sonnet-5", &HashMap::new(), &|_| None, &no_gateway).unwrap();
        assert!(plan
            .set
            .iter()
            .all(|(k, _)| k != "ANTHROPIC_BASE_URL" && k != "ANTHROPIC_AUTH_TOKEN"));
        assert!(plan.set.iter().any(|(k, v)| k == "CONTEXT_GATE" && v == "0"));
    }

    #[test]
    fn gateway_model_resolves_from_a_module_declaration() {
        let plan = build_node_env(
            "acme-large",
            &HashMap::new(),
            &|name| (name == "ACME_API_KEY").then(|| "acme-token".to_string()),
            &acme_lookup,
        )
        .unwrap();
        let get = |k: &str| plan.set.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone());
        assert_eq!(get("ANTHROPIC_BASE_URL").as_deref(), Some("https://api.acme.example/anthropic"));
        assert_eq!(get("ANTHROPIC_AUTH_TOKEN").as_deref(), Some("acme-token"));
        assert_eq!(get("ANTHROPIC_DEFAULT_SONNET_MODEL").as_deref(), Some("acme-large"));
        assert_eq!(get("ANTHROPIC_DEFAULT_OPUS_MODEL").as_deref(), Some("acme-large"));
        assert_eq!(get("ANTHROPIC_DEFAULT_HAIKU_MODEL").as_deref(), Some("acme-small"));
        assert_eq!(get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").as_deref(), Some("200000"));
        // One entry per key: the module's env replaced the default, it did not duplicate it.
        assert_eq!(plan.set.iter().filter(|(k, _)| k == "ANTHROPIC_DEFAULT_HAIKU_MODEL").count(), 1);
    }

    #[test]
    fn gateway_model_missing_key_names_the_variable_not_a_value() {
        let err = build_node_env("acme-large", &HashMap::new(), &|_| None, &acme_lookup).unwrap_err();
        assert!(err.contains("ACME_API_KEY"));
        assert!(!err.to_lowercase().contains("secret"));
    }

    #[test]
    fn an_id_with_no_module_is_refused() {
        let err = build_node_env("gpt-4", &HashMap::new(), &|_| Some("t".into()), &acme_lookup).unwrap_err();
        assert!(err.contains("gpt-4"));
        assert!(build_node_env("acme-large", &HashMap::new(), &|_| Some("t".into()), &no_gateway).is_err());
    }

    #[test]
    fn no_inherited_env_value_ever_appears_in_the_plan() {
        let inherited = env_with(&[("ANTHROPIC_API_KEY", "sk-should-never-leak")]);
        let plan = build_node_env("claude-sonnet-5", &inherited, &|_| None, &no_gateway).unwrap();
        for name in &plan.remove {
            assert_ne!(name, "sk-should-never-leak");
        }
        for (_, v) in &plan.set {
            assert_ne!(v, "sk-should-never-leak");
        }
    }

    #[test]
    fn scrub_match_is_case_insensitive() {
        // Windows env names are case-insensitive; a mixed-case variant
        // of either matched shape must scrub the same as the canonical name.
        let inherited = env_with(&[("Anthropic_Api_Key", "x"), ("acme_api_key", "y")]);
        let plan = build_node_env("claude-sonnet-5", &inherited, &|_| None, &no_gateway).unwrap();
        assert!(plan.remove.iter().any(|r| r == "Anthropic_Api_Key"));
        assert!(plan.remove.iter().any(|r| r == "acme_api_key"));
    }

    #[test]
    fn no_inherited_secret_leaks_via_err_or_payload_across_every_path() {
        // Exercise every Err-producing path (unknown model,
        // vendor missing its registry key) plus a representative emitted payload,
        // not just the Ok/Claude path the older test above covers.
        let inherited_secret = "sk-inherited-should-never-leak";
        let vendor_token = "ds-token-from-registry";
        let inherited = env_with(&[
            ("ANTHROPIC_API_KEY", inherited_secret),
            ("ACME_API_KEY", inherited_secret),
        ]);

        let unknown = build_node_env("gpt-4", &inherited, &|_| None, &acme_lookup).unwrap_err();
        assert!(!unknown.contains(inherited_secret));

        let missing_key = build_node_env("acme-large", &inherited, &|_| None, &acme_lookup).unwrap_err();
        assert!(!missing_key.contains(inherited_secret));

        let plan = build_node_env(
            "acme-large",
            &inherited,
            &|_| Some(vendor_token.to_string()),
            &acme_lookup,
        )
        .unwrap();
        let plan_debug = format!("{plan:?}");
        assert!(
            !plan_debug.contains(inherited_secret),
            "inherited secret leaked into the env plan: {plan_debug}"
        );
        assert!(
            plan_debug.contains(vendor_token),
            "sanity: the vendor's own registry token should still be set"
        );

        let payload = FlowNodeEventPayload {
            run_id: "r".into(),
            node_id: "n".into(),
            attempt: 1,
            status: FlowRunNodeStatus::Error,
            text: None,
            cost_usd: None,
            error: Some(missing_key.clone()),
            permission: None,
            output_file: None,
        };
        let payload_json = serde_json::to_string(&payload).unwrap();
        assert!(!payload_json.contains(inherited_secret));
    }

    #[test]
    fn env_plan_application_order_lets_vendor_values_survive_the_scrub() {
        // Applies the plan to a real `Command` the same
        // way `spawn_sidecar` does (remove-then-set) and reads back the *final*
        // env via `get_envs()` — proves the order, not just the plan's two lists,
        // which would stay green even if `spawn_sidecar` applied them reversed.
        let inherited = env_with(&[("ANTHROPIC_BASE_URL", "https://stale.example")]);
        let plan = build_node_env(
            "acme-large",
            &inherited,
            &|name| (name == "ACME_API_KEY").then(|| "acme-token".to_string()),
            &acme_lookup,
        )
        .unwrap();
        assert!(plan.remove.iter().any(|r| r == "ANTHROPIC_BASE_URL"));

        let mut cmd = Command::new("node");
        apply_env_plan(&mut cmd, &plan);
        let get = |k: &str| {
            cmd.get_envs()
                .find(|(kk, _)| kk.to_str() == Some(k))
                .and_then(|(_, v)| v)
                .map(|v| v.to_string_lossy().into_owned())
        };
        assert_eq!(get("ANTHROPIC_BASE_URL").as_deref(), Some("https://api.acme.example/anthropic"));
        assert_eq!(get("ANTHROPIC_AUTH_TOKEN").as_deref(), Some("acme-token"));
    }
}
