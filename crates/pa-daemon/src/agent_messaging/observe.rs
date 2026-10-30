//! The `agent_observe.*` controller: message previews and full session
//! summaries from the supervisor, the nuclear-family roster derivation, and
//! the preview text helpers.
use super::{
    json, row_is_child, row_is_parent, row_is_sibling, row_str, AgentFamilyRelationship,
    AgentFamilyStatus, AgentObserveActivity, AgentObserveController, AgentObserveListResult,
    AgentObserveMessagePreview, AgentObserveRecentMessagesResult, AgentObserveSummary, Arc,
    FamilyIdentity, SupervisorLink, Value, AGENT_OBSERVE_PREVIEW_MAX_CHARS,
};

/// `agent_observe.*` controller for daemon workers: message previews and
/// full session summaries from the supervisor. The roster this controller
/// reports is the caller's NUCLEAR FAMILY, derived from the same durable
/// parent edges `agent_message.send` resolves through — never the whole daemon.
pub struct LinkAgentObserveController {
    link: Arc<SupervisorLink>,
    /// This worker's live active session id (the family-scope anchor).
    active_session_id: String,
    /// This worker's own session summary, pushed at create and rename.
    own_summary: Arc<std::sync::Mutex<Option<Value>>>,
    /// This session's resident RLM children (the registry join for Child
    /// rows the roster may not list).
    children: Option<Arc<crate::rlm_children::SupervisorChildSessions>>,
}

impl LinkAgentObserveController {
    pub fn new(
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
        // passive ledger children, so a released child's durable row stays
        // in the caller's nuclear family exactly like the TS roster.
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

    /// This session's resident children's live active session ids (rows the
    /// registry owns are Children even before their durable edges hydrate).
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

    /// The nuclear-family summaries every observe handler reads: one
    /// roster walk plus the registry join.
    async fn family_summaries(&self) -> anyhow::Result<Vec<AgentObserveSummary>> {
        let (sessions, identity) = self.roster_and_identity().await?;
        let child_ids = self.registry_child_active_ids().await;
        Ok(summaries_from_roster(sessions, &identity, &child_ids))
    }

    /// The family member `target` names: the one resolution and permission check
    /// every read of another session goes through.
    async fn family_target(&self, target: &str) -> anyhow::Result<AgentObserveSummary> {
        find_target(self.family_summaries().await?, target)?
            .ok_or_else(|| anyhow::anyhow!("agent {target} is not reachable"))
    }

    /// One `get_session_messages` read of `agent`'s transcript: its worker answers when one
    /// holds the session, otherwise the supervisor reads the session file.
    async fn request_session_messages(
        &self,
        agent: &AgentObserveSummary,
        start: i64,
        limit: u64,
        roles: Vec<String>,
    ) -> anyhow::Result<Value> {
        let command = pa_types::daemon::DaemonCommand::GetSessionMessages {
            id: None,
            active_session_id: agent.active_session_id.clone().unwrap_or_default(),
            start,
            limit,
            roles,
            session_file: agent.session_file.clone(),
            rest: serde_json::Map::default(),
        };
        self.link
            .request_success(
                serde_json::to_value(command)?,
                std::time::Duration::from_secs(30),
            )
            .await
    }

    /// The caller's own summary from its pushed state alone, no roster
    /// read: the row `list_agents` serves when the walk missed this
    /// session's live row.
    fn current_summary(&self) -> Option<AgentObserveSummary> {
        let own = self
            .own_summary
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        let identity = FamilyIdentity::from_summary(Some(&own), &self.active_session_id);
        summaries_from_roster(vec![own], &identity, &[])
            .into_iter()
            .next()
    }
}

/// Resolve within the nuclear family using the registry's normalized id-suffix
/// and exact-name contract. Exact active ids retain direct-lookup precedence.
fn find_target(
    mut summaries: Vec<AgentObserveSummary>,
    target: &str,
) -> anyhow::Result<Option<AgentObserveSummary>> {
    if let Some(at) = summaries
        .iter()
        .position(|summary| summary.active_session_id.as_deref() == Some(target))
    {
        return Ok(Some(summaries.remove(at)));
    }
    let mut matches: Vec<_> = summaries
        .into_iter()
        .filter(|summary| {
            summary
                .active_session_id
                .as_deref()
                .is_some_and(|id| crate::registry::selector_matches(id, target))
                || crate::registry::selector_matches(&summary.session_id, target)
                || summary.session_name.as_deref() == Some(target)
        })
        .collect();
    if matches.len() > 1 {
        let rendered = matches
            .iter()
            .map(|summary| {
                let id = summary
                    .active_session_id
                    .as_deref()
                    .unwrap_or(&summary.session_id);
                summary
                    .session_name
                    .as_deref()
                    .filter(|name| !name.is_empty())
                    .map_or_else(|| id.to_string(), |name| format!("{id} ({name})"))
            })
            .collect::<Vec<_>>()
            .join(", ");
        anyhow::bail!("Ambiguous active session \"{target}\": matches {rendered}");
    }
    Ok(matches.pop())
}

impl AgentObserveController for LinkAgentObserveController {
    async fn list_agents(&self) -> anyhow::Result<AgentObserveListResult> {
        let mut summaries = self.family_summaries().await?;
        // TS `requireCurrentState`: the caller's own row always rides the
        // list response. The roster walk can miss it when the caller's own
        // worker `get_state` degraded to the offline stub, so fall back to
        // the pushed own summary before erroring.
        let own_row = || {
            self.current_summary().ok_or_else(|| {
                anyhow::anyhow!("Agent observe state is not ready for this session yet")
            })
        };
        let current = match summaries.iter().position(|summary| summary.is_current) {
            // A degraded own row is the offline stub (empty sessionId, no
            // activeSessionId): never serve it as `current` — drop it and
            // serve the pushed own summary instead.
            Some(at) if !summaries[at].session_id.is_empty() => summaries.remove(at),
            Some(at) => {
                summaries.remove(at);
                own_row()?
            }
            None => own_row()?,
        };
        Ok(AgentObserveListResult {
            current,
            agents: summaries,
        })
    }

