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
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentFamilyRelationship::Parent => "parent",
            AgentFamilyRelationship::Sibling => "sibling",
            AgentFamilyRelationship::Child => "child",
        }
    }

    #[must_use]
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
    #[must_use]
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
    #[must_use]
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

#[must_use]
pub fn create_agent_session_message_id() -> String {
    format!("{AGENT_MESSAGE_ID_PREFIX}{}", uuid::Uuid::new_v4())
}

/// Distinguishes agent-to-agent ids from synthetic prompt ids.
#[must_use]
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
#[must_use]
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
#[must_use]
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
#[must_use]
pub fn parse_agent_session_message_prompt_id(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let offset = usize::from(lines.first().is_some_and(|line| line.starts_with("[from ")));
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

#[must_use]
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

/// The family lifecycle status every observation row carries (TS #2493
/// `AgentFamilyStatus`, the roster's `AgentRosterStatus`): `running` while
// The observe half (TS agent-observe.ts) lives in the child module
// (agent_messaging::observe); the pub use re-exports keep every external
// agent_messaging:: path stable (the pa-daemon importers).
mod observe;
pub use observe::{
    create_agent_observe_message_preview, normalize_observe_limit, normalize_observe_max_chars,
    register_agent_observe_host_handlers, AgentFamilyStatus, AgentObserveActivity,
    AgentObserveController, AgentObserveMessagePreview, AgentObserveSummary,
};

// The unit battery lives in the child module (agent_messaging::tests);
// its use-super glob resolves through this facade's bindings and re-exports.
#[cfg(test)]
mod tests;
