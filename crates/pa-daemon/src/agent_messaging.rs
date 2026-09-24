//! Kernel `agent_message`/`agent_observe` controllers for daemon workers:
//! the supervisor-link family roster, worker-to-worker direct peer delivery
//! (thin-supervisor stage 3) with the supervisor-routed fallback, and the
//! wire receipt mapping.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use pa_core::session_engine::agent_messaging::{
    AgentFamilyMember, AgentFamilyRelationship, AgentFamilyStatus, AgentMessageController,
    AgentMessageDeliveryStatus, AgentMessageReceipt, AgentMessageSendInput, AgentObserveActivity,
    AgentObserveController, AgentObserveMessagePreview, AgentObserveSummary,
};

use crate::supervisor_link::SupervisorLink;

// ---------------------------------------------------------------------------
// Supervisor-link controllers (kernel agent_message/agent_observe bridges)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Durable family edges (the nuclear-family classification)
// ---------------------------------------------------------------------------

/// One session's durable family identity: the ids its family references it
/// by, and its recorded parent edge in every identifier form the roster
/// exposes. Family membership is derived from these edges alone — never
/// from session names — so a parent-reply reaches its true parent across
/// worker restarts and storage moves, and a role-addressed send can never
/// cross families on a name collision.
#[derive(Debug, Clone, Default)]
pub(crate) struct FamilyIdentity {
    /// This session's live active session id.
    pub active_session_id: String,
    /// This session's persisted session id (the durable uuid).
    pub session_id: Option<String>,
    /// This session's session-file path.
    pub session_file: Option<String>,
    /// The parent's live active-session id (subagent sessions).
    pub parent_active_session_id: Option<String>,
    /// The parent's persisted session id (subagent sessions).
    pub parent_session_id: Option<String>,
    /// The parent's session-file path (subagent sessions and seeded rows).
    pub parent_session_path: Option<String>,
}

