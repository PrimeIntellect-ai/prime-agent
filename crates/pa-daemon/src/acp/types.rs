//! ACP wire types: the five-method surface, `session/update` payload shapes,
//! and prompt-block parsing.
//!
//! The served surface is exactly what the TS product serves: `initialize`,
//! `session/new`, `session/prompt`, `session/close` (requests),
//! `session/cancel` (notification), and the outgoing `session/update`
//! notification. ACP-spec methods the TS product does not serve
//! (`session/load`, `session/read`, `session/clone`, cwd adoption) are not
//! invented here.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The `initialize` result payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: u64,
    pub agent_capabilities: AgentCapabilities,
    pub agent_info: AgentInfo,
    #[serde(rename = "_meta")]
    pub meta: Value,
}

/// What the agent can do, advertised in `initialize`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub load_session: bool,
    pub prompt_capabilities: PromptCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_capabilities: Option<McpCapabilities>,
    pub session_capabilities: SessionCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCapabilities {
    pub image: bool,
    pub embedded_context: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpCapabilities {
    pub http: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionCapabilities {
    pub close: CloseCapability,
}

/// `{}`: present means `session/close` is served.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CloseCapability {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

/// The agent-facing classification of a tool call (`kind` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AcpToolKind {
    #[serde(rename = "read")]
    Read,
    #[serde(rename = "edit")]
    Edit,
    #[serde(rename = "delete")]
    Delete,
    #[serde(rename = "move")]
    Move,
    #[serde(rename = "search")]
    Search,
    #[serde(rename = "execute")]
    Execute,
    #[serde(rename = "think")]
    Think,
    #[serde(rename = "fetch")]
    Fetch,
    #[serde(rename = "other")]
    Other,
}

impl AcpToolKind {
    /// The TS kind map: the model-facing tool is the Python REPL; bash is the
    /// secondary escape hatch.
    pub fn of_tool(tool_name: &str) -> AcpToolKind {
        match tool_name {
            "ipython" | "bash" => AcpToolKind::Execute,
            "read" => AcpToolKind::Read,
            "edit" | "write" => AcpToolKind::Edit,
            _ => AcpToolKind::Other,
        }
    }
}

/// The lifecycle status of a tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// The terminal stop reason of a `session/prompt` request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AcpStopReason {
    #[serde(rename = "end_turn")]
    EndTurn,
    #[serde(rename = "max_tokens")]
    MaxTokens,
    #[serde(rename = "max_turn_requests")]
    MaxTurnRequests,
    #[serde(rename = "refusal")]
    Refusal,
    #[serde(rename = "cancelled")]
    Cancelled,
}

/// The `session/prompt` result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AcpStopReasonResponse {
    #[serde(rename = "stopReason")]
    pub stop_reason: AcpStopReason,
}

/// The `session/update` payload body (the `update` object).
///
/// Every variant carries its TS `sessionUpdate` tag; fields are the exact
/// wire names ACP clients read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "sessionUpdate")]
pub enum AcpSessionUpdate {
    /// A streaming chunk of the assistant's visible answer.
    #[serde(rename = "agent_message_chunk")]
    AgentMessageChunk {
        #[serde(rename = "messageId")]
        message_id: String,
        content: TextBlock,
    },
    /// A streaming chunk of the assistant's reasoning.
    #[serde(rename = "agent_thought_chunk")]
    AgentThoughtChunk {
        #[serde(rename = "messageId")]
        message_id: String,
        content: TextBlock,
    },
    /// A tool call started executing.
    #[serde(rename = "tool_call")]
    ToolCall {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        title: String,
        kind: AcpToolKind,
        status: AcpToolStatus,
        #[serde(rename = "rawInput")]
        raw_input: Value,
    },
    /// A tool call progressed or finished.
    #[serde(rename = "tool_call_update")]
    ToolCallUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<AcpToolStatus>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Vec<ToolCallContent>>,
        #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    /// Namespaced prime-agent state (compaction, quiescence, ...).
    #[serde(rename = "session_info_update")]
    SessionInfoUpdate {
        #[serde(rename = "_meta")]
        meta: Value,
    },
}

