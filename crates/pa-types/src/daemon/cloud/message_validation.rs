//! Validation for protocol frames (TS `protocol.ts` `cloudMessageProblem`):
//! exact problem strings, exact check order, dispatch by frame `type`.

use serde_json::Value;

use super::checks::{
    expect_fields, expect_integer, expect_one_of, expect_string, first_problem, record_field,
    string_utf16_units,
};
use super::event_validation::cloud_event_problem;
use super::frames::{cloud_request_digest, CLOUD_MESSAGE_TYPES};
use super::request_validation::{cloud_id_problem, cloud_request_problem};
use super::shapes_validation::{capabilities_problem, cursor_problem, receipt_problem};
use super::{
    CLOUD_MAX_ERROR_CHARS, CLOUD_MAX_ID_CHARS, CLOUD_MAX_INFERENCE_MESSAGES,
    CLOUD_MAX_MODEL_ID_CHARS, CLOUD_MAX_QUEUED_COMMANDS, CLOUD_MAX_REQUEST_JSON_CHARS,
    CLOUD_MAX_SNAPSHOT_EVENTS, CLOUD_MAX_TOKEN_CHARS,
};

/// TS `cloudMessageProblem`: runtime validation for any protocol frame;
/// `None` means the value is a valid message.
#[must_use]
pub fn cloud_message_problem(value: &Value) -> Option<String> {
    if !value.is_object() {
        return Some("message must be a JSON object".to_string());
    }
    match record_field(value, "type").and_then(Value::as_str) {
        Some("hello") => hello_problem(value),
        Some("snapshot") => snapshot_problem(value),
        Some("subscribe") => subscribe_problem(value),
        Some("events") => events_problem(value),
        Some("submit") => submit_problem(value),
        Some("get_command") => get_command_problem(value),
        Some("command") => command_problem(value),
        Some("ack") => ack_problem(value),
        Some("inference_request") => inference_request_problem(value),
        Some("inference_event") => inference_response_problem(value, "event"),
        Some("inference_end") => inference_response_problem(value, "message"),
        Some("inference_error") => inference_response_problem(value, "error"),
        _ => Some(format!("message.type must be one of {CLOUD_MESSAGE_TYPES}")),
    }
}

/// TS `helloProblem`.
fn hello_problem(value: &Value) -> Option<String> {
    #[allow(clippy::cast_precision_loss)] // the protocol version is a small exact integer
    let expected_version = super::CLOUD_PROTOCOL_VERSION as f64;
    let base = first_problem([
        expect_fields(
            value,
            &[
                "type",
                "protocolVersion",
                "generation",
                "clientId",
                "sessionId",
                "authToken",
                "cursor",
                "capabilities",
            ],
        ),
        expect_integer(
            record_field(value, "protocolVersion"),
            "hello.protocolVersion",
            1,
        ),
        // TS compares the parsed numbers with `===`; exact IEEE equality
        // is the parity requirement, not an epsilon comparison.
        #[allow(clippy::float_cmp)]
        match record_field(value, "protocolVersion").and_then(Value::as_f64) {
            Some(version) if version == expected_version => None,
            _ => Some(format!(
                "hello.protocolVersion must equal {}",
                super::CLOUD_PROTOCOL_VERSION
            )),
        },
        expect_integer(record_field(value, "generation"), "hello.generation", 1),
        cloud_id_problem(record_field(value, "clientId"), "hello.clientId"),
        cloud_id_problem(record_field(value, "sessionId"), "hello.sessionId"),
        record_field(value, "authToken").and_then(|token| {
            expect_string(Some(token), "hello.authToken", CLOUD_MAX_TOKEN_CHARS, 1)
        }),
        record_field(value, "cursor")
            .and_then(|cursor| cursor_problem(Some(cursor), "hello.cursor")),
        capabilities_problem(record_field(value, "capabilities"), "hello.capabilities"),
    ]);
    if base.is_some() {
        return base;
    }
    let cursor_generation = record_field(value, "cursor")
        .and_then(|cursor| cursor.get("generation"))
        .and_then(Value::as_f64);
    let generation = record_field(value, "generation").and_then(Value::as_f64);
    if cursor_generation.is_some() && cursor_generation != generation {
        return Some("hello.cursor.generation must match hello.generation".to_string());
    }
    None
}

