//! The result a hosted Codex card's answer carries, built from the request's
//! own params and the view's decision (`permission_response`): a port of
//! `src/agents/codex-requests.ts` `answer()`, so a hosted card answers the
//! wire exactly as an in-process one would. A form cannot widen a grant: an
//! allowed permissions card grants what was asked, a question answers only
//! the questions asked, and an elicitation form is accepted only with
//! content that fits its schema.
//!
//! A deny is the card's contract `refusal` (`contracts/codex-server-requests.json`),
//! which the drift test validates against the pinned schema; the unattended
//! deny takes the same path.

use super::requests::{contract, Disposition};
use serde_json::{json, Map, Value};

const FORM_MODES: [&str; 3] = ["form", "openai/form", "openaiForm"];
/// The form answer's field, as a pointer: the paths-contract scan reads a
/// bare quoted field name as the layout dir of that name.
const CONTENT: &str = "/content";

/// Why an allowed form answer was refused (`result`).
pub const FORM_MISFIT: &str =
    "the form answer is missing a required field or has a value that does not fit; \
     the card stays open";

fn content_key() -> String {
    CONTENT[1..].to_string()
}

/// The deny answer for a card method: its contract refusal.
pub fn deny(method: &str) -> Option<Value> {
    contract()["requests"]
        .get(method)
        .filter(|entry| entry["disposition"] == "card")
        .and_then(|entry| entry.get("refusal"))
        .cloned()
}

/// Whether `method` is drawn as a card (the table's `card` rows).
pub fn is_card(method: &str) -> bool {
    super::requests::disposition(method) == Disposition::Card
}

/// The result for card `method` with request `params` and the view's
/// `decision` (`{behavior: "allow", updatedInput?}` or `{behavior: "deny",
/// message?}`). `Err` for a method that is not a card, and for an allowed
/// elicitation form whose content does not fit it: sending that as a decline
/// would tell the MCP server no while the user asked for yes, so the answer
/// is refused with the reason and the card stays open for a corrected one.
pub fn result(method: &str, params: &Value, decision: &Value) -> Result<Value, String> {
    let not_a_card = || format!("{method} cannot be answered");
    if !is_card(method) {
        return Err(not_a_card());
    }
    let allow = decision.get("behavior").and_then(Value::as_str) == Some("allow");
    if !allow {
        return deny(method).ok_or_else(not_a_card);
    }
    let updated = decision.get("updatedInput").unwrap_or(&Value::Null);
    Ok(match method {
        "item/tool/requestUserInput" => {
            let provided = obj(updated.get("answers"));
            let mut answers = Map::new();
            for question in &arr(params.get("questions")) {
                let id = str(question.get("id"));
                // The shared single-select form returns a string; labels are
                // never split on commas.
                if let Some(answer) = provided.get(id).and_then(Value::as_str) {
                    if !id.is_empty() && !answer.trim().is_empty() {
                        answers.insert(id.into(), json!({ "answers": [answer] }));
                    }
                }
            }
            json!({ "answers": answers })
        }
        "item/permissions/requestApproval" => {
            json!({ "permissions": obj(params.get("permissions")), "scope": "turn" })
        }
        "mcpServer/elicitation/request" => {
            let content = form_content(params, updated);
            if content.is_none() && supported_form(params) {
                return Err(FORM_MISFIT.into());
            }
            if str(params.get("mode")) == "url" || content.is_some() {
                let mut accepted = json!({ "action": "accept" });
                if let Some(content) = content {
                    accepted[content_key()] = Value::Object(content);
                }
                accepted
            } else {
                json!({ "action": "decline" })
            }
        }
        _ => json!({ "decision": "accept" }),
    })
}

