//! src-tauri\src\voice_slots\write.rs — the one writer of `voiceSlots.rewrite` (Settings › Audio
//! Speak Rewrite row). The pick is validated through `check_pick`, the rule set `resolve_named`
//! runs, so a write and a resolve cannot disagree; it is then merged into vidar.json through
//! `with_config_root` (every other key, `voiceSlots.tts` included, stays). A pick that is valid
//! but resolves broken at runtime (the CLI not on PATH) is still written: the slot's status
//! row reports it.

use std::path::Path;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter};

use super::{check_pick, manifest, pick, Ctx, Slot, SlotStatus};

/// Validates `value` as the rewrite slot's pick, then writes it (`None` removes it).
fn apply(ctx: &Ctx, config: &Path, slot: &str, value: Option<Value>) -> Result<(), String> {
    if slot != Slot::Rewrite.as_str() {
        return Err("Only the Rewrite Slot Can Be Picked Here".into());
    }
    let stored = match value {
        None | Some(Value::Null) => None,
        Some(v) => {
            // The resolver's own parser: unknown keys, non-strings and a missing adapter fail here.
            let raw = json!({ "voiceSlots": { "rewrite": v } });
            let p = pick(&raw, Slot::Rewrite).map_err(|e| e.to_string())?.ok_or("Expected an Object")?;
            let super::PickKind::Named(id) = &p.kind else { return Err("Expected a Named Adapter".into()) };
            let scan = manifest::scan(&ctx.packs);
            let a = match scan.adapters.iter().find(|a| &a.qid() == id) {
                Some(a) => a,
                None => {
                    let reason = match (scan.broken.iter().find(|b| b.adapter.as_deref() == Some(id)), &scan.packs_error) {
                        (Some(b), _) => b.reason.clone(),
                        (None, Some(e)) => e.clone(),
                        (None, None) => format!("Unknown Pick: {id}"),
                    };
                    return Err(format!("{id}: {reason}"));
                }
            };
            if a.slot != Slot::Rewrite {
                return Err(format!("{id}: {id} Is a {} Adapter", a.slot.as_str()));
            }
            check_pick(a, p.model.as_deref(), p.effort.as_deref()).map_err(|(_, reason)| format!("{id}: {reason}"))?;
            let mut o = Map::new();
            o.insert("adapter".into(), Value::String(id.clone()));
            if let Some(m) = &p.model {
                o.insert("model".into(), Value::String(m.clone()));
            }
            if let Some(e) = &p.effort {
                o.insert("effort".into(), Value::String(e.clone()));
            }
            Some(Value::Object(o))
        }
    };
    crate::settings::store::with_config_root_at(config, |obj| {
        match stored {
            Some(v) => {
                let slots = obj.entry("voiceSlots").or_insert_with(|| Value::Object(Map::new()));
                let slots = slots.as_object_mut().ok_or("vidar.json `voiceSlots` is not an object")?;
                slots.insert("rewrite".into(), v);
            }
            None => {
                match obj.get_mut("voiceSlots") {
                    None | Some(Value::Null) => {}
                    Some(Value::Object(slots)) => {
                        slots.remove("rewrite");
                    }
                    Some(_) => return Err("vidar.json `voiceSlots` is not an object".into()),
                }
                obj.remove("speakRewrite");
            }
        }
        Ok(())
    })
}