/// TS `sessionStateProblem` (lives between the snapshot checks).
fn session_state_problem(value: Option<&Value>) -> Option<String> {
    let Some(value) = value else {
        return Some("snapshot.state must be an object".to_string());
    };
    if !value.is_object() {
        return Some("snapshot.state must be an object".to_string());
    }
    let queued = record_field(value, "queuedCommandIds");
    if queued.is_none() {
        return Some("snapshot.state.queuedCommandIds is required".to_string());
    }
    let Some(queued) = queued.and_then(Value::as_array) else {
        return Some("snapshot.state.queuedCommandIds must be an array".to_string());
    };
    if queued.len() > CLOUD_MAX_QUEUED_COMMANDS {
        return Some(format!(
            "snapshot.state.queuedCommandIds must hold at most {CLOUD_MAX_QUEUED_COMMANDS} entries"
        ));
    }
    for (index, id) in queued.iter().enumerate() {
        if let Some(problem) = cloud_id_problem(
            Some(id),
            &format!("snapshot.state.queuedCommandIds[{index}]"),
        ) {
            return Some(problem);
        }
    }
    first_problem([
        expect_fields(
            value,
            &["cwd", "modelId", "activeCommandId", "queuedCommandIds"],
        ),
        expect_string(
            record_field(value, "cwd"),
            "snapshot.state.cwd",
            super::CLOUD_MAX_PATH_CHARS,
            0,
        ),
        expect_string(
            record_field(value, "modelId"),
            "snapshot.state.modelId",
            CLOUD_MAX_MODEL_ID_CHARS,
            1,
        ),
        record_field(value, "activeCommandId")
            .and_then(|id| cloud_id_problem(Some(id), "snapshot.state.activeCommandId")),
    ])
}

/// TS `snapshotProblem`.
fn snapshot_problem(value: &Value) -> Option<String> {
    let base = first_problem([
        expect_fields(
            value,
            &[
                "type",
                "sessionId",
                "generation",
                "cursor",
                "status",
                "state",
                "events",
                "capabilities",
            ],
        ),
        capabilities_problem(record_field(value, "capabilities"), "snapshot.capabilities"),
        cloud_id_problem(record_field(value, "sessionId"), "snapshot.sessionId"),
        expect_integer(record_field(value, "generation"), "snapshot.generation", 1),
        expect_one_of(
            record_field(value, "status"),
            "snapshot.status",
            super::CLOUD_SESSION_STATUSES,
        ),
        session_state_problem(record_field(value, "state")),
    ]);
    if base.is_some() {
        return base;
    }
    let cursor_base = cursor_problem(record_field(value, "cursor"), "snapshot.cursor");
    if cursor_base.is_some() {
        return cursor_base;
    }
    let events = record_field(value, "events").and_then(Value::as_array);
    let Some(events) = events else {
        return Some("snapshot.events must be an array".to_string());
    };
    if events.len() > CLOUD_MAX_SNAPSHOT_EVENTS {
        return Some(format!(
            "snapshot.events must hold at most {CLOUD_MAX_SNAPSHOT_EVENTS} events"
        ));
    }
    let mut last_sequence = 0_f64;
    for (index, event) in events.iter().enumerate() {
        if let Some(problem) = cloud_event_problem(event, &format!("snapshot.events[{index}]")) {
            return Some(problem);
        }
        let sequence = event
            .get("sequence")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        if sequence <= last_sequence {
            return Some(format!(
                "snapshot.events[{index}].sequence must strictly increase"
            ));
        }
        last_sequence = sequence;
    }
    let cursor = record_field(value, "cursor").unwrap_or(&Value::Null);
    let cursor_generation = cursor.get("generation").and_then(Value::as_f64);
    let generation = record_field(value, "generation").and_then(Value::as_f64);
    if cursor_generation != generation {
        return Some("snapshot.cursor.generation must match snapshot.generation".to_string());
    }
    let cursor_sequence = cursor.get("sequence").and_then(Value::as_f64);
    if !events.is_empty() && cursor_sequence != Some(last_sequence) {
        return Some("snapshot.cursor.sequence must match the last event sequence".to_string());
    }
    None
}

/// TS `subscribeProblem`.
fn subscribe_problem(value: &Value) -> Option<String> {
    first_problem([
        expect_fields(value, &["type", "sessionId", "cursor"]),
        cloud_id_problem(record_field(value, "sessionId"), "subscribe.sessionId"),
        cursor_problem(record_field(value, "cursor"), "subscribe.cursor"),
    ])
}

