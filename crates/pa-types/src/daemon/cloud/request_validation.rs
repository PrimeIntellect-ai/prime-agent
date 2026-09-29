//! Validation for base command requests (TS `protocol.ts`
//! `cloudIdProblem` / `cloudRequestProblem` / `cloudRequestJsonProblem`):
//! exact problem strings, exact check order. The family kinds delegate to
//! the family validators, so the full 16-kind union validates with one
//! entry point.

use serde_json::Value;

use super::checks::{
    expect_fields, expect_integer, expect_one_of, expect_string, first_problem, optional_boolean,
    optional_string, record_field,
};
use super::validation::{cloud_family_command_problem, cloud_send_message_problem};
use super::{
    canonical_json, cloud_family_info_problem, CLOUD_COMMAND_KINDS,
    CLOUD_MAX_EXTENSION_RESPONSE_CHARS, CLOUD_MAX_ID_CHARS, CLOUD_MAX_MODEL_ID_CHARS,
    CLOUD_MAX_PATH_CHARS, CLOUD_MAX_PROMPT_CHARS, CLOUD_MAX_REQUEST_JSON_CHARS,
    CLOUD_MAX_SESSION_NAME_CHARS, CLOUD_MAX_THINKING_CHARS,
};

/// TS `cloudIdProblem`: runtime validation for a stable protocol id
/// (session, client, or command).
#[must_use]
pub fn cloud_id_problem(value: Option<&Value>, label: &str) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(text)
            if super::checks::string_utf16_units(text) >= 1
                && super::checks::string_utf16_units(text) <= CLOUD_MAX_ID_CHARS =>
        {
            None
        }
        _ => Some(format!(
            "{label} must be a non-empty string of at most {CLOUD_MAX_ID_CHARS} characters"
        )),
    }
}

/// TS `cloudRequestProblem`: runtime validation for a submit request
/// payload. `None` means the request is a valid command request.
// One function per TS switch: every arm's check order is the ported order,
// so the union stays reviewable against `cloudRequestProblem` in one place.
#[allow(clippy::too_many_lines)]
#[must_use]
pub fn cloud_request_problem(value: &Value) -> Option<String> {
    if !value.is_object() {
        return Some("request must be a JSON object".to_string());
    }
    if let Some(problem) = expect_one_of(
        record_field(value, "kind"),
        "request.kind",
        CLOUD_COMMAND_KINDS,
    ) {
        return Some(problem);
    }
    match record_field(value, "kind").and_then(Value::as_str) {
        Some("open_session") => first_problem([
            expect_fields(
                value,
                &[
                    "kind",
                    "cwd",
                    "model",
                    "thinking",
                    "seedTranscriptArtifact",
                    "prompt",
                    "family",
                    "modelMetadata",
                ],
            ),
            expect_string(
                record_field(value, "cwd"),
                "request.cwd",
                CLOUD_MAX_PATH_CHARS,
                1,
            ),
            optional_string(
                record_field(value, "model"),
                "request.model",
                CLOUD_MAX_MODEL_ID_CHARS,
            ),
            optional_string(
                record_field(value, "thinking"),
                "request.thinking",
                CLOUD_MAX_THINKING_CHARS,
            ),
            optional_string(
                record_field(value, "seedTranscriptArtifact"),
                "request.seedTranscriptArtifact",
                CLOUD_MAX_PATH_CHARS,
            ),
            optional_string(
                record_field(value, "prompt"),
                "request.prompt",
                CLOUD_MAX_PROMPT_CHARS,
            ),
            record_field(value, "family")
                .and_then(|family| cloud_family_info_problem(family, "request.family")),
            model_metadata_problem(record_field(value, "modelMetadata")),
        ]),
        Some("prompt") => first_problem([
            expect_fields(value, &["kind", "text", "queueIfBusy", "targetSessionId"]),
            expect_string(
                record_field(value, "text"),
                "request.text",
                CLOUD_MAX_PROMPT_CHARS,
                1,
            ),
            optional_boolean(record_field(value, "queueIfBusy"), "request.queueIfBusy"),
            optional_string(
                record_field(value, "targetSessionId"),
                "request.targetSessionId",
                CLOUD_MAX_ID_CHARS,
            ),
        ]),
        Some("steer" | "follow_up") => first_problem([
            expect_fields(value, &["kind", "text"]),
            expect_string(
                record_field(value, "text"),
                "request.text",
                CLOUD_MAX_PROMPT_CHARS,
                1,
            ),
        ]),
        Some("abort" | "release") => expect_fields(value, &["kind"]),
        Some("send_message") => cloud_send_message_problem(value, "request"),
        Some("set_model") => first_problem([
            expect_fields(value, &["kind", "provider", "modelId"]),
            expect_string(
                record_field(value, "provider"),
                "request.provider",
                CLOUD_MAX_MODEL_ID_CHARS,
                1,
            ),
            expect_string(
                record_field(value, "modelId"),
                "request.modelId",
                CLOUD_MAX_MODEL_ID_CHARS,
                1,
            ),
        ]),
        Some("set_thinking_level") => first_problem([
            expect_fields(value, &["kind", "level"]),
            expect_string(
                record_field(value, "level"),
                "request.level",
                CLOUD_MAX_THINKING_CHARS,
                1,
            ),
        ]),
        Some("set_session_name") => first_problem([
            expect_fields(value, &["kind", "name"]),
            expect_string(
                record_field(value, "name"),
                "request.name",
                CLOUD_MAX_SESSION_NAME_CHARS,
                1,
            ),
        ]),
        Some("compact") => first_problem([
            expect_fields(value, &["kind", "customInstructions"]),
            optional_string(
                record_field(value, "customInstructions"),
                "request.customInstructions",
                CLOUD_MAX_PROMPT_CHARS,
            ),
        ]),
        Some("cancel_child" | "delete_child") => first_problem([
            expect_fields(value, &["kind", "childId"]),
            expect_string(
                record_field(value, "childId"),
                "request.childId",
                CLOUD_MAX_ID_CHARS,
                1,
            ),
        ]),
        Some("extension_ui_response") => {
            let base = first_problem([
                expect_fields(value, &["kind", "requestId", "response", "targetSessionId"]),
                expect_string(
                    record_field(value, "requestId"),
                    "request.requestId",
                    CLOUD_MAX_ID_CHARS,
                    1,
                ),
                optional_string(
                    record_field(value, "targetSessionId"),
                    "request.targetSessionId",
                    CLOUD_MAX_ID_CHARS,
                ),
            ]);
            if base.is_some() {
                return base;
            }
            let Some(response) = record_field(value, "response") else {
                return Some("request.response is required".to_string());
            };
            match canonical_json(response) {
                Ok(encoded) if encoded.len() <= CLOUD_MAX_EXTENSION_RESPONSE_CHARS => None,
                Ok(_) => Some(format!(
                    "request.response exceeds {CLOUD_MAX_EXTENSION_RESPONSE_CHARS} bytes"
                )),
                Err(reason) => Some(format!("request.response is not canonical JSON: {reason}")),
            }
        }
        Some("family_roster_result" | "agent_message_result") => {
            cloud_family_command_problem(value, "request")
        }
        _ => Some(format!("request.kind must be one of {CLOUD_COMMAND_KINDS}")),
    }
}

