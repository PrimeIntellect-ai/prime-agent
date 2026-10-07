//! Validation for events (TS `protocol.ts` `cloudEventProblem`): exact
//! problem strings, exact check order. The family kinds delegate to the
//! family validators, so the full 12-kind union validates with one entry
//! point.

use serde_json::Value;

use super::base::CLOUD_SESSION_STATUSES;
use super::checks::{
    expect_boolean, expect_digest, expect_fields, expect_integer, expect_one_of, expect_string,
    first_problem, optional_string, record_field,
};
use super::shapes_validation::receipt_problem;
use super::validation::cloud_family_event_problem;
use super::{
    canonical_json, cloud_id_problem, CLOUD_EVENT_KINDS, CLOUD_MAX_ARTIFACT_REFS,
    CLOUD_MAX_CAPABILITIES, CLOUD_MAX_ENTRY_JSON_CHARS, CLOUD_MAX_ID_CHARS, CLOUD_MAX_META_CHARS,
    CLOUD_MAX_MODEL_ID_CHARS, CLOUD_MAX_OUTPUT_CHARS, CLOUD_MAX_PATH_CHARS,
    CLOUD_MAX_PREVIEW_CHARS, CLOUD_MAX_ROSTER_ROWS, CLOUD_MAX_SESSION_EVENT_BYTES,
    CLOUD_MAX_SESSION_NAME_CHARS, CLOUD_MAX_TIMESTAMP_CHARS,
};

/// TS `cloudEventProblem`: runtime validation for one event; `None` means
/// the value is a valid event.
// One function per TS switch: every arm's check order is the ported order,
// so the union stays reviewable against `eventProblem` in one place.
#[allow(clippy::too_many_lines)]
#[must_use]
pub fn cloud_event_problem(value: &Value, label: &str) -> Option<String> {
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
    if let Some(problem) = expect_one_of(
        record_field(value, "kind"),
        &format!("{label}.kind"),
        CLOUD_EVENT_KINDS,
    ) {
        return Some(problem);
    }
    match record_field(value, "kind").and_then(Value::as_str) {
        // TS fallthrough for `command_accepted` and `command_state`.
        Some("command_accepted" | "command_state") => first_problem([
            expect_fields(value, &["sequence", "kind", "recordedAt", "receipt"]),
            receipt_problem(record_field(value, "receipt"), &format!("{label}.receipt")),
        ]),
        Some("session_status") => first_problem([
            expect_fields(value, &["sequence", "kind", "recordedAt", "status"]),
            expect_one_of(
                record_field(value, "status"),
                &format!("{label}.status"),
                CLOUD_SESSION_STATUSES,
            ),
        ]),
        Some("output_delta") => first_problem([
            expect_fields(
                value,
                &["sequence", "kind", "recordedAt", "taskId", "stream", "text"],
            ),
            cloud_id_problem(record_field(value, "taskId"), &format!("{label}.taskId")),
            expect_one_of(
                record_field(value, "stream"),
                &format!("{label}.stream"),
                "stdout, stderr",
            ),
            expect_string(
                record_field(value, "text"),
                &format!("{label}.text"),
                CLOUD_MAX_OUTPUT_CHARS,
                0,
            ),
        ]),
        Some("session_entry") => session_entry_problem(value, label),
        Some("session_event") => session_event_problem(value, label),
        Some("session_meta") => session_meta_problem(value, label),
        Some("roster_delta") => roster_delta_problem(value, label),
        Some("child_update") => first_problem([
            expect_fields(
                value,
                &[
                    "sequence",
                    "kind",
                    "recordedAt",
                    "childId",
                    "status",
                    "answerPreview",
                    "sessionFile",
                    "model",
                ],
            ),
            expect_string(
                record_field(value, "childId"),
                &format!("{label}.childId"),
                CLOUD_MAX_ID_CHARS,
                1,
            ),
            expect_one_of(
                record_field(value, "status"),
                &format!("{label}.status"),
                "queued, running, completed, failed, cancelled",
            ),
            optional_string(
                record_field(value, "answerPreview"),
                &format!("{label}.answerPreview"),
                CLOUD_MAX_PREVIEW_CHARS,
            ),
            optional_string(
                record_field(value, "sessionFile"),
                &format!("{label}.sessionFile"),
                CLOUD_MAX_PATH_CHARS,
            ),
            optional_string(
                record_field(value, "model"),
                &format!("{label}.model"),
                CLOUD_MAX_MODEL_ID_CHARS,
            ),
        ]),
        Some("usage") => first_problem([
            expect_fields(
                value,
                &[
                    "sequence",
                    "kind",
                    "recordedAt",
                    "sessionId",
                    "totals",
                    "revision",
                ],
            ),
            expect_string(
                record_field(value, "sessionId"),
                &format!("{label}.sessionId"),
                CLOUD_MAX_ID_CHARS,
                1,
            ),
            usage_totals_problem(
                record_field(value, "totals").unwrap_or(&Value::Null),
                &format!("{label}.totals"),
            ),
            expect_integer(
                record_field(value, "revision"),
                &format!("{label}.revision"),
                0,
            ),
        ]),
        Some("family_roster_request" | "agent_message_request") => {
            cloud_family_event_problem(value, label)
        }
        _ => Some(format!("{label}.kind must be one of {CLOUD_EVENT_KINDS}")),
    }
}