/// Settings › Audio Speak Rewrite: sets (`Some`) or clears (`None`) the rewrite pick, emits
/// `settings-changed`, and returns the slot's fresh status. Any other slot is refused.
#[tauri::command]
pub async fn voice_slots_pick(app: AppHandle, slot: String, pick: Option<Value>) -> Result<SlotStatus, String> {
    let status = tauri::async_runtime::spawn_blocking(move || {
        apply(&Ctx::live(), &crate::paths::config_path(), &slot, pick)?;
        Ok::<_, String>(super::status_one(Slot::Rewrite))
    })
    .await
    .map_err(|e| e.to_string())??;
    // Best-effort, like `patch_settings`: the file is already correct.
    let _ = app.emit("settings-changed", json!({ "keys": ["voiceSlots"], "tier": "config" }));
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vidar-voice-slots-write-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A pack with an effort adapter, a plain rewrite adapter and a tts adapter.
    fn ctx(root: &Path) -> Ctx {
        let pack = root.join("packs").join("t");
        put(&pack.join("pack.json"), &json!({ "id": "t", "version": 1, "slots": { "rewrite": ["voice/eff.json", "voice/plain.json"], "tts": ["voice/say.json"] } }).to_string());
        let rewrite = |id: &str, args: Value, extra: Value| {
            let mut m = json!({ "version": 1, "id": id, "slot": "rewrite", "label": "T", "run": { "command": "{pack}/x.exe", "args": args } });
            m.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            m.to_string()
        };
        put(&pack.join("voice").join("eff.json"), &rewrite("eff", json!(["--model", "{model}", "--effort", "{effort}"]), json!({ "modelIds": true, "efforts": ["low", "high"], "suggestedModels": [{ "id": "m-1", "label": "M One" }] })));
        put(&pack.join("voice").join("plain.json"), &rewrite("plain", json!(["--model", "{model}"]), json!({ "modelIds": true })));
        put(&pack.join("voice").join("say.json"), &json!({ "version": 1, "id": "say", "slot": "tts", "label": "S", "run": { "command": "{pack}/x.exe" } }).to_string());
        Ctx { vidar: root.to_path_buf(), packs: root.join("packs"), home: None, pins: root.join("pins.json"), raw: Ok(json!({})), origin: "http://127.0.0.1:1234".into() }
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn voice_slots_write_merges_and_keeps_tts_and_unrelated_keys() {
        let root = temp("merge");
        let (c, cfg) = (ctx(&root), root.join("vidar.json"));
        put(&cfg, &json!({ "fontSize": 14, "voiceSlots": { "tts": { "adapter": "t/say" } } }).to_string());
        apply(&c, &cfg, "rewrite", Some(json!({ "adapter": "t/eff", "model": " m-1 ", "effort": "high" }))).expect("a valid pick writes");
        let v = read(&cfg);
        assert_eq!(v["fontSize"], 14);
        assert_eq!(v["voiceSlots"]["tts"], json!({ "adapter": "t/say" }));
        assert_eq!(v["voiceSlots"]["rewrite"], json!({ "adapter": "t/eff", "model": "m-1", "effort": "high" }));
        // What was written resolves through the same parser.
        let p = pick(&v, Slot::Rewrite).unwrap().unwrap();
        assert_eq!((p.model.as_deref(), p.effort.as_deref()), (Some("m-1"), Some("high")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn voice_slots_write_none_removes_rewrite_and_the_retired_key() {
        let root = temp("none");
        let (c, cfg) = (ctx(&root), root.join("vidar.json"));
        put(&cfg, &json!({ "speakRewrite": "acme", "fontSize": 14, "voiceSlots": { "tts": { "adapter": "t/say" }, "rewrite": { "adapter": "t/eff", "model": "m-1", "effort": "low" } } }).to_string());
        apply(&c, &cfg, "rewrite", None).expect("None clears");
        let v = read(&cfg);
        assert!(v.get("speakRewrite").is_none());
        assert!(v["voiceSlots"].get("rewrite").is_none());
        assert_eq!(v["voiceSlots"]["tts"], json!({ "adapter": "t/say" }));
        assert_eq!(v["fontSize"], 14);
        // JSON null is the same as None, and a config with no voiceSlots stays without one.
        put(&cfg, &json!({ "fontSize": 14 }).to_string());
        apply(&c, &cfg, "rewrite", Some(Value::Null)).expect("null clears");
        assert_eq!(read(&cfg), json!({ "fontSize": 14 }));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn voice_slots_write_refuses_other_slots_and_bad_picks_without_touching_the_file() {
        let root = temp("refuse");
        let (c, cfg) = (ctx(&root), root.join("vidar.json"));
        let before = json!({ "voiceSlots": { "tts": { "adapter": "t/say" } } });
        put(&cfg, &before.to_string());
        let err = |slot: &str, v: Value| apply(&c, &cfg, slot, Some(v)).expect_err("must refuse");
        assert_eq!(err("tts", json!({ "adapter": "t/say" })), "Only the Rewrite Slot Can Be Picked Here");
        assert_eq!(apply(&c, &cfg, "stt", None).unwrap_err(), "Only the Rewrite Slot Can Be Picked Here");
        assert!(err("rewrite", json!({ "adapter": "t/eff", "model": "m-1" })).contains("No Effort Picked"));
        assert!(err("rewrite", json!({ "adapter": "t/eff", "model": "m-1", "effort": "max" })).contains("Effort Not Listed: max"));
        for flag in ["--x", "-x"] {
            assert!(err("rewrite", json!({ "adapter": "t/eff", "model": "m-1", "effort": flag })).contains("Bad Effort"), "{flag}");
            assert!(err("rewrite", json!({ "adapter": "t/eff", "model": flag, "effort": "low" })).contains("Bad Model Id"), "{flag}");
        }
        assert!(err("rewrite", json!({ "adapter": "t/plain", "model": "m-1", "effort": "low" })).contains("Adapter Takes No Effort"));
        assert!(err("rewrite", json!({ "adapter": "t/say" })).contains("Is a tts Adapter"));
        assert!(err("rewrite", json!({ "adapter": "t/nope" })).contains("Unknown Pick: t/nope"));
        assert!(err("rewrite", json!({ "adapter": "t/eff", "extra": 1 })).contains("Expected"));
        assert_eq!(read(&cfg), before);
        let _ = std::fs::remove_dir_all(&root);
    }
}