fn obj(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn arr(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn str(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn is_object(value: Option<&Value>) -> bool {
    value.is_some_and(Value::is_object)
}

fn has_enum(schema: &Map<String, Value>) -> bool {
    let items = obj(schema.get("items"));
    schema.get("enum").is_some_and(Value::is_array)
        || schema.get("oneOf").is_some_and(Value::is_array)
        || items.get("enum").is_some_and(Value::is_array)
        || items.get("anyOf").is_some_and(Value::is_array)
}

/// `enumValues` in `codex-requests.ts`; a `oneOf`/`anyOf` option with no
/// `const` reads as `null`, which no type check below accepts.
fn enum_values(schema: &Map<String, Value>) -> Vec<Value> {
    let consts = |options: &Vec<Value>| -> Vec<Value> {
        options
            .iter()
            .map(|option| option.get("const").cloned().unwrap_or(Value::Null))
            .collect()
    };
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values.clone();
    }
    if let Some(options) = schema.get("oneOf").and_then(Value::as_array) {
        return consts(options);
    }
    let items = obj(schema.get("items"));
    if let Some(values) = items.get("enum").and_then(Value::as_array) {
        return values.clone();
    }
    if let Some(options) = items.get("anyOf").and_then(Value::as_array) {
        return consts(options);
    }
    Vec::new()
}

fn supported_field(schema: &Map<String, Value>) -> bool {
    let choices = enum_values(schema);
    let kind = str(schema.get("type"));
    if kind == "array" {
        return has_enum(schema) && !choices.is_empty() && choices.iter().all(Value::is_string);
    }
    if !["string", "boolean", "integer", "number"].contains(&kind) {
        return false;
    }
    if !has_enum(schema) {
        return true;
    }
    !choices.is_empty()
        && choices.iter().all(|value| match kind {
            "string" => value.is_string(),
            "boolean" => false,
            _ => value.is_number(),
        })
}

fn supported_form(params: &Value) -> bool {
    if !FORM_MODES.contains(&str(params.get("mode"))) {
        return false;
    }
    let schema = obj(params.get("requestedSchema"));
    let properties = obj(schema.get("properties"));
    is_object(params.get("requestedSchema"))
        && schema.get("type").and_then(Value::as_str) == Some("object")
        && is_object(schema.get("properties"))
        && arr(schema.get("required")).iter().all(|field| {
            field
                .as_str()
                .is_some_and(|field| properties.contains_key(field))
        })
        && properties
            .values()
            .all(|field| supported_field(&obj(Some(field))))
}

/// JavaScript's `includes` on numbers compares values, not representations.
fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => a == b,
        _ => a == b,
    }
}