/// TS `artifactRefsProblem`.
fn artifact_refs_problem(value: Option<&Value>, label: &str) -> Option<String> {
    let value = value?;
    let Some(refs) = value.as_array() else {
        return Some(format!("{label} must be an array"));
    };
    if refs.len() > CLOUD_MAX_ARTIFACT_REFS {
        return Some(format!(
            "{label} must hold at most {CLOUD_MAX_ARTIFACT_REFS} entries"
        ));
    }
    for (index, entry) in refs.iter().enumerate() {
        if !entry.is_object() {
            return Some(format!("{label}[{index}] must be an object"));
        }
        let problem = first_problem([
            expect_fields(entry, &["path", "sha256", "bytes"]),
            expect_string(
                record_field(entry, "path"),
                &format!("{label}[{index}].path"),
                CLOUD_MAX_PATH_CHARS,
                1,
            ),
            expect_digest(
                record_field(entry, "sha256"),
                &format!("{label}[{index}].sha256"),
            ),
            expect_integer(
                record_field(entry, "bytes"),
                &format!("{label}[{index}].bytes"),
                0,
            ),
        ]);
        if problem.is_some() {
            return problem;
        }
    }
    None
}

/// TS `sessionEntryProblem`.
fn session_entry_problem(value: &Value, label: &str) -> Option<String> {
    let base = first_problem([
        expect_fields(
            value,
            &[
                "sequence",
                "kind",
                "recordedAt",
                "sessionId",
                "entryId",
                "entry",
                "artifacts",
            ],
        ),
        expect_string(
            record_field(value, "sessionId"),
            &format!("{label}.sessionId"),
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        expect_string(
            record_field(value, "entryId"),
            &format!("{label}.entryId"),
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        artifact_refs_problem(
            record_field(value, "artifacts"),
            &format!("{label}.artifacts"),
        ),
    ]);
    if base.is_some() {
        return base;
    }
    let Some(entry) = record_field(value, "entry") else {
        return Some(format!("{label}.entry must be a JSON object"));
    };
    if !entry.is_object() {
        return Some(format!("{label}.entry must be a JSON object"));
    }
    let entry_problem = first_problem([
        expect_string(
            record_field(entry, "type"),
            &format!("{label}.entry.type"),
            128,
            1,
        ),
        expect_string(
            record_field(entry, "id"),
            &format!("{label}.entry.id"),
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        match record_field(entry, "parentId") {
            None | Some(Value::Null) => None,
            Some(parent_id) => expect_string(
                Some(parent_id),
                &format!("{label}.entry.parentId"),
                CLOUD_MAX_ID_CHARS,
                1,
            ),
        },
        expect_string(
            record_field(entry, "timestamp"),
            &format!("{label}.entry.timestamp"),
            CLOUD_MAX_TIMESTAMP_CHARS,
            1,
        ),
    ]);
    if entry_problem.is_some() {
        return entry_problem;
    }
    match canonical_json(entry) {
        Ok(encoded) if encoded.len() <= CLOUD_MAX_ENTRY_JSON_CHARS => None,
        Ok(_) => Some(format!(
            "{label}.entry exceeds {CLOUD_MAX_ENTRY_JSON_CHARS} bytes; it must travel as artifact refs"
        )),
        Err(reason) => Some(format!("{label}.entry is not canonical JSON: {reason}")),
    }
}

/// TS `sessionEventProblem`.
fn session_event_problem(value: &Value, label: &str) -> Option<String> {
    let base = first_problem([
        expect_fields(
            value,
            &["sequence", "kind", "recordedAt", "sessionId", "event"],
        ),
        expect_string(
            record_field(value, "sessionId"),
            &format!("{label}.sessionId"),
            CLOUD_MAX_ID_CHARS,
            1,
        ),
    ]);
    if base.is_some() {
        return base;
    }
    let Some(event) = record_field(value, "event") else {
        return Some(format!("{label}.event must be a JSON object"));
    };
    if !event.is_object() {
        return Some(format!("{label}.event must be a JSON object"));
    }
    if record_field(event, "type")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Some(format!("{label}.event.type must be a non-empty string"));
    }
    match canonical_json(event) {
        Ok(encoded) if encoded.len() <= CLOUD_MAX_SESSION_EVENT_BYTES => None,
        Ok(_) => Some(format!(
            "{label}.event exceeds {CLOUD_MAX_SESSION_EVENT_BYTES} bytes"
        )),
        Err(reason) => Some(format!("{label}.event is not canonical JSON: {reason}")),
    }
}

/// TS `sessionMetaProblem`.
fn session_meta_problem(value: &Value, label: &str) -> Option<String> {
    first_problem([
        expect_fields(
            value,
            &[
                "sequence",
                "kind",
                "recordedAt",
                "sessionId",
                "streaming",
                "runningTools",
                "queue",
                "recap",
                "taskState",
                "model",
                "connectivityHints",
            ],
        ),
        expect_string(
            record_field(value, "sessionId"),
            &format!("{label}.sessionId"),
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        expect_boolean(
            record_field(value, "streaming"),
            &format!("{label}.streaming"),
        ),
        expect_integer(
            record_field(value, "runningTools"),
            &format!("{label}.runningTools"),
            0,
        ),
        expect_integer(record_field(value, "queue"), &format!("{label}.queue"), 0),
        optional_string(
            record_field(value, "recap"),
            &format!("{label}.recap"),
            CLOUD_MAX_META_CHARS,
        ),
        record_field(value, "taskState").and_then(|task_state| {
            expect_one_of(
                Some(task_state),
                &format!("{label}.taskState"),
                "needs_input, completed",
            )
        }),
        optional_string(
            record_field(value, "model"),
            &format!("{label}.model"),
            CLOUD_MAX_MODEL_ID_CHARS,
        ),
        connectivity_hints_problem(
            record_field(value, "connectivityHints"),
            &format!("{label}.connectivityHints"),
        ),
    ])
}

/// TS `connectivityHintsProblem`.
fn connectivity_hints_problem(value: Option<&Value>, label: &str) -> Option<String> {
    let value = value?;
    let Some(hints) = value.as_array() else {
        return Some(format!("{label} must be an array"));
    };
    if hints.len() > CLOUD_MAX_CAPABILITIES {
        return Some(format!(
            "{label} must hold at most {CLOUD_MAX_CAPABILITIES} entries"
        ));
    }
    for (index, hint) in hints.iter().enumerate() {
        if let Some(problem) = expect_string(
            Some(hint),
            &format!("{label}[{index}]"),
            CLOUD_MAX_META_CHARS,
            1,
        ) {
            return Some(problem);
        }
    }
    None
}

/// TS `rosterRowProblem`.
fn roster_row_problem(value: &Value, label: &str) -> Option<String> {
    if !value.is_object() {
        return Some(format!("{label} must be an object"));
    }
    first_problem([
        expect_fields(
            value,
            &[
                "childId",
                "parentRemoteId",
                "name",
                "status",
                "depth",
                "preview",
            ],
        ),
        expect_string(
            record_field(value, "childId"),
            &format!("{label}.childId"),
            CLOUD_MAX_ID_CHARS,
            1,
        ),
        record_field(value, "parentRemoteId").and_then(|parent| {
            expect_string(
                Some(parent),
                &format!("{label}.parentRemoteId"),
                CLOUD_MAX_ID_CHARS,
                1,
            )
        }),
        optional_string(
            record_field(value, "name"),
            &format!("{label}.name"),
            CLOUD_MAX_SESSION_NAME_CHARS,
        ),
        expect_one_of(
            record_field(value, "status"),
            &format!("{label}.status"),
            "queued, running, completed, failed, cancelled",
        ),
        expect_integer(record_field(value, "depth"), &format!("{label}.depth"), 0),
        optional_string(
            record_field(value, "preview"),
            &format!("{label}.preview"),
            CLOUD_MAX_PREVIEW_CHARS,
        ),
    ])
}

/// TS `rosterDeltaProblem`.
fn roster_delta_problem(value: &Value, label: &str) -> Option<String> {
    let base = expect_fields(value, &["sequence", "kind", "recordedAt", "rows"]);
    if base.is_some() {
        return base;
    }
    let Some(rows) = record_field(value, "rows") else {
        return Some(format!("{label}.rows must be an array"));
    };
    let Some(rows) = rows.as_array() else {
        return Some(format!("{label}.rows must be an array"));
    };
    if rows.len() > CLOUD_MAX_ROSTER_ROWS {
        return Some(format!(
            "{label}.rows must hold at most {CLOUD_MAX_ROSTER_ROWS} entries"
        ));
    }
    for (index, row) in rows.iter().enumerate() {
        if let Some(problem) = roster_row_problem(row, &format!("{label}.rows[{index}]")) {
            return Some(problem);
        }
    }
    None
}

/// TS `usageTotalsProblem`.
fn usage_totals_problem(value: &Value, label: &str) -> Option<String> {
    if !value.is_object() {
        return Some(format!("{label} must be an object"));
    }
    first_problem([
        expect_fields(
            value,
            &["inputTokens", "outputTokens", "cachedTokens", "requests"],
        ),
        expect_integer(
            record_field(value, "inputTokens"),
            &format!("{label}.inputTokens"),
            0,
        ),
        expect_integer(
            record_field(value, "outputTokens"),
            &format!("{label}.outputTokens"),
            0,
        ),
        record_field(value, "cachedTokens")
            .and_then(|cached| expect_integer(Some(cached), &format!("{label}.cachedTokens"), 0)),
        expect_integer(
            record_field(value, "requests"),
            &format!("{label}.requests"),
            0,
        ),
    ])
}
