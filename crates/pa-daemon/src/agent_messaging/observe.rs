//! The `agent_observe.*` controller (moved with its concern): message
//! previews and full session summaries from the supervisor, the
//! nuclear-family roster derivation, and the preview text helpers.
use super::{
    json, row_is_child, row_is_parent, row_is_sibling, AgentFamilyRelationship, AgentFamilyStatus,
    AgentObserveActivity, AgentObserveController, AgentObserveMessagePreview, AgentObserveSummary,
    Arc, FamilyIdentity, SupervisorLink, Value,
};

/// `agent_observe.*` controller for daemon workers: message previews and
/// full session summaries from the supervisor. The roster this controller
/// reports is the caller's NUCLEAR FAMILY (its parent, siblings, and
/// direct children — plus the caller's own row), derived from the same
/// durable parent edges `agent_message.send` resolves through; a
/// `list_agents()` never spans the whole daemon, and a relationship label
/// never claims a family edge the recorded topology does not have.
pub(crate) struct LinkAgentObserveController {
    link: Arc<SupervisorLink>,
    /// This worker's live active session id (the family-scope anchor).
    active_session_id: String,
    /// This worker's own session summary, pushed at create and rename
    /// (the durable identity the edge classification reads).
    own_summary: Arc<std::sync::Mutex<Option<Value>>>,
    /// This session's resident RLM children (the registry join for Child
    /// rows the roster may not list).
    children: Option<Arc<crate::rlm_children::SupervisorChildSessions>>,
}

impl LinkAgentObserveController {
    pub(crate) fn new(
        link: Arc<SupervisorLink>,
        active_session_id: String,
        own_summary: Arc<std::sync::Mutex<Option<Value>>>,
        children: Option<Arc<crate::rlm_children::SupervisorChildSessions>>,
    ) -> Self {
        LinkAgentObserveController {
            link,
            active_session_id,
            own_summary,
            children,
        }
    }

    /// The full roster rows plus the caller's durable family identity.
    async fn roster_and_identity(&self) -> anyhow::Result<(Vec<Value>, FamilyIdentity)> {
        // The full session walk (`all: true`): live residents plus the
        // passive ledger children, so a released child's durable row
        // stays in the caller's nuclear family exactly like the TS
        // roster (a live-residents-only join would drop it the moment
        // its worker settles and releases).
        let data = self
            .link
            .request_success(
                json!({ "type": "list", "all": true }),
                std::time::Duration::from_secs(30),
            )
            .await?;
        let sessions = data
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let summary = self
            .own_summary
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let identity = FamilyIdentity::from_summary(summary.as_ref(), &self.active_session_id);
        Ok((sessions, identity))
    }

    /// This session's resident children's live active session ids (the
    /// registry join; rows it owns are Children even before their durable
    /// edges hydrate).
    async fn registry_child_active_ids(&self) -> Vec<String> {
        match &self.children {
            Some(children) => children
                .child_identities()
                .await
                .into_iter()
                .map(|child| child.active_session_id)
                .collect(),
            None => Vec::new(),
        }
    }
}

impl AgentObserveController for LinkAgentObserveController {
    async fn list_agents(&self) -> anyhow::Result<Vec<AgentObserveSummary>> {
        let (sessions, identity) = self.roster_and_identity().await?;
        let child_ids = self.registry_child_active_ids().await;
        Ok(summaries_from_roster(sessions, &identity, &child_ids))
    }

    async fn get_agent(&self, target: &str) -> anyhow::Result<Option<AgentObserveSummary>> {
        let (sessions, identity) = self.roster_and_identity().await?;
        let child_ids = self.registry_child_active_ids().await;
        Ok(summaries_from_roster(sessions, &identity, &child_ids)
            .into_iter()
            .find(|summary| {
                summary.active_session_id.as_deref() == Some(target)
                    || summary.session_id == target
                    || summary.session_name.as_deref() == Some(target)
            }))
    }