fn number(schema: &Map<String, Value>, key: &str, default: f64) -> f64 {
    schema.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn valid_value(schema: &Map<String, Value>, value: &Value) -> bool {
    let kind = str(schema.get("type"));
    if has_enum(schema) {
        let choices = enum_values(schema);
        if kind == "array" {
            let Some(items) = value.as_array() else {
                return false;
            };
            let length = items.len() as f64;
            return length >= number(schema, "minItems", 0.0)
                && length <= number(schema, "maxItems", f64::INFINITY)
                && items.iter().all(|item| {
                    item.is_string() && choices.iter().any(|choice| same(choice, item))
                });
        }
        let typed = if kind == "string" {
            value.is_string()
        } else {
            value.is_number()
        };
        return typed && choices.iter().any(|choice| same(choice, value));
    }
    match kind {
        "string" => value.as_str().is_some_and(|text| {
            // JavaScript string length counts UTF-16 code units.
            let length = text.encode_utf16().count() as f64;
            length >= number(schema, "minLength", 0.0)
                && length <= number(schema, "maxLength", f64::INFINITY)
        }),
        "boolean" => value.is_boolean(),
        "integer" | "number" => value.as_f64().is_some_and(|number_value| {
            (kind == "number" || number_value.fract() == 0.0)
                && number_value.is_finite()
                && number_value >= number(schema, "minimum", f64::NEG_INFINITY)
                && number_value <= number(schema, "maximum", f64::INFINITY)
        }),
        _ => false,
    }
}

/// `formContent` in `codex-requests.ts`: the supplied fields that the form
/// declares, or `None` when the form is unsupported, a required field is
/// missing, or any declared field's value does not fit.
fn form_content(params: &Value, updated: &Value) -> Option<Map<String, Value>> {
    if !supported_form(params) {
        return None;
    }
    let supplied = updated.pointer(CONTENT).and_then(Value::as_object)?;
    let schema = obj(params.get("requestedSchema"));
    let properties = obj(schema.get("properties"));
    let required = arr(schema.get("required"));
    if !required
        .iter()
        .filter_map(Value::as_str)
        .all(|field| supplied.contains_key(field))
    {
        return None;
    }
    let mut content = Map::new();
    for (field, value) in supplied {
        let Some(field_schema) = properties.get(field) else {
            continue;
        };
        if !valid_value(&obj(Some(field_schema)), value) {
            return None;
        }
        content.insert(field.clone(), value.clone());
    }
    Some(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow(input: Value) -> Value {
        json!({ "behavior": "allow", "updatedInput": input })
    }

    fn deny_decision() -> Value {
        json!({ "behavior": "deny", "message": "no" })
    }

    /// `base` with the form's content field (no bare literal; see `CONTENT`).
    fn with_content(mut base: Value, content: Value) -> Value {
        base[content_key()] = content;
        base
    }

    /// Allow and deny for each card match what the in-process adapter writes
    /// (`codex-requests.ts` `answer()`; the drift test's fixtures).
    #[test]
    fn each_card_answers_as_the_in_process_adapter_does() {
        let command = "item/commandExecution/requestApproval";
        let file = "item/fileChange/requestApproval";
        for method in [command, file] {
            assert_eq!(
                result(method, &json!({}), &allow(Value::Null)),
                Ok(json!({ "decision": "accept" }))
            );
            assert_eq!(
                result(method, &json!({}), &deny_decision()),
                Ok(json!({ "decision": "decline" }))
            );
        }
        let permissions = "item/permissions/requestApproval";
        let params = json!({ "permissions": { "network": { "enabled": true } } });
        assert_eq!(
            result(
                permissions,
                &params,
                &allow(json!({ "permissions": { "fs": {} } }))
            ),
            Ok(json!({ "permissions": { "network": { "enabled": true } }, "scope": "turn" })),
            "an allow grants what was asked, never what the form sent"
        );
        assert_eq!(
            result(permissions, &params, &deny_decision()),
            Ok(json!({ "permissions": {}, "scope": "turn" }))
        );
        let question = "item/tool/requestUserInput";
        let params = json!({ "questions": [{ "id": "q1" }, { "id": "q2" }, { "id": "" }] });
        assert_eq!(
            result(
                question,
                &params,
                &allow(json!({ "answers": { "q1": "Yes, a, b", "q2": "  ", "q9": "No" } }))
            ),
            Ok(json!({ "answers": { "q1": { "answers": ["Yes, a, b"] } } }))
        );
        assert_eq!(
            result(question, &params, &deny_decision()),
            Ok(json!({ "answers": {} }))
        );
        assert!(result("item/tool/call", &json!({}), &deny_decision()).is_err());
        assert!(result("future/thing", &json!({}), &deny_decision()).is_err());
    }

    #[test]
    fn an_elicitation_accepts_only_content_that_fits_its_form() {
        let method = "mcpServer/elicitation/request";
        let form = json!({
            "mode": "form",
            "requestedSchema": {
                "type": "object",
                "required": ["name"],
                "properties": {
                    "name": { "type": "string", "maxLength": 4 },
                    "count": { "type": "integer", "minimum": 1 },
                    "colour": { "type": "string", "enum": ["red", "blue"] },
                    "tags": { "type": "array", "items": { "enum": ["a", "b"] }, "maxItems": 2 }
                }
            }
        });
        assert_eq!(
            result(
                method,
                &form,
                &allow(with_content(
                    json!({}),
                    json!({ "name": "abc", "count": 2, "colour": "red", "tags": ["a"], "extra": true })
                ))
            ),
            Ok(with_content(
                json!({ "action": "accept" }),
                json!({ "name": "abc", "count": 2, "colour": "red", "tags": ["a"] })
            )),
            "undeclared fields are dropped"
        );
        for bad in [
            json!({ "count": 2 }),
            json!({ "name": "abcde" }),
            json!({ "name": "a", "count": 1.5 }),
            json!({ "name": "a", "count": 0 }),
            json!({ "name": "a", "colour": "green" }),
            json!({ "name": "a", "tags": ["a", "b", "a"] }),
            json!({ "name": "a", "tags": ["c"] }),
        ] {
            assert_eq!(
                result(method, &form, &allow(with_content(json!({}), bad.clone()))),
                Err(FORM_MISFIT.into()),
                "an allow that does not fit is refused, never sent as a decline: {bad}"
            );
        }
        assert_eq!(
            result(method, &form, &allow(json!({}))),
            Err(FORM_MISFIT.into()),
            "no content, no accept"
        );
        assert_eq!(
            result(method, &form, &deny_decision()),
            Ok(json!({ "action": "decline" })),
            "a deny still declines"
        );
        assert_eq!(
            result(method, &json!({ "mode": "url" }), &allow(Value::Null)),
            Ok(json!({ "action": "accept" }))
        );
        assert_eq!(
            result(
                method,
                &json!({ "mode": "openai/userVerification" }),
                &allow(Value::Null)
            ),
            Ok(json!({ "action": "decline" }))
        );
        let unsupported = json!({
            "mode": "form",
            "requestedSchema": { "type": "object", "properties": { "f": { "type": "object" } } }
        });
        assert_eq!(
            result(
                method,
                &unsupported,
                &allow(with_content(json!({}), json!({ "f": {} })))
            ),
            Ok(json!({ "action": "decline" }))
        );
        assert_eq!(
            result(method, &json!({ "mode": "url" }), &deny_decision()),
            Ok(json!({ "action": "decline" }))
        );
    }

    #[test]
    fn every_card_has_a_contract_deny() {
        for (method, entry) in contract()["requests"].as_object().unwrap() {
            if entry["disposition"] == "card" {
                assert!(deny(method).is_some(), "{method} has no deny refusal");
            }
        }
    }
}
