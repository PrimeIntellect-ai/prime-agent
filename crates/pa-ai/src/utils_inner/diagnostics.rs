//! Structured diagnostics attached to assistant messages on failures and
//! recoveries. Ported from `packages/ai/src/utils/diagnostics.ts`; the types
//! themselves are the shared [`AssistantMessageDiagnostic`] /
//! [`DiagnosticErrorInfo`] from `pa-types`.

pub use crate::types::{AssistantMessage, AssistantMessageDiagnostic, DiagnosticErrorInfo};

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub fn create_assistant_message_diagnostic(
    diagnostic_type: &str,
    error: Option<DiagnosticErrorInfo>,
    details: Option<serde_json::Value>,
) -> AssistantMessageDiagnostic {
    AssistantMessageDiagnostic {
        type_: diagnostic_type.to_string(),
        timestamp: now_ms(),
        error,
        details: details.and_then(|value| value.as_object().cloned()),
    }
}

/// Append a diagnostic to a message, preserving existing entries.
pub fn append_assistant_message_diagnostic(
    message: &mut AssistantMessage,
    diagnostic: AssistantMessageDiagnostic,
) {
    message
        .diagnostics
        .get_or_insert_with(Vec::new)
        .push(diagnostic);
}
