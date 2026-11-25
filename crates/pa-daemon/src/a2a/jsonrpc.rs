//! JSON-RPC 2.0 framing for the A2A JSON-RPC binding (spec section 9):
//! one request per POST body, A2A errors in the -32001..-32009 range with
//! a `google.rpc.ErrorInfo` detail (spec 5.4, 9.5).

use serde_json::{json, Value};

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

/// One parsed request.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

/// Parse one request body. `Err` is the error response to send (with a
/// null id, since the request's id is unknowable or malformed).
pub fn parse_request(body: &Value) -> Result<Request, Value> {
    let invalid = || error_response(&Value::Null, INVALID_REQUEST, "Invalid Request", None);
    let object = body.as_object().ok_or_else(invalid)?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(invalid());
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    // Notifications (no id) have no A2A meaning; ids are strings, numbers,
    // or null.
    let id = object.get("id").cloned().ok_or_else(invalid)?;
    if !(id.is_string() || id.is_number() || id.is_null()) {
        return Err(invalid());
    }
    Ok(Request {
        id,
        method: method.to_string(),
        params: object.get("params").cloned().unwrap_or_else(|| json!({})),
    })
}

#[must_use]
pub fn response(id: &Value, result: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

#[must_use]
pub fn error_response(id: &Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message });
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

/// The invalid-params error with a `google.rpc.BadRequest` detail.
#[must_use]
pub fn invalid_params(id: &Value, field: &str, description: &str) -> Value {
    error_response(
        id,
        INVALID_PARAMS,
        "Invalid parameters",
        Some(json!([{
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            "fieldViolations": [{ "field": field, "description": description }],
        }])),
    )
}

/// The A2A-specific errors this server answers (spec 5.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum A2aError {
    TaskNotFound,
    TaskNotCancelable,
    PushNotificationNotSupported,
    UnsupportedOperation,
    ContentTypeNotSupported,
    VersionNotSupported,
}

impl A2aError {
    fn code_message_reason(self) -> (i64, &'static str, &'static str) {
        match self {
            Self::TaskNotFound => (-32001, "Task not found", "TASK_NOT_FOUND"),
            Self::TaskNotCancelable => (-32002, "Task not cancelable", "TASK_NOT_CANCELABLE"),
            Self::PushNotificationNotSupported => (
                -32003,
                "Push notification is not supported",
                "PUSH_NOTIFICATION_NOT_SUPPORTED",
            ),
            Self::UnsupportedOperation => (
                -32004,
                "Operation is not supported",
                "UNSUPPORTED_OPERATION",
            ),
            Self::ContentTypeNotSupported => (
                -32005,
                "Content type is not supported",
                "CONTENT_TYPE_NOT_SUPPORTED",
            ),
            Self::VersionNotSupported => (
                -32009,
                "A2A version is not supported",
                "VERSION_NOT_SUPPORTED",
            ),
        }
    }
}

/// An A2A error response: the table's code and message plus the
/// `ErrorInfo` detail, with optional primitive `metadata`.
#[must_use]
pub fn a2a_error(id: &Value, error: A2aError, metadata: Option<Value>) -> Value {
    let (code, message, reason) = error.code_message_reason();
    let mut info = json!({
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": reason,
        "domain": "a2a-protocol.org",
    });
    if let Some(metadata) = metadata {
        info["metadata"] = metadata;
    }
    error_response(id, code, message, Some(json!([info])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_parse_and_malformed_envelopes_answer_invalid_request() {
        let request = parse_request(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "GetTask", "params": {"id": "t"}
        }))
        .unwrap();
        assert_eq!((request.id, request.method.as_str()), (json!(1), "GetTask"));
        for body in [
            json!({ "jsonrpc": "2.0", "method": "GetTask" }),
            json!({ "id": 1, "method": "GetTask" }),
            json!({ "jsonrpc": "2.0", "id": {"a": 1}, "method": "GetTask" }),
            json!([1]),
        ] {
            let error = parse_request(&body).unwrap_err();
            assert_eq!(error["error"]["code"], INVALID_REQUEST, "{body}");
            assert_eq!(error["id"], Value::Null);
        }
    }

    #[test]
    fn a2a_errors_carry_the_spec_code_and_error_info() {
        let reply = a2a_error(&json!(7), A2aError::TaskNotCancelable, None);
        assert_eq!(reply["error"]["code"], -32002);
        assert_eq!(reply["error"]["data"][0]["reason"], "TASK_NOT_CANCELABLE");
        assert_eq!(
            reply["error"]["data"][0]["@type"],
            "type.googleapis.com/google.rpc.ErrorInfo"
        );
        assert_eq!(
            a2a_error(&json!(1), A2aError::VersionNotSupported, None)["error"]["code"],
            -32009
        );
    }
}
