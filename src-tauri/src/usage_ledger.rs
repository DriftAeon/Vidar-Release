//! src-tauri\src\usage_ledger.rs — one JSON line per finished agent call, appended to the file of
//! `contracts/paths.json` id `usageLedger` (`usage-ledger.jsonl` under the state folder). It records the calls that leave no transcript (rune generation runs
//! `--no-session-persistence`) and, with `transcript`, the ones that do, so `tools/usage/window-report.mjs` can
//! account for every call a 5H window paid for. The Falcon sidecar writes the `falcon` lines itself
//! (`tools/claude-sidecar-ledger.mjs`, same shape).
//! - `ledger_line` is pure; `append` opens the file for append and issues one `write` per line.
//! - A write failure is logged with `eprintln!` and never reaches the caller: the run it describes already finished.

use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// One finished agent call.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Entry {
    /// `rune-gen`, `flow` or `falcon`.
    pub source: &'static str,
    pub sid: Option<String>,
    pub model: Option<String>,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: Option<f64>,
    /// Whether the call also leaves a transcript under a `projects` folder.
    pub transcript: bool,
}

/// The ledger line (no trailing newline) for `entry` finished at `ts` (ISO 8601, UTC).
pub fn ledger_line(ts: &str, entry: &Entry) -> String {
    json!({
        "ts": ts,
        "source": entry.source,
        "sid": entry.sid,
        "model": entry.model,
        "in": entry.input,
        "out": entry.output,
        "cacheRead": entry.cache_read,
        "cacheWrite": entry.cache_write,
        "costUsd": entry.cost_usd,
        "transcript": entry.transcript,
    })
    .to_string()
}

/// `2026-10-18T12:34:56.789Z` for `ms` since the Unix epoch (civil-from-days, proleptic Gregorian).
pub fn iso_from_ms(ms: u64) -> String {
    let (secs, milli) = (ms / 1000, ms % 1000);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{milli:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn now_iso() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    iso_from_ms(ms)
}

/// Appends one line for `entry` to `path` (created with its folder when absent). Never fails the caller.
pub fn append(path: &Path, entry: &Entry) {
    if let Err(e) = try_append(path, entry) {
        eprintln!("usage ledger: write to {} failed: {e}", path.display());
    }
}

fn try_append(path: &Path, entry: &Entry) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut line = ledger_line(&now_iso(), entry);
    line.push('\n');
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())
}

fn count(v: Option<&Value>, key: &str) -> u64 {
    v.and_then(|u| u.get(key)).and_then(Value::as_u64).unwrap_or(0)
}

/// The entry for a Claude `result` object (the CLI's `--output-format json` reply and the SDK's `result` message
/// share this shape): `usage`, `total_cost_usd`, `session_id` and the model with the largest cost in `modelUsage`,
/// else `fallback_model`.
pub fn from_claude_result(result: &Value, source: &'static str, transcript: bool, fallback_model: Option<&str>) -> Entry {
    let usage = result.get("usage");
    let model = result
        .get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|m| {
            m.iter()
                .max_by(|a, b| {
                    let cost = |v: &Value| v.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0);
                    cost(a.1).partial_cmp(&cost(b.1)).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(k, _)| k.clone())
        })
        .or_else(|| fallback_model.map(str::to_string));
    Entry {
        source,
        sid: result.get("session_id").and_then(Value::as_str).map(str::to_string),
        model,
        input: count(usage, "input_tokens"),
        output: count(usage, "output_tokens"),
        cache_read: count(usage, "cache_read_input_tokens"),
        cache_write: count(usage, "cache_creation_input_tokens"),
        cost_usd: result.get("total_cost_usd").and_then(Value::as_f64),
        transcript,
    }
}

/// The entry for a finished rune-generation call from the child's stdout: Claude's one JSON object, or Codex's
/// JSONL (`turn.completed.usage`; Codex counts cached tokens inside `input_tokens`, so they are split out here;
/// no cost). `None` when the output carries no usage object.
pub fn from_rune_gen(agent: &str, stdout: &[u8], model: &str) -> Option<Entry> {
    let out = String::from_utf8_lossy(stdout);
    match crate::agent_spec::parse(agent)? {
        crate::agent_spec::Agent::Claude => {
            let json: Value = serde_json::from_str(out.trim()).ok().filter(Value::is_object)?;
            Some(from_claude_result(&json, "rune-gen", false, Some(model)))
        }
        crate::agent_spec::Agent::Codex => codex_rune_gen(&out, model),
    }
}

