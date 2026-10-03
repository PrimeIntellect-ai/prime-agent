//! The `agent_message.send` controller (moved with its concern): the family
//! roster + message delivery through the supervisor, the direct peer
//! transport with the supervisor-routed fallback, and the wire receipt
//! mapping.
use super::{
    json, row_is_child, row_is_parent, row_is_sibling, row_str, AgentFamilyMember,
    AgentFamilyRelationship, AgentMessageController, AgentMessageDeliveryStatus,
    AgentMessageReceipt, AgentMessageSendInput, Arc, FamilyIdentity, SupervisorLink, Value,
};

/// `agent_message.send` controller for daemon workers. The family roster
/// and message delivery both go through the supervisor; a send first tries
/// the direct worker-to-worker peer transport (thin-supervisor stage 3) and
/// falls back to the supervisor-routed `send_message` (the TS worker's
/// `sendRemoteAgentSessionMessage` path). Neither path is retried: daemon
/// commands are not idempotent.
/// Exposed for the agent-family e2e verifier (`tests/agent_family_e2e.rs)`:
/// the same controller construction the worker engine wires.
pub struct LinkAgentMessageController {
    pub(super) link: Arc<SupervisorLink>,
    pub(super) active_session_id: String,
    pub(super) worker_token: String,
    /// This worker's own session summary, pushed by the worker at create
    /// (and rename); the sender identity block for direct deliveries.
    pub(super) own_summary: Arc<std::sync::Mutex<Option<Value>>>,
    /// This session's resident RLM children (the same registry
    /// `rlm.list_subagents` reads); `None` for standalone workers.
    pub(super) children: Option<Arc<crate::rlm_children::SupervisorChildSessions>>,
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
    // The budget is the shared `list_agent_peers` window (TS #2516
    // `AGENT_PEER_LIST_REQUEST_TIMEOUT_MS`): the supervisor's own mesh
    // refresh for the command stays inside half of it, so the local
    // siblings and the response fit in the rest.
    let data = link
        .request_success(
            json!({ "type": "list_agent_peers", "workerToken": worker_token }),
            std::time::Duration::from_millis(crate::protocol::AGENT_PEER_LIST_REQUEST_TIMEOUT_MS),
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
        // The calling session's durable family identity (its own ids and
        // its recorded parent edge); never derived from names.
        let identity = self.family_identity();
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
            let row_rlm_child_id = row_str(&session, "rlmChildId").map(str::to_string);
            if let Some(position) = children.iter().position(|child| {
                // The join is durable-keyed so a child worker replacement
                // (a new live id, the same rlm child id / persisted session
                // id) consumes its registry record here instead of leaving
                // it for the leftover loop below to append twice.
                child.active_session_id == active_session_id
                    || row_rlm_child_id
                        .as_deref()
                        .is_some_and(|id| id == child.rlm_child_id)
                    || ((!session_id.is_empty()) && child.session_id.as_deref() == Some(session_id))
            }) {
                let child = children.swap_remove(position);
                let mut member = child_member(&child, name);
                // A worker replacement keeps the durable ids but swaps the
                // live one: the roster row carries the CURRENT active id
                // while the registry record holds the id from spawn. The
                // member keys on the row's live id so role-addressed sends
                // target the live worker, never the replaced id.
                if active_session_id != child.active_session_id {
                    member.id.clone_from(&active_session_id);
                }
                child_members.push(member);
                continue;
            }
            // The session that spawned this worker (when this worker is a
            // subagent): a Parent member resolved through the durable edge,
            // never a name. The persisted session id decides first (it
            // survives the parent's worker replacements and any storage
            // move), then the live active id, then the session-file alias.
            if row_is_parent(&session, &identity) {
                parent_member = Some(AgentFamilyMember {
                    relationship: AgentFamilyRelationship::Parent,
                    id: active_session_id,
                    name,
                    aliases: (!session_id.is_empty())
                        .then(|| session_id.to_string())
                        .into_iter()
                        .collect(),
                });
                continue;
            }
            // A row whose durable parent edge points back at this session
            // is a Child (the registry may lose a record across a worker
            // replacement; the recorded edge never lies).
            if row_is_child(&session, &identity) {
                let mut aliases = session
                    .get("rlmChildId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .into_iter()
                    .collect::<Vec<String>>();
                if !session_id.is_empty() {
                    aliases.push(session_id.to_string());
                }
                child_members.push(AgentFamilyMember {
                    relationship: AgentFamilyRelationship::Child,
                    id: active_session_id,
                    name,
                    aliases,
                });
                continue;
            }
            // Siblings share this session's durable parent edge (other
            // subagents of the same parent); a top-level session's
            // siblings are the other parentless top-level sessions.
            // Everything else is outside the nuclear family: it is not
            // addressable by role, so no name-keyed send can cross
            // families.
            if !row_is_sibling(&session, &identity) {
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
        // Children the roster does not list (a passivated or
        // mid-registration child worker) are addressed by their DURABLE
        // id, like TS family entries (`id: agent.sessionId`): the
        // supervisor's send_message wake resolves it through the spawn
        // ledger and relaunches a passivated child. The spawn-time live id
        // stays an alias selector.
        for child in children {
            let mut member = child_member(&child, None);
            let durable = crate::rlm_children::durable_child_selector(
                child.session_id.as_deref(),
                &child.rlm_child_id,
            );
            member
                .aliases
                .push(std::mem::replace(&mut member.id, durable));
            child_members.push(member);
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
        // A message delivered to one of this session's own children starts
        // a follow-up turn there (delayed messaging): re-arm that child's
        // usage observation BEFORE the delivery — a fast child can start
        // and settle its turn before the delivery await returns, and an
        // observation armed after the fact phases out against an idle
        // child and never bills (TS keeps the child subscription alive
        // across the whole turn; the Rust task-run watcher retired at its
        // settle).
        if let Some(children) = &self.children {
            children.observe_child_usage(&input.target).await;
        }
        let receipt = match self.deliver_direct(&input).await {
            DirectDelivery::Delivered(receipt) => receipt,
            DirectDelivery::Unavailable => self.deliver_via_supervisor(input.clone()).await?,
            DirectDelivery::Failed(error) => return Err(anyhow::anyhow!(error)),
        };
        Ok(receipt)
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

    /// This session's durable family identity from its own pushed summary:
    /// the ids its family references it by, and its recorded parent edge.
    /// `None` fields degrade; the active session id always comes from the
    /// worker's own link config (the summary may lag a rename).
    fn family_identity(&self) -> FamilyIdentity {
        let summary = self
            .own_summary
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        FamilyIdentity::from_summary(summary.as_ref(), &self.active_session_id)
    }

    /// The TS `createAgentSessionMessageSender` shape for agent-origin
    /// sends: the sending session's endpoint fields plus the `agent`
    /// client identity (the TS daemon attributes kernel sends this way
    /// when no client id is in play).
    fn sender_block(&self) -> Value {
        let summary = self
            .own_summary
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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
            // The sender's durable parent edge rides the block so the
            // receiving session can label the delivery by its TRUE
            // relationship (a child only when this sender's recorded
            // parent is the recipient), never by runtime kind alone.
            for (field, summary_field) in [
                ("parentActiveSessionId", "parentActiveSessionId"),
                ("parentSessionId", "parentSessionId"),
                ("parentSessionPath", "parentSessionPath"),
            ] {
                if let Some(value) = summary
                    .get(summary_field)
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    sender[field] = json!(value);
                }
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
