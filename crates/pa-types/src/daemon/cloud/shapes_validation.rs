//! Validators shared by the event and frame validators (TS `receiptProblem`,
//! `cursorProblem`, `capabilitiesProblem`): exact problem strings, exact
//! check order.

use serde_json::Value;

use super::base::{CLOUD_CAPABILITY_KINDS, CLOUD_COMMAND_STATES};
use super::checks::{
    expect_boolean, expect_digest, expect_fields, expect_integer, expect_one_of, expect_string,
    first_problem, optional_string, record_field,
};
use super::{
    cloud_id_problem, CLOUD_MAX_CAPABILITIES, CLOUD_MAX_ERROR_CHARS,
    CLOUD_MAX_RECEIPT_RESULT_CHARS, CLOUD_MAX_TIMESTAMP_CHARS,
};

/// TS `receiptProblem`.
pub(super) fn receipt_problem(value: Option<&Value>, label: &str) -> Option<String> {
    let Some(value) = value else {
        return Some(format!("{label} must be an object"));
    };
    if !value.is_object() {
        return Some(format!("{label} must be an object"));
    }
    first_problem([
        expect_fields(
            value,
            &[
                "commandId",
                "digest",
                "state",
                "submittedAt",
                "updatedAt",
                "uncertain",
                "error",
                "result",
            ],
        ),
        cloud_id_problem(
            record_field(value, "commandId"),
            &format!("{label}.commandId"),
        ),
        expect_digest(record_field(value, "digest"), &format!("{label}.digest")),
        expect_one_of(
            record_field(value, "state"),
            &format!("{label}.state"),
            CLOUD_COMMAND_STATES,
        ),
        expect_string(
            record_field(value, "submittedAt"),
            &format!("{label}.submittedAt"),
            CLOUD_MAX_TIMESTAMP_CHARS,
            1,
        ),
        expect_string(
            record_field(value, "updatedAt"),
            &format!("{label}.updatedAt"),
            CLOUD_MAX_TIMESTAMP_CHARS,
            1,
        ),
        expect_boolean(
            record_field(value, "uncertain"),
            &format!("{label}.uncertain"),
        ),
        record_field(value, "error").and_then(|error| {
            expect_string(
                Some(error),
                &format!("{label}.error"),
                CLOUD_MAX_ERROR_CHARS,
                1,
            )
        }),
        optional_string(
            record_field(value, "result"),
            &format!("{label}.result"),
            CLOUD_MAX_RECEIPT_RESULT_CHARS,
        ),
    ])
}

/// TS `cursorProblem`.
pub(super) fn cursor_problem(value: Option<&Value>, label: &str) -> Option<String> {
    let Some(value) = value else {
        return Some(format!("{label} must be an object"));
    };
    if !value.is_object() {
        return Some(format!("{label} must be an object"));
    }
    first_problem([
        expect_fields(value, &["generation", "sequence"]),
        expect_integer(
            record_field(value, "generation"),
            &format!("{label}.generation"),
            1,
        ),
        expect_integer(
            record_field(value, "sequence"),
            &format!("{label}.sequence"),
            0,
        ),
    ])
}

/// TS `capabilitiesProblem`.
pub(super) fn capabilities_problem(value: Option<&Value>, label: &str) -> Option<String> {
    let value = value?;
    let Some(entries) = value.as_array() else {
        return Some(format!("{label} must be an array"));
    };
    if entries.len() > CLOUD_MAX_CAPABILITIES {
        return Some(format!(
            "{label} must hold at most {CLOUD_MAX_CAPABILITIES} entries"
        ));
    }
    for entry in entries {
        if let Some(problem) = expect_one_of(
            Some(entry),
            &format!("{label} entry"),
            CLOUD_CAPABILITY_KINDS,
        ) {
            return Some(problem);
        }
    }
    None
}