fn codex_rune_gen(out: &str, model: &str) -> Option<Entry> {
    let usage = out
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|e| e.get("type").and_then(Value::as_str) == Some("turn.completed"))
        .last()?
        .get("usage")
        .cloned();
    let usage = usage.as_ref();
    let cached = count(usage, "cached_input_tokens");
    Some(Entry {
        source: "rune-gen",
        sid: None,
        model: Some(model.to_string()),
        input: count(usage, "input_tokens").saturating_sub(cached),
        output: count(usage, "output_tokens"),
        cache_read: cached,
        cache_write: 0,
        cost_usd: None,
        transcript: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Entry {
        Entry {
            source: "rune-gen",
            sid: Some("abc".into()),
            model: Some("claude-opus-4-7".into()),
            input: 10,
            output: 20,
            cache_read: 30,
            cache_write: 40,
            cost_usd: Some(0.5),
            transcript: false,
        }
    }

    #[test]
    fn the_line_carries_every_field_in_order() {
        assert_eq!(
            ledger_line("2026-10-18T00:00:00.000Z", &sample()),
            r#"{"ts":"2026-10-18T00:00:00.000Z","source":"rune-gen","sid":"abc","model":"claude-opus-4-7","in":10,"out":20,"cacheRead":30,"cacheWrite":40,"costUsd":0.5,"transcript":false}"#
        );
    }

    #[test]
    fn unknown_values_are_null() {
        let line = ledger_line("t", &Entry { source: "flow", transcript: true, ..Entry::default() });
        let v: Value = serde_json::from_str(&line).unwrap();
        assert!(v["sid"].is_null() && v["model"].is_null() && v["costUsd"].is_null());
        assert_eq!(v["transcript"], true);
        assert_eq!(v["in"], 0);
    }

    #[test]
    fn iso_formats_known_instants() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(951_782_400_000 + 86_399_999), "2000-02-29T23:59:59.999Z");
        assert_eq!(iso_from_ms(1_792_326_896_789), "2026-10-18T12:34:56.789Z");
    }

    #[test]
    fn claude_result_maps_usage_cost_session_and_dominant_model() {
        let r: Value = serde_json::from_str(
            r#"{"type":"result","session_id":"s1","total_cost_usd":1.25,
                "usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4},
                "modelUsage":{"claude-haiku-4-5":{"costUSD":0.01},"claude-opus-4-7":{"costUSD":1.2}}}"#,
        )
        .unwrap();
        let e = from_claude_result(&r, "flow", true, Some("fallback"));
        assert_eq!(
            e,
            Entry {
                source: "flow",
                sid: Some("s1".into()),
                model: Some("claude-opus-4-7".into()),
                input: 1,
                output: 2,
                cache_read: 3,
                cache_write: 4,
                cost_usd: Some(1.25),
                transcript: true
            }
        );
    }

    #[test]
    fn claude_result_without_model_usage_takes_the_fallback() {
        let r: Value = serde_json::from_str(r#"{"usage":{"input_tokens":5}}"#).unwrap();
        let e = from_claude_result(&r, "rune-gen", false, Some("opus"));
        assert_eq!((e.model.as_deref(), e.input, e.cost_usd, e.sid), (Some("opus"), 5, None, None));
    }

    #[test]
    fn rune_gen_reads_codex_turn_completed_and_splits_cached_input() {
        let out = "{\"type\":\"thread.started\"}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":100,\"cached_input_tokens\":60,\"output_tokens\":7}}\n";
        let e = from_rune_gen("codex", out.as_bytes(), "gpt-x").unwrap();
        assert_eq!((e.input, e.cache_read, e.output, e.cost_usd, e.transcript), (40, 60, 7, None, false));
        assert!(from_rune_gen("codex", b"{\"type\":\"error\"}\n", "gpt-x").is_none());
        assert!(from_rune_gen("claude", b"not json", "opus").is_none());
    }

    #[test]
    fn append_writes_one_line_per_call_and_never_panics_on_failure() {
        let dir = std::env::temp_dir().join(format!("vidar-ledger-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("nested").join("usage-ledger.jsonl");
        append(&file, &sample());
        append(&file, &Entry { source: "flow", ..Entry::default() });
        let text = std::fs::read_to_string(&file).unwrap();
        let rows: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["source"], "rune-gen");
        assert_eq!(rows[1]["source"], "flow");
        // a path whose parent is a file cannot be created: logged, not raised
        append(&file.join("nested").join("x.jsonl"), &sample());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