impl AcpSessionUpdate {
    /// Serialize to the wire value. `ToolCallUpdate::meta` carries a
    /// namespaced `_meta` payload (see [`meta::prime_agent_meta`]); the
    /// producer merges its correlation fields into that payload afterwards.
    pub fn to_bare_value(&self) -> Value {
        serde_json::to_value(self).expect("session updates serialize")
    }
}

/// `{ "type": "text", "text": ... }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextBlock {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

impl TextBlock {
    pub fn new(text: impl Into<String>) -> Self {
        TextBlock {
            kind: "text".to_string(),
            text: text.into(),
        }
    }
}

/// `{ "type": "content", "content": { ... } }` — the tool-call update shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallContent {
    #[serde(rename = "type")]
    pub kind: String,
    pub content: TextBlock,
}

impl ToolCallContent {
    pub fn new(text: impl Into<String>) -> Self {
        ToolCallContent {
            kind: "content".to_string(),
            content: TextBlock::new(text),
        }
    }
}

/// A prompt whose blocks could not be admitted.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PromptBlockError {
    #[error("image block requires base64 `data` and `mimeType` strings")]
    InvalidImage,
}

/// Split ACP prompt blocks into the text and images the agent accepts.
///
/// Image, embedded-resource, and resource-link blocks are advertised in
/// `initialize`, so they must actually reach the model: dropping them
/// silently would let a client believe a pasted screenshot was accepted.
/// Embedded text resources become context the model can read.
pub fn parse_prompt_blocks(
    prompt: &[Value],
) -> Result<(String, Vec<ImageBlock>), PromptBlockError> {
    let mut texts: Vec<String> = Vec::new();
    let mut images: Vec<ImageBlock> = Vec::new();
    for block in prompt {
        let Some(object) = block.as_object() else {
            continue;
        };
        let kind = object.get("type").and_then(Value::as_str);
        match kind {
            Some("text") => {
                if let Some(text) = object.get("text").and_then(Value::as_str) {
                    texts.push(text.to_string());
                }
            }
            Some("image") => {
                let data = object.get("data").and_then(Value::as_str);
                let mime_type = object.get("mimeType").and_then(Value::as_str);
                match (data, mime_type) {
                    (Some(data), Some(mime_type)) => images.push(ImageBlock {
                        data: data.to_string(),
                        mime_type: mime_type.to_string(),
                    }),
                    _ => return Err(PromptBlockError::InvalidImage),
                }
            }
            Some("resource") => {
                let resource = object.get("resource");
                let text = resource.and_then(|r| r.get("text")).and_then(Value::as_str);
                let uri = resource.and_then(|r| r.get("uri")).and_then(Value::as_str);
                if let Some(text) = text {
                    let uri = uri.map(|uri| format!("{uri}\n")).unwrap_or_default();
                    texts.push(format!("{uri}{text}"));
                }
            }
            Some("resource_link") => {
                if let Some(uri) = object.get("uri").and_then(Value::as_str) {
                    texts.push(uri.to_string());
                }
            }
            _ => {}
        }
    }
    Ok((texts.join("\n"), images))
}

/// An image block admitted into a prompt.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageBlock {
    pub data: String,
    pub mime_type: String,
}

/// The `session/new` request params.
#[derive(Debug, Clone, PartialEq)]
pub struct NewSessionParams {
    pub cwd: Option<String>,
    pub mcp_servers: Vec<Value>,
}

impl NewSessionParams {
    /// Parse `session/new` params. Unknown fields are ignored, matching the
    /// TS SDK's tolerance of forward-compatible params.
    pub fn parse(params: &Value) -> NewSessionParams {
        NewSessionParams {
            cwd: params.get("cwd").and_then(Value::as_str).map(String::from),
            mcp_servers: params
                .get("mcpServers")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }
    }
}

/// The `session/prompt` request params.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptParams {
    pub session_id: String,
    pub prompt: Vec<Value>,
}

impl PromptParams {
    pub fn parse(params: &Value) -> PromptParams {
        PromptParams {
            session_id: params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            prompt: params
                .get("prompt")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }
    }
}

