//! Agent messaging and observation host requests: validation helpers, message
//! ids and prompts, controller traits, and kernel host-handler registration.
//! Port of core/agent-messages.ts (validation/prompt half) and
//! core/agent-observe.ts.

use std::future::Future;

use serde_json::{json, Value};

use crate::kernel::shared::{host_handler, HostRequestHandlers};

pub const AGENT_MESSAGE_CUSTOM_TYPE: &str = "agent_message";
/// TS `AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL`: the queue-strip preview label
/// for a delivered agent message (`queuedAgentMessagePreview` renders
/// "<label>: <details.message>").
pub const AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL: &str = "Agent message received";
pub const AGENT_MESSAGE_SOURCE: &str = "agent_message";
pub const AGENT_MESSAGE_ID_PREFIX: &str = "agentmsg_";
pub const DEFAULT_AGENT_MESSAGE_MAX_CHARS: usize = 16_384;
pub const DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION: usize = 20;
/// The per-sender token bucket capacity (TS
/// `DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY`): three deliveries burst
/// before the refill paces them.
pub const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY: usize = 3;
/// One rate-limit token per sender per this window (TS
/// `DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS`).
pub const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS: u64 = 1_000;

pub const AGENT_OBSERVE_PREVIEW_MAX_CHARS: usize = 240;
pub const AGENT_OBSERVE_IMPORT_NAME: &str = "agent_observe";

/// Family relationships between agents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentFamilyRelationship {
    Parent,
    Sibling,
    Child,
}

impl std::fmt::Display for AgentFamilyRelationship {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl AgentFamilyRelationship {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentFamilyRelationship::Parent => "parent",
            AgentFamilyRelationship::Sibling => "sibling",
            AgentFamilyRelationship::Child => "child",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "parent" => Some(AgentFamilyRelationship::Parent),
            "sibling" => Some(AgentFamilyRelationship::Sibling),
            "child" => Some(AgentFamilyRelationship::Child),
            _ => None,
        }
    }
}

/// Delivery status for a sent agent message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentMessageDeliveryStatus {
    Delivered,
    Queued,
}

impl AgentMessageDeliveryStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentMessageDeliveryStatus::Delivered => "delivered",
            AgentMessageDeliveryStatus::Queued => "queued",
        }
    }
}

/// `agent_message.send` input.
#[derive(Debug, Clone)]
pub struct AgentMessageSendInput {
    pub target: String,
    pub message: String,
    pub receiver_role: Option<AgentFamilyRelationship>,
}

/// The receipt returned after sending an agent message.
#[derive(Debug, Clone)]
pub struct AgentMessageReceipt {
    pub id: String,
    /// The target's active session id (TS `target.activeSessionId`).
    pub target: String,
    /// The target endpoint's session id (TS `target.sessionId`).
    pub target_session_id: Option<String>,
    pub target_session_name: Option<String>,
    pub target_runtime_kind: Option<String>,
    pub message: String,
    pub delivery_status: AgentMessageDeliveryStatus,
    pub delivery_mode: Option<&'static str>,
    pub receiver_role: Option<AgentFamilyRelationship>,
    pub delivered_at: Option<String>,
    pub queued_at: Option<String>,
}

/// One addressable family member (TS `AgentFamilyMember`): a parent,
/// sibling, or child of this session, keyed by a routable target selector.
#[derive(Debug, Clone)]
pub struct AgentFamilyMember {
    pub relationship: AgentFamilyRelationship,
    /// The target selector the controller can deliver to (session id for
    /// local family members, the active session id for peers served by
    /// another worker).
    pub id: String,
    pub name: Option<String>,
    /// Extra selector forms that resolve to this same member (empty for
    /// the TS shape). The supervisor-backed controller lists a child's
    /// RLM child id and persisted session id here so every identifier the
    /// roster exposes addresses the child, while broadcast sends stay
    /// one-per-member.
    pub aliases: Vec<String>,
}

impl AgentFamilyMember {
    /// TS `agentFamilyMemberName`: the name, else the id.
    pub fn member_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.id)
    }

    /// Whether `selector` addresses this member by name, id, or alias.
    fn matches_selector(&self, selector: &str) -> bool {
        self.member_name() == selector
            || self.id == selector
            || self.aliases.iter().any(|alias| alias == selector)
    }
}

/// The controller the daemon supplies for `agent_message.*` requests.
pub trait AgentMessageController: Send + Sync {
    /// The addressable family (TS `controller.family()`): the parent,
    /// siblings, and children of this session, excluding the session itself.
    fn family(&self) -> impl Future<Output = anyhow::Result<Vec<AgentFamilyMember>>> + Send;
    fn send_agent_message(
        &self,
        input: AgentMessageSendInput,
    ) -> impl Future<Output = anyhow::Result<AgentMessageReceipt>> + Send;
}

/// Message payload for the rendered `[agent-message from ...]` prompt.
#[derive(Debug, Clone, Default)]
pub struct AgentMessagePromptPayload {
    pub message: String,
    pub sender_name: String,
    pub from_relationship: Option<AgentFamilyRelationship>,
}

pub fn create_agent_session_message_id() -> String {
    format!("{AGENT_MESSAGE_ID_PREFIX}{}", uuid::Uuid::new_v4())
}

