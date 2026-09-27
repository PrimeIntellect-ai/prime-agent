//! The RPC protocol wire types: the JSONL commands the TS `modes/rpc`
//! surface accepts on stdin and the responses and errors it answers on
//! stdout (`rpc-types.ts`).
//!
//! Loose-shape like the TS handler: an unknown `type` answers the
//! `Unknown command` error; a frame that is not an object with a string
//! `type` answers the `parse` error. Response `data` distinguishes an
//! absent key (TS `success(id, command)`) from a JSON `null` (TS
//! `success(id, command, null)`), which the TS client library treats
//! differently (`cycle_model`'s no-second-model answer).

use serde_json::{json, Map, Value};

/// The RPC response data channel: absent (key omitted) or present
/// (possibly JSON null).
#[derive(Debug, Clone, PartialEq)]
pub enum ResponseData {
    Absent,
    Present(Value),
}

impl From<Value> for ResponseData {
    fn from(value: Value) -> Self {
        ResponseData::Present(value)
    }
}

/// A success response in the TS key order (`id`, `type`, `command`,
/// `success`, `data`): `id` and `data` are omitted when absent, exactly
/// like the TS object literals under `JSON.stringify`.
pub fn success(id: Option<&Value>, command: &str, data: ResponseData) -> Value {
    let mut object = Map::new();
    if let Some(id) = id {
        object.insert("id".to_string(), id.clone());
    }
    object.insert("type".to_string(), json!("response"));
    object.insert("command".to_string(), json!(command));
    object.insert("success".to_string(), json!(true));
    if let ResponseData::Present(data) = data {
        object.insert("data".to_string(), data);
    }
    Value::Object(object)
}

/// An error response: `id` echoed when the command carried one, the
/// TS error text under `error`.
pub fn error(id: Option<&Value>, command: &str, message: &str) -> Value {
    let mut object = Map::new();
    if let Some(id) = id {
        object.insert("id".to_string(), id.clone());
    }
    object.insert("type".to_string(), json!("response"));
    object.insert("command".to_string(), json!(command));
    object.insert("success".to_string(), json!(false));
    object.insert("error".to_string(), json!(message));
    Value::Object(object)
}

/// One parsed inbound command: the echo `id`, the `type`, and the raw
/// payload (every handler reads its fields from it, TS-loose).
#[derive(Debug, Clone)]
pub struct RpcCommand {
    pub id: Option<Value>,
    pub command: String,
    pub payload: Value,
}

/// What one stdin line parsed into.
#[derive(Debug, Clone)]
pub enum ParsedLine {
    Command(RpcCommand),
    /// An `extension_ui_response` line: the TS mode routes it to the
    /// extension-UI bridge first and silently ignores unknown ids.
    ExtensionUiResponse,
    /// The frame failed the JSON or shape parse: the protocol error
    /// response to answer with.
    ParseError(Value),
}

/// Parse one stdin line the way `runRpcModeWithConnectionInternal`'s
/// `handleInputLine` does.
pub fn parse_line(line: &str) -> ParsedLine {
    let trimmed = line.trim();
    let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(parse_error) => {
            return ParsedLine::ParseError(error(
                None,
                "parse",
                &format!("Failed to parse command: {parse_error}"),
            ));
        }
    };
    let Value::Object(object) = parsed else {
        return ParsedLine::ParseError(error(
            None,
            "parse",
            "Invalid command: expected an object with a string type",
        ));
    };
    let command = match object.get("type") {
        Some(Value::String(command)) => command.clone(),
        _ => {
            return ParsedLine::ParseError(error(
                None,
                "parse",
                "Invalid command: expected an object with a string type",
            ));
        }
    };
    if command == "extension_ui_response" {
        return ParsedLine::ExtensionUiResponse;
    }
    ParsedLine::Command(RpcCommand {
        id: object.get("id").cloned().filter(|id| !id.is_null()),
        command,
        payload: Value::Object(object),
    })
}

/// The image attachment of a prompt-family command (TS `ImageContent`:
/// `{type: "image", data, mimeType}`); entries without payload data or
/// a mime type are dropped, not failed.
pub fn command_images(payload: &Value) -> Vec<pa_agent::types::ImageContent> {
    let Some(images) = payload.get("images").and_then(Value::as_array) else {
        return Vec::new();
    };
    images
        .iter()
        .filter_map(|image| {
            if image.get("type").and_then(Value::as_str) != Some("image") {
                return None;
            }
            let data = image.get("data").and_then(Value::as_str)?;
            let mime_type = image.get("mimeType").and_then(Value::as_str)?;
            Some(pa_agent::types::ImageContent {
                data: data.to_string(),
                mime_type: mime_type.to_string(),
            })
        })
        .collect()
}

/// The `streamingBehavior` of a prompt command: `"steer"` or `"followUp"`.
pub fn command_streaming_behavior(
    payload: &Value,
) -> Option<pa_core::session_engine::StreamingBehavior> {
    match payload.get("streamingBehavior").and_then(Value::as_str) {
        Some("steer") => Some(pa_core::session_engine::StreamingBehavior::Steer),
        Some("followUp") => Some(pa_core::session_engine::StreamingBehavior::FollowUp),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_absent_data_omits_the_key() {
        let response = success(None, "prompt", ResponseData::Absent);
        assert_eq!(response["type"], "response");
        assert_eq!(response["command"], "prompt");
        assert_eq!(response["success"], true);
        assert!(response.get("data").is_none(), "absent data omits the key");
        assert!(response.get("id").is_none(), "absent id omits the key");
    }

    #[test]
    fn success_null_data_keeps_the_key() {
        let response = success(
            Some(&json!("cmd-1")),
            "cycle_model",
            ResponseData::Present(Value::Null),
        );
        assert_eq!(response["id"], "cmd-1");
        assert_eq!(response["data"], Value::Null, "null data keeps the key");
    }

    #[test]
    fn parse_errors_carry_the_ts_prefix() {
        match parse_line("{nope") {
            ParsedLine::ParseError(response) => {
                assert_eq!(response["command"], "parse");
                assert_eq!(response["success"], false);
                assert!(
                    response["error"]
                        .as_str()
                        .unwrap()
                        .starts_with("Failed to parse command:"),
                    "the TS error prefix is the contract"
                );
            }
            other => panic!("expected a parse error, got {other:?}"),
        }
        match parse_line("[1, 2]") {
            ParsedLine::ParseError(response) => {
                assert_eq!(
                    response["error"],
                    "Invalid command: expected an object with a string type"
                );
            }
            other => panic!("expected a parse error, got {other:?}"),
        }
    }

    #[test]
    fn commands_parse_with_id_echo() {
        let ParsedLine::Command(command) = parse_line(
            r#"{"id": "q1", "type": "prompt", "message": "hi", "streamingBehavior": "steer"}"#,
        ) else {
            panic!("expected a command");
        };
        assert_eq!(command.id, Some(json!("q1")));
        assert_eq!(command.command, "prompt");
        assert_eq!(
            command_streaming_behavior(&command.payload),
            Some(pa_core::session_engine::StreamingBehavior::Steer)
        );
    }

    #[test]
    fn extension_ui_response_is_a_silent_route() {
        assert!(matches!(
            parse_line(r#"{"type": "extension_ui_response", "id": "ui-1", "value": "x"}"#),
            ParsedLine::ExtensionUiResponse
        ));
    }
}
