//! Cloud session wire vocabulary: the bounded JSON protocol a gateway,
//! a remote client, and a session executor speak over any reliable
//! transport (TS `protocol.ts`, protocol v3, ported field-for-field from
//! `origin/feat/direct-cloud-sandbox @ 193d42bf`).
//!
//! Layout: [`base`] holds the base wire types (statuses, cursors,
//! receipts, roster rows, session state, model metadata, the full
//! command-request and event unions), [`frames`] holds the frame types,
//! the `CloudMessage` union, digests, and the parse/serialize codec, and
//! [`family`] holds the cross-boundary family slice (PR #3145's typed
//! surface). The validators live in [`request_validation`],
//! [`event_validation`], [`shapes_validation`], [`message_validation`],
//! and [`validation`] (family), sharing the TS-exact checks in [`checks`]:
//! exact problem strings, exact check order, JS property-key order
//! (`Object.keys` yields array indices first), UTF-16-unit string bounds
//! (TS `.length` semantics), JS-integer acceptance (`Number.isInteger`
//! over the parsed `f64`), and canonical JSON whose keys sort by UTF-16
//! code units and whose numbers render with JavaScript semantics so
//! digests match the TS bytes.
//!
//! This module is vocabulary only: no transport, gateway, journal, or
//! capability advertising is implemented here. The family kinds of the
//! unions embed the family slice's value types and validate through its
//! validators, so the family surface stays owned by one place.
//!
//! Receipts never claim delivery on the family surface: a
//! `CloudAgentMessageReceipt` exists only after the receiving side
//! admitted the message (the journaled `agent_message_result` carries
//! it), so "durably admitted but unanswered" is a request state, never a
//! receipt state.

use serde_json::Value;

pub const CLOUD_PROTOCOL_NAME: &str = "prime-agent.cloud";
/// Version 3 adds the cross-boundary family surface; hello requires an exact
/// match, so a mixed-version pair refuses attachment (TS
/// `CLOUD_PROTOCOL_VERSION`).
pub const CLOUD_PROTOCOL_VERSION: u64 = 3;
/// The hello capability that gates the family surface (TS `family_messages`).
pub const CLOUD_CAPABILITY_FAMILY_MESSAGES: &str = "family_messages";

pub const CLOUD_MAX_MESSAGE_BYTES: usize = 1_048_576;
pub const CLOUD_MAX_JSON_DEPTH: usize = 64;
pub const CLOUD_MAX_ID_CHARS: usize = 128;
pub const CLOUD_MAX_PROMPT_CHARS: usize = 65_536;
pub const CLOUD_MAX_ERROR_CHARS: usize = 2_048;
pub const CLOUD_MAX_TIMESTAMP_CHARS: usize = 64;
pub const CLOUD_MAX_PATH_CHARS: usize = 4_096;
pub const CLOUD_MAX_SESSION_NAME_CHARS: usize = 128;
/// Bound on one remote-family roster batch (`family_roster_result` entries).
pub const CLOUD_MAX_FAMILY_ROWS: usize = 64;
/// Bound on the terminal receipt `result` payload (canonical JSON string).
pub const CLOUD_MAX_RECEIPT_RESULT_CHARS: usize = 2_048;
/// Bound on an agent-message request id and a remote target selector.
pub const CLOUD_MAX_SELECTOR_CHARS: usize = 128;
pub const CLOUD_MAX_REQUEST_JSON_CHARS: usize = 131_072;
pub const CLOUD_MAX_MODEL_ID_CHARS: usize = 256;
pub const CLOUD_MAX_CAPABILITIES: usize = 16;
pub const CLOUD_MAX_QUEUED_COMMANDS: usize = 64;
pub const CLOUD_MAX_SNAPSHOT_EVENTS: usize = 256;
pub const CLOUD_MAX_TOKEN_CHARS: usize = 256;
pub const CLOUD_MAX_OUTPUT_CHARS: usize = 65_536;
/// Bound on one ephemeral `session_event` frame's encoded JSON.
pub const CLOUD_MAX_SESSION_EVENT_BYTES: usize = 131_072;
/// Bound on brokered inference request conversation length.
pub const CLOUD_MAX_INFERENCE_MESSAGES: usize = 2_048;
/// Bound on one inline `session_entry`'s encoded JSON; larger entries
/// travel as artifact refs.
pub const CLOUD_MAX_ENTRY_JSON_CHARS: usize = 262_144;
pub const CLOUD_MAX_THINKING_CHARS: usize = 64;
pub const CLOUD_MAX_EXTENSION_RESPONSE_CHARS: usize = 8_192;
pub const CLOUD_MAX_META_CHARS: usize = 4_096;
pub const CLOUD_MAX_PREVIEW_CHARS: usize = 4_096;
pub const CLOUD_MAX_ROSTER_ROWS: usize = 256;
/// Bound on artifact refs attached to one `session_entry`.
pub const CLOUD_MAX_ARTIFACT_REFS: usize = 32;

/// TS `CloudEvent.kind` one-of list, joined exactly as the TS validator
/// reports it (used for the problem string; only the family kinds have typed
/// shapes here).
pub const CLOUD_EVENT_KINDS: &str = "command_accepted, command_state, session_status, output_delta, session_entry, session_event, session_meta, roster_delta, child_update, usage, family_roster_request, agent_message_request";
/// TS `CloudCommandRequest.kind` one-of list, joined exactly as the TS
/// validator reports it.
pub const CLOUD_COMMAND_KINDS: &str = "open_session, prompt, steer, follow_up, abort, send_message, set_model, set_thinking_level, set_session_name, compact, cancel_child, delete_child, extension_ui_response, release, family_roster_result, agent_message_result";