/// TS `eventsProblem` (the `events` frame).
fn events_problem(value: &Value) -> Option<String> {
    let base = first_problem([
        expect_fields(value, &["type", "sessionId", "generation", "events"]),
        cloud_id_problem(record_field(value, "sessionId"), "events.sessionId"),
        expect_integer(record_field(value, "generation"), "events.generation", 1),
    ]);
    if base.is_some() {
        return base;
    }
    let events = record_field(value, "events").and_then(Value::as_array);
    let Some(events) = events else {
        return Some("events.events must be an array".to_string());
    };
    if events.len() > CLOUD_MAX_SNAPSHOT_EVENTS {
        return Some(format!(
            "events.events must hold at most {CLOUD_MAX_SNAPSHOT_EVENTS} entries"
        ));
    }
    let mut last_sequence = 0_f64;
    for (index, event) in events.iter().enumerate() {
        if let Some(problem) = cloud_event_problem(event, &format!("events.events[{index}]")) {
            return Some(problem);
        }
        let sequence = event
            .get("sequence")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        if sequence <= last_sequence {
            return Some(format!(
                "events.events[{index}].sequence must strictly increase"
            ));
        }
        last_sequence = sequence;
    }
    None
}

/// TS `submitProblem`. A canonicalization failure of a validated request is
/// unreachable (the arm checks cap every nested value); the Rust form
/// surfaces it as the `cloudRequestJsonProblem` string instead of the TS
/// uncaught throw. Deliberate parity: the request size is NOT bounded here
/// — the pinned TS `submitProblem` never calls
/// `cloudRequestJsonProblem` (see
/// [`super::request_validation::cloud_request_json_problem`]); the size
/// bound stays the submit constructor's invariant.
fn submit_problem(value: &Value) -> Option<String> {
    let base = first_problem([
        expect_fields(
            value,
            &[
                "type",
                "sessionId",
                "generation",
                "commandId",
                "request",
                "digest",
            ],
        ),
        cloud_id_problem(record_field(value, "sessionId"), "submit.sessionId"),
        expect_integer(record_field(value, "generation"), "submit.generation", 1),
        cloud_id_problem(record_field(value, "commandId"), "submit.commandId"),
        // TS passes `value.request` (undefined when absent) straight to
        // `cloudRequestProblem`, so a missing request reports the request
        // problem here, before the digest check hashes `null`.
        cloud_request_problem(record_field(value, "request").unwrap_or(&Value::Null)),
        super::checks::expect_digest(record_field(value, "digest"), "submit.digest"),
    ]);
    if base.is_some() {
        return base;
    }
    let request = record_field(value, "request").unwrap_or(&Value::Null);
    let digest = record_field(value, "digest").and_then(Value::as_str);
    match cloud_request_digest(request) {
        Ok(computed) if Some(computed.as_str()) == digest => None,
        Ok(_) => {
            Some("submit.digest must equal the canonical digest of submit.request".to_string())
        }
        Err(reason) => Some(format!("request is not canonical JSON: {reason}")),
    }
}

/// TS `getCommandProblem`.
fn get_command_problem(value: &Value) -> Option<String> {
    let base = first_problem([
        expect_fields(
            value,
            &["type", "sessionId", "generation", "commandId", "claim"],
        ),
        cloud_id_problem(record_field(value, "sessionId"), "get_command.sessionId"),
        expect_integer(
            record_field(value, "generation"),
            "get_command.generation",
            1,
        ),
        record_field(value, "commandId")
            .and_then(|id| cloud_id_problem(Some(id), "get_command.commandId")),
        match record_field(value, "claim") {
            None | Some(Value::Bool(_)) => None,
            Some(_) => Some("get_command.claim must be a boolean".to_string()),
        },
    ]);
    if base.is_some() {
        return base;
    }
    let claim = record_field(value, "claim").and_then(Value::as_bool);
    if claim == Some(true) && record_field(value, "commandId").is_some() {
        return Some("get_command.claim cannot be combined with get_command.commandId".to_string());
    }
    None
}