/// Distinguishes agent-to-agent ids from synthetic prompt ids.
pub fn is_agent_session_message_id(id: Option<&str>) -> bool {
    id.is_some_and(|id| id.starts_with(AGENT_MESSAGE_ID_PREFIX))
}

/// Normalize and validate an outgoing message body.
///
/// # Errors
///
/// Returns an error when the message is empty after trimming or longer
/// than the default message limit.
pub fn normalize_agent_session_message(message: &str) -> anyhow::Result<String> {
    normalize_agent_session_message_limited(message, DEFAULT_AGENT_MESSAGE_MAX_CHARS)
}

/// Normalize and validate an outgoing message body with an explicit
/// character limit.
///
/// # Errors
///
/// Returns an error when the message is empty after trimming or longer
/// than `max_chars`.
pub fn normalize_agent_session_message_limited(
    message: &str,
    max_chars: usize,
) -> anyhow::Result<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Agent session message cannot be empty");
    }
    if trimmed.chars().count() > max_chars {
        anyhow::bail!(
            "Agent session message is too long: {} chars exceeds {max_chars}",
            trimmed.chars().count()
        );
    }
    Ok(trimmed.to_string())
}

/// Reject broadcast targets: only direct messaging is supported.
/// Normalize a direct-messaging target and reject broadcast wildcards.
///
/// # Errors
///
/// Returns an error when the target is empty after trimming or names the
/// broadcast wildcard.
pub fn assert_direct_agent_message_target(target: &str) -> anyhow::Result<String> {
    let normalized = target.trim();
    if normalized.is_empty() {
        anyhow::bail!("Agent message target cannot be empty");
    }
    if normalized == "*"
        || normalized.eq_ignore_ascii_case("all")
        || normalized.eq_ignore_ascii_case("broadcast")
    {
        anyhow::bail!("Broadcast agent messaging is not supported");
    }
    Ok(normalized.to_string())
}

/// Guard the target session's pending-work capacity.
///
/// # Errors
///
/// Returns an error when the target's unfinished action count has reached
/// the pending-work limit.
pub fn assert_agent_message_queue_capacity(
    unfinished_action_count: usize,
    max_pending: usize,
) -> anyhow::Result<()> {
    if unfinished_action_count >= max_pending {
        anyhow::bail!(
            "Target session has too many pending messages: {unfinished_action_count} unfinished, limit is {max_pending}"
        );
    }
    Ok(())
}

/// Names interpolated into a `[<kind> ...]` header line must not carry the
/// characters that delimit the header itself (brackets, newlines, commas,
/// or the relationship separator ":"): runs of those collapse into one
/// space, then the value trims (TS `sanitizeMessageHeaderValue`).
pub(crate) fn sanitize_message_header_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for char in value.chars() {
        let delimiter = char.is_whitespace() || matches!(char, ',' | ':' | '[' | ']');
        if delimiter {
            pending_space = true;
        } else {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(char);
        }
    }
    out
}

/// The rendered prompt a receiving context sees.
pub fn create_agent_session_message_prompt(payload: &AgentMessagePromptPayload) -> String {
    let sender = sanitize_message_header_value(&payload.sender_name);
    let sender = if sender.is_empty() {
        "unknown".to_string()
    } else {
        sender
    };
    let sender = match payload.from_relationship {
        Some(relationship) => format!("{}:{sender}", relationship.as_str()),
        None => sender,
    };
    format!("[agent-message from {sender}]\n\n{}", payload.message)
}

/// The receiving side's custom-row inputs (TS
/// `AgentSessionMessagePayload` at `createAgentSessionMessage` time).
#[derive(Debug, Clone)]
pub struct AgentSessionMessageRowPayload<'a> {
    pub id: &'a str,
    /// The rendered prompt (TS stores `createAgentSessionMessagePrompt`'s
    /// output as the row `content`; the model context reads it).
    pub prompt: &'a str,
    /// The raw delivered body (TS `details.message`).
    pub message: &'a str,
    /// The sender endpoint (TS `details.from`).
    pub from: &'a Value,
    pub from_relationship: Option<AgentFamilyRelationship>,
    /// The receiver endpoint (TS `details.target`).
    pub target: &'a Value,
    /// Unix timestamp in milliseconds (TS `Date.now()`).
    pub timestamp: u64,
}

/// TS `createAgentSessionMessage`: the `role: "custom"` agent-message row
/// the receiving session's transcript holds. `content` is the rendered
/// prompt, so the turn's model context (the loop-boundary user-role
/// conversion of the custom row) matches the plain-prompt delivery, while
/// the details carry the identity the `agent_message` UI reads.
pub fn create_agent_session_message_row(payload: &AgentSessionMessageRowPayload<'_>) -> Value {
    let mut details = serde_json::Map::new();
    details.insert("id".to_string(), json!(payload.id));
    details.insert("message".to_string(), json!(payload.message));
    details.insert("from".to_string(), payload.from.clone());
    if let Some(relationship) = payload.from_relationship {
        details.insert("fromRelationship".to_string(), json!(relationship.as_str()));
    }
    details.insert("target".to_string(), payload.target.clone());
    json!({
        "role": "custom",
        "customType": AGENT_MESSAGE_CUSTOM_TYPE,
        "content": payload.prompt,
        "display": true,
        "details": Value::Object(details),
        "timestamp": payload.timestamp,
    })
}

