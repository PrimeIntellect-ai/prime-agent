//! The agent-observe half: the family status and activity enums, the
//! observe summary and preview types, the controller trait, the limit
//! clamps, and the host-handler registration.
use super::{host_handler, json, AgentFamilyRelationship, Future, HostRequestHandlers, Value};

/// The family lifecycle status every observation row carries: `running`
/// while the agent has work in flight, `idle` for a resident-but-quiet
/// session, `inactive` for a family member with no live session in this
/// daemon.
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
    /// The session's working directory (TS marks the field absent for
    /// roster rows that carry none).
    pub cwd: Option<String>,
    pub status: AgentFamilyStatus,
    /// The live activity of a resident session; `None` for family members
    /// with no live session in this daemon (TS marks the field absent).
    pub activity: Option<AgentObserveActivity>,
    pub is_current: bool,
    pub is_streaming: bool,
    pub is_compacting: bool,
    pub attached_clients: usize,
    /// The session's persisted message count.
    pub message_count: Option<u64>,
    pub queued_count: usize,
    pub is_session_active: bool,
    /// The parent's live active session id (subagent summaries).
    pub parent_active_session_id: Option<String>,
    /// The parent's persisted session id (subagent summaries).
    pub parent_session_id: Option<String>,
    /// This subagent's child id under its parent.
    pub rlm_child_id: Option<String>,
    /// The session's first user message, preview-capped (an inactive
    /// child's identity signal; TS `firstMessage`).
    pub first_message: Option<String>,
    /// The session's file: a transcript read of a member no worker holds opens it.
    pub session_file: Option<String>,
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
        // The TS summary spreads these facts in only when the row
        // carries them.
        if let Some(cwd) = &self.cwd {
            row["cwd"] = json!(cwd);
        }
        if let Some(message_count) = self.message_count {
            row["messageCount"] = json!(message_count);
        }
        if let Some(parent_active_session_id) = &self.parent_active_session_id {
            row["parentActiveSessionId"] = json!(parent_active_session_id);
        }
        if let Some(parent_session_id) = &self.parent_session_id {
            row["parentSessionId"] = json!(parent_session_id);
        }
        if let Some(rlm_child_id) = &self.rlm_child_id {
            row["rlmChildId"] = json!(rlm_child_id);
        }
        if let Some(first_message) = &self.first_message {
            row["firstMessage"] = json!(first_message);
        }
        row
    }
}

/// TS `AgentObserveListResult`: the caller's own summary plus the family
/// roster, which excludes the caller.
#[derive(Debug, Clone)]
pub struct AgentObserveListResult {
    pub current: AgentObserveSummary,
    pub agents: Vec<AgentObserveSummary>,
}

/// TS `AgentObserveRecentMessagesResult`: the target's summary plus the
/// bounded preview window and the clamped bounds.
#[derive(Debug, Clone)]
pub struct AgentObserveRecentMessagesResult {
    pub agent: AgentObserveSummary,
    pub messages: Vec<AgentObserveMessagePreview>,
    pub limit: usize,
    pub max_chars: usize,
    /// Whether older messages exist beyond the returned window
    /// (TS `truncated: startIndex > 0`).
    pub truncated: bool,
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
    fn list_agents(&self) -> impl Future<Output = anyhow::Result<AgentObserveListResult>> + Send;
    fn get_agent(
        &self,
        target: &str,
    ) -> impl Future<Output = anyhow::Result<Option<AgentObserveSummary>>> + Send;
    fn recent_messages(
        &self,
        target: &str,
        limit: usize,
        max_chars: usize,
    ) -> impl Future<Output = anyhow::Result<AgentObserveRecentMessagesResult>> + Send;
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
                    let list = controller.list_agents().await?;
                    Ok(json!({
                        "current": list.current.to_value(),
                        "agents": list.agents.iter().map(AgentObserveSummary::to_value).collect::<Vec<_>>(),
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
                let recent = controller
                    .recent_messages(
                        target,
                        normalize_observe_limit(limit)?,
                        normalize_observe_max_chars(max_chars)?,
                    )
                    .await?;
                Ok(json!({
                    "agent": recent.agent.to_value(),
                    "messages": recent.messages.iter().map(preview_value).collect::<Vec<_>>(),
                    "limit": recent.limit,
                    "maxChars": recent.max_chars,
                    "truncated": recent.truncated,
                }))
            })
        }),
    );
}