/// A bare `{ "sessionId": ... }` params reader shared by close and cancel.
pub fn session_id_params(params: &Value) -> String {
    params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// The initialize result with the served capability set.
pub fn initialize_result(product_version: &str) -> InitializeResult {
    InitializeResult {
        protocol_version: 1,
        agent_capabilities: AgentCapabilities {
            load_session: false,
            prompt_capabilities: PromptCapabilities {
                image: true,
                embedded_context: true,
            },
            mcp_capabilities: Some(McpCapabilities { http: true }),
            session_capabilities: SessionCapabilities {
                close: CloseCapability::default(),
            },
        },
        agent_info: AgentInfo {
            name: "prime-agent".to_string(),
            title: "Prime Agent".to_string(),
            version: product_version.to_string(),
        },
        meta: super::meta::prime_agent_meta(super::meta::PrimeAgentSessionMeta::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initialize_result_matches_the_served_surface() {
        let value = serde_json::to_value(initialize_result("9.9.9")).unwrap();
        assert_eq!(
            value,
            json!({
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": false,
                    "promptCapabilities": { "image": true, "embeddedContext": true },
                    "mcpCapabilities": { "http": true },
                    "sessionCapabilities": { "close": {} },
                },
                "agentInfo": { "name": "prime-agent", "title": "Prime Agent", "version": "9.9.9" },
                "_meta": { "ai.primeintellect.prime-agent": {} },
            })
        );
    }

    #[test]
    fn tool_kind_map_matches_the_ts_map() {
        assert_eq!(AcpToolKind::of_tool("ipython"), AcpToolKind::Execute);
        assert_eq!(AcpToolKind::of_tool("bash"), AcpToolKind::Execute);
        assert_eq!(AcpToolKind::of_tool("read"), AcpToolKind::Read);
        assert_eq!(AcpToolKind::of_tool("edit"), AcpToolKind::Edit);
        assert_eq!(AcpToolKind::of_tool("write"), AcpToolKind::Edit);
        assert_eq!(AcpToolKind::of_tool("fetch"), AcpToolKind::Other);
    }

    #[test]
    fn prompt_blocks_split_text_and_images() {
        let prompt = json!([
            { "type": "text", "text": "hello" },
            { "type": "image", "data": "AAAA", "mimeType": "image/png" },
            { "type": "resource", "resource": { "uri": "file:///x", "text": "body" } },
            { "type": "resource_link", "uri": "https://example" },
            { "type": "unknown", "nonsense": true },
        ]);
        let (text, images) = parse_prompt_blocks(prompt.as_array().unwrap()).unwrap();
        assert_eq!(text, "hello\nfile:///x\nbody\nhttps://example");
        assert_eq!(
            images,
            vec![ImageBlock {
                data: "AAAA".into(),
                mime_type: "image/png".into()
            }]
        );
    }

    #[test]
    fn malformed_image_block_is_rejected() {
        let prompt = json!([{ "type": "image", "data": "AAAA" }]);
        let error = parse_prompt_blocks(prompt.as_array().unwrap()).unwrap_err();
        assert_eq!(error, PromptBlockError::InvalidImage);
    }

    #[test]
    fn update_variants_carry_the_ts_tags() {
        let chunk = AcpSessionUpdate::AgentMessageChunk {
            message_id: "m1".into(),
            content: TextBlock::new("hi"),
        };
        assert_eq!(
            chunk.to_bare_value()["sessionUpdate"],
            "agent_message_chunk"
        );
        let call = AcpSessionUpdate::ToolCall {
            tool_call_id: "t1".into(),
            title: "Python cell".into(),
            kind: AcpToolKind::Execute,
            status: AcpToolStatus::InProgress,
            raw_input: json!({ "code": "1+1" }),
        };
        let value = call.to_bare_value();
        assert_eq!(value["sessionUpdate"], "tool_call");
        assert_eq!(value["kind"], "execute");
        assert_eq!(value["status"], "in_progress");
        let update = AcpSessionUpdate::ToolCallUpdate {
            tool_call_id: "t1".into(),
            status: Some(AcpToolStatus::Completed),
            content: Some(vec![ToolCallContent::new("42")]),
            meta: None,
        };
        let value = update.to_bare_value();
        assert_eq!(value["sessionUpdate"], "tool_call_update");
        assert_eq!(value["status"], "completed");
        assert_eq!(value["content"][0]["type"], "content");
        assert_eq!(value["content"][0]["content"]["text"], "42");
    }
}
