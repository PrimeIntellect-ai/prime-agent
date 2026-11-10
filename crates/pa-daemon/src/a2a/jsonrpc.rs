//! JSON-RPC 2.0 framing for the A2A JSON-RPC binding (spec section 9):
//! one request body per HTTP POST, the response one of `result` /
//! `error`, A2A-specific errors in the -32001..-32009 range with a
//! `google.rpc.ErrorInfo` detail object per spec 5.4 and 9.5.

use serde_json::{json, Value};

/// The request could not be parsed as JSON (JSON-RPC -32700).
pub const PARSE_ERROR: i64 = -32700;
/// The JSON is valid but not a JSON-RPC request (-32600).
pub const INVALID_REQUEST: i64 = -32600;
/// The method is not part of the served A2A surface (-32601).
pub const METHOD_NOT_FOUND: i64 = -32601;
/// The method exists but a parameter failed validation (-32602).
pub const INVALID_PARAMS: i64 = -32602;
/// A handler failed while processing the request (-32603).
pub const INTERNAL_ERROR: i64 = -32603;

/// The protocol version this server speaks; the `A2A-Version` service
/// parameter must match it (spec 3.6).
pub const PROTOCOL_VERSION: &str = "1.0";
/// The `A2A-Version` HTTP service parameter name (spec 3.2.6).
pub const VERSION_HEADER: &str = "A2A-Version";

/// One incoming JSON-RPC request parsed from a POST body.
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingRequest {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

/// Parse one request body. `Err` carries the error response value to
/// answer with (JSON-RPC requires an answer even for malformed input,
/// with a null `id` when unknowable).
pub fn parse_request(body: &Value) -> Result<IncomingRequest, Value> {
    let Value::Object(object) = body else {
        return Err(error_response(
            &Value::Null,
            INVALID_REQUEST,
            "Invalid Request",
            None,
        ));
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(error_response(
            &Value::Null,
            INVALID_REQUEST,
            "Invalid Request",
            None,
        ));
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Err(error_response(
            &Value::Null,
            INVALID_REQUEST,
            "Invalid Request",
            None,
        ));
    };
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    // JSON-RPC 2.0: a request id is a string, a number, or null (a
    // notification). Object, array, and boolean ids are malformed; the
    // A2A surface answers them before any side effect runs.
    if !id.is_string() && !id.is_number() {
        return Err(error_response(
            &Value::Null,
            INVALID_REQUEST,
            "Invalid Request",
            None,
        ));
    }
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    Ok(IncomingRequest {
        id,
        method: method.to_string(),
        params,
    })
}

/// A success response in the binding's wire order.
#[must_use]
pub fn response(id: &Value, result: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

/// The A2A-specific error table (spec 5.4): one JSON-RPC code per
/// error type, the detail object's `reason` the `UPPER_SNAKE` type
/// name.
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
    /// The JSON-RPC error code (spec 5.4).
    #[must_use]
    pub fn code(self) -> i64 {
        match self {
            Self::TaskNotFound => -32001,
            Self::TaskNotCancelable => -32002,
            Self::PushNotificationNotSupported => -32003,
            Self::UnsupportedOperation => -32004,
            Self::ContentTypeNotSupported => -32005,
            Self::VersionNotSupported => -32009,
        }
    }

    /// The human-readable error message.
    #[must_use]
    pub fn message(self) -> &'static str {
        match self {
            Self::TaskNotFound => "Task not found",
            Self::TaskNotCancelable => "Task not cancelable",
            Self::PushNotificationNotSupported => "Push notification is not supported",
            Self::UnsupportedOperation => "Operation is not supported",
            Self::ContentTypeNotSupported => "Content type is not supported",
            Self::VersionNotSupported => "A2A version is not supported",
        }
    }

    /// The `google.rpc.ErrorInfo` reason (spec 5.4): the error type in
    /// `UPPER_SNAKE` without the "Error" suffix.
    #[must_use]
    pub fn reason(self) -> &'static str {
        match self {
            Self::TaskNotFound => "TASK_NOT_FOUND",
            Self::TaskNotCancelable => "TASK_NOT_CANCELABLE",
            Self::PushNotificationNotSupported => "PUSH_NOTIFICATION_NOT_SUPPORTED",
            Self::UnsupportedOperation => "UNSUPPORTED_OPERATION",
            Self::ContentTypeNotSupported => "CONTENT_TYPE_NOT_SUPPORTED",
            Self::VersionNotSupported => "VERSION_NOT_SUPPORTED",
        }
    }
}

/// A generic JSON-RPC error response (`-32xxx` protocol codes).
#[must_use]
pub fn error_response(id: &Value, code: i64, message: &str, data: Option<&Value>) -> Value {
    let mut error = json!({
        "code": code,
        "message": message,
    });
    if let Some(data) = data {
        error["data"] = data.clone();
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": error,
    })
}

/// The `Invalid parameters` envelope with a typed detail (spec 9.5:
/// `error.data`, when present, is an array of objects and each object
/// carries `@type` — the `ProtoJSON` `Any` form; the spec's own example
/// attaches a `google.rpc.BadRequest` to a validation failure). The
/// reason rides the violated field's violation — never a bare map.
#[must_use]
pub fn invalid_params_response(id: &Value, field: &str, description: &str) -> Value {
    error_response(
        id,
        INVALID_PARAMS,
        "Invalid parameters",
        Some(&json!([{
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            "fieldViolations": [{ "field": field, "description": description }],
        }])),
    )
}

