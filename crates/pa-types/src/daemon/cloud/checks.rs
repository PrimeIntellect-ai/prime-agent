//! Shared runtime-check helpers for the cloud wire validators (TS
//! `protocol.ts` `expect*`/`optional*` helpers): exact problem strings,
//! exact check order. String bounds count UTF-16 code units (TS `.length`
//! semantics; astral characters count as two), integers check with JS
//! `Number.isInteger` semantics over the parsed `f64` (so `1.0` and `1e0`
//! are integers), and field presence walks keys in `Object.keys` order, so
//! an id valid here is valid in TS and vice versa.

use serde_json::Value;

pub(super) fn first_problem<const N: usize>(problems: [Option<String>; N]) -> Option<String> {
    problems.into_iter().flatten().next()
}

pub(super) fn expect_fields(value: &Value, fields: &[&str]) -> Option<String> {
    let map = value.as_object()?;
    // TS `expectFields` walks `Object.keys`, which yields array-index keys
    // ("0".."4294967294") ascending first and the rest in insertion order.
    // The allowed field names are never array indices, so the smallest
    // array index wins over any later insertion-order key.
    let mut smallest_index: Option<u32> = None;
    for key in map.keys() {
        if let Some(index) = js_array_index(key) {
            smallest_index = Some(smallest_index.map_or(index, |prev| prev.min(index)));
        }
    }
    if let Some(index) = smallest_index {
        return Some(format!("unexpected field: {index}"));
    }
    map.keys()
        .find(|key| !fields.contains(&key.as_str()))
        .map(|key| format!("unexpected field: {key}"))
}

/// One canonical JavaScript array-index property key: decimal digits, no
/// leading zeros, `0..=4294967294` (the keys `Object.keys` orders
/// numerically; anything else is a plain string key).
fn js_array_index(key: &str) -> Option<u32> {
    let index: u32 = key.parse().ok()?;
    if index < u32::MAX && index.to_string() == key {
        return Some(index);
    }
    None
}

pub(super) fn expect_string(
    value: Option<&Value>,
    label: &str,
    max_length: usize,
    min_length: usize,
) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(text)
            if string_utf16_units(text) >= min_length && string_utf16_units(text) <= max_length =>
        {
            None
        }
        _ => Some(format!(
            "{label} must be a string of {min_length}-{max_length} characters"
        )),
    }
}

pub(super) fn optional_string(
    value: Option<&Value>,
    label: &str,
    max_length: usize,
) -> Option<String> {
    match value {
        None => None,
        Some(Value::String(text)) if !text.is_empty() && string_utf16_units(text) <= max_length => {
            None
        }
        _ => Some(format!(
            "{label} must be a string of 1-{max_length} characters when present"
        )),
    }
}

/// TS `expectInteger`: `Number.isInteger` over the parsed `f64`, so the
/// valid JS spellings (`1.0`, `1e0`, integers beyond i64 or 2^53) pass
/// exactly as they do through `JSON.parse`.
#[allow(clippy::cast_precision_loss)] // the 0/1 bounds are exact in f64
pub(super) fn expect_integer(value: Option<&Value>, label: &str, minimum: i64) -> Option<String> {
    match value.and_then(Value::as_f64) {
        Some(number) if super::js_number::is_js_integer(number) && number >= minimum as f64 => None,
        _ => Some(format!("{label} must be an integer of at least {minimum}")),
    }
}

pub(super) fn expect_one_of(value: Option<&Value>, label: &str, allowed: &str) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(text) if allowed.split(", ").any(|item| item == text) => None,
        _ => Some(format!("{label} must be one of {allowed}")),
    }
}

/// TS `.length`: UTF-16 code units (astral characters count as two).
pub(super) fn string_utf16_units(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(super) fn record_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

/// TS inline `typeof value === "boolean"` checks.
pub(super) fn expect_boolean(value: Option<&Value>, label: &str) -> Option<String> {
    match value.and_then(Value::as_bool) {
        Some(_) => None,
        None => Some(format!("{label} must be a boolean")),
    }
}

/// TS inline `value === undefined || typeof value === "boolean"` checks
/// (`queueIfBusy`-style optional flags).
pub(super) fn optional_boolean(value: Option<&Value>, label: &str) -> Option<String> {
    match value {
        None | Some(Value::Bool(_)) => None,
        Some(_) => Some(format!("{label} must be a boolean when present")),
    }
}

/// TS `expectDigest` via `isCloudDigest`.
pub(super) fn expect_digest(value: Option<&Value>, label: &str) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(text) if super::frames::is_cloud_digest(text) => None,
        _ => Some(format!("{label} must be a sha256:<64 hex> digest")),
    }
}