/// TS `commandProblem`.
fn command_problem(value: &Value) -> Option<String> {
    let base = first_problem([
        expect_fields(
            value,
            &["type", "sessionId", "generation", "receipt", "request"],
        ),
        cloud_id_problem(record_field(value, "sessionId"), "command.sessionId"),
        expect_integer(record_field(value, "generation"), "command.generation", 1),
        receipt_problem(record_field(value, "receipt"), "command.receipt"),
    ]);
    if base.is_some() {
        return base;
    }
    let request = record_field(value, "request")?;
    if let Some(problem) = expect_string(
        Some(request),
        "command.request",
        CLOUD_MAX_REQUEST_JSON_CHARS,
        1,
    ) {
        return Some(problem);
    }
    let Some(parsed) = request
        .as_str()
        .and_then(|request| serde_json::from_str::<Value>(request).ok())
    else {
        return Some("command.request must be JSON of a command request".to_string());
    };
    cloud_request_problem(&parsed)
}

/// TS `ackProblem`.
fn ack_problem(value: &Value) -> Option<String> {
    first_problem([
        expect_fields(value, &["type", "sessionId", "cursor"]),
        cloud_id_problem(record_field(value, "sessionId"), "ack.sessionId"),
        cursor_problem(record_field(value, "cursor"), "ack.cursor"),
    ])
}

/// TS `inferenceRequestProblem`. Note the TS labels: the id fields report
/// unprefixed (`sessionId`, not `inference_request.sessionId`).
fn inference_request_problem(value: &Value) -> Option<String> {
    let base = first_problem([
        expect_fields(
            value,
            &[
                "type",
                "sessionId",
                "remoteSessionId",
                "requestId",
                "model",
                "thinking",
                "payload",
            ],
        ),
        expect_string(
            record_field(value, "sessionId"),
            "sessionId",
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        expect_string(
            record_field(value, "remoteSessionId"),
            "remoteSessionId",
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        expect_string(
            record_field(value, "requestId"),
            "requestId",
            CLOUD_MAX_ID_CHARS,
            1,
        ),
    ]);
    if base.is_some() {
        return base;
    }
    if let Some(thinking) = record_field(value, "thinking") {
        let Some(text) = thinking.as_str() else {
            return Some("thinking must be a bounded string".to_string());
        };
        if string_utf16_units(text) > CLOUD_MAX_ID_CHARS {
            return Some("thinking must be a bounded string".to_string());
        }
    }
    let Some(model) = record_field(value, "model").filter(|model| model.is_object()) else {
        return Some("model must be a JSON object".to_string());
    };
    let bounded = model
        .get("provider")
        .and_then(Value::as_str)
        .is_some_and(|provider| string_utf16_units(provider) <= CLOUD_MAX_ID_CHARS)
        && model
            .get("modelId")
            .and_then(Value::as_str)
            .is_some_and(|model_id| string_utf16_units(model_id) <= CLOUD_MAX_MODEL_ID_CHARS);
    if !bounded {
        return Some("model must carry bounded provider and modelId strings".to_string());
    }
    let Some(payload) = record_field(value, "payload").filter(|payload| payload.is_object()) else {
        return Some("payload must be a JSON object".to_string());
    };
    let Some(messages) = payload.get("messages").and_then(Value::as_array) else {
        return Some("payload.messages must be an array".to_string());
    };
    if messages.len() > CLOUD_MAX_INFERENCE_MESSAGES {
        return Some(format!(
            "payload.messages exceeds {CLOUD_MAX_INFERENCE_MESSAGES} entries"
        ));
    }
    match payload.get("options") {
        None | Some(Value::Object(_)) => None,
        Some(_) => Some("payload.options must be a JSON object".to_string()),
    }
}

/// TS `inferenceResponseProblem` for `inference_event` (`event`),
/// `inference_end` (`message`), and `inference_error` (`error`).
fn inference_response_problem(value: &Value, field: &str) -> Option<String> {
    let base = first_problem([
        expect_fields(value, &["type", "sessionId", "requestId", field]),
        expect_string(
            record_field(value, "sessionId"),
            "sessionId",
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        expect_string(
            record_field(value, "requestId"),
            "requestId",
            CLOUD_MAX_ID_CHARS,
            1,
        ),
    ]);
    if base.is_some() {
        return base;
    }
    if field == "error" {
        let Some(error) = record_field(value, "error").and_then(Value::as_str) else {
            return Some("error must be a bounded string".to_string());
        };
        if string_utf16_units(error) > CLOUD_MAX_ERROR_CHARS {
            return Some("error must be a bounded string".to_string());
        }
        return None;
    }
    record_field(value, field)
        .filter(|value| value.is_object())
        .map_or_else(|| Some(format!("{field} must be a JSON object")), |_| None)
}