/// TS `cloudRequestJsonProblem`: maximum encoded bytes of one canonical
/// request payload; enforced alongside digests. Parity note: the pinned
/// TS exports this without a single call site in `protocol.ts` — its
/// `submitProblem` validates a submit through `cloudRequestProblem` and
/// the digest only, so the wire accepts canonical requests over
/// [`CLOUD_MAX_REQUEST_JSON_CHARS`] bytes. The Rust mirrors that exactly
/// (submit validation never bounds request size): the bound is the
/// submit constructor's invariant, not the validator's, and wiring it
/// into submit would reject frames the pinned TS accepts.
#[must_use]
pub fn cloud_request_json_problem(value: &Value) -> Option<String> {
    match canonical_json(value) {
        Ok(encoded) if encoded.len() <= CLOUD_MAX_REQUEST_JSON_CHARS => None,
        Ok(_) => Some(format!(
            "request exceeds {CLOUD_MAX_REQUEST_JSON_CHARS} bytes"
        )),
        Err(reason) => Some(format!("request is not canonical JSON: {reason}")),
    }
}

/// TS `modelMetadataProblem` (the `open_session` brokered-model metadata).
fn model_metadata_problem(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if !value.is_object() {
        return Some("request.modelMetadata must be an object".to_string());
    }
    first_problem([
        expect_fields(value, &["name", "contextWindow", "maxTokens", "reasoning"]),
        expect_string(
            record_field(value, "name"),
            "request.modelMetadata.name",
            CLOUD_MAX_SESSION_NAME_CHARS,
            1,
        ),
        expect_integer(
            record_field(value, "contextWindow"),
            "request.modelMetadata.contextWindow",
            1,
        ),
        expect_integer(
            record_field(value, "maxTokens"),
            "request.modelMetadata.maxTokens",
            1,
        ),
        super::checks::expect_boolean(
            record_field(value, "reasoning"),
            "request.modelMetadata.reasoning",
        ),
    ])
}