/// Parse the message id out of the pre-bracket-grammar transcript header.
pub fn parse_agent_session_message_prompt_id(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let offset = lines.first().is_some_and(|line| line.starts_with("[from ")) as usize;
    if lines.get(offset).copied() != Some("Agent-to-agent message received.")
        || lines.get(offset + 1).copied()
            != Some(format!("Source: {AGENT_MESSAGE_SOURCE}").as_str())
    {
        return None;
    }
    let to_line_index = if lines
        .get(offset + 2)
        .is_some_and(|line| line.starts_with("From: "))
    {
        offset + 3
    } else {
        offset + 2
    };
    if !lines
        .get(to_line_index)
        .is_some_and(|line| line.starts_with("To: "))
    {
        return None;
    }
    let id_line = lines.get(to_line_index + 1)?;
    let id = id_line.strip_prefix("Message id: ")?;
    (!id.is_empty() && id.starts_with(AGENT_MESSAGE_ID_PREFIX)).then(|| id.to_string())
}

pub fn is_agent_session_message_prompt(text: &str) -> bool {
    parse_agent_session_message_prompt_id(text).is_some()
}

/// The TS `AgentSessionMessageEndpoint` the receipt carries as `target`.
fn receipt_target_value(receipt: &AgentMessageReceipt) -> Value {
    let mut target = json!({
        "activeSessionId": receipt.target,
        "sessionId": receipt.target_session_id.clone().unwrap_or_default(),
    });
    if let Some(name) = receipt
        .target_session_name
        .as_deref()
        .filter(|name| !name.is_empty())
    {
        target["sessionName"] = json!(name);
    }
    if let Some(kind) = receipt
        .target_runtime_kind
        .as_deref()
        .filter(|kind| !kind.is_empty())
    {
        target["runtimeKind"] = json!(kind);
    }
    target
}

fn receipt_value(receipt: &AgentMessageReceipt) -> Value {
    json!({
        "id": receipt.id,
        "source": AGENT_MESSAGE_SOURCE,
        "target": receipt_target_value(receipt),
        "message": receipt.message,
        "deliveryStatus": receipt.delivery_status.as_str(),
        "deliveredAt": receipt.delivered_at,
        "queuedAt": receipt.queued_at,
        "deliveryMode": receipt.delivery_mode,
        "receiverRole": receipt.receiver_role.map(|role| role.as_str()),
    })
}

/// Register `agent_message.*` handlers onto a handler map. The `send`
/// contract matches the kernel skill: role/addressed sends carry
/// `receiver_role`/`receiver_name`, and `target: "all"` is the broadcast
/// form. Positional targets other than `"all"` are rejected exactly like
/// the TS handler.
pub fn register_agent_message_host_handlers<C: AgentMessageController + 'static>(
    controller: std::sync::Arc<C>,
    handlers: &mut HostRequestHandlers,
) {
    handlers.register(
        "agent_message.list_agents",
        host_handler(|_payload| {
            Box::pin(async {
                Err(anyhow::anyhow!(
                    "agent_message.list_agents was removed; the family roster now lives in agent_observe.list_agents(). Restart the Python kernel to load the current skills, then call await agent_observe.list_agents()."
                ))
            })
        }),
    );
    handlers.register(
        "agent_message.send",
        host_handler(move |payload| {
            let controller = controller.clone();
            Box::pin(async move {
                let data = payload.data;
                let Some(message) = data.get("message").and_then(Value::as_str) else {
                    return Err(anyhow::anyhow!(
                        "agent_message.send message must be a string"
                    ));
                };
                // TS normalizes inside every send (broadcast included), so
                // normalizing up front is behaviorally identical.
                let message = normalize_agent_session_message(message)?;
                // Broadcast form (`target: "all"`): one send per family
                // member, all-settled into a receipts array.
                if let Some(target) = data.get("target").and_then(Value::as_str) {
                    if target != "all" {
                        return Err(anyhow::anyhow!(
                            "positional agent_message.send targets are not supported; use receiver_role and receiver_name"
                        ));
                    }
                    if data.get("receiver_role").is_some() || data.get("receiver_name").is_some() {
                        return Err(anyhow::anyhow!(
                            "agent_message.send broadcast cannot be combined with receiver_role/receiver_name"
                        ));
                    }
                    let family = controller.family().await?;
                    let mut receipts = Vec::with_capacity(family.len());
                    for member in family {
                        let result = controller
                            .send_agent_message(AgentMessageSendInput {
                                target: member.id.clone(),
                                message: message.clone(),
                                receiver_role: Some(member.relationship),
                            })
                            .await;
                        receipts.push(match result {
                            Ok(receipt) => receipt_value(&receipt),
                            Err(error) => json!({
                                "target": member.id,
                                "error": error.to_string(),
                            }),
                        });
                    }
                    return Ok(json!({ "receipts": receipts }));
                }
                // Role-addressed form: resolve the receiver through the
                // family roster, then send once.
                let role = match data.get("receiver_role").and_then(Value::as_str) {
                    Some("parent") => AgentFamilyRelationship::Parent,
                    Some("sibling") => AgentFamilyRelationship::Sibling,
                    Some("child") => AgentFamilyRelationship::Child,
                    _ => {
                        return Err(anyhow::anyhow!(
                            "agent_message.send receiver_role must be \"parent\", \"sibling\", or \"child\""
                        ))
                    }
                };
                let receiver_name = data.get("receiver_name").filter(|value| !value.is_null());
                if role == AgentFamilyRelationship::Parent && receiver_name.is_some() {
                    return Err(anyhow::anyhow!(
                        "agent_message.send receiver_name must be omitted for parent messages"
                    ));
                }
                let selector: Option<&str> = if role == AgentFamilyRelationship::Parent {
                    None
                } else {
                    match receiver_name
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                    {
                        Some(name) => Some(name),
                        None => {
                            return Err(anyhow::anyhow!(
                                "agent_message.send receiver_name is required for sibling and child messages"
                            ))
                        }
                    }
                };
                // TS renders the receiver in errors via JSON.stringify.
                let rendered_receiver = match receiver_name {
                    Some(Value::String(name)) => format!("\"{name}\""),
                    Some(other) => serde_json::to_string(other).unwrap_or_default(),
                    None => "null".to_string(),
                };
                let family = controller.family().await?;
                let matches: Vec<AgentFamilyMember> = family
                    .into_iter()
                    .filter(|member| {
                        member.relationship == role
                            && (role == AgentFamilyRelationship::Parent
                                || selector.is_some_and(|selector| {
                                    member.matches_selector(selector)
                                }))
                    })
                    .collect();
                // Exactly one match resolves; zero or many keep the TS
                // error strings.
                let member = match matches.as_slice() {
                    [only] => only,
                    [] => {
                        return Err(anyhow::anyhow!(
                            if role == AgentFamilyRelationship::Parent {
                                "No parent matches the current agent".to_string()
                            } else {
                                format!("No {role} matches {rendered_receiver}")
                            }
                        ))
                    }
                    _ => {
                        return Err(anyhow::anyhow!(
                            format!("{role} selector {rendered_receiver} is ambiguous")
                        ))
                    }
                };
                let receipt = controller
                    .send_agent_message(AgentMessageSendInput {
                        target: member.id.clone(),
                        message: message.clone(),
                        receiver_role: Some(role),
                    })
                    .await?;
                Ok(receipt_value(&receipt))
            })
        }),
    );
}

