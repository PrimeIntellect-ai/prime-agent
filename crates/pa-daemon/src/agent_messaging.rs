//! Kernel `agent_message`/`agent_observe` controllers for daemon workers:
//! the supervisor-link family roster, worker-to-worker direct peer delivery
//! (thin-supervisor stage 3) with the supervisor-routed fallback, and the
//! wire receipt mapping.

use std::sync::Arc;

use serde_json::{json, Value};

use pa_core::session_engine::agent_messaging::{
    AgentFamilyMember, AgentFamilyRelationship, AgentMessageController, AgentMessageDeliveryStatus,
    AgentMessageReceipt, AgentMessageSendInput, AgentObserveController, AgentObserveMessagePreview,
    AgentObserveSummary,
};

use crate::supervisor_link::SupervisorLink;

// ---------------------------------------------------------------------------
// Supervisor-link controllers (kernel agent_message/agent_observe bridges)
// ---------------------------------------------------------------------------

/// `agent_message.send` controller for daemon workers. The family roster
/// and message delivery both go through the supervisor; a send first tries
/// the direct worker-to-worker peer transport (thin-supervisor stage 3) and
/// falls back to the supervisor-routed `send_message` (the TS worker's
/// `sendRemoteAgentSessionMessage` path). Neither path is retried: daemon
/// commands are not idempotent.
/// Exposed for the agent-family e2e verifier (tests/agent_family_e2e.rs):
/// the same controller construction the worker engine wires.
pub struct LinkAgentMessageController {
    link: Arc<SupervisorLink>,
    active_session_id: String,
    worker_token: String,
    /// This worker's own session summary, pushed by the worker at create
    /// (and rename); the sender identity block for direct deliveries.
    own_summary: Arc<std::sync::Mutex<Option<Value>>>,
    /// This session's resident RLM children (the same registry
    /// `rlm.list_subagents` reads); `None` for standalone workers.
    children: Option<Arc<crate::rlm_children::SupervisorChildSessions>>,
}

impl LinkAgentMessageController {
    pub fn new(
        link: Arc<SupervisorLink>,
        active_session_id: String,
        worker_token: String,
        own_summary: Arc<std::sync::Mutex<Option<Value>>>,
        children: Option<Arc<crate::rlm_children::SupervisorChildSessions>>,
    ) -> Self {
        LinkAgentMessageController {
            link,
            active_session_id,
            worker_token,
            own_summary,
            children,
        }
    }
}

/// Budget for the peer-ticket request on the supervisor link (the TS
/// `get_direct_worker_transport` window).
const PEER_TICKET_TIMEOUT_MS: u64 = 5_000;