impl FamilyIdentity {
    /// The identity from the worker's own pushed summary (its wire shape),
    /// with the active session id from the supervisor-link config.
    pub(crate) fn from_summary(summary: Option<&Value>, active_session_id: &str) -> Self {
        let non_empty = |value: Option<&Value>, key: &str| {
            value
                .and_then(|summary| summary.get(key))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let summary_ref = summary;
        FamilyIdentity {
            active_session_id: active_session_id.to_string(),
            session_id: non_empty(summary_ref, "sessionId"),
            session_file: non_empty(summary_ref, "sessionFile"),
            parent_active_session_id: non_empty(summary_ref, "parentActiveSessionId"),
            parent_session_id: non_empty(summary_ref, "parentSessionId"),
            parent_session_path: non_empty(summary_ref, "parentSessionPath"),
        }
    }

    /// A top-level session has no recorded parent edge in any form.
    fn is_top_level(&self) -> bool {
        self.parent_active_session_id.is_none()
            && self.parent_session_id.is_none()
            && self.parent_session_path.is_none()
    }
}

/// The non-empty string value of one roster-row field.
fn row_str<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// Whether two session-file paths name the same session: canonical-path
/// equality first, then the durable session id extracted from the file
/// name (the storage-root alias — the same session recorded under the
/// pre-migration root and the migrated root resolves to one parent).
pub(crate) fn same_session_file(left: &str, right: &str) -> bool {
    let canonical = |path: &str| {
        crate::lease::canonical_session_path(Path::new(path))
            .to_string_lossy()
            .to_string()
    };
    if canonical(left) == canonical(right) {
        return true;
    }
    session_file_id(left).is_some_and(|left_id| session_file_id(right) == Some(left_id))
}

/// The durable session id of one session-file path (the `.jsonl` file
/// stem), when the stem parses as a uuid-shaped session id.
fn session_file_id(path: &str) -> Option<String> {
    let stem = Path::new(path).file_stem()?.to_string_lossy().to_string();
    (!stem.is_empty() && uuid::Uuid::parse_str(&stem).is_ok()).then_some(stem)
}

/// Whether `row` is the parent of the session `identity` describes: the
/// persisted session id decides first (it survives worker replacements
/// and storage moves), then the live active id, then the session-file
/// alias (a passivated parent's seeded row carries only the path).
fn row_is_parent(row: &Value, identity: &FamilyIdentity) -> bool {
    if let Some(parent_id) = identity.parent_session_id.as_deref() {
        if row_str(row, "sessionId") == Some(parent_id) {
            return true;
        }
    }
    if let Some(parent_active) = identity.parent_active_session_id.as_deref() {
        if row_str(row, "activeSessionId").or_else(|| row_str(row, "id")) == Some(parent_active) {
            return true;
        }
    }
    if let Some(parent_path) = identity.parent_session_path.as_deref() {
        // The peers roster (`list_agent_peers` -> `agent_peer_summary`)
        // carries the session file under `sessionPath`; the supervisor's
        // own roster rows carry `sessionFile`.
        if row_str(row, "sessionFile")
            .or_else(|| row_str(row, "sessionPath"))
            .is_some_and(|file| same_session_file(file, parent_path))
        {
            return true;
        }
    }
    false
}

/// Whether `row` is a child of the session `identity` describes: the row's
/// durable parent edge points back at this session by its persisted id,
/// its live id, or its session file.
fn row_is_child(row: &Value, identity: &FamilyIdentity) -> bool {
    if identity
        .session_id
        .as_deref()
        .is_some_and(|id| row_str(row, "parentSessionId").is_some_and(|parent| parent == id))
    {
        return true;
    }
    if !identity.active_session_id.is_empty()
        && row_str(row, "parentActiveSessionId") == Some(identity.active_session_id.as_str())
    {
        return true;
    }
    if identity.session_file.as_deref().is_some_and(|file| {
        row_str(row, "parentSessionPath").is_some_and(|parent| same_session_file(parent, file))
    }) {
        return true;
    }
    false
}

/// Whether `row` is a sibling of the session `identity` describes: for a
/// subagent, the row's durable parent edge points at the same parent
/// (persisted id, live id, or session-file alias); for a top-level
/// session, the row is another parentless top-level session (root
/// sessions are each other's family). A resumed subagent file re-opened
/// as a top-level runtime keeps its parent edge and is not a root sibling.
fn row_is_sibling(row: &Value, identity: &FamilyIdentity) -> bool {
    if identity.is_top_level() {
        // A root session's siblings are the other root sessions: no
        // recorded parent edge in any form, and not a subagent runtime
        // (an orphaned subagent row has no durable family at all; a
        // resumed subagent file re-opened top-level keeps its parent
        // path and is not a root either).
        let subagent_runtime = row_str(row, "runtimeKind").is_some_and(|kind| kind == "subagent");
        return !subagent_runtime
            && row_str(row, "parentSessionId").is_none()
            && row_str(row, "parentActiveSessionId").is_none()
            && row_str(row, "parentSessionPath").is_none();
    }
    if let Some(parent_id) = identity.parent_session_id.as_deref() {
        if row_str(row, "parentSessionId") == Some(parent_id) {
            return true;
        }
    }
    if let Some(parent_active) = identity.parent_active_session_id.as_deref() {
        if row_str(row, "parentActiveSessionId") == Some(parent_active) {
            return true;
        }
    }
    if let Some(parent_path) = identity.parent_session_path.as_deref() {
        if row_str(row, "parentSessionPath")
            .is_some_and(|path| same_session_file(path, parent_path))
        {
            return true;
        }
    }
    false
}

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
fn summaries_from_roster(
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
            // TS #2493 `classifyAgentStatus`: every roster row is a
            // resident session, so the family status is the busy verdict
            // (`activity === "working" || isSessionActive`) split into
            // `running`/`idle` — never the mixed `inactive` a quiet row
            // used to map to. `Inactive` stays reserved for family members
            // with no live session, which the live-roster path never
            // returns.
            let status = if session.get("activity").and_then(Value::as_str) == Some("working")
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
                activity: Some(activity),
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
    /// is not also a sibling. Siblings are the rows sharing this
    /// session's durable parent edge — a top-level row from another
    /// family is NOT a sibling, even with a matching name.
    #[tokio::test]
    async fn family_labels_children_and_parent_from_the_registry() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(
            socket.clone(),
            json!({ "sessions": [
                { "activeSessionId": "aaa111", "sessionId": "sess-a", "sessionName": "alpha" },
                { "activeSessionId": "bbb222", "sessionId": "sess-b", "sessionName": "beta",
                  "parentActiveSessionId": "ppp000", "parentSessionId": "sess-p",
                  "runtimeKind": "subagent" },
                { "activeSessionId": "ddd444", "sessionId": "sess-d", "sessionName": "worker-a" },
                { "activeSessionId": "ppp000", "sessionId": "sess-p", "sessionName": "papa" },
                { "activeSessionId": "xxx999", "sessionId": "sess-x", "sessionName": "beta",
                  "runtimeKind": "top-level" },
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
        // TS `selectAgentFamily` order: parent, siblings, children. The
        // unrelated top-level row (xxx999) never enters the family, and
        // the second "beta" name cannot cross families.
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
        // No member duplicates the child as a sibling; no other family's
        // session appears in any role.
        assert!(!family.iter().any(|member| member.id == "ddd444"
            && member.relationship == AgentFamilyRelationship::Sibling));
        assert!(!family.iter().any(|member| member.id == "xxx999"));
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

    /// A session file recorded under a migrated storage root still names
    /// its session: the durable id (the file-name stem) resolves the
    /// alias when the canonical paths differ (the storage-root
    /// re-parenting fix).
    #[test]
    fn same_session_file_resolves_the_storage_root_alias() {
        assert!(same_session_file(
            "/agent/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
            "/agent/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        ));
        assert!(same_session_file(
            "/old-agent-root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
            "/agent/session-artifacts/sess-p/sub-1/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        ));
        assert!(!same_session_file(
            "/agent/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
            "/agent/sessions/21b1e1b6-f065-4288-9fa0-9ec8980768a2.jsonl",
        ));
        // The durable id is uuid-shaped: a shared NON-uuid stem (arbitrary
        // create-provided sessionPath values) never aliases across families.
        assert!(!same_session_file(
            "/project-a/session.jsonl",
            "/project-b/session.jsonl",
        ));
    }

    /// The observe roster is the caller's nuclear family with
    /// edge-derived labels: its own row carries `isCurrent`, its parent
    /// and true siblings label by their durable edges, and subagents
    /// spawned by OTHER parents never appear (the daemon-wide "every
    /// subagent is a child" mislabel regression).
    #[test]
    fn summaries_label_the_nuclear_family_by_durable_edges() {
        let identity = FamilyIdentity {
            active_session_id: "kid111".to_string(),
            session_id: Some("sess-kid".to_string()),
            session_file: Some("/agent/session-artifacts/sess-p/sub-2/sess-kid.jsonl".to_string()),
            parent_active_session_id: Some("ppp000".to_string()),
            parent_session_id: Some("sess-p".to_string()),
            parent_session_path: Some("/agent/sessions/sess-p.jsonl".to_string()),
        };
        let sessions = vec![
            json!({
                "activeSessionId": "kid111", "sessionId": "sess-kid",
                "sessionName": "self", "runtimeKind": "subagent", "activity": "idle",
            }),
            json!({
                "activeSessionId": "ppp000", "sessionId": "sess-p",
                "sessionName": "papa", "runtimeKind": "top-level", "activity": "idle",
            }),
            json!({
                "activeSessionId": "sib222", "sessionId": "sess-sib",
                "sessionName": "sibling", "runtimeKind": "subagent", "activity": "working",
                "parentActiveSessionId": "ppp000", "parentSessionId": "sess-p",
            }),
            json!({
                "activeSessionId": "own333", "sessionId": "sess-own",
                "sessionName": "own-child", "runtimeKind": "subagent", "activity": "idle",
                "parentActiveSessionId": "kid111", "parentSessionId": "sess-kid",
            }),
            json!({
                "activeSessionId": "foreign444", "sessionId": "sess-foreign",
                "sessionName": "survey-stream-route", "runtimeKind": "subagent",
                "parentActiveSessionId": "other999", "parentSessionId": "sess-other",
            }),
            json!({
                "activeSessionId": "root555", "sessionId": "sess-root",
                "sessionName": "another-root", "runtimeKind": "top-level",
            }),
        ];
        let summaries = summaries_from_roster(sessions, &identity, &[]);
        assert_eq!(summaries.len(), 4, "{summaries:?}");
        let current = summaries.iter().find(|s| s.is_current).unwrap();
        assert_eq!(current.active_session_id.as_deref(), Some("kid111"));
        assert_eq!(current.relationship, None);
        let parent = summaries
            .iter()
            .find(|s| s.active_session_id.as_deref() == Some("ppp000"))
            .unwrap();
        assert_eq!(parent.relationship, Some(AgentFamilyRelationship::Parent));
        let sibling = summaries
            .iter()
            .find(|s| s.active_session_id.as_deref() == Some("sib222"))
            .unwrap();
        assert_eq!(sibling.relationship, Some(AgentFamilyRelationship::Sibling));
        let child = summaries
            .iter()
            .find(|s| s.active_session_id.as_deref() == Some("own333"))
            .unwrap();
        assert_eq!(child.relationship, Some(AgentFamilyRelationship::Child));
        // The other family's subagent and the other root session are
        // outside the nuclear family: absent, never mislabeled.
        assert!(!summaries
            .iter()
            .any(|s| s.active_session_id.as_deref() == Some("foreign444")));
        assert!(!summaries
            .iter()
            .any(|s| s.active_session_id.as_deref() == Some("root555")));
    }

    /// A root caller's observe roster lists the other root sessions as
    /// siblings, never another family's subagents, and marks its own row.
    /// TS #2493: observe rows carry the typed family status (the busy
    /// verdict: `running` while work is in flight, `idle` for a
    /// resident-but-quiet session) plus the separate live activity axis —
    /// a quiet row is `idle`, never the pre-fix `inactive` the coarse
    /// activity mapping produced.
    #[test]
    fn summaries_carry_the_typed_status_and_activity() {
        let identity = FamilyIdentity {
            active_session_id: "me000".to_string(),
            session_id: Some("sess-me".to_string()),
            session_file: Some("/agent/sessions/sess-me.jsonl".to_string()),
            parent_active_session_id: Some("ppp00".to_string()),
            parent_session_id: Some("sess-p".to_string()),
            parent_session_path: Some("/agent/sessions/sess-p.jsonl".to_string()),
        };
        let sessions = vec![
            // The current session streams a tool call: running, tool work.
            json!({
                "activeSessionId": "me000", "sessionId": "sess-me", "runtimeKind": "top-level",
                "activity": "working", "isStreaming": true, "isCompacting": false,
                "isSessionActive": true, "isRunningTools": true, "attachedClients": 1,
            }),
            // The parent sits quiet with a client attached: idle, a user.
            json!({
                "activeSessionId": "ppp00", "sessionId": "sess-p", "runtimeKind": "top-level",
                "activity": "idle", "isStreaming": false, "isCompacting": false,
                "isSessionActive": false, "isRunningTools": false, "attachedClients": 1,
            }),
            // A child mid-compaction: running, compacting.
            json!({
                "activeSessionId": "ch111", "sessionId": "sess-ch", "runtimeKind": "subagent",
                "activity": "working", "isStreaming": false, "isCompacting": true,
                "isSessionActive": true, "isRunningTools": false, "attachedClients": 0,
                "parentActiveSessionId": "me000", "parentSessionId": "sess-me",
            }),
            // A quiet child with no client: idle, idle.
            json!({
                "activeSessionId": "ch222", "sessionId": "sess-ch2", "runtimeKind": "subagent",
                "activity": "idle", "isStreaming": false, "isCompacting": false,
                "isSessionActive": false, "isRunningTools": false, "attachedClients": 0,
                "parentActiveSessionId": "me000", "parentSessionId": "sess-me",
            }),
        ];
        let summaries = summaries_from_roster(sessions, &identity, &[]);
        assert_eq!(summaries.len(), 4, "{summaries:?}");
        let row = |id: &str| {
            summaries
                .iter()
                .find(|s| s.active_session_id.as_deref() == Some(id))
                .unwrap_or_else(|| panic!("missing row {id}: {summaries:?}"))
        };
        assert_eq!(row("me000").status, AgentFamilyStatus::Running);
        assert_eq!(row("me000").activity, Some(AgentObserveActivity::Tool));
        assert_eq!(row("ppp00").status, AgentFamilyStatus::Idle);
        assert_eq!(row("ppp00").activity, Some(AgentObserveActivity::User));
        assert_eq!(row("ch111").status, AgentFamilyStatus::Running);
        assert_eq!(
            row("ch111").activity,
            Some(AgentObserveActivity::Compacting)
        );
        assert_eq!(row("ch222").status, AgentFamilyStatus::Idle);
        assert_eq!(row("ch222").activity, Some(AgentObserveActivity::Idle));
    }

    #[test]
    fn summaries_label_root_siblings_and_never_foreign_children() {
        let identity = FamilyIdentity {
            active_session_id: "root111".to_string(),
            session_id: Some("sess-root".to_string()),
            session_file: Some("/agent/sessions/sess-root.jsonl".to_string()),
            ..Default::default()
        };
        let sessions = vec![
            json!({
                "activeSessionId": "root111", "sessionId": "sess-root",
                "runtimeKind": "top-level", "activity": "idle",
            }),
            json!({
                "activeSessionId": "root222", "sessionId": "sess-root2",
                "runtimeKind": "top-level", "activity": "idle",
            }),
            json!({
                "activeSessionId": "child999", "sessionId": "sess-child",
                "runtimeKind": "subagent", "parentActiveSessionId": "root222",
            }),
        ];
        let summaries = summaries_from_roster(sessions, &identity, &[]);
        assert_eq!(summaries.len(), 2, "{summaries:?}");
        assert!(summaries.iter().any(|s| s.is_current));
        let sibling = summaries
            .iter()
            .find(|s| s.active_session_id.as_deref() == Some("root222"))
            .unwrap();
        assert_eq!(sibling.relationship, Some(AgentFamilyRelationship::Sibling));
        // Another root's subagent child is not this root's child.
        assert!(!summaries
            .iter()
            .any(|s| s.active_session_id.as_deref() == Some("child999")));
    }

    /// The peers roster (`list_agent_peers` -> `agent_peer_summary`) carries
    /// the session file under `sessionPath`, not `sessionFile`: a
    /// passivated parent resolves by the alias on the peers shape too.
    #[tokio::test]
    async fn family_resolves_a_moved_parent_by_the_peers_roster_alias() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(
            socket.clone(),
            json!({ "sessions": [
                { "activeSessionId": "aaa111", "sessionId": "sess-a" },
                { "activeSessionId": "rrr777", "sessionId": "sess-p", "sessionName": "papa",
                  "sessionPath": "/agent/session-artifacts/sess-g/sub-9/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl" },
            ]}),
            None,
        )
        .await;
        let own_summary = Some(json!({
            "activeSessionId": "aaa111",
            "sessionId": "sess-a",
            "parentActiveSessionId": "stale-parent",
            "parentSessionPath": "/old-agent-root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        }));
        let controller = controller(socket, own_summary);
        let family = controller.family().await.unwrap();
        assert_eq!(family.len(), 1, "{family:?}");
        assert_eq!(family[0].relationship, AgentFamilyRelationship::Parent);
        assert_eq!(family[0].id, "rrr777");
    }

    /// A child worker replacement (a new live id, the same rlm child id and
    /// persisted session id) joins its registry record by the durable ids:
    /// the family lists the child ONCE, never the roster row plus the
    /// leftover registry entry.
    #[tokio::test]
    async fn family_joins_a_replaced_child_by_its_durable_ids() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(
            socket.clone(),
            json!({ "sessions": [
                { "activeSessionId": "aaa111", "sessionId": "sess-a" },
                { "activeSessionId": "new999", "sessionId": "sess-kid",
                  "sessionName": "kid", "rlmChildId": "sub-kid1",
                  "parentActiveSessionId": "aaa111", "parentSessionId": "sess-a" },
            ]}),
            None,
        )
        .await;
        let controller = controller_with_children(socket, own_summary());
        admit_child(
            &controller,
            RlmChildIdentity {
                rlm_child_id: "sub-kid1".to_string(),
                active_session_id: "ddd444".to_string(),
                session_id: Some("sess-kid".to_string()),
                session_name: "kid".to_string(),
            },
        )
        .await;
        let family = controller.family().await.unwrap();
        let children: Vec<_> = family
            .iter()
            .filter(|member| member.relationship == AgentFamilyRelationship::Child)
            .collect();
        assert_eq!(children.len(), 1, "{family:?}");
        assert_eq!(children[0].id, "new999");
        assert!(children[0].aliases.contains(&"sub-kid1".to_string()));
    }

    /// The family roster resolves a parent whose worker was replaced (the
    /// live id went stale) through the durable persisted id, and a
    /// parent whose recorded path moved (the storage-root migration)
    /// through the session-file alias: the pre-restart child's
    /// parent-reply reaches its true parent, never a name-holder.
    #[tokio::test]
    async fn family_resolves_a_moved_parent_by_the_session_file_alias() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        spawn_fake_supervisor(
            socket.clone(),
            json!({ "sessions": [
                { "activeSessionId": "aaa111", "sessionId": "sess-a" },
                { "activeSessionId": "rrr777", "sessionId": "sess-p", "sessionName": "papa",
                  "sessionFile": "/agent/session-artifacts/sess-g/sub-9/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl" },
            ]}),
            None,
        )
        .await;
        let own_summary = Some(json!({
            "activeSessionId": "aaa111",
            "sessionId": "sess-a",
            "parentActiveSessionId": "stale-parent",
            "parentSessionPath": "/old-agent-root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        }));
        let controller = controller(socket, own_summary);
        let family = controller.family().await.unwrap();
        assert_eq!(family.len(), 1, "{family:?}");
        assert_eq!(family[0].relationship, AgentFamilyRelationship::Parent);
        assert_eq!(family[0].id, "rrr777");
    }
}