// ---------------------------------------------------------------------------
// Agent observation
// ---------------------------------------------------------------------------

/// One roster row / agent summary.
#[derive(Debug, Clone, Default)]
pub struct AgentObserveSummary {
    pub active_session_id: Option<String>,
    pub session_id: String,
    pub session_name: Option<String>,
    pub relationship: Option<AgentFamilyRelationship>,
    pub runtime_kind: Option<String>,
    pub status: String,
    pub is_current: bool,
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub attached_clients: usize,
    pub queued_count: usize,
    pub is_session_active: bool,
}

impl AgentObserveSummary {
    fn to_value(&self) -> Value {
        json!({
            "activeSessionId": self.active_session_id,
            "sessionId": self.session_id,
            "sessionName": self.session_name,
            "relationship": self.relationship.map(|r| r.as_str()),
            "runtimeKind": self.runtime_kind,
            "status": self.status,
            "isCurrent": self.is_current,
            "isStreaming": self.is_streaming,
            "isCompacting": self.is_compacting,
            "attachedClients": self.attached_clients,
            "queuedCount": self.queued_count,
            "isSessionActive": self.is_session_active,
        })
    }
}

/// One bounded message preview.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AgentObserveMessagePreview {
    pub index: usize,
    pub role: String,
    pub timestamp: Option<u64>,
    pub text: String,
    pub truncated: bool,
    pub tool_calls: Vec<String>,
    pub custom_type: Option<String>,
}

/// The controller the daemon supplies for `agent_observe.*` requests.
pub trait AgentObserveController: Send + Sync {
    fn list_agents(&self) -> impl Future<Output = anyhow::Result<Vec<AgentObserveSummary>>> + Send;
    fn get_agent(
        &self,
        target: &str,
    ) -> impl Future<Output = anyhow::Result<Option<AgentObserveSummary>>> + Send;
    fn recent_messages(
        &self,
        target: &str,
        limit: usize,
        max_chars: usize,
    ) -> impl Future<Output = anyhow::Result<Vec<AgentObserveMessagePreview>>> + Send;
}

/// Clamp an observe limit (default 8, range 1..=50).
///
/// # Errors
///
/// Returns an error when the limit falls outside 1..=50.
pub fn normalize_observe_limit(limit: Option<u64>) -> anyhow::Result<usize> {
    clamp_integer(limit.unwrap_or(8), 1, 50, "agent_observe limit")
}

/// Clamp an observe preview width (default 800, range 80..=2000).
///
/// # Errors
///
/// Returns an error when the width falls outside 80..=2000.
pub fn normalize_observe_max_chars(max_chars: Option<u64>) -> anyhow::Result<usize> {
    clamp_integer(
        max_chars.unwrap_or(800),
        80,
        2_000,
        "agent_observe max_chars",
    )
}

fn clamp_integer(value: u64, min: u64, max: u64, label: &str) -> anyhow::Result<usize> {
    if value < min || value > max {
        anyhow::bail!("{label} must be between {min} and {max}");
    }
    Ok(value as usize)
}

fn optional_integer(value: Option<&Value>, label: &str) -> anyhow::Result<Option<u64>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            if let Some(integer) = number.as_u64() {
                Ok(Some(integer))
            } else {
                anyhow::bail!("{label} must be an integer when provided")
            }
        }
        Some(_) => anyhow::bail!("{label} must be an integer when provided"),
    }
}