// ---------------------------------------------------------------------------
// Deterministic JSON (TS protocol.ts canonicalJson)
// ---------------------------------------------------------------------------

/// Deterministic JSON: recursively sorted keys, no whitespace, plain
/// values only, finite numbers, depth bounded by [`CLOUD_MAX_JSON_DEPTH`].
/// Two deep-equal values serialize to the same bytes, so digests are stable
/// across processes and key order never matters (TS `canonicalJson`).
///
/// # Errors
///
/// Returns a problem string when the value nests deeper than
/// [`CLOUD_MAX_JSON_DEPTH`].
pub fn canonical_json(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    canonicalize_into(&mut out, value, 0)?;
    Ok(out)
}

/// Renders one JSON number exactly as the TS canonicalizer does, i.e. as
/// JavaScript `String(number)`: shortest round-trip digits, integral floats
/// without a trailing `.0`, plain decimal form inside `[1e-6, 1e21)`, and
/// `1e+21` (with the sign) above it. `serde_json`'s own rendering diverges
/// from JS on all three (e.g. `2.0`, `-0`, `1e20`), and digests are computed
/// over these bytes, so parity is load-bearing. JSON integers beyond ±2^53
/// parse as floats in JS (rounding to the nearest f64), so they normalize
/// through f64 here too.
// The rounding of integers beyond ±2^53 through f64 is the whole point: JS
// `JSON.parse` produces the same rounded double, and the canonical bytes
// must match the TS side's.
#[allow(clippy::cast_precision_loss)]
fn canonical_number(number: &serde_json::Number) -> String {
    const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_992; // 2^53
    let mut buffer = ryu_js::Buffer::new();
    if let Some(value) = number.as_u64() {
        if value <= JS_SAFE_INTEGER {
            return value.to_string();
        }
        return buffer.format(value as f64).to_string();
    }
    if let Some(value) = number.as_i64() {
        if value.unsigned_abs() <= JS_SAFE_INTEGER {
            return value.to_string();
        }
        return buffer.format(value as f64).to_string();
    }
    buffer
        .format(number.as_f64().unwrap_or_default())
        .to_string()
}

fn json_string(out: &mut String, text: &str) -> Result<(), String> {
    let encoded = serde_json::to_string(text).map_err(|error| error.to_string())?;
    out.push_str(&encoded);
    Ok(())
}

/// Orders two object keys by UTF-16 code units: TS `Object.keys(record).sort()`
/// compares strings by their UTF-16 code units, where an astral character
/// (surrogates D800-DFFF) sorts before the BMP range from U+E000 up, unlike
/// Rust's scalar-value `str` ordering, and digests are computed over the
/// resulting order.
fn cmp_utf16_units(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a = a.encode_utf16();
    let mut b = b.encode_utf16();
    loop {
        match (a.next(), b.next()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) => match x.cmp(&y) {
                std::cmp::Ordering::Equal => {}
                other => return other,
            },
        }
    }
}

fn canonicalize_into(out: &mut String, value: &Value, depth: usize) -> Result<(), String> {
    if depth > CLOUD_MAX_JSON_DEPTH {
        return Err(format!(
            "canonical JSON depth exceeds {CLOUD_MAX_JSON_DEPTH}"
        ));
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            out.push_str(&canonical_number(number));
        }
        Value::String(text) => json_string(out, text)?,
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                canonicalize_into(out, item, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<&str> = map.keys().map(String::as_str).collect();
            keys.sort_unstable_by(|a, b| cmp_utf16_units(a, b));
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                let Some(item) = map.get(*key) else {
                    return Err("canonical JSON key vanished".to_string());
                };
                json_string(out, key)?;
                out.push(':');
                canonicalize_into(out, item, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Module layout
// ---------------------------------------------------------------------------

mod base;
#[cfg(test)]
mod base_tests;
mod checks;
mod event_validation;
mod family;
mod frames;
mod js_number;
mod message_validation;
mod request_validation;
mod shapes_validation;
#[cfg(test)]
mod tests;
mod validation;

pub use base::{
    canonical_cloud_model_selector, split_cloud_model_selector, CloudArtifactRef, CloudChildStatus,
    CloudClientId, CloudCommandId, CloudCommandReceipt, CloudCommandRequest, CloudCommandState,
    CloudCursor, CloudEvent, CloudModelMetadata, CloudOutputStream, CloudRosterRow, CloudSessionId,
    CloudSessionState, CloudSessionStatus, CloudTaskId, CloudTaskState, CloudUsageTotals,
    CLOUD_CAPABILITY_KINDS, CLOUD_COMMAND_STATES, CLOUD_SESSION_STATUSES,
};
pub use event_validation::cloud_event_problem;
pub use family::*;
pub use frames::{
    cloud_digest, cloud_request_digest, is_cloud_digest, parse_cloud_message,
    serialize_cloud_message, CloudAck, CloudCommand, CloudEventsFrame, CloudGetCommand, CloudHello,
    CloudInferenceEnd, CloudInferenceError, CloudInferenceEvent, CloudInferenceModel,
    CloudInferencePayload, CloudInferenceRequest, CloudMessage, CloudSnapshot, CloudSubmit,
    CloudSubscribe, CLOUD_MESSAGE_TYPES, CLOUD_REQUEST_DIGEST_DOMAIN,
};
pub use message_validation::cloud_message_problem;
pub use request_validation::{cloud_id_problem, cloud_request_json_problem, cloud_request_problem};
pub use validation::{
    cloud_agent_message_sender_problem, cloud_family_command_problem, cloud_family_event_problem,
    cloud_family_info_problem, cloud_family_rows_problem, cloud_send_message_problem,
};