    async fn get_agent(&self, target: &str) -> anyhow::Result<Option<AgentObserveSummary>> {
        find_target(self.family_summaries().await?, target)
    }

    async fn recent_messages(
        &self,
        target: &str,
        limit: usize,
        max_chars: usize,
    ) -> anyhow::Result<AgentObserveRecentMessagesResult> {
        let agent = self.family_target(target).await?;
        let data = self
            .request_session_messages(
                &agent,
                -i64::try_from(limit)?,
                u64::try_from(limit)?,
                vec!["*".to_string()],
            )
            .await?;
        let reply: SessionMessagesReply = serde_json::from_value(data)?;
        let truncated = reply.total > reply.messages.len();
        let previews = reply
            .messages
            .into_iter()
            .map(|SessionMessageRow { index, message }| {
                let full_text = message_preview_text(&message);
                AgentObserveMessagePreview {
                    index,
                    role: message
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    timestamp: message.get("timestamp").and_then(|value| {
                        value
                            .as_u64()
                            .or_else(|| value.as_str().and_then(crate::util::iso_to_unix_ms))
                    }),
                    text: truncate_chars(&full_text, max_chars),
                    truncated: full_text.chars().count() > max_chars,
                    tool_calls: Vec::new(),
                    custom_type: message
                        .get("customType")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                }
            })
            .collect();
        Ok(AgentObserveRecentMessagesResult {
            agent,
            messages: previews,
            limit,
            max_chars,
            truncated,
        })
    }
}

/// The `get_session_messages` reply fields a preview reads.
#[derive(serde::Deserialize)]
struct SessionMessagesReply {
    messages: Vec<SessionMessageRow>,
    total: usize,
}

#[derive(serde::Deserialize)]
struct SessionMessageRow {
    index: usize,
    message: Value,
}

/// Flatten the supervisor's roster rows into observation summaries of the caller's NUCLEAR
/// FAMILY: the caller's own row, its parent, its siblings, and its direct children. The
/// relationship derives from the durable edges, never the row's runtime kind.
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
            // TS #2493 `classifyAgentStatus`: residency is the row's LIVE `activeSessionId`
            // - the `all: true` roster's passivated children are INACTIVE, never live.
            let has_live_session = session
                .get("activeSessionId")
                .and_then(Value::as_str)
                .is_some();
            // A resident session's family status is the busy verdict
            // (`activity === "working" || isSessionActive`) split into
            // `running`/`idle`; `inactive` names only rows with no
            // resident session. A session whose subagents still run
            // reports `activity: "working"`, so it counts as running.
            let status = if !has_live_session {
                AgentFamilyStatus::Inactive
            } else if session.get("activity").and_then(Value::as_str) == Some("working")
                || is_session_active
            {
                AgentFamilyStatus::Running
            } else {
                AgentFamilyStatus::Idle
            };
            // TS #2493 `createAgentObserveSummary`: the live activity is its own axis;
            // `isSessionActive` covers the session's own work, not delegated child work.
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
                cwd: row_str(&session, "cwd").map(str::to_string),
                status,
                activity: has_live_session.then_some(activity),
                is_current,
                is_streaming,
                is_compacting,
                attached_clients,
                message_count: session.get("messageCount").and_then(Value::as_u64),
                queued_count: queued,
                is_session_active,
                // TS `AgentObserveAgentSummary`: the parent edges and the
                // child id ride the row when the roster carries them; the
                // preview cap bounds an inactive child's first message.
                parent_active_session_id: row_str(&session, "parentActiveSessionId")
                    .map(str::to_string),
                parent_session_id: row_str(&session, "parentSessionId").map(str::to_string),
                rlm_child_id: row_str(&session, "rlmChildId").map(str::to_string),
                first_message: row_str(&session, "firstMessage")
                    .map(|text| truncate_chars(text, AGENT_OBSERVE_PREVIEW_MAX_CHARS)),
                session_file: row_str(&session, "sessionFile").map(str::to_string),
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
        // A `compactionSummary` row keeps its text in `summary`.
        _ => message
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}