/// Build one preview from a session message.
pub fn create_agent_observe_message_preview(
    message: &pa_types::session::AgentMessage,
    index: usize,
    max_chars: usize,
) -> AgentObserveMessagePreview {
    use pa_types::session::AgentMessage;
    let text = observe_message_text(message);
    let (text, truncated) = if text.chars().count() <= max_chars {
        (text, false)
    } else {
        (text.chars().take(max_chars).collect(), true)
    };
    let (role, timestamp, custom_type, tool_calls) = match message {
        AgentMessage::User(message) => ("user", Some(message.timestamp), None, Vec::new()),
        AgentMessage::Assistant(message) => (
            "assistant",
            Some(message.timestamp),
            None,
            message
                .content
                .iter()
                .filter_map(|block| match block {
                    pa_types::ai::AssistantContentBlock::ToolCall(call) => Some(call.name.clone()),
                    _ => None,
                })
                .collect(),
        ),
        AgentMessage::ToolResult(message) => {
            ("toolResult", Some(message.timestamp), None, Vec::new())
        }
        AgentMessage::BashExecution(message) => {
            ("bashExecution", Some(message.timestamp), None, Vec::new())
        }
        AgentMessage::Custom(message) => (
            "custom",
            Some(message.timestamp),
            Some(message.custom_type.clone()),
            Vec::new(),
        ),
        AgentMessage::BranchSummary(message) => {
            ("branchSummary", Some(message.timestamp), None, Vec::new())
        }
        AgentMessage::CompactionSummary(message) => (
            "compactionSummary",
            Some(message.timestamp),
            None,
            Vec::new(),
        ),
    };
    AgentObserveMessagePreview {
        index,
        role: role.to_string(),
        timestamp,
        text,
        truncated,
        tool_calls,
        custom_type,
    }
}

fn user_content_text(content: &pa_types::ai::UserContent) -> String {
    match content {
        pa_types::ai::UserContent::Text(text) => text.clone(),
        pa_types::ai::UserContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::UserContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

fn observe_message_text(message: &pa_types::session::AgentMessage) -> String {
    use pa_types::session::AgentMessage;
    match message {
        AgentMessage::User(message) => user_content_text(&message.content),
        AgentMessage::Assistant(message) => message
            .content
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                pa_types::ai::AssistantContentBlock::Thinking(thinking) => {
                    Some(thinking.thinking.clone())
                }
                pa_types::ai::AssistantContentBlock::ToolCall(_) => None,
            })
            .collect::<Vec<_>>()
            .join(""),
        AgentMessage::ToolResult(message) => {
            user_content_text(&pa_types::ai::UserContent::Blocks(message.content.clone()))
        }
        AgentMessage::BashExecution(message) => [message.command.clone(), message.output.clone()]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        AgentMessage::Custom(message) => user_content_text(&message.content),
        AgentMessage::BranchSummary(message) => message.summary.clone(),
        AgentMessage::CompactionSummary(message) => message.summary.clone(),
    }
}

fn preview_value(preview: &AgentObserveMessagePreview) -> Value {
    json!({
        "index": preview.index,
        "role": preview.role,
        "timestamp": preview.timestamp,
        "text": preview.text,
        "truncated": preview.truncated,
        "toolCalls": if preview.tool_calls.is_empty() { Value::Null } else { json!(preview.tool_calls) },
        "customType": preview.custom_type,
    })
}

