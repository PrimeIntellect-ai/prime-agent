//! The agent-observe half (TS `agent-observe.ts`): the family status and
//! activity enums, the observe summary and preview types, the controller
//! trait, the limit clamps, and the host-handler registration.
use super::{host_handler, json, AgentFamilyRelationship, Future, HostRequestHandlers, Value};

/// the agent has work in flight, `idle` for a resident-but-quiet session,
/// `inactive` for a family member with no live session in this daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentFamilyStatus {
    Running,
    Idle,
    Inactive,
}

impl AgentFamilyStatus {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentFamilyStatus::Running => "running",
            AgentFamilyStatus::Idle => "idle",
            AgentFamilyStatus::Inactive => "inactive",
        }
    }
}

/// What a resident session is doing right now (TS #2493
/// `AgentObserveActivity`): a separate axis from the family lifecycle in
/// [`AgentFamilyStatus`], absent for members with no live session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentObserveActivity {
    Tool,
    Model,
    Compacting,
    Busy,
    User,
    Idle,
}

impl AgentObserveActivity {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            AgentObserveActivity::Tool => "tool",
            AgentObserveActivity::Model => "model",
            AgentObserveActivity::Compacting => "compacting",
            AgentObserveActivity::Busy => "busy",
            AgentObserveActivity::User => "user",
            AgentObserveActivity::Idle => "idle",
        }
    }
}

/// One roster row / agent summary.
#[derive(Debug, Clone)]
// The mirrored TS API shape is deliberate (the booleans are the
// product's own surface, not a refactor target).
#[allow(clippy::struct_excessive_bools)]
pub struct AgentObserveSummary {
    pub active_session_id: Option<String>,
    pub session_id: String,
    pub session_name: Option<String>,
    pub relationship: Option<AgentFamilyRelationship>,
    pub runtime_kind: Option<String>,
    pub status: AgentFamilyStatus,
    /// The live activity of a resident session; `None` for family members
    /// with no live session in this daemon (TS marks the field absent).
    pub activity: Option<AgentObserveActivity>,
    pub is_current: bool,
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub attached_clients: usize,
    pub queued_count: usize,
    pub is_session_active: bool,
}

impl AgentObserveSummary {
    pub(super) fn to_value(&self) -> Value {
        let mut row = json!({
            "activeSessionId": self.active_session_id,
            "sessionId": self.session_id,
            "sessionName": self.session_name,
            "relationship": self.relationship.map(|r| r.as_str()),
            "runtimeKind": self.runtime_kind,
            "status": self.status.as_str(),
            "isCurrent": self.is_current,
            "isStreaming": self.is_streaming,
            "isCompacting": self.is_compacting,
            "attachedClients": self.attached_clients,
            "queuedCount": self.queued_count,
            "isSessionActive": self.is_session_active,
        });
        if let Some(activity) = self.activity {
            row["activity"] = json!(activity.as_str());
        }
        row
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
#[must_use]
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
            .collect::<String>(),
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
            .collect::<String>(),
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