    async fn recent_messages(
        &self,
        target: &str,
        limit: usize,
        max_chars: usize,
    ) -> anyhow::Result<Vec<AgentObserveMessagePreview>> {
        let data = self
            .link
            .request_success(
                json!({
                    "type": "get_messages",
                    "activeSessionId": target,
                }),
                std::time::Duration::from_secs(30),
            )
            .await?;
        let messages = data
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let total = messages.len();
        let start = total.saturating_sub(limit);
        let mut previews = Vec::new();
        for (index, message) in messages.iter().enumerate().skip(start) {
            let full_text = message_preview_text(message);
            previews.push(AgentObserveMessagePreview {
                index,
                role: message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                timestamp: message.get("timestamp").and_then(Value::as_u64),
                text: truncate_chars(&full_text, max_chars),
                truncated: full_text.chars().count() > max_chars,
                tool_calls: Vec::new(),
                custom_type: message
                    .get("customType")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        Ok(previews)
    }
}

/// Flatten the supervisor's roster rows into observation summaries of the
/// caller's NUCLEAR FAMILY: the caller's own row (`isCurrent`), its
/// parent, its siblings, and its direct children — and nothing else. The
/// relationship of each row derives from the recorded durable edges (the
/// same classification `agent_message.send` resolves through), never from
/// the row's runtime kind alone: a subagent spawned by a different parent
/// is not a child here.
pub(super) fn summaries_from_roster(
    sessions: Vec<Value>,
    identity: &FamilyIdentity,
    registry_child_active_ids: &[String],
) -> Vec<AgentObserveSummary> {
    sessions
        .into_iter()
        .filter_map(|session| {
            let active_session_id = session
                .get("activeSessionId")
                .or_else(|| session.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)?;
            let is_current = active_session_id == identity.active_session_id;
            let relationship = if is_current {
                None
            } else if registry_child_active_ids
                .iter()
                .any(|child| child == &active_session_id)
                || row_is_child(&session, identity)
            {
                Some(AgentFamilyRelationship::Child)
            } else if row_is_parent(&session, identity) {
                Some(AgentFamilyRelationship::Parent)
            } else if row_is_sibling(&session, identity) {
                Some(AgentFamilyRelationship::Sibling)
            } else {
                // Outside the nuclear family: not a family row at all.
                return None;
            };
            let runtime_kind = session
                .get("runtimeKind")
                .and_then(Value::as_str)
                .unwrap_or("top-level")
                .to_string();
            let queued = session
                .get("sessionActions")
                .and_then(|actions| actions.get("queuedCount"))
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize;
            let is_streaming = session
                .get("isStreaming")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let is_compacting = session
                .get("isCompacting")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let is_session_active = session
                .get("isSessionActive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let is_running_tools = session
                .get("isRunningTools")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let attached_clients = session
                .get("attachedClients")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize;
            // TS #2493 `classifyAgentStatus`: residency is the row's LIVE
            // `activeSessionId` — the `all: true` roster also carries
            // passivated ledger children (the stop strips the live id and
            // keys the durable session under `id`), which are INACTIVE
            // family members (TS `resident: !!summary.activeSessionId`),
            // never live quiet sessions.
            let has_live_session = session
                .get("activeSessionId")
                .and_then(Value::as_str)
                .is_some();
            // A resident session's family status is the busy verdict
            // (`activity === "working" || isSessionActive`) split into
            // `running`/`idle`; `inactive` names only rows with no
            // resident session.
            let status = if !has_live_session {
                AgentFamilyStatus::Inactive
            } else if session.get("activity").and_then(Value::as_str) == Some("working")
                || is_session_active
            {
                AgentFamilyStatus::Running
            } else {
                AgentFamilyStatus::Idle
            };
            // TS #2493 `createAgentObserveSummary`: the live activity is
            // its own axis (streaming tool work, streaming model work,
            // compaction, queued/accepted work, an attached human, or
            // quiet). The row's `isSessionActive` covers the session's own
            // work; delegated child work is not a roster-row field.
            let activity = if is_streaming && is_running_tools {
                AgentObserveActivity::Tool
            } else if is_streaming {
                AgentObserveActivity::Model
            } else if is_compacting {
                AgentObserveActivity::Compacting
            } else if is_session_active {
                AgentObserveActivity::Busy
            } else if attached_clients > 0 {
                AgentObserveActivity::User
            } else {
                AgentObserveActivity::Idle
            };
            Some(AgentObserveSummary {
                active_session_id: Some(active_session_id),
                session_id: session
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                session_name: session
                    .get("sessionName")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string),
                relationship,
                runtime_kind: Some(runtime_kind),
                status,
                activity: has_live_session.then_some(activity),
                is_current,
                is_streaming,
                is_compacting,
                attached_clients,
                queued_count: queued,
                is_session_active,
            })
        })
        .collect()
}

/// Concatenate a stored message's content into preview text.
fn message_preview_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}
