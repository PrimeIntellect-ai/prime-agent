//! Validation for the cloud family wire slice (TS `protocol.ts` problem
//! functions; exact strings, exact check order).

use serde_json::Value;

use super::{
    canonical_json, CLOUD_COMMAND_KINDS, CLOUD_EVENT_KINDS, CLOUD_MAX_ERROR_CHARS,
    CLOUD_MAX_FAMILY_ROWS, CLOUD_MAX_ID_CHARS, CLOUD_MAX_PATH_CHARS, CLOUD_MAX_PROMPT_CHARS,
    CLOUD_MAX_RECEIPT_RESULT_CHARS, CLOUD_MAX_SELECTOR_CHARS, CLOUD_MAX_SESSION_NAME_CHARS,
    CLOUD_MAX_TIMESTAMP_CHARS,
};

use super::checks::{
    expect_fields, expect_integer, expect_one_of, expect_string, first_problem, optional_string,
    record_field,
};

// ---------------------------------------------------------------------------

/// TS `familyInfoProblem`.
#[must_use]
pub fn cloud_family_info_problem(value: &Value, label: &str) -> Option<String> {
    if !value.is_object() {
        return Some(format!("{label} must be an object"));
    }
    let depth_problem = expect_integer(record_field(value, "depth"), &format!("{label}.depth"), 1);
    first_problem([
        expect_fields(
            value,
            &[
                "depth",
                "parentSessionId",
                "parentSessionFile",
                "parentName",
            ],
        ),
        depth_problem,
        expect_string(
            record_field(value, "parentSessionId"),
            &format!("{label}.parentSessionId"),
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        expect_string(
            record_field(value, "parentSessionFile"),
            &format!("{label}.parentSessionFile"),
            CLOUD_MAX_PATH_CHARS,
            1,
        ),
        optional_string(
            record_field(value, "parentName"),
            &format!("{label}.parentName"),
            CLOUD_MAX_SESSION_NAME_CHARS,
        ),
    ])
}

/// TS `agentMessageSenderProblem`.
#[must_use]
pub fn cloud_agent_message_sender_problem(value: &Value, label: &str) -> Option<String> {
    if !value.is_object() {
        return Some(format!("{label} must be an object"));
    }
    let runtime_kind = match record_field(value, "runtimeKind") {
        None => None,
        Some(kind) => expect_one_of(
            Some(kind),
            &format!("{label}.runtimeKind"),
            "top-level, subagent",
        ),
    };
    first_problem([
        expect_fields(
            value,
            &["activeSessionId", "sessionId", "sessionName", "runtimeKind"],
        ),
        optional_string(
            record_field(value, "activeSessionId"),
            &format!("{label}.activeSessionId"),
            CLOUD_MAX_ID_CHARS,
        ),
        optional_string(
            record_field(value, "sessionId"),
            &format!("{label}.sessionId"),
            CLOUD_MAX_ID_CHARS,
        ),
        optional_string(
            record_field(value, "sessionName"),
            &format!("{label}.sessionName"),
            CLOUD_MAX_SESSION_NAME_CHARS,
        ),
        runtime_kind,
    ])
}

/// TS `familyRowsProblem`.
#[must_use]
pub fn cloud_family_rows_problem(value: &Value, label: &str) -> Option<String> {
    let Some(rows) = value.as_array() else {
        return Some(format!("{label} must be an array"));
    };
    if rows.len() > CLOUD_MAX_FAMILY_ROWS {
        return Some(format!(
            "{label} must hold at most {CLOUD_MAX_FAMILY_ROWS} entries"
        ));
    }
    for (index, row) in rows.iter().enumerate() {
        if !row.is_object() {
            return Some(format!("{label}[{index}] must be an object"));
        }
        let row_label = format!("{label}[{index}]");
        let problem = first_problem([
            expect_fields(
                row,
                &[
                    "id",
                    "name",
                    "depth",
                    "status",
                    "parentSessionId",
                    "parentSessionPath",
                    "sessionPath",
                ],
            ),
            expect_string(
                record_field(row, "id"),
                &format!("{row_label}.id"),
                CLOUD_MAX_ID_CHARS,
                1,
            ),
            expect_integer(record_field(row, "depth"), &format!("{row_label}.depth"), 0),
            expect_one_of(
                record_field(row, "status"),
                &format!("{row_label}.status"),
                "running, idle, inactive",
            ),
            optional_string(
                record_field(row, "name"),
                &format!("{row_label}.name"),
                CLOUD_MAX_SESSION_NAME_CHARS,
            ),
            optional_string(
                record_field(row, "parentSessionId"),
                &format!("{row_label}.parentSessionId"),
                CLOUD_MAX_ID_CHARS,
            ),
            optional_string(
                record_field(row, "parentSessionPath"),
                &format!("{row_label}.parentSessionPath"),
                CLOUD_MAX_PATH_CHARS,
            ),
            optional_string(
                record_field(row, "sessionPath"),
                &format!("{row_label}.sessionPath"),
                CLOUD_MAX_PATH_CHARS,
            ),
        ]);
        if problem.is_some() {
            return problem;
        }
    }
    None
}

/// The family slice of TS `cloudEventProblem`: `sequence` and `recordedAt`
/// bounds, then the kind check, then the per-kind exact-field validation.
/// Non-family event kinds are rejected with the TS kind-list problem — this
/// slice validates family intake boundaries; the full event validator
/// lands with the protocol-server port.
#[must_use]
pub fn cloud_family_event_problem(value: &Value, label: &str) -> Option<String> {
    if !value.is_object() {
        return Some(format!("{label} must be an object"));
    }
    if let Some(base) = first_problem([
        expect_integer(
            record_field(value, "sequence"),
            &format!("{label}.sequence"),
            1,
        ),
        expect_string(
            record_field(value, "recordedAt"),
            &format!("{label}.recordedAt"),
            CLOUD_MAX_TIMESTAMP_CHARS,
            1,
        ),
    ]) {
        return Some(base);
    }
    match record_field(value, "kind").and_then(Value::as_str) {
        Some("family_roster_request") => first_problem([
            expect_fields(
                value,
                &[
                    "sequence",
                    "kind",
                    "recordedAt",
                    "requestId",
                    "fromRemoteSessionId",
                ],
            ),
            expect_string(
                record_field(value, "requestId"),
                &format!("{label}.requestId"),
                CLOUD_MAX_ID_CHARS,
                1,
            ),
            expect_string(
                record_field(value, "fromRemoteSessionId"),
                &format!("{label}.fromRemoteSessionId"),
                CLOUD_MAX_ID_CHARS,
                1,
            ),
        ]),
        Some("agent_message_request") => first_problem([
            expect_fields(
                value,
                &[
                    "sequence",
                    "kind",
                    "recordedAt",
                    "requestId",
                    "fromRemoteSessionId",
                    "targetSelector",
                    "message",
                ],
            ),
            expect_string(
                record_field(value, "requestId"),
                &format!("{label}.requestId"),
                CLOUD_MAX_ID_CHARS,
                1,
            ),
            expect_string(
                record_field(value, "fromRemoteSessionId"),
                &format!("{label}.fromRemoteSessionId"),
                CLOUD_MAX_ID_CHARS,
                1,
            ),
            expect_string(
                record_field(value, "targetSelector"),
                &format!("{label}.targetSelector"),
                CLOUD_MAX_SELECTOR_CHARS,
                1,
            ),
            expect_string(
                record_field(value, "message"),
                &format!("{label}.message"),
                CLOUD_MAX_PROMPT_CHARS,
                1,
            ),
        ]),
        _ => Some(format!("{label}.kind must be one of {CLOUD_EVENT_KINDS}")),
    }
}

/// The family slice of TS `cloudRequestProblem`:
/// `family_roster_result` and `agent_message_result` answers. Other command
/// kinds are rejected with the TS kind-list problem (full validator lands
/// with the protocol-server port).
#[must_use]
pub fn cloud_family_command_problem(value: &Value, label: &str) -> Option<String> {
    if !value.is_object() {
        return Some(format!("{label} must be a JSON object"));
    }
    match record_field(value, "kind").and_then(Value::as_str) {
        Some("family_roster_result") => {
            if let Some(base) = first_problem([
                expect_fields(value, &["kind", "requestId", "entries"]),
                expect_string(
                    record_field(value, "requestId"),
                    &format!("{label}.requestId"),
                    CLOUD_MAX_ID_CHARS,
                    1,
                ),
            ]) {
                return Some(base);
            }
            cloud_family_rows_problem(
                record_field(value, "entries").unwrap_or(&Value::Null),
                &format!("{label}.entries"),
            )
        }
        Some("agent_message_result") => {
            if let Some(base) = agent_message_result_problem(value, label) {
                return Some(base);
            }
            receipt_problem(value, label)
        }
        _ => Some(format!("{label}.kind must be one of {CLOUD_COMMAND_KINDS}")),
    }
}

fn agent_message_result_problem(value: &Value, label: &str) -> Option<String> {
    let ok = record_field(value, "ok");
    first_problem([
        expect_fields(value, &["kind", "requestId", "ok", "receipt", "error"]),
        expect_string(
            record_field(value, "requestId"),
            &format!("{label}.requestId"),
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        match ok.and_then(Value::as_bool) {
            Some(_) => None,
            None => Some(format!("{label}.ok must be a boolean")),
        },
        optional_string(
            record_field(value, "error"),
            &format!("{label}.error"),
            CLOUD_MAX_ERROR_CHARS,
        ),
    ])
}

fn receipt_problem(value: &Value, label: &str) -> Option<String> {
    let ok = record_field(value, "ok").and_then(Value::as_bool);
    let receipt = record_field(value, "receipt");
    match (ok, receipt) {
        (Some(true), None) => Some(format!("{label}.receipt is required when ok is true")),
        (Some(false), Some(_)) => Some(format!("{label}.receipt must be omitted when ok is false")),
        (Some(false), None) | (None, _) => None,
        (Some(true), Some(receipt)) => {
            if !receipt.is_object() {
                return Some(format!("{label}.receipt must be a JSON object"));
            }
            match canonical_json(receipt) {
                Ok(encoded) if encoded.len() <= CLOUD_MAX_RECEIPT_RESULT_CHARS => None,
                Ok(_) => Some(format!(
                    "{label}.receipt exceeds {CLOUD_MAX_RECEIPT_RESULT_CHARS} bytes"
                )),
                Err(reason) => Some(format!("{label}.receipt is not canonical JSON: {reason}")),
            }
        }
    }
}

/// The `send_message` arm of TS `cloudRequestProblem` (plus the object
/// check its caller applies).
#[must_use]
pub fn cloud_send_message_problem(value: &Value, label: &str) -> Option<String> {
    if !value.is_object() {
        return Some(format!("{label} must be a JSON object"));
    }
    let from_relationship = match record_field(value, "fromRelationship") {
        None => None,
        Some(relationship) => expect_one_of(
            Some(relationship),
            &format!("{label}.fromRelationship"),
            "parent, sibling, child",
        ),
    };
    first_problem([
        expect_fields(
            value,
            &[
                "kind",
                "targetRemoteSessionId",
                "message",
                "messageId",
                "from",
                "fromRelationship",
            ],
        ),
        expect_string(
            record_field(value, "targetRemoteSessionId"),
            &format!("{label}.targetRemoteSessionId"),
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        expect_string(
            record_field(value, "message"),
            &format!("{label}.message"),
            CLOUD_MAX_PROMPT_CHARS,
            1,
        ),
        optional_string(
            record_field(value, "messageId"),
            &format!("{label}.messageId"),
            CLOUD_MAX_ID_CHARS,
        ),
        record_field(value, "from")
            .and_then(|from| cloud_agent_message_sender_problem(from, &format!("{label}.from"))),
        from_relationship,
    ])
}