/// Register `agent_observe.*` handlers onto a handler map.
pub fn register_agent_observe_host_handlers<C: AgentObserveController + 'static>(
    controller: std::sync::Arc<C>,
    handlers: &mut HostRequestHandlers,
) {
    handlers.register(
        "agent_observe.list",
        host_handler({
            let controller = controller.clone();
            move |_payload| {
                let controller = controller.clone();
                Box::pin(async move {
                    let agents = controller.list_agents().await?;
                    Ok(json!({
                        "agents": agents.iter().map(AgentObserveSummary::to_value).collect::<Vec<_>>(),
                    }))
                })
            }
        }),
    );
    handlers.register(
        "agent_observe.get",
        host_handler({
            let controller = controller.clone();
            move |payload| {
                let controller = controller.clone();
                Box::pin(async move {
                    let Some(target) = payload.data.get("target").and_then(Value::as_str) else {
                        return Err(anyhow::anyhow!("agent_observe.get target must be a string"));
                    };
                    let Some(agent) = controller.get_agent(target).await? else {
                        anyhow::bail!("agent {target} is not reachable");
                    };
                    Ok(json!({ "agent": agent.to_value() }))
                })
            }
        }),
    );
    handlers.register(
        "agent_observe.recent",
        host_handler(move |payload| {
            let controller = controller.clone();
            Box::pin(async move {
                let Some(target) = payload.data.get("target").and_then(Value::as_str) else {
                    return Err(anyhow::anyhow!(
                        "agent_observe.recent target must be a string"
                    ));
                };
                let limit =
                    optional_integer(payload.data.get("limit"), "agent_observe.recent limit")?;
                let max_chars = optional_integer(
                    payload
                        .data
                        .get("max_chars")
                        .or_else(|| payload.data.get("maxChars")),
                    "agent_observe.recent max_chars",
                )?;
                let messages = controller
                    .recent_messages(
                        target,
                        normalize_observe_limit(limit)?,
                        normalize_observe_max_chars(max_chars)?,
                    )
                    .await?;
                Ok(json!({
                    "messages": messages.iter().map(preview_value).collect::<Vec<_>>(),
                }))
            })
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_ids_and_validation() {
        let id = create_agent_session_message_id();
        assert!(id.starts_with("agentmsg_"));
        assert!(is_agent_session_message_id(Some(&id)));
        assert!(!is_agent_session_message_id(Some("prompt123")));
        assert!(!is_agent_session_message_id(None));
        assert_eq!(
            normalize_agent_session_message("  hello  ").unwrap(),
            "hello"
        );
        assert!(normalize_agent_session_message("   ").is_err());
        assert!(normalize_agent_session_message("").is_err());
        let long = "x".repeat(DEFAULT_AGENT_MESSAGE_MAX_CHARS + 1);
        assert!(normalize_agent_session_message(&long).is_err());
        let at_limit = "x".repeat(DEFAULT_AGENT_MESSAGE_MAX_CHARS);
        assert!(normalize_agent_session_message(&at_limit).is_ok());
    }

    #[test]
    fn target_and_capacity_guards() {
        assert_eq!(
            assert_direct_agent_message_target(" worker ").unwrap(),
            "worker"
        );
        assert!(assert_direct_agent_message_target("").is_err());
        for broadcast in ["*", "all", "All", "BROADCAST"] {
            let error = assert_direct_agent_message_target(broadcast).unwrap_err();
            assert_eq!(
                error.to_string(),
                "Broadcast agent messaging is not supported"
            );
        }
        assert_agent_message_queue_capacity(3, 20).unwrap();
        let error = assert_agent_message_queue_capacity(20, 20).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Target session has too many pending messages: 20 unfinished, limit is 20"
        );
    }

    #[test]
    fn message_prompts_and_id_parsing() {
        let payload = AgentMessagePromptPayload {
            message: "keep going".to_string(),
            sender_name: "worker-1".to_string(),
            from_relationship: Some(AgentFamilyRelationship::Child),
        };
        let prompt = create_agent_session_message_prompt(&payload);
        assert_eq!(prompt, "[agent-message from child:worker-1]\n\nkeep going");
        // Header values are sanitized.
        let evil = AgentMessagePromptPayload {
            message: "m".to_string(),
            sender_name: "bad name!".to_string(),
            from_relationship: None,
        };
        assert_eq!(
            create_agent_session_message_prompt(&evil),
            "[agent-message from bad name!]\n\nm"
        );
        // Legacy transcript header parsing.
        let header = format!(
            "Agent-to-agent message received.\nSource: {AGENT_MESSAGE_SOURCE}\nTo: worker\nMessage id: {}",
            create_agent_session_message_id()
        );
        let parsed = parse_agent_session_message_prompt_id(&header).unwrap();
        assert!(parsed.starts_with("agentmsg_"));
        assert!(is_agent_session_message_prompt(&header));
        assert!(!is_agent_session_message_prompt("plain text"));
    }

    #[test]
    fn the_custom_row_carries_the_ts_agent_message_shape() {
        let prompt = "[agent-message from child:lane]\n\nfinished the research";
        let from = json!({
            "activeSessionId": "child-1",
            "sessionId": "child-file",
            "sessionName": "lane",
            "runtimeKind": "subagent",
        });
        let target = json!({
            "activeSessionId": "parent-1",
            "sessionId": "parent-file",
            "runtimeKind": "top-level",
        });
        let row = create_agent_session_message_row(&AgentSessionMessageRowPayload {
            id: "agentmsg_1",
            prompt,
            message: "finished the research",
            from: &from,
            from_relationship: Some(AgentFamilyRelationship::Child),
            target: &target,
            timestamp: 123,
        });
        // TS `createAgentSessionMessage`: the custom role, the agent_message
        // type, the prompt as the content, display on, and the identity
        // details the `agent_message` UI reads.
        assert_eq!(row["role"], "custom");
        assert_eq!(row["customType"], AGENT_MESSAGE_CUSTOM_TYPE);
        assert_eq!(row["content"], prompt);
        assert_eq!(row["display"], true);
        assert_eq!(row["timestamp"], 123);
        assert_eq!(row["details"]["id"], "agentmsg_1");
        assert_eq!(row["details"]["message"], "finished the research");
        assert_eq!(row["details"]["from"], from);
        assert_eq!(row["details"]["fromRelationship"], "child");
        assert_eq!(row["details"]["target"], target);
        // An absent relationship omits the key (TS serializes `undefined`
        // away), not a null.
        let plain = create_agent_session_message_row(&AgentSessionMessageRowPayload {
            id: "agentmsg_2",
            prompt,
            message: "finished the research",
            from: &Value::Null,
            from_relationship: None,
            target: &target,
            timestamp: 124,
        });
        assert!(plain["details"].get("fromRelationship").is_none());
        assert_eq!(plain["details"]["from"], Value::Null);
    }

    #[test]
    fn observe_limits_clamp() {
        assert_eq!(normalize_observe_limit(None).unwrap(), 8);
        assert_eq!(normalize_observe_limit(Some(50)).unwrap(), 50);
        assert!(normalize_observe_limit(Some(51)).is_err());
        assert!(normalize_observe_limit(Some(0)).is_err());
        assert_eq!(normalize_observe_max_chars(None).unwrap(), 800);
        assert_eq!(normalize_observe_max_chars(Some(80)).unwrap(), 80);
        assert!(normalize_observe_max_chars(Some(79)).is_err());
        assert!(normalize_observe_max_chars(Some(2_001)).is_err());
    }

    #[test]
    fn observe_previews_truncate() {
        let user = pa_types::session::AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text("short".to_string()),
            timestamp: 42,
            rest: Default::default(),
        });
        let preview = create_agent_observe_message_preview(&user, 3, 800);
        assert_eq!(preview.index, 3);
        assert_eq!(preview.role, "user");
        assert_eq!(preview.timestamp, Some(42));
        assert_eq!(preview.text, "short");
        assert!(!preview.truncated);
        let long = pa_types::session::AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text("x".repeat(100)),
            timestamp: 0,
            rest: Default::default(),
        });
        let clipped = create_agent_observe_message_preview(&long, 0, 10);
        assert!(clipped.truncated);
        assert_eq!(clipped.text.chars().count(), 10);
    }

    /// A family of one parent, two siblings (one named "scout"), and two
    /// children both named "dual".
    fn family() -> Vec<AgentFamilyMember> {
        vec![
            AgentFamilyMember {
                relationship: AgentFamilyRelationship::Parent,
                id: "parent-1".to_string(),
                name: None,
                aliases: Vec::new(),
            },
            AgentFamilyMember {
                relationship: AgentFamilyRelationship::Sibling,
                id: "sib-1".to_string(),
                name: Some("scout".to_string()),
                aliases: Vec::new(),
            },
            AgentFamilyMember {
                relationship: AgentFamilyRelationship::Sibling,
                id: "sib-2".to_string(),
                name: None,
                aliases: Vec::new(),
            },
            AgentFamilyMember {
                relationship: AgentFamilyRelationship::Child,
                id: "kid-1".to_string(),
                name: Some("dual".to_string()),
                aliases: vec!["sub-kid1".to_string(), "sess-kid1".to_string()],
            },
            AgentFamilyMember {
                relationship: AgentFamilyRelationship::Child,
                id: "kid-2".to_string(),
                name: Some("dual".to_string()),
                aliases: Vec::new(),
            },
        ]
    }

    struct RecordingMessageController;

    impl AgentMessageController for RecordingMessageController {
        async fn family(&self) -> anyhow::Result<Vec<AgentFamilyMember>> {
            Ok(family())
        }

        async fn send_agent_message(
            &self,
            input: AgentMessageSendInput,
        ) -> anyhow::Result<AgentMessageReceipt> {
            Ok(AgentMessageReceipt {
                id: create_agent_session_message_id(),
                target_session_id: Some(format!("{}-session", input.target)),
                target: input.target,
                target_session_name: None,
                target_runtime_kind: Some("top-level".to_string()),
                message: input.message,
                delivery_status: AgentMessageDeliveryStatus::Delivered,
                delivery_mode: Some("steer"),
                receiver_role: input.receiver_role,
                delivered_at: Some("2024-01-01T00:00:00.000Z".to_string()),
                queued_at: None,
            })
        }
    }

    fn send_request(
        send: &crate::kernel::shared::HostHandlerFn,
        data: Value,
    ) -> anyhow::Result<Value> {
        // The handler futures here are plain (no tokio IO), so driving
        // them on the test executor is safe.
        futures::executor::block_on(send(crate::kernel::shared::HostRequestPayload {
            data,
            cell_source_code: None,
        }))
    }

    #[tokio::test]
    async fn message_host_handler_round_trip() {
        let mut handlers = HostRequestHandlers::default();
        register_agent_message_host_handlers(
            std::sync::Arc::new(RecordingMessageController),
            &mut handlers,
        );
        let send = handlers.get("agent_message.send").unwrap().clone();

        // Role-addressed send resolves the name through the family.
        let receipt = send_request(
            &send,
            json!({
                "message": "  proceed  ",
                "receiver_role": "sibling",
                "receiver_name": " scout "
            }),
        )
        .unwrap();
        assert_eq!(receipt["target"]["activeSessionId"], "sib-1");
        assert_eq!(receipt["target"]["sessionId"], "sib-1-session");
        assert_eq!(receipt["target"]["runtimeKind"], "top-level");
        assert_eq!(receipt["message"], "proceed");
        assert_eq!(receipt["deliveryStatus"], "delivered");
        assert_eq!(receipt["receiverRole"], "sibling");
        assert!(receipt["id"].as_str().unwrap().starts_with("agentmsg_"));

        // Unnamed members resolve by id (TS agentFamilyMemberName).
        let by_id = send_request(
            &send,
            json!({ "message": "hi", "receiver_role": "sibling", "receiver_name": "sib-2" }),
        )
        .unwrap();
        assert_eq!(by_id["target"]["activeSessionId"], "sib-2");

        // Parent sends need no name.
        let parent = send_request(
            &send,
            json!({ "message": "reply to parent", "receiver_role": "parent" }),
        )
        .unwrap();
        assert_eq!(parent["target"]["activeSessionId"], "parent-1");
        let parent_named = send_request(
            &send,
            json!({ "message": "x", "receiver_role": "parent", "receiver_name": "p" }),
        )
        .unwrap_err();
        assert_eq!(
            parent_named.to_string(),
            "agent_message.send receiver_name must be omitted for parent messages"
        );

        // Contract errors carry the TS strings verbatim.
        let positional =
            send_request(&send, json!({ "target": "worker", "message": "hi" })).unwrap_err();
        assert_eq!(
            positional.to_string(),
            "positional agent_message.send targets are not supported; use receiver_role and receiver_name"
        );
        let no_role = send_request(&send, json!({ "message": "hi" })).unwrap_err();
        assert_eq!(
            no_role.to_string(),
            "agent_message.send receiver_role must be \"parent\", \"sibling\", or \"child\""
        );
        let missing_name =
            send_request(&send, json!({ "message": "hi", "receiver_role": "child" })).unwrap_err();
        assert_eq!(
            missing_name.to_string(),
            "agent_message.send receiver_name is required for sibling and child messages"
        );

        // Resolution failures keep the TS wording.
        let no_match = send_request(
            &send,
            json!({ "message": "hi", "receiver_role": "child", "receiver_name": "ghost" }),
        )
        .unwrap_err();
        assert_eq!(no_match.to_string(), "No child matches \"ghost\"");
        let ambiguous = send_request(
            &send,
            json!({ "message": "hi", "receiver_role": "child", "receiver_name": "dual" }),
        )
        .unwrap_err();
        assert_eq!(
            ambiguous.to_string(),
            "child selector \"dual\" is ambiguous"
        );

        // Aliased members resolve by every alias form (the daemon lists a
        // child's RLM child id and persisted session id as aliases).
        let by_child_alias = send_request(
            &send,
            json!({ "message": "hi", "receiver_role": "child", "receiver_name": "sub-kid1" }),
        )
        .unwrap();
        assert_eq!(by_child_alias["target"]["activeSessionId"], "kid-1");
        let by_session_alias = send_request(
            &send,
            json!({ "message": "hi", "receiver_role": "child", "receiver_name": "sess-kid1" }),
        )
        .unwrap();
        assert_eq!(by_session_alias["target"]["activeSessionId"], "kid-1");

        // Broadcast sends to every family member, all-settled.
        let broadcast =
            send_request(&send, json!({ "target": "all", "message": "  everyone  " })).unwrap();
        let receipts = broadcast["receipts"].as_array().expect("receipts");
        assert_eq!(receipts.len(), 5, "{broadcast:?}");
        assert!(receipts
            .iter()
            .all(|receipt| receipt["message"] == "everyone"));

        // The removed roster request answers with the TS migration error.
        let list_agents = handlers.get("agent_message.list_agents").unwrap().clone();
        let removed = send_request(&list_agents, json!({})).unwrap_err();
        assert!(removed.to_string().starts_with(
            "agent_message.list_agents was removed; the family roster now lives in agent_observe.list_agents()"
        ));
    }

    #[tokio::test]
    async fn broadcast_without_family_is_empty_and_failures_settle() {
        struct NoFamilyController;
        impl AgentMessageController for NoFamilyController {
            async fn family(&self) -> anyhow::Result<Vec<AgentFamilyMember>> {
                Ok(Vec::new())
            }
            async fn send_agent_message(
                &self,
                _input: AgentMessageSendInput,
            ) -> anyhow::Result<AgentMessageReceipt> {
                anyhow::bail!("no route")
            }
        }
        struct LoneFamilyController;
        impl AgentMessageController for LoneFamilyController {
            async fn family(&self) -> anyhow::Result<Vec<AgentFamilyMember>> {
                Ok(vec![AgentFamilyMember {
                    relationship: AgentFamilyRelationship::Sibling,
                    id: "sib-1".to_string(),
                    name: None,
                    aliases: Vec::new(),
                }])
            }
            async fn send_agent_message(
                &self,
                _input: AgentMessageSendInput,
            ) -> anyhow::Result<AgentMessageReceipt> {
                anyhow::bail!("peer unreachable")
            }
        }
        let mut handlers = HostRequestHandlers::default();
        register_agent_message_host_handlers(
            std::sync::Arc::new(NoFamilyController),
            &mut handlers,
        );
        let send = handlers.get("agent_message.send").unwrap().clone();
        let broadcast = send_request(&send, json!({ "target": "all", "message": "hi" })).unwrap();
        assert_eq!(broadcast["receipts"].as_array().map(Vec::len), Some(0));

        // A role send against an empty family: no parent matches.
        let no_parent =
            send_request(&send, json!({ "message": "hi", "receiver_role": "parent" })).unwrap_err();
        assert_eq!(no_parent.to_string(), "No parent matches the current agent");

        // One-member family with a failing send: the receipt records the
        // error instead of aborting the broadcast.
        let mut handlers = HostRequestHandlers::default();
        register_agent_message_host_handlers(
            std::sync::Arc::new(LoneFamilyController),
            &mut handlers,
        );
        let send = handlers.get("agent_message.send").unwrap().clone();
        let broadcast = send_request(&send, json!({ "target": "all", "message": "hi" })).unwrap();
        let receipts = broadcast["receipts"].as_array().expect("receipts");
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0]["target"], "sib-1");
        assert_eq!(receipts[0]["error"], "peer unreachable");
    }
}