/// An A2A-specific error response: the table's code and message with the
/// `google.rpc.ErrorInfo` detail the spec's error envelope carries (spec
/// 9.5), plus optional `metadata` primitives for context (e.g. the task
/// id). Never user or session content.
#[must_use]
pub fn a2a_error_response(id: &Value, error: A2aError, metadata: Option<&Value>) -> Value {
    let mut info = json!({
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": error.reason(),
        "domain": "a2a-protocol.org",
    });
    if let Some(metadata) = metadata {
        info["metadata"] = metadata.clone();
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": error.code(),
            "message": error.message(),
            "data": [info],
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_parseable_request_carries_id_method_params() {
        let request = parse_request(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "SendMessage",
            "params": { "message": { "role": "ROLE_USER", "parts": [] } }
        }))
        .expect("valid request");
        assert_eq!(request.method, "SendMessage");
        assert_eq!(request.id, json!(1));
    }

    #[test]
    fn a_missing_id_or_version_is_an_invalid_request_error() {
        let no_id = parse_request(&json!({ "jsonrpc": "2.0", "method": "GetTask" }))
            .expect_err("notification shape");
        assert_eq!(no_id["error"]["code"], INVALID_REQUEST);

        let no_version =
            parse_request(&json!({ "id": 1, "method": "GetTask" })).expect_err("missing version");
        assert_eq!(no_version["error"]["code"], INVALID_REQUEST);
        assert_eq!(no_version["id"], Value::Null);
    }

    /// JSON-RPC 2.0 pins the id to string/number/null: object, array,
    /// and boolean ids are rejected before dispatch (no side effects).
    #[test]
    fn malformed_request_ids_are_invalid_requests() {
        for id in [json!({ "id": 1 }), json!([1, 2]), json!(true), json!(false)] {
            let request = json!({ "jsonrpc": "2.0", "id": id, "method": "GetTask" });
            let reply = parse_request(&request).expect_err("malformed id");
            assert_eq!(reply["error"]["code"], INVALID_REQUEST, "id {id}");
            assert_eq!(reply["id"], Value::Null, "the reply id is null: {id}");
        }
        // The legal shapes still parse.
        for id in [json!("abc"), json!(1), json!(-7)] {
            let request = json!({ "jsonrpc": "2.0", "id": id, "method": "GetTask" });
            assert!(parse_request(&request).is_ok(), "id {id}");
        }
    }

    #[test]
    fn the_a2a_error_envelope_carries_the_errorinfo_detail() {
        let response = a2a_error_response(
            &json!(7),
            A2aError::VersionNotSupported,
            Some(&json!({ "requested": "0.3" })),
        );
        assert_eq!(response["id"], json!(7));
        assert_eq!(response["error"]["code"], -32009);
        assert_eq!(response["error"]["message"], "A2A version is not supported");
        assert_eq!(
            response["error"]["data"][0]["reason"],
            "VERSION_NOT_SUPPORTED"
        );
        assert_eq!(response["error"]["data"][0]["domain"], "a2a-protocol.org");
        assert_eq!(
            response["error"]["data"][0]["@type"],
            "type.googleapis.com/google.rpc.ErrorInfo"
        );
        assert_eq!(response["error"]["data"][0]["metadata"]["requested"], "0.3");
    }

    #[test]
    fn the_error_table_matches_the_spec_codes() {
        let table = [
            (A2aError::TaskNotFound, -32001, "TASK_NOT_FOUND"),
            (A2aError::TaskNotCancelable, -32002, "TASK_NOT_CANCELABLE"),
            (
                A2aError::PushNotificationNotSupported,
                -32003,
                "PUSH_NOTIFICATION_NOT_SUPPORTED",
            ),
            (
                A2aError::UnsupportedOperation,
                -32004,
                "UNSUPPORTED_OPERATION",
            ),
            (
                A2aError::ContentTypeNotSupported,
                -32005,
                "CONTENT_TYPE_NOT_SUPPORTED",
            ),
            (
                A2aError::VersionNotSupported,
                -32009,
                "VERSION_NOT_SUPPORTED",
            ),
        ];
        for (error, code, reason) in table {
            assert_eq!(error.code(), code, "{error:?}");
            assert_eq!(error.reason(), reason, "{error:?}");
        }
    }

    /// The generic `-32602` detail is the spec's `Any` form (spec 9.5:
    /// `error.data` is an array of objects, each carrying `@type`),
    /// never a bare map — a `BadRequest` violation names the field.
    #[test]
    fn an_invalid_params_response_carries_typed_detail_objects() {
        let response = invalid_params_response(
            &json!(3),
            "message.parts",
            "message.parts must not be empty",
        );
        assert_eq!(response["error"]["code"], INVALID_PARAMS);
        let data = response["error"]["data"]
            .as_array()
            .expect("error.data is an array");
        assert_eq!(data.len(), 1);
        assert_eq!(
            data[0]["@type"],
            "type.googleapis.com/google.rpc.BadRequest"
        );
        assert_eq!(data[0]["fieldViolations"][0]["field"], "message.parts");
        assert_eq!(
            data[0]["fieldViolations"][0]["description"],
            "message.parts must not be empty"
        );
    }
}