/// The supervisor roster read behind `family()` and `agent_observe.list`.
async fn roster_summaries(
    link: &Arc<crate::supervisor_link::SupervisorLink>,
    worker_token: &str,
) -> anyhow::Result<Vec<Value>> {
    // TS uses the supervisor's pushed in-memory peer roster, not `list`
    // (which refreshes every worker serially). Surface an unavailable
    // supervisor instead of silently claiming the caller has no siblings.
    let data = link
        .request_success(
            json!({ "type": "list_agent_peers", "workerToken": worker_token }),
            std::time::Duration::from_secs(5),
        )
        .await?;
    Ok(data
        .get("peers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

impl AgentMessageController for LinkAgentMessageController {
    async fn family(&self) -> anyhow::Result<Vec<AgentFamilyMember>> {
        let sessions = roster_summaries(&self.link, &self.worker_token).await?;
        // The parent identity (subagent summaries carry their parent's
        // live and persisted ids); a top-level session has none.
        let parent = self.parent_identity();
        // This session's resident children, keyed for the roster join.
        // The registry is the same source `rlm.list_subagents` reads, so
        // the family view and the RLM roster can never disagree on which
        // children exist.
        let mut children = match &self.children {
            Some(children) => children.child_identities().await,
            None => Vec::new(),
        };
        let mut parent_member: Option<AgentFamilyMember> = None;
        let mut siblings: Vec<AgentFamilyMember> = Vec::new();
        let mut child_members: Vec<AgentFamilyMember> = Vec::new();
        for session in sessions {
            let Some(active_session_id) = session
                .get("activeSessionId")
                .or_else(|| session.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            if active_session_id == self.active_session_id {
                continue;
            }
            let session_id = session
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = session
                .get("sessionName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_string);
            // A roster row owned by this session's children registry is a
            // Child member (keyed by its RLM child id and persisted session
            // id as aliases, so every identifier form the roster exposes
            // addresses it).
            if let Some(position) = children
                .iter()
                .position(|child| child.active_session_id == active_session_id)
            {
                let child = children.swap_remove(position);
                child_members.push(child_member(&child, name));
                continue;
            }
            // The session that spawned this worker (when this worker is a
            // subagent): a Parent member, addressed by its live ids.
            if parent.as_ref().is_some_and(|(active, persisted)| {
                active.as_deref() == Some(active_session_id.as_str())
                    || (persisted.is_some() && persisted.as_deref() == Some(session_id))
            }) {
                parent_member = Some(AgentFamilyMember {
                    relationship: AgentFamilyRelationship::Parent,
                    id: active_session_id,
                    name,
                    aliases: Vec::new(),
                });
                continue;
            }
            siblings.push(AgentFamilyMember {
                relationship: AgentFamilyRelationship::Sibling,
                id: active_session_id,
                name,
                // The persisted session id also addresses a sibling
                // (TS family entries are keyed by it).
                aliases: (!session_id.is_empty())
                    .then(|| session_id.to_string())
                    .into_iter()
                    .collect(),
            });
        }
        // Children the roster does not list (a passivating or
        // mid-registration child worker) stay addressable: the delivery
        // transports resolve or wake them from their persisted identity.
        for child in children {
            child_members.push(child_member(&child, None));
        }
        // TS `selectAgentFamily` order: parent, siblings by name, then
        // children by name.
        siblings.sort_by(|left, right| left.member_name().cmp(right.member_name()));
        child_members.sort_by(|left, right| left.member_name().cmp(right.member_name()));
        Ok(parent_member
            .into_iter()
            .chain(siblings)
            .chain(child_members)
            .collect())
    }

    async fn send_agent_message(
        &self,
        input: AgentMessageSendInput,
    ) -> anyhow::Result<AgentMessageReceipt> {
        if input.target == self.active_session_id {
            anyhow::bail!("Agent messaging cannot target the sending session");
        }
        // Direct peer delivery first (stage 3): a single-use `worker`
        // grant on the target's own socket, bypassing the supervisor's
        // route plane. Falls back to the supervisor-routed send (the TS
        // remote path) whenever the direct link cannot be established -
        // but never after the delivery command was sent: the grant burns
        // on first use, so an in-flight delivery's outcome is final.
        match self.deliver_direct(&input).await {
            DirectDelivery::Delivered(receipt) => Ok(receipt),
            DirectDelivery::Unavailable => self.deliver_via_supervisor(input).await,
            DirectDelivery::Failed(error) => Err(anyhow::anyhow!(error)),
        }
    }
}

/// The outcome of the direct-delivery attempt.
enum DirectDelivery {
    /// The target answered with a receipt.
    Delivered(AgentMessageReceipt),
    /// No direct link could be established; the supervisor route may take
    /// over.
    Unavailable,
    /// The attempt reached the target and is final: the grant burned, so
    /// the error surfaces instead of a fallback.
    Failed(String),
}

impl LinkAgentMessageController {
    /// Try the direct worker-to-worker path. `Unavailable` only when the
    /// delivery command never reached the target (no ticket, connect
    /// failure, or failed grant burn - the message was not delivered);
    /// once the command is sent the outcome is final either way.
    async fn deliver_direct(&self, input: &AgentMessageSendInput) -> DirectDelivery {
        let ticket = match self
            .link
            .request_success(
                json!({
                    "type": "get_worker_peer_transport",
                    "workerToken": self.worker_token,
                    "targetActiveSessionId": input.target,
                }),
                std::time::Duration::from_millis(PEER_TICKET_TIMEOUT_MS),
            )
            .await
        {
            Ok(data) => {
                match serde_json::from_value::<pa_types::daemon::DaemonPeerTransportTicket>(data) {
                    Ok(ticket) => ticket,
                    Err(_) => return DirectDelivery::Unavailable,
                }
            }
            // A ticket refusal (worker without direct transport, target
            // unavailable) is the fallback trigger, not an error.
            Err(_) => return DirectDelivery::Unavailable,
        };
        match crate::peer_client::deliver_message_over_peer_transport(
            &ticket,
            &input.target,
            &input.message,
            &self.sender_block(),
            None,
        )
        .await
        {
            crate::peer_client::PeerDeliveryOutcome::NotEstablished => DirectDelivery::Unavailable,
            crate::peer_client::PeerDeliveryOutcome::Lost => DirectDelivery::Failed(
                "Peer delivery to the target session was sent but not acknowledged".to_string(),
            ),
            crate::peer_client::PeerDeliveryOutcome::Answered(response) => {
                let response = *response;
                if !response.success {
                    return DirectDelivery::Failed(
                        response
                            .error
                            .unwrap_or_else(|| "Agent message was not accepted".to_string()),
                    );
                }
                match response
                    .data
                    .as_ref()
                    .and_then(|data| receipt_from_wire(data, input.clone()))
                {
                    Some(receipt) => DirectDelivery::Delivered(receipt),
                    None => DirectDelivery::Failed(
                        "Target session returned an invalid agent-message receipt".to_string(),
                    ),
                }
            }
        }
    }

    /// The supervisor-routed fallback (TS `sendRemoteAgentSessionMessage`).
    async fn deliver_via_supervisor(
        &self,
        input: AgentMessageSendInput,
    ) -> anyhow::Result<AgentMessageReceipt> {
        let data = self
            .link
            .request_success(
                json!({
                    "type": "send_message",
                    "targetActiveSessionId": input.target,
                    "message": input.message,
                    "fromActiveSessionId": self.active_session_id,
                    "agentOrigin": true,
                }),
                std::time::Duration::from_secs(30),
            )
            .await?;
        receipt_from_wire(&data, input)
            .ok_or_else(|| anyhow::anyhow!("Supervisor returned an invalid agent-message receipt"))
    }

    /// This session's parent identity from its own summary (the subagent
    /// create metadata carries the parent's live and persisted ids):
    /// `(active session id, persisted session id)`, `None` when this
    /// session is not a subagent.
    fn parent_identity(&self) -> Option<(Option<String>, Option<String>)> {
        let summary = self
            .own_summary
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()?;
        let non_empty = |key: &str| {
            summary
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let active = non_empty("parentActiveSessionId");
        let persisted = non_empty("parentSessionId");
        (active.is_some() || persisted.is_some()).then_some((active, persisted))
    }

    /// The TS `createAgentSessionMessageSender` shape for agent-origin
    /// sends: the sending session's endpoint fields plus the `agent`
    /// client identity (the TS daemon attributes kernel sends this way
    /// when no client id is in play).
    fn sender_block(&self) -> Value {
        let summary = self
            .own_summary
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let mut sender = json!({
            "activeSessionId": self.active_session_id,
            "runtimeKind": "top-level",
            "clientId": "agent",
        });
        if let Some(summary) = summary {
            if let Some(session_id) = summary.get("sessionId").filter(|value| !value.is_null()) {
                sender["sessionId"] = session_id.clone();
            }
            if let Some(name) = summary
                .get("sessionName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
            {
                sender["sessionName"] = json!(name);
            }
            if let Some(kind) = summary
                .get("runtimeKind")
                .and_then(Value::as_str)
                .filter(|kind| !kind.is_empty())
            {
                sender["runtimeKind"] = json!(kind);
            }
        }
        sender
    }
}

/// One registry child as a family member: a Child relationship keyed by
/// its live active session id, named by its session name, with the RLM
/// child id and the persisted session id as alias selectors (every
/// identifier form `rlm.list_subagents` and the roster expose). `name`
/// from the roster row overrides the registry's when set (a fresh rename).
fn child_member(
    child: &crate::rlm_children::RlmChildIdentity,
    name: Option<String>,
) -> AgentFamilyMember {
    let mut aliases = vec![child.rlm_child_id.clone()];
    if let Some(session_id) = &child.session_id {
        if !session_id.is_empty() {
            aliases.push(session_id.clone());
        }
    }
    AgentFamilyMember {
        relationship: AgentFamilyRelationship::Child,
        id: child.active_session_id.clone(),
        name: name.or_else(|| (!child.session_name.is_empty()).then(|| child.session_name.clone())),
        aliases,
    }
}

/// Map a delivery receipt payload (the `worker_deliver_message` response
/// data, both delivery paths) onto the kernel receipt shape. `None` marks
/// a payload that does not carry the TS receipt fields.
fn receipt_from_wire(data: &Value, input: AgentMessageSendInput) -> Option<AgentMessageReceipt> {
    let target = data.get("target")?;
    let id = data.get("id")?.as_str()?.to_string();
    let delivery_status = if data.get("deliveryStatus").and_then(Value::as_str) == Some("delivered")
    {
        AgentMessageDeliveryStatus::Delivered
    } else {
        AgentMessageDeliveryStatus::Queued
    };
    let delivery_mode = match data.get("deliveryMode").and_then(Value::as_str) {
        Some("follow_up") => "follow_up",
        _ => "steer",
    };
    Some(AgentMessageReceipt {
        id,
        target: target
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(&input.target)
            .to_string(),
        target_session_id: target
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string),
        target_session_name: target
            .get("sessionName")
            .and_then(Value::as_str)
            .map(str::to_string),
        target_runtime_kind: target
            .get("runtimeKind")
            .and_then(Value::as_str)
            .map(str::to_string),
        message: input.message,
        delivery_status,
        delivery_mode: Some(delivery_mode),
        receiver_role: input.receiver_role,
        delivered_at: data
            .get("deliveredAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        queued_at: data
            .get("queuedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// `agent_observe.*` controller for daemon workers: message previews and
/// full session summaries from the supervisor.
pub(crate) struct LinkAgentObserveController {
    link: Arc<SupervisorLink>,
}

impl LinkAgentObserveController {
    pub(crate) fn new(link: Arc<SupervisorLink>) -> Self {
        LinkAgentObserveController { link }
    }
}

impl AgentObserveController for LinkAgentObserveController {
    async fn list_agents(&self) -> anyhow::Result<Vec<AgentObserveSummary>> {
        let data = self
            .link
            .request_success(
                json!({ "type": "list" }),
                std::time::Duration::from_secs(30),
            )
            .await?;
        let sessions = data
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(summaries_from_roster(sessions))
    }

    async fn get_agent(&self, target: &str) -> anyhow::Result<Option<AgentObserveSummary>> {
        let data = self
            .link
            .request_success(
                json!({ "type": "list" }),
                std::time::Duration::from_secs(30),
            )
            .await?;
        let sessions = data
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(summaries_from_roster(sessions).into_iter().find(|summary| {
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

/// Flatten the supervisor's full `list` rows into observation summaries.
fn summaries_from_roster(sessions: Vec<Value>) -> Vec<AgentObserveSummary> {
    sessions
        .into_iter()
        .map(|session| {
            let runtime_kind = session
                .get("runtimeKind")
                .and_then(Value::as_str)
                .unwrap_or("top-level")
                .to_string();
            let relationship = match runtime_kind.as_str() {
                "subagent" => {
                    Some(pa_core::session_engine::agent_messaging::AgentFamilyRelationship::Child)
                }
                _ => None,
            };
            let queued = session
                .get("sessionActions")
                .and_then(|actions| actions.get("queuedCount"))
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize;
            AgentObserveSummary {
                active_session_id: session
                    .get("activeSessionId")
                    .or_else(|| session.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
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
                status: if session.get("activity").and_then(Value::as_str) == Some("idle") {
                    "inactive".to_string()
                } else {
                    "running".to_string()
                },
                is_current: false,
                is_streaming: session
                    .get("isStreaming")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                is_compacting: session
                    .get("isCompacting")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                attached_clients: session
                    .get("attachedClients")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as usize,
                queued_count: queued,
                is_session_active: session
                    .get("isSessionActive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
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

// ---------------------------------------------------------------------------
// Controller tests: family roster, direct peer delivery, fallback
// ---------------------------------------------------------------------------

#[cfg(test)]
mod controller_tests {
    use super::*;
    use crate::protocol::{response_failure, response_success};
    use crate::rlm_children::RlmChildIdentity;
    use crate::supervisor_link::SupervisorLink;
    use pa_core::session_engine::agent_messaging::AgentMessageController;
    use pa_types::platform::transport::bind_transport;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    /// A scripted JSONL supervisor: answers `list` with a roster,
    /// `get_worker_peer_transport` per script, and `send_message` with a
    /// TS receipt.
    async fn spawn_fake_supervisor(
        socket: std::path::PathBuf,
        roster: Value,
        ticket_response: Option<Value>,
    ) {
        let listener = bind_transport(&socket).await.unwrap();
        tokio::spawn(async move {
            loop {
                let Ok(stream) = listener.accept().await else {
                    return;
                };
                let roster = roster.clone();
                let ticket_response = ticket_response.clone();
                tokio::spawn(async move {
                    let (reader, mut writer) = stream.split();
                    let mut reader = BufReader::new(reader);
                    writer
                        .write_all(
                            b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                        )
                        .await
                        .unwrap();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap() == 0 {
                            return;
                        }
                        let value: Value = serde_json::from_str(line.trim()).unwrap();
                        let id = value["id"].as_str().unwrap_or_default().to_string();
                        let command = value["command"].clone();
                        let command_type = command["type"].as_str().unwrap_or_default().to_string();
                        let response = match command_type.as_str() {
                            "list_agent_peers" => response_success(
                                Some(&id),
                                "list_agent_peers",
                                Some(json!({ "peers": roster["sessions"] })),
                            ),
                            "get_worker_peer_transport" => match ticket_response.clone() {
                                Some(ticket) => {
                                    response_success(Some(&id), &command_type, Some(ticket))
                                }
                                None => response_failure(
                                    Some(&id),
                                    &command_type,
                                    "Session worker does not support direct peer transport",
                                    None,
                                ),
                            },
                            "send_message" => response_success(
                                Some(&id),
                                "send_message",
                                Some(json!({
                                    "id": "agentmsg_direct",
                                    "source": "agent_message",
                                    "target": {
                                        "activeSessionId": "bbb222",
                                        "sessionId": "sess-b",
                                        "runtimeKind": "top-level",
                                    },
                                    "message": command["message"].clone(),
                                    "deliveryStatus": "delivered",
                                    "deliveredAt": "2026-01-01T00:00:00.000Z",
                                    "deliveryMode": "steer",
                                })),
                            ),
                            other => response_failure(Some(&id), other, "unexpected command", None),
                        };
                        let mut line = serde_json::to_string(&response).unwrap();
                        line.push('\n');
                        if writer.write_all(line.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
    }

    fn controller(
        socket: std::path::PathBuf,
        own_summary: Option<Value>,
    ) -> LinkAgentMessageController {
        LinkAgentMessageController {
            link: Arc::new(SupervisorLink::new(socket)),
            active_session_id: "aaa111".to_string(),
            worker_token: "tok-a".to_string(),
            own_summary: Arc::new(std::sync::Mutex::new(own_summary)),
            children: None,
        }
    }

    /// A controller whose children registry holds one resident child
    /// (`sub-kid1`, live id `ddd444`): the same registry shape
    /// `rlm.list_subagents` reads.
    fn controller_with_children(
        socket: std::path::PathBuf,
        own_summary: Option<Value>,
    ) -> LinkAgentMessageController {
        let children = crate::rlm_children::SupervisorChildSessions::new(
            Arc::new(SupervisorLink::new(socket.clone())),
            std::path::PathBuf::from("/agent"),
            "aaa111".to_string(),
            std::sync::Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
                std::path::PathBuf::from("/agent"),
                std::path::PathBuf::from("/agent"),
                /*telemetry_disabled*/ true,
            )),
        );
        let mut controller = controller(socket, own_summary);
        controller.children = Some(Arc::new(children));
        controller
    }

    /// Seed the children registry with one admitted child (the same state
    /// `rlm.spawn` leaves behind, without the supervisor round trip).
    async fn admit_child(controller: &LinkAgentMessageController, child: RlmChildIdentity) {
        controller
            .children
            .as_ref()
            .expect("children registry")
            .push_test_child(child)
            .await;
    }

    fn own_summary() -> Option<Value> {
        Some(json!({
            "activeSessionId": "aaa111",
            "sessionId": "sess-a",
            "sessionName": "alpha",
            "runtimeKind": "top-level",
        }))
    }

    fn input() -> AgentMessageSendInput {
        AgentMessageSendInput {
            target: "bbb222".to_string(),
            message: "hello there".to_string(),
            receiver_role: Some(AgentFamilyRelationship::Sibling),
        }
    }

    #[tokio::test]
    async fn family_reads_siblings_from_the_supervisor_roster() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(
            socket.clone(),
            json!({ "sessions": [
                { "activeSessionId": "aaa111", "sessionId": "sess-a", "sessionName": "alpha" },
                { "activeSessionId": "bbb222", "sessionId": "sess-b", "sessionName": "beta" },
                { "activeSessionId": "ccc333", "sessionId": "sess-c" },
            ]}),
            None,
        )
        .await;
        let controller = controller(socket, None);
        let family = controller.family().await.unwrap();
        assert_eq!(family.len(), 2, "{family:?}");
        assert_eq!(family[0].relationship, AgentFamilyRelationship::Sibling);
        assert_eq!(family[0].id, "bbb222");
        assert_eq!(family[0].name.as_deref(), Some("beta"));
        assert_eq!(family[1].id, "ccc333");
        assert_eq!(family[1].name, None);
    }

    /// The family view labels this session's registry children as Child
    /// members (with the RLM child id and persisted session id as alias
    /// selectors) and its own parent as the Parent member; the child row
    /// is not also a sibling.
    #[tokio::test]
    async fn family_labels_children_and_parent_from_the_registry() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(
            socket.clone(),
            json!({ "sessions": [
                { "activeSessionId": "aaa111", "sessionId": "sess-a", "sessionName": "alpha" },
                { "activeSessionId": "bbb222", "sessionId": "sess-b", "sessionName": "beta" },
                { "activeSessionId": "ddd444", "sessionId": "sess-d", "sessionName": "worker-a" },
                { "activeSessionId": "ppp000", "sessionId": "sess-p", "sessionName": "papa" },
            ]}),
            None,
        )
        .await;
        let own_summary = Some(json!({
            "activeSessionId": "aaa111",
            "sessionId": "sess-a",
            "sessionName": "alpha",
            "parentActiveSessionId": "ppp000",
            "parentSessionId": "sess-p",
        }));
        let controller = controller_with_children(socket, own_summary);
        admit_child(
            &controller,
            RlmChildIdentity {
                rlm_child_id: "sub-kid1".to_string(),
                active_session_id: "ddd444".to_string(),
                session_id: Some("sess-d".to_string()),
                session_name: "worker-a".to_string(),
            },
        )
        .await;
        let family = controller.family().await.unwrap();
        // TS `selectAgentFamily` order: parent, siblings, children.
        assert_eq!(family.len(), 3, "{family:?}");
        assert_eq!(family[0].relationship, AgentFamilyRelationship::Parent);
        assert_eq!(family[0].id, "ppp000");
        assert_eq!(family[0].name.as_deref(), Some("papa"));
        assert_eq!(family[1].relationship, AgentFamilyRelationship::Sibling);
        assert_eq!(family[1].id, "bbb222");
        assert_eq!(
            family[2].relationship,
            AgentFamilyRelationship::Child,
            "{family:?}"
        );
        assert_eq!(family[2].id, "ddd444");
        assert_eq!(family[2].name.as_deref(), Some("worker-a"));
        assert_eq!(family[2].aliases, vec!["sub-kid1", "sess-d"]);
        // No member duplicates the child as a sibling.
        assert!(!family.iter().any(|member| member.id == "ddd444"
            && member.relationship == AgentFamilyRelationship::Sibling));
    }

    /// A child resolves its parent by the persisted session id too (the
    /// live id can change across a parent worker restart).
    #[tokio::test]
    async fn family_resolves_the_parent_by_session_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(
            socket.clone(),
            json!({ "sessions": [
                { "activeSessionId": "aaa111", "sessionId": "sess-a" },
                { "activeSessionId": "rrr777", "sessionId": "sess-p", "sessionName": "papa" },
            ]}),
            None,
        )
        .await;
        let own_summary = Some(json!({
            "activeSessionId": "aaa111",
            "sessionId": "sess-a",
            "parentActiveSessionId": "stale-parent",
            "parentSessionId": "sess-p",
        }));
        let controller = controller(socket, own_summary);
        let family = controller.family().await.unwrap();
        assert_eq!(family.len(), 1, "{family:?}");
        assert_eq!(family[0].relationship, AgentFamilyRelationship::Parent);
        assert_eq!(family[0].id, "rrr777");
    }

    /// Registry children the roster does not list stay addressable as Child
    /// members keyed by their registry identity.
    #[tokio::test]
    async fn family_keeps_off_roster_children_addressable() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(
            socket.clone(),
            json!({ "sessions": [
                { "activeSessionId": "aaa111", "sessionId": "sess-a" },
            ]}),
            None,
        )
        .await;
        let controller = controller_with_children(socket, None);
        admit_child(
            &controller,
            RlmChildIdentity {
                rlm_child_id: "sub-kid2".to_string(),
                active_session_id: "eee555".to_string(),
                session_id: Some("sess-e".to_string()),
                session_name: "worker-b".to_string(),
            },
        )
        .await;
        let family = controller.family().await.unwrap();
        assert_eq!(family.len(), 1, "{family:?}");
        assert_eq!(family[0].relationship, AgentFamilyRelationship::Child);
        assert_eq!(family[0].id, "eee555");
        assert_eq!(family[0].name.as_deref(), Some("worker-b"));
        assert_eq!(family[0].aliases, vec!["sub-kid2", "sess-e"]);
    }

    /// A refused ticket falls back to the supervisor-routed send_message.
    #[tokio::test]
    async fn refused_ticket_falls_back_to_the_supervisor_route() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(socket.clone(), json!({ "sessions": [] }), None).await;
        let controller = controller(socket, own_summary());
        let receipt = controller.send_agent_message(input()).await.unwrap();
        assert_eq!(receipt.id, "agentmsg_direct");
        assert_eq!(receipt.target, "bbb222");
        assert_eq!(receipt.target_session_id.as_deref(), Some("sess-b"));
        assert_eq!(
            receipt.delivery_status,
            AgentMessageDeliveryStatus::Delivered
        );
        assert_eq!(receipt.message, "hello there");
        assert_eq!(
            receipt.receiver_role,
            Some(AgentFamilyRelationship::Sibling)
        );
    }

    /// The self-target guard answers with the TS string before any wire
    /// traffic.
    #[tokio::test]
    async fn self_target_is_refused() {
        let controller = controller(std::path::PathBuf::from("/nonexistent.sock"), None);
        let error = controller
            .send_agent_message(AgentMessageSendInput {
                target: "aaa111".to_string(),
                message: "note to self".to_string(),
                receiver_role: None,
            })
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Agent messaging cannot target the sending session"
        );
    }

    /// A minted ticket delivers straight to the target worker's socket:
    /// `peer_auth` with the worker purpose, then `worker_deliver_message`
    /// carrying the TS sender identity block, and the receipt maps onto
    /// the kernel shape.
    #[tokio::test]
    async fn direct_ticket_delivers_to_the_target_worker_socket() {
        let dir = tempfile::TempDir::new().unwrap();
        let worker_socket = dir.path().join("worker.sock");
        let listener = bind_transport(&worker_socket).await.unwrap();
        let received = Arc::new(std::sync::Mutex::new(Vec::<(String, Value)>::new()));
        let recorded = Arc::clone(&received);
        tokio::spawn(async move {
            let stream = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.split();
            let mut reader = crate::framing::PrivateFrameReader::new(
                reader,
                crate::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
            );
            let hello = crate::framing::encode_private_frame(
                &json!({ "kind": "outbound", "outboundType": "daemon_hello" }),
                b"{}".as_slice(),
                crate::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
            )
            .unwrap();
            writer.write_all(&hello).await.unwrap();
            loop {
                let Some(frame) = reader.read_frame().await.unwrap() else {
                    return;
                };
                let command_type = frame
                    .header
                    .get("commandType")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let request_id = frame
                    .header
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let payload: Value = serde_json::from_slice(&frame.payload).unwrap();
                recorded
                    .lock()
                    .unwrap()
                    .push((command_type.clone(), payload.clone()));
                let response = match command_type.as_str() {
                    "peer_auth" => response_success(
                        Some(&request_id),
                        "peer_auth",
                        Some(json!({
                            "workerInstanceId": "inst-b",
                            "activeSessionId": "bbb222",
                            "purpose": "worker",
                        })),
                    ),
                    "worker_deliver_message" => response_success(
                        Some(&request_id),
                        "worker_deliver_message",
                        Some(json!({
                            "id": "agentmsg_peer",
                            "source": "agent_message",
                            "target": {
                                "activeSessionId": "bbb222",
                                "sessionId": "sess-b",
                                "sessionName": "beta",
                                "runtimeKind": "top-level",
                            },
                            "message": payload["message"].clone(),
                            "deliveryStatus": "queued",
                            "queuedAt": "2026-01-01T00:00:00.000Z",
                            "deliveryMode": "steer",
                        })),
                    ),
                    other => response_failure(Some(&request_id), other, "unexpected", None),
                };
                let frame = crate::framing::encode_private_frame(
                    &json!({
                        "kind": "outbound",
                        "requestId": request_id,
                        "outboundType": "response",
                    }),
                    &serde_json::to_vec(&response).unwrap(),
                    crate::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
                )
                .unwrap();
                writer.write_all(&frame).await.unwrap();
            }
        });

        let ticket = json!({
            "purpose": "worker",
            "socketPath": worker_socket.to_string_lossy(),
            "socketIdentity": { "dev": 1, "ino": 1 },
            "workerInstanceId": "inst-b",
            "activeSessionId": "bbb222",
            "grantId": "g1",
            "token": "secret",
            "expiresAt": "2026-01-01T00:00:30.000Z",
        });
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(socket.clone(), json!({ "sessions": [] }), Some(ticket)).await;
        let controller = controller(socket, own_summary());
        let receipt = controller.send_agent_message(input()).await.unwrap();
        assert_eq!(receipt.id, "agentmsg_peer");
        assert_eq!(receipt.delivery_status, AgentMessageDeliveryStatus::Queued);
        assert_eq!(receipt.target, "bbb222");
        assert_eq!(receipt.target_session_name.as_deref(), Some("beta"));

        // The wire saw the exact two commands with the TS shapes.
        let received = received.lock().unwrap().clone();
        assert_eq!(received.len(), 2, "{received:?}");
        assert_eq!(received[0].0, "peer_auth");
        assert_eq!(received[0].1["purpose"], "worker");
        assert_eq!(received[0].1["grantId"], "g1");
        assert_eq!(received[1].0, "worker_deliver_message");
        let delivery = &received[1].1;
        assert_eq!(delivery["targetActiveSessionId"], "bbb222");
        assert_eq!(delivery["message"], "hello there");
        // TS sender identity block: endpoint fields plus the agent client id.
        assert_eq!(delivery["sender"]["activeSessionId"], "aaa111");
        assert_eq!(delivery["sender"]["sessionId"], "sess-a");
        assert_eq!(delivery["sender"]["sessionName"], "alpha");
        assert_eq!(delivery["sender"]["runtimeKind"], "top-level");
        assert_eq!(delivery["sender"]["clientId"], "agent");
    }
}
