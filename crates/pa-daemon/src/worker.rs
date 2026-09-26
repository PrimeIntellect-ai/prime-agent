//! Session worker runtime: one process, one session.
//!
//! Port of the TS daemon's worker mode (`modes/daemon/daemon-mode.ts` worker
//! branch, `modes/session-worker/*`): the worker owns the session - the
//! append-only store, the queue lanes, event sequencing, and turn execution.
//! Supervisors connect over a private-framed Unix socket and authenticate
//! with the bootstrap token before any command.

mod config;
mod env;
mod session_core;

pub(crate) use config::WorkerConfig;
// KillCloseReason is read only by the commands module (via `use super::*`); the facade
// itself does not reference it directly, so allow the unused-import lint deliberately.
#[allow(unused_imports)]
use env::KillCloseReason;
mod create;
mod turn;

use create::{active_session_id_of, worker_server_capabilities};
use turn::TurnRunner;

mod commands;

pub use env::{
    WORKER_ACTIVE_SESSION_ID_ENV, WORKER_CWD_ENV, WORKER_INSTANCE_ID_ENV,
    WORKER_RECOVERY_JOURNAL_ENV, WORKER_ROLE_ENV, WORKER_SCRIPT_ENV, WORKER_SOCKET_ENV,
    WORKER_SUPERVISOR_LOST_EXIT_MS_ENV, WORKER_SUPERVISOR_SOCKET_ENV,
    WORKER_TELEMETRY_DISABLED_ENV, WORKER_TOKEN_ENV,
};
use serde_json::Map;
pub(crate) use session_core::SessionCore;
use std::collections::VecDeque;
// PathBuf is read only by this facade's in-file test modules (via `use super::*`); the
// lib-target import is flagged unused since the lib users moved out, so allow it deliberately.
#[allow(unused_imports)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pa_core::session_engine::agent_messaging::{
    AgentFamilyRelationship, AgentMessagePromptPayload, AGENT_MESSAGE_SOURCE,
    DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
};
use pa_types::platform::transport::{bind_transport, TransportStream};
use serde_json::{json, Value};
use tokio::sync::{broadcast, oneshot, Notify};

use crate::agent_engine::{AgentEngineConfig, AgentSessionEngine, SupervisorLinkConfig};
use crate::autonomous_continuation::AUTONOMOUS_QUEUE_KEY;
use crate::engine::{
    EngineEvent, EngineModelSelection, PromptRequest, RlmSessionIdentity, ScriptedEngine,
    SessionEngine,
};
use crate::framing::{write_frame, DEFAULT_PRIVATE_FRAME_LIMITS};
use crate::journal::WorkerRecoveryJournal;
use crate::paths;
use crate::peer::{
    peer_command_allowed, worker_peer_command_allowed, ConnectionRole, PeerGrantStore,
    PEER_COMMAND_NOT_ALLOWED,
};
use crate::protocol::{
    create_daemon_event_meta, create_daemon_replay_info, current_protocol_info,
    default_client_capabilities, default_server_capabilities, normalize_client_capabilities,
    response_failure, response_success, DaemonOutbound, DaemonResponse, DaemonResumeCursor,
    DaemonSessionClosedReason, DAEMON_APP_VERSION, DAEMON_SCHEMA_ID, DAEMON_SCHEMA_REVISION,
};
use crate::registration::RegistrationHandle;
use crate::session_store::{session_file_name, SessionFile};

use crate::setting_switches::{effective_service_tier, supports_fast_mode};
use crate::types::{AgentConnectionState, SessionActionSnapshot, SessionSummary};

/// Result of one connection's authentication command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthOutcome {
    Authenticated,
    Failed,
}

/// Queue delivery lanes (port of the session action store's two deliveries).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Steering,
    FollowUp,
}

impl Lane {
    fn as_str(&self) -> &'static str {
        match self {
            Lane::Steering => "steering",
            Lane::FollowUp => "follow_up",
        }
    }
}

/// The TS `_assertSessionActionAdmissionAvailable` rejection while the
/// queued-input pump is suspended (agent-session.ts).
/// How long the close paths (`shutdown`, `kill`) wait for aborted side
/// question runs to queue their terminal cancelled events before the
/// process exits. The runs observe the abort within their 20ms pump tick
/// and the stream teardown, so this is generous headroom, not a gate.
const SIDE_QUESTION_SETTLE_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) const QUEUED_INPUT_SUSPENDED: &str =
    "Cannot admit a session action while queued session input is suspended.";

/// The item's turn-execution class (TS `TurnExecutionPolicy`, the
/// `_pumpSessionInputs` batch-gathering's `turnExecutionPoliciesEqual`
/// gate): items co-deliver as one batched turn only within the same
/// class. Client-queued rows (the `steer`/`follow_up` commands and
/// prompt admissions behind work, TS `"queued"`) batch together;
/// injected rows (heartbeat fires, agent-message deliveries, goal and
/// autonomous continuations, TS `"injected"`) batch among themselves;
/// the idle session's direct-prompt hand-off (TS `"directPrompt"`)
/// never joins a queue batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnPolicy {
    Queued,
    Injected,
    Direct,
}

impl TurnPolicy {
    /// The journal record's string form (`worker.recovery` queue
    /// snapshots); the restore maps it back through the same names.
    pub(crate) fn journal_value(self) -> &'static str {
        match self {
            TurnPolicy::Queued => "queued",
            TurnPolicy::Injected => "injected",
            TurnPolicy::Direct => "direct",
        }
    }
}

/// The turn-execution class restored from a wire `restore_actions`
/// payload (TS `restoreSessionActions` restores the full
/// `executionPolicy`): `nextTurnContextTiming` "commit" is the
/// client-queued policy; "preparation" with a preserved empty
/// extension prompt is injected; "preparation" without it is the
/// direct-prompt hand-off. An absent or unknown policy restores as the
/// dominant queued class.
pub(crate) fn restored_turn_policy(payload: &Value) -> TurnPolicy {
    let timing = payload
        .get("executionPolicy")
        .and_then(|policy| policy.get("nextTurnContextTiming"))
        .and_then(Value::as_str);
    match timing {
        Some("preparation") => {
            let preserved = payload
                .get("executionPolicy")
                .and_then(|policy| policy.get("preserveEmptyExtensionPrompt"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if preserved {
                TurnPolicy::Injected
            } else {
                TurnPolicy::Direct
            }
        }
        _ => TurnPolicy::Queued,
    }
}

/// The wire text of an aborted turn's settle (the `turn_end` error frame
/// and the waiting prompt's failure): the turn was aborted before an
/// assistant message was produced (a user abort, a queued-input
/// suspension).
pub(crate) const ABORTED_TURN_SETTLE_ERROR: &str = "No response produced.";

/// The wire text of a prompt cancelled before delivery (the
/// queue-invisible abort path).
pub(crate) const PROMPT_ABORTED_BEFORE_DELIVERY: &str = "Prompt aborted before delivery.";

/// The wire text of a queued prompt deleted through a queue mutation (TS
/// `QueuedMessageError` verbatim).
pub(crate) const QUEUED_PROMPT_DELETED: &str = "Queued prompt was deleted before delivery.";

/// The typed settle of one queued prompt, as the waiting caller's `done`
/// channel carries it. The variants classify the settle without reading
/// the (provider-controllable) error text: an aborted turn is not a
/// provider failure, and a withdrawn prompt never ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TurnSettle {
    /// The turn ran to its settle.
    Completed,
    /// The turn was aborted before an assistant message was produced.
    Aborted,
    /// The queued prompt was withdrawn before delivery (the abort
    /// cancel, a queue edit deleting the row); the text is the
    /// wire-facing reason.
    Withdrawn(String),
    /// The turn settled with an error; the text surfaces to the waiting
    /// caller.
    Failed(String),
}

impl TurnSettle {
    /// The wire-facing failure text of the settle (`None` when the
    /// settle is a success).
    pub(crate) fn wire_error(&self) -> Option<String> {
        match self {
            TurnSettle::Completed => None,
            TurnSettle::Aborted => Some(ABORTED_TURN_SETTLE_ERROR.to_string()),
            TurnSettle::Withdrawn(text) | TurnSettle::Failed(text) => Some(text.clone()),
        }
    }
}

/// Priority is applied only at admission. Existing lane positions (including user
/// moves and restored snapshots) remain authoritative until another item arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueuePriority {
    Human,
    Pinned,
    #[serde(other)]
    Background,
}

impl QueuePriority {
    fn rank(self) -> u8 {
        match self {
            Self::Background => 0,
            Self::Human => 1,
            Self::Pinned => 2,
        }
    }
}

/// TS `ActionStore` priority insertion: walk back only across a lower-priority
/// suffix. Never re-sort a lane: explicit moves and restored order can cross
/// priority boundaries, and equal-priority arrivals remain FIFO.
pub(crate) fn enqueue_priority(lane: &mut VecDeque<QueuedItem>, item: QueuedItem) {
    let mut index = lane.len();
    while index > 0 && lane[index - 1].priority.rank() < item.priority.rank() {
        index -= 1;
    }
    lane.insert(index, item);
}

#[derive(Debug)]
pub(crate) struct QueuedItem {
    pub(crate) message: String,
    pub(crate) priority: QueuePriority,
    /// The labeled queue-strip row (TS `payload.preview`): the queue
    /// snapshot serves it instead of `message` when the delivery carries
    /// one, and the active-action label reads it too (TS #2063
    /// `queuedAgentMessagePreview` returns `payload.preview ??
    /// payload.text`); the turn's prompt text stays `message`.
    pub(crate) preview: Option<String>,
    /// An injected custom row that replaces this turn's user message (the
    /// RLM child terminal notices ride the follow-up lane this way).
    pub(crate) custom_message: Option<Value>,
    /// The original agent-message text when this item came from an
    /// `agent_message` delivery (the marker `agent_messages_clear` /
    /// `agent_messages_pause` remove queued items by); `None` for items a
    /// client queued directly (`steer/follow_up`).
    pub(crate) agent_message: Option<String>,
    /// The scheduler's queue key (TS `followUpQueueKey`): a heartbeat's
    /// queued fire carries `heartbeat:<id>`, and a later fire replaces the
    /// queued item with the same key instead of stacking.
    pub(crate) queue_key: Option<String>,
    /// The prompt-admission id this admitted prompt registered (the
    /// `cancel_prompt_admission` bookkeeping); `None` for prompts that
    /// carried no admission id.
    pub(crate) admission_id: Option<String>,
    /// Images attached to the prompt (wire `images`: base64 payload plus
    /// mime type), admitted with the message as multimodal content.
    pub(crate) images: Vec<pa_agent::types::ImageContent>,
    pub(crate) done: Option<oneshot::Sender<TurnSettle>>,
    /// TS `payload.queueVisible`: the item shows in the queue projection
    /// and its delivery projects the active-action phase transitions
    /// (steer/follow-up lanes, agent-message deliveries, prompt-behind-work,
    /// heartbeat fires, restored rows). Injected continuations (goal,
    /// autonomous, post-compaction) and an idle session's direct prompt
    /// admission stay invisible: the TS wire shows no queue rows or
    /// active phases for them.
    pub(crate) queue_visible: bool,
    /// The item's turn-execution class (see [`TurnPolicy`]): the batch
    /// gathering's compatibility gate.
    pub(crate) policy: TurnPolicy,
    /// Membership of the one-shot forced steering batch (TS
    /// `_forcedAllSteeringActionIds`, armed by `abortAndSendQueued`):
    /// armed items co-deliver as one batched turn even under queue mode
    /// "one-at-a-time". Transient worker state — never journaled; a
    /// restart between the abort and the delivery loses the forced batch
    /// (the TS armed set is equally in-memory).
    pub(crate) forced_batch: bool,
}

/// Parse the wire `images` array of a prompt-family command (each entry
/// `{type: "image", data, mimeType}`). Entries that do not carry payload
/// data or a mime type are dropped, not failed: the text still admits.
pub(crate) fn parse_prompt_images(payload: &Value) -> Vec<pa_agent::types::ImageContent> {
    let Some(images) = payload.get("images").and_then(Value::as_array) else {
        return Vec::new();
    };
    images
        .iter()
        .filter_map(|image| {
            if image.get("type").and_then(Value::as_str) != Some("image") {
                return None;
            }
            let data = image.get("data").and_then(Value::as_str)?;
            let mime_type = image.get("mimeType").and_then(Value::as_str)?;
            Some(pa_agent::types::ImageContent {
                data: data.to_string(),
                mime_type: mime_type.to_string(),
            })
        })
        .collect()
}

/// One outbound frame: the serialized JSON payload plus its private-frame
/// `outboundType` (`session_event` or `side_question_event`), mirroring the
/// TS worker frame header. The supervisor fans frames out per its own
/// routing (clients attached to the session).
pub(crate) struct OutboundFrame {
    pub(crate) payload: Vec<u8>,
    pub(crate) outbound_type: &'static str,
    /// The pump-assigned broadcast sequence. Connection sinks use it as a
    /// flush position so response frames cannot overtake event frames.
    pub(crate) seq: u64,
}

impl OutboundFrame {
    pub(crate) fn session_event(payload: Vec<u8>) -> Self {
        OutboundFrame {
            payload,
            outbound_type: "session_event",
            seq: 0,
        }
    }

    pub(crate) fn side_question_event(payload: Vec<u8>) -> Self {
        OutboundFrame {
            payload,
            outbound_type: "side_question_event",
            seq: 0,
        }
    }

    /// `heartbeats_changed` (TS daemon-mode `broadcastGlobal`): the store's
    /// heartbeat-catalog-change notification, re-broadcast daemon-wide by
    /// the supervisor.
    pub(crate) fn heartbeats_changed() -> Self {
        OutboundFrame {
            payload: br#"{"type":"heartbeats_changed"}"#.to_vec(),
            outbound_type: "heartbeats_changed",
            seq: 0,
        }
    }

    /// `model_catalog_changed`: a background catalog refresh changed what
    /// this worker would answer for `get_model_catalog` (Rust-only
    /// extension over the TS daemon-mode protocol — TS awaits
    /// `refreshModelCatalog` inside the request; the no-stall picker-open
    /// refresh returns the validated snapshot instantly and lands the
    /// fresh catalog through this broadcast instead). Every client
    /// re-fetches; an open picker folds the catalog through its stable
    /// update path, so the selection never flickers.
    pub(crate) fn model_catalog_changed() -> Self {
        OutboundFrame {
            payload: br#"{"type":"model_catalog_changed"}"#.to_vec(),
            outbound_type: "model_catalog_changed",
            seq: 0,
        }
    }
}

/// The worker's outbound event pump: one sequence-stamped broadcast stream
/// shared by every frame-emitting path (turns, compaction, side questions,
/// status lines). Sequences are assigned under a send guard so channel
/// delivery order matches sequence order, which keeps per-connection flush
/// positions monotonic.
pub(crate) struct EventPump {
    events: broadcast::Sender<Arc<OutboundFrame>>,
    next_seq: AtomicU64,
    send_guard: std::sync::Mutex<()>,
}

impl EventPump {
    pub(crate) fn new() -> Self {
        let (events, _) = broadcast::channel(4096);
        EventPump {
            events,
            next_seq: AtomicU64::new(0),
            send_guard: std::sync::Mutex::new(()),
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Arc<OutboundFrame>> {
        self.events.subscribe()
    }

    /// Stamp the frame with the next sequence and broadcast it.
    pub(crate) fn send(&self, mut frame: OutboundFrame) {
        let _guard = self.send_guard.lock().unwrap();
        frame.seq = self.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.events.send(Arc::new(frame));
    }

    /// The current broadcast sequence: a response written now must wait for
    /// every frame with a sequence up to this value to be flushed.
    pub(crate) fn current_seq(&self) -> u64 {
        self.next_seq.load(Ordering::SeqCst)
    }
}

/// One connection's outbound state: the framed writer plus the fan-out's
/// flush position. The TS worker writes session events synchronously while
/// a command runs, so its command response always follows them; the Rust
/// fan-out is a separate task, so response writes wait for the fan-out to
/// catch up to the sequence they observed (`wait_flushed`), restoring the
/// same ordering contract: events emitted during a command are written
/// before the command's response, never after it.
pub(crate) struct ConnectionSink {
    pub(crate) writer:
        Arc<tokio::sync::Mutex<Box<dyn pa_types::platform::transport::AsyncWriteHalf>>>,
    /// The fan-out's flush position; `FLUSH_CLOSED` once the fan-out ended.
    /// Watch semantics: a send with zero live receivers is dropped, so
    /// the sink keeps a permanent receiver and every position update is
    /// stored even while no response is waiting.
    flushed: tokio::sync::watch::Sender<u64>,
    _flushed_anchor: tokio::sync::watch::Receiver<u64>,
    /// The first broadcast sequence this connection's fan-out can receive:
    /// frames older than this were broadcast before the connection
    /// subscribed and are never delivered to it, so a gate below `entry_seq`
    /// is already satisfied.
    entry_seq: u64,
}

/// The fan-out either wrote every frame or the connection ended; a waiting
/// response proceeds on both paths.
const FLUSH_CLOSED: u64 = u64::MAX;

impl ConnectionSink {
    pub(crate) fn new(
        writer: Arc<tokio::sync::Mutex<Box<dyn pa_types::platform::transport::AsyncWriteHalf>>>,
        entry_seq: u64,
    ) -> Self {
        let (flushed, flushed_anchor) = tokio::sync::watch::channel(0);
        ConnectionSink {
            writer,
            flushed,
            _flushed_anchor: flushed_anchor,
            entry_seq,
        }
    }

    /// Record the fan-out's position after one processed frame (written or
    /// skipped for role reasons: a skipped frame cannot arrive later).
    pub(crate) fn mark_flushed(&self, seq: u64) {
        let _ = self.flushed.send(seq);
    }

    /// The fan-out ended (write failure or closed stream); waiting
    /// responses stop waiting.
    pub(crate) fn mark_closed(&self) {
        let _ = self.flushed.send(FLUSH_CLOSED);
    }

    /// Block until the fan-out flushed `gate` (or ended).
    pub(crate) async fn wait_flushed(&self, gate: u64) {
        // Frames older than `entry_seq` are never delivered to this
        // connection, so a gate below them needs no wait.
        if gate < self.entry_seq {
            return;
        }
        let mut rx = self.flushed.subscribe();
        loop {
            if *rx.borrow_and_update() >= gate {
                return;
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

/// Releases a connection's supervisor claim when the connection ends:
/// the supervisor-role connection on the worker's socket is the supervisor's
/// presence proof for the orphan-exit monitor, so its end must decrement
/// the claim count on every return path. Inspects the role at drop time —
/// only a connection that authenticated as the supervisor ever claimed.
struct SupervisorClaimRelease {
    role: Arc<std::sync::Mutex<crate::peer::ConnectionRole>>,
    claims: Arc<std::sync::atomic::AtomicUsize>,
}

impl Drop for SupervisorClaimRelease {
    fn drop(&mut self) {
        let supervisor = matches!(
            *self.role.lock().unwrap(),
            crate::peer::ConnectionRole::Supervisor { .. }
        );
        if supervisor {
            self.claims
                .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

pub struct Worker {
    pub(crate) config: WorkerConfig,
    /// Supervisor self-registration handle; `None` for standalone workers.
    registration: Option<RegistrationHandle>,
    /// Live connections authenticated as the supervisor role. A non-zero
    /// count disarms the supervisor-lost exit monitor (TS
    /// `hasAuthenticatedSupervisorConnection`): while the supervisor is
    /// connected on this socket, it is by definition reachable.
    pub(crate) supervisor_claims: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub(crate) core: Arc<Mutex<SessionCore>>,
    pub(crate) engine: std::sync::Arc<dyn SessionEngine>,
    /// The real agent engine behind `engine`, when the worker runs one (the
    /// scripted harness engines are not it): the create command's eager
    /// session build (TS `createAgentSessionFromServices` parity — the
    /// kernel prewarm starts at create) runs through the concrete handle.
    pub(crate) agent_engine: Option<std::sync::Arc<crate::agent_engine::AgentSessionEngine>>,
    /// The monotonic roster-delta counter shared with the roster push
    /// queue: per-request links deliver pushes unordered, so every delta
    /// carries the counter's value for the supervisor's stale-delta gate.
    roster_delta_sequence: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub(crate) work_notify: Arc<Notify>,
    idle_notify: Arc<Notify>,
    pub(crate) events: Arc<EventPump>,
    /// The `/model` catalog background-refresh coalescing gate: at most
    /// one refresh runs per worker with one queued trailing re-arm, so a
    /// picker burst or an auth-change storm costs one refresh, not N
    /// parallel entitlement fetches.
    pub(crate) model_catalog_refresh_gate: std::sync::Arc<crate::model_catalog::RefreshGate>,
    recovery: Arc<Mutex<Option<WorkerRecoveryJournal>>>,
    /// Live side-question runs (registry, guards, event frames).
    side_questions: crate::side_question::SideQuestionManager,
    /// Single-use peer-transport grants (worker memory only).
    pub(crate) peer_grants: PeerGrantStore,
    /// Compaction runs: abort slot, events, durable entry persistence.
    pub(crate) compaction: crate::compaction::CompactionManager,
    /// Session-tree navigation: `/tree` moves, branch summaries, forks.
    pub(crate) tree_navigation: crate::branch_navigation::TreeNavigation,
    /// The `get_context_tree` children cache: the artifact-tree walk is a
    /// multi-second disk read on a grown session store (the operator's
    /// `/context` timeout), so it runs as a background refresh and the
    /// request serves the cached snapshot (`context_tree_cache`).
    pub(crate) context_tree: std::sync::Arc<crate::context_tree_cache::ContextTreeCache>,
    /// Session export: the `/export` HTML and JSONL branches.
    exports: crate::session_export::ExportCommands,
    /// Session-scoped ACP MCP servers for engines without their own store
    /// (the scripted harness); the real engine's manager serves the
    /// product path.
    acp_mcp: std::sync::Arc<std::sync::Mutex<pa_core::mcp::McpManager>>,
    /// The user-bash slot (`execute_bash` / `execute_bash_and_wait` /
    /// `abort_bash`): one command runs at a time, killed on abort.
    pub(crate) user_bash: std::sync::Arc<crate::user_bash::UserBash>,
    /// The coalescing roster push queue shared with the turn runner: the
    /// awaited bash handler enqueues the run-settle flush (TS
    /// `execute_bash_and_wait`'s `finally` roster flush).
    pub(crate) roster_pushes: crate::roster_activity::RosterPushQueue,
    /// Agent-message ingestion state (`agent_messages_*` arms): the pause
    /// flag the delivery gate checks.
    pub(crate) agent_messages: crate::agent_message_ingest::AgentMessageIngest,
    /// Session input-pause leases (`acquire`/`release_session_input_pause`):
    /// the admission gate the turn runner consults.
    pub(crate) input_pauses: crate::session_input_pause::InputPauseTable,
    /// Session navigation (wave b9): `new_session` / `switch_session` /
    /// `import_jsonl`, the shared replacement flow.
    pub(crate) navigation: crate::session_navigation::SessionNavigation,
    /// Worker-side prompt admissions (wave b9): the registry the
    /// supervisor's forwarded `cancel_prompt_admission` reads; shared with
    /// the turn runner, which commits a queued admission when its turn
    /// starts.
    pub(crate) prompt_admissions: crate::prompt_admission::WorkerAdmissions,
    /// The scheduling surface (wave b10): the session's cron/heartbeat
    /// artifact store plus the scheduler firing due jobs into the queue;
    /// the worker rebinds the live session's jobs onto it after create
    /// and every replacement swap (TS `rebindCronJobsToState`).
    pub(crate) scheduled: std::sync::Arc<crate::scheduled_jobs::ScheduledJobs>,
    /// Session creation is one serialized critical section (TS
    /// `openingSessions`: a concurrent open for the same session JOINS
    /// the in-flight one instead of racing it). Commands run on spawned
    /// tasks, so without the gate two concurrent `create` requests could
    /// both pass the `core.created` check while the first still awaits
    /// its session-model restore — duplicating creation-prefix rows and
    /// overwriting the initialized core state.
    create_gate: tokio::sync::Mutex<()>,
    /// Whole-session replacements are one serialized critical section
    /// too: the teardown, the store/file swap, the session-model
    /// restore's awaits, and the branch-context rebuild must move the
    /// worker onto the replacement session as one unit. Two concurrent
    /// replacements (`switch_session`/`new_session`/`import_jsonl`/
    /// `fork`) could otherwise interleave at the restore's awaits — the
    /// first command's rebuild landing against the second command's
    /// session file, its restore decision rejected, the store, context,
    /// and model left from different sessions.
    pub(crate) replacement_gate: tokio::sync::Mutex<()>,
}

/// The kernel cron wiring the worker hands its session engine (TS
/// daemon-mode wires its `AgentCronJobStore.forSessionArtifacts()` into
/// the session runtime): the shared scheduled-jobs store, the durable
/// binding the engine enriches per build, and the mutation hook the
/// kernel's `rlm_heartbeat.*` host handlers invoke after every
/// create/update/delete (TS `removeQueuedHeartbeatFollowUp` +
/// `cronScheduler.wake()` inside the daemon's rlm heartbeat controllers).
fn kernel_cron_wiring(
    scheduled: &std::sync::Arc<crate::scheduled_jobs::ScheduledJobs>,
) -> pa_core::session_engine::runtime_wiring::KernelCronWiring {
    pa_core::session_engine::runtime_wiring::KernelCronWiring {
        store: std::sync::Arc::clone(scheduled.store()),
        binding: None,
        mutation_hook: Some(scheduled.mutation_hook()),
    }
}

/// Supervisor-link coordinates for a worker's agent engine: where the
/// supervisor listens and who this worker is on it.
fn supervisor_link_config(config: &WorkerConfig) -> SupervisorLinkConfig {
    SupervisorLinkConfig {
        socket_path: config.supervisor_socket_path.clone(),
        active_session_id: config.active_session_id.clone(),
        worker_token: config.token.clone(),
    }
}

/// Whether a delivery's sender is one of THIS session's children, by the
/// sender's recorded durable parent edge: the persisted session id first
/// (it survives this session's own worker replacement), then the live
/// active id, then the session-file alias. Runtime kind alone never
/// decides — a subagent spawned by another parent is not a child here.
fn sender_is_child_of(sender: &Value, core: &SessionCore) -> bool {
    let store = core.store.as_ref();
    sender_parent_edge_is(
        sender,
        store.map(SessionFile::session_id),
        core.active_session_id.as_str(),
        store
            .filter(|store| !store.path.as_os_str().is_empty())
            .map(|store| store.path.as_path()),
    )
}

/// The edge test behind [`sender_is_child_of`], pure over the recipient's
/// durable identity: the sender block's parent edge (persisted id, live
/// id, or session file) must point back at this session.
fn sender_parent_edge_is(
    sender: &Value,
    own_session_id: Option<&str>,
    own_active_session_id: &str,
    own_session_file: Option<&std::path::Path>,
) -> bool {
    let sender_parent = |key: &str| {
        sender
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    if let Some(parent) = sender_parent("parentSessionId") {
        if own_session_id.is_some_and(|id| id == parent) {
            return true;
        }
    }
    if let Some(parent) = sender_parent("parentActiveSessionId") {
        if parent == own_active_session_id {
            return true;
        }
    }
    if let (Some(parent), Some(file)) = (sender_parent("parentSessionPath"), own_session_file) {
        if crate::agent_messaging::same_session_file(parent, &file.to_string_lossy()) {
            return true;
        }
    }
    false
}

impl Worker {
    /// Build the worker: the session core, the engine, and the sink and
    /// hook wiring between them.
    ///
    /// # Panics
    ///
    /// The closures wired here (the queue purge and the session-input
    /// probe) panic on a poisoned session-core mutex (a holder panicked
    /// while holding it).
    pub fn new(config: WorkerConfig, registration: Option<RegistrationHandle>) -> Self {
        let events = Arc::new(EventPump::new());
        let supervisor_claims = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let core = SessionCore {
            active_session_id: config.active_session_id.clone(),
            generation: crate::util::new_display_id(),
            last_event_sequence: 0,
            store: None,
            cwd: String::new(),
            steering: VecDeque::new(),
            follow_up: VecDeque::new(),
            busy: false,
            created: false,
            attached_client_ids: Vec::new(),
            abort_requested: false,
            suppress_aborted_row: false,
            shutdown_requested: false,
            compacting: false,
            auto_compaction_enabled: true,
            // TS seeds `_lastSessionActionSnapshot` with the empty
            // projection, so a fresh session's first empty snapshot is not
            // an update.
            last_action_snapshot: Some(SessionActionSnapshot::default()),
            rlm_depth: 0,
            runtime_kind: "top-level".to_string(),
            rlm_child_id: None,
            parent_active_session_id: None,
            parent_session_id: None,
            child_script: None,
            service_tier: None,
            steering_mode: "all".to_string(),
            follow_up_mode: "one-at-a-time".to_string(),
            forced_all_steering: false,
            scoped_models: Vec::new(),
            retry_abort_requested: false,
            queued_input_suspended: false,
            pending_next_turn: Vec::new(),
            active_action: None,
            running_tool_calls: std::collections::HashSet::new(),
        };
        let active_session_id = config.active_session_id.clone();
        let script = config.script.clone();
        let core = Arc::new(Mutex::new(core));
        // TS `_steeringStopPending` (the session's stop hooks): the
        // steering lane owning the probe makes a queued steer stop the
        // running turn at its next turn boundary — the runner delivers
        // the steer as the next turn (the follow-up lane never stops the
        // run; it waits for the settle, TS `when_run_idle`).
        let queued_steering_probe: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>> = Some({
            let core = Arc::clone(&core);
            std::sync::Arc::new(move || {
                !core
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .steering
                    .is_empty()
            })
        });
        // Shared worker recovery journal: the turn runner persists queue
        // snapshots into it, `serve` opens the file, and command handlers
        // record busy/operation state.
        let recovery = Arc::new(Mutex::new(None));
        let work_notify = Arc::new(Notify::new());
        let idle_notify = Arc::new(Notify::new());
        // The supervisor link and worker token for roster pushes: one
        // construction shared by the turn runner's busy-flip pushes and
        // the command arms' switch pushes (the same env the runner reads,
        // so both push over the identical dial path).
        let roster_link = std::sync::Arc::new(crate::supervisor_link::SupervisorLink::new(
            std::env::var_os(WORKER_SUPERVISOR_SOCKET_ENV)
                .map(std::path::PathBuf::from)
                .unwrap_or_default(),
        ));
        let worker_token = std::env::var(WORKER_TOKEN_ENV).unwrap_or_default();
        let roster_delta_sequence = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let roster_push_order = std::sync::Arc::new(std::sync::Mutex::new(()));
        // The session input-pause table (the admission gate): shared by
        // the worker's arms and the turn runner below.
        let input_pauses = crate::session_input_pause::InputPauseTable::new();
        // The worker's prompt-admission registry: shared with the turn
        // runner (the commit happens at turn start).
        let prompt_admissions = crate::prompt_admission::WorkerAdmissions::new();
        // The user-bash slot and the scheduled-jobs catalog: created before
        // the session engine so the engine's kernel `rlm_heartbeat.*` host
        // requests write the worker's shared cron store (agent-created
        // heartbeats reach the `heartbeats_list` catalog and the scheduler;
        // TS daemon-mode wires the same `forSessionArtifacts()` store into
        // the session runtime).
        let user_bash = std::sync::Arc::new(crate::user_bash::UserBash::new());
        let scheduled = std::sync::Arc::new(crate::scheduled_jobs::ScheduledJobs::new(
            Arc::clone(&core),
            Arc::clone(&work_notify),
            std::sync::Arc::clone(&user_bash),
            Arc::clone(&events),
            Arc::clone(&recovery),
        ));
        // The turn runner runs for the whole process lifetime. The command
        // dispatcher keeps the engine handle too (model metadata for the
        // stats commands).
        let (engine, agent_engine, roster_pushes): (
            std::sync::Arc<dyn SessionEngine>,
            Option<std::sync::Arc<crate::agent_engine::AgentSessionEngine>>,
            crate::roster_activity::RosterPushQueue,
        ) = {
            // Scripted sessions serve the integration harness; sessions
            // without a script run the real agent engine.
            let mut agent_engine: Option<std::sync::Arc<crate::agent_engine::AgentSessionEngine>> =
                None;
            let engine: std::sync::Arc<dyn SessionEngine> = match &script {
                // A `{"engine": "faux", ...}` script drives the real agent
                // engine over the scripted faux provider (full turns with
                // tools, thinking, and token-paced streaming). Verification
                // harness only; the product never sets a script.
                Some(script) if script.get("engine") == Some(&serde_json::json!("faux")) => {
                    let cwd =
                        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
                    match AgentSessionEngine::new(AgentEngineConfig {
                        cwd,
                        agent_dir: config.agent_dir.clone(),
                        provider: None,
                        model: None,
                        api_key: None,
                        thinking: None,
                        session_dir: None,
                        session_file: None,
                        faux_script: Some(script.to_string()),
                        supervisor_link: Some(supervisor_link_config(&config)),
                        telemetry_disabled: config.telemetry_disabled,
                        cron_store: Some(kernel_cron_wiring(&scheduled)),
                        queued_steering_probe: queued_steering_probe.clone(),
                    }) {
                        Ok(engine) => {
                            let concrete = std::sync::Arc::new(engine);
                            agent_engine = Some(std::sync::Arc::clone(&concrete));
                            concrete
                        }
                        // Runtime construction failed: degrade to the echo engine.
                        Err(_) => std::sync::Arc::new(ScriptedEngine::default()),
                    }
                }
                Some(script) => std::sync::Arc::new(
                    ScriptedEngine::from_value(script.clone()).unwrap_or_default(),
                ),
                None => {
                    let cwd =
                        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
                    match AgentSessionEngine::new(AgentEngineConfig {
                        cwd,
                        agent_dir: config.agent_dir.clone(),
                        provider: std::env::var("PRIME_AGENT_MODEL_PROVIDER").ok(),
                        model: std::env::var("PRIME_AGENT_MODEL").ok(),
                        api_key: None,
                        thinking: None,
                        session_dir: None,
                        session_file: None,
                        faux_script: None,
                        supervisor_link: Some(supervisor_link_config(&config)),
                        telemetry_disabled: config.telemetry_disabled,
                        cron_store: Some(kernel_cron_wiring(&scheduled)),
                        queued_steering_probe: queued_steering_probe.clone(),
                    }) {
                        Ok(engine) => {
                            let concrete = std::sync::Arc::new(engine);
                            agent_engine = Some(std::sync::Arc::clone(&concrete));
                            concrete
                        }
                        // Runtime construction failed: degrade to the echo engine.
                        Err(_) => std::sync::Arc::new(ScriptedEngine::default()),
                    }
                }
            };
            // The goal continuation seam (TS `getContinuationMessages`):
            // the worker owns the queue and the suspension gates, the
            // engine owns the goal mint — the probe exposes the queue
            // state to the mint's deferral rules, the sink admits minted
            // follow-ups through the queue lanes, and the children
            // registry's settle hook (registered inside) delivers a
            // continuation owed behind descendant work.
            if let Some(concrete) = agent_engine.as_ref() {
                // The in-run autonomous continuation seam (TS
                // `getContinuationMessages` -> the autonomous arm): the
                // engine's hook holds itself weakly through the registered
                // arc, and the held threshold continuation admits through
                // the worker's follow-up lane (`/autonomous off` withdraws
                // it, TS `_clearQueuedAutonomousContinuations`).
                concrete.register_arc();
                let sink_core = Arc::clone(&core);
                let sink_notify = Arc::clone(&work_notify);
                let autonomous_sink: crate::agent_engine::AutonomousAdmission = {
                    let sink_core = Arc::clone(&sink_core);
                    let sink_notify = Arc::clone(&sink_notify);
                    let sink_recovery = Arc::clone(&recovery);
                    std::sync::Arc::new(move |text| {
                        admit_autonomous_follow_up(&sink_recovery, &sink_core, &sink_notify, text);
                    })
                };
                concrete.set_autonomous_admission(autonomous_sink);
                let purge_core = Arc::clone(&core);
                let purge_recovery = Arc::clone(&recovery);
                let autonomous_purge: std::sync::Arc<dyn Fn() + Send + Sync> =
                    std::sync::Arc::new(move || {
                        {
                            let mut core = purge_core.lock().unwrap();
                            core.follow_up.retain(|item| {
                                item.queue_key.as_deref() != Some(AUTONOMOUS_QUEUE_KEY)
                            });
                            core.steering.retain(|item| {
                                item.queue_key.as_deref() != Some(AUTONOMOUS_QUEUE_KEY)
                            });
                        }
                        // The withdraw settles the rows: `/autonomous
                        // off` dropping the last queued row must not
                        // leave its admission busy=true promising a revive
                        // work that was withdrawn (and the snapshot must
                        // not keep replaying the withdrawn row). Mid-turn
                        // the verdict stays busy — the in-flight turn is
                        // live work until its own `turn_end`.
                        checkpoint_queue_recovery(
                            &purge_recovery,
                            &purge_core,
                            QueueCheckpoint::Settle {
                                operation: "queue_purged",
                            },
                        );
                    });
                concrete.set_autonomous_queue_purge(autonomous_purge);
                let probe_core = Arc::clone(&core);
                let probe: crate::engine::SessionInputProbe = Arc::new(move || {
                    let core = probe_core.lock().unwrap();
                    core.queued_input_suspended
                        || !core.steering.is_empty()
                        || !core.follow_up.is_empty()
                });
                let sink_core = Arc::clone(&core);
                let sink_events = events.clone();
                let sink_notify = Arc::clone(&work_notify);
                let sink_recovery = Arc::clone(&recovery);
                let sink: crate::engine::GoalAdmissionSink = Arc::new(move |work| {
                    admit_goal_follow_up(
                        &sink_recovery,
                        &sink_core,
                        &sink_events,
                        &sink_notify,
                        work,
                    );
                });
                // TS `_clearQueuedGoalContexts`: withdraw queued minted
                // goal-context turns (the pause/clear/start commands and
                // the kernel's `goal.complete`).
                let purge_core = Arc::clone(&core);
                let purge_recovery = Arc::clone(&recovery);
                let queue_purge: std::sync::Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                    {
                        let mut core = purge_core.lock().unwrap();
                        core.steering.retain(|item| !is_goal_context_item(item));
                        core.follow_up.retain(|item| !is_goal_context_item(item));
                    }
                    // Same settle as the autonomous withdraw: the
                    // withdrawal must refresh the verdict (and the
                    // snapshot) so a pause/clear cannot leave busy=true
                    // over withdrawn rows (a mid-turn withdrawal stays
                    // busy through the in-flight turn).
                    checkpoint_queue_recovery(
                        &purge_recovery,
                        &purge_core,
                        QueueCheckpoint::Settle {
                            operation: "queue_purged",
                        },
                    );
                });
                concrete.set_goal_admission(probe, sink, queue_purge);
                // The live compaction summary-delta sink (the
                // `compaction_summary_delta` broadcast, the operator's
                // "stream the compacted summary" feature): every
                // summarizer text delta the engine's compactions stream
                // reaches the attached clients as one ephemeral
                // session-event frame between the owning
                // `compaction_start` and the settling `compaction_end`.
                // The frames sequence + broadcast exactly like the
                // worker's other session events (never persisted, never
                // a roster trigger), so the ordering contract with the
                // compaction loader's start/end pair holds.
                let summary_core = Arc::clone(&core);
                let summary_events = events.clone();
                let summary_sink: pa_core::session_engine::compaction_exec::SummaryDeltaSink =
                    Arc::new(move |delta| {
                        emit_worker_event_with(
                            &summary_core,
                            &summary_events,
                            crate::compaction::compaction_summary_delta_event(delta),
                        );
                    });
                concrete.set_compaction_summary_sink(summary_sink);
                // The bash-completion wake seam (TS
                // `_promptInjectedMessage` for `bash.completed` and
                // `_withdrawAsyncBashCompletionNotice` for
                // `bash.consumed`): the handler validates and the sink
                // admits/withdraws through the queue lanes. The engine
                // reference carries the closed-session gate (the same
                // refusal `deliver_goal_work` applies).
                // A weak engine reference: the engine holds the sinks,
                // so a strong reference here would pin it forever (the
                // same reason the goal settle hook downgrades).
                let notice_engine = std::sync::Arc::downgrade(concrete);
                let notice_core = Arc::clone(&core);
                let notice_notify = Arc::clone(&work_notify);
                let notice_recovery = Arc::clone(&recovery);
                let completion: crate::engine::BashCompletionSink = Arc::new(move |notice| {
                    let Some(engine) = notice_engine.upgrade() else {
                        return;
                    };
                    if engine.session_is_closed() {
                        return;
                    }
                    admit_bash_completion_notice(
                        &notice_recovery,
                        &notice_core,
                        &notice_notify,
                        notice,
                        // Revalidated inside the admission's own lock
                        // section: the close paths mark the session
                        // BEFORE clearing the lanes, so a notice that
                        // slips past the check above is either refused
                        // here or wiped by the close's clear.
                        || engine.session_is_closed(),
                    );
                });
                let withdraw_core = Arc::clone(&core);
                let withdraw_recovery = Arc::clone(&recovery);
                let consumed: crate::engine::BashConsumedSink = Arc::new(move |notice| {
                    withdraw_bash_completion_notice(&withdraw_recovery, &withdraw_core, notice);
                });
                concrete.set_bash_notice_sinks(completion, consumed);
            }
            // The live roster activity feed (TS `observeRosterEvent` +
            // `scheduleRosterFlush`): the busy flips and every trigger
            // event that flows through the worker's event pump coalesce
            // into fresh-composed `worker_roster_delta` pushes, so the
            // activity rows advance mid-turn (`running tools` while tool
            // calls execute, `running bash` for the user bash, idle at the
            // settle) instead of holding the turn-start snapshot.
            let roster_pushes =
                crate::roster_activity::RosterPushQueue::spawn(crate::worker::RosterPushContext {
                    core: Arc::clone(&core),
                    engine: std::sync::Arc::clone(&engine),
                    user_bash: std::sync::Arc::clone(&user_bash),
                    roster_link: Arc::clone(&roster_link),
                    worker_token,
                    worker_instance_id: config.worker_instance_id.clone(),
                    roster_delta_sequence: std::sync::Arc::clone(&roster_delta_sequence),
                    roster_push_order: std::sync::Arc::clone(&roster_push_order),
                });
            crate::roster_activity::spawn_roster_activity_watch(
                events.clone(),
                roster_pushes.clone(),
            );
            let runner = TurnRunner {
                recovery: Arc::clone(&recovery),
                core: Arc::clone(&core),
                input_pauses: input_pauses.clone(),
                prompt_admissions,
                work_notify: Arc::clone(&work_notify),
                idle_notify: Arc::clone(&idle_notify),
                events: events.clone(),
                engine: std::sync::Arc::clone(&engine),
                active_session_id,
                roster_pushes: roster_pushes.clone(),
            };
            tokio::spawn(async move {
                runner.run().await;
            });
            (engine, agent_engine, roster_pushes)
        };
        let side_questions = crate::side_question::SideQuestionManager::new(
            std::sync::Arc::clone(&engine),
            events.clone(),
            config.active_session_id.clone(),
        );
        let compaction = crate::compaction::CompactionManager::new(
            std::sync::Arc::clone(&engine),
            events.clone(),
            Arc::clone(&core),
            config.active_session_id.clone(),
            config.agent_dir.clone(),
        );
        let tree_navigation = crate::branch_navigation::TreeNavigation::new(
            std::sync::Arc::clone(&engine),
            Arc::clone(&core),
            idle_notify.clone(),
        );
        let exports = crate::session_export::ExportCommands::new(
            std::sync::Arc::clone(&engine),
            Arc::clone(&core),
            config.agent_dir.clone(),
        );
        // The session-scoped ACP MCP manager: auth storage construction is
        // blocking, so the builder runs off the async runtime (the same
        // pattern as the session engine's MCP gating).
        let agent_dir = config.agent_dir.clone();
        let acp_mcp = pa_core::mcp::McpManager::new(pa_core::mcp::McpManagerOptions {
            auth_storage: pa_core::auth::AuthStorage::create(&agent_dir),
            get_user_servers: Box::new(|| None),
            begin_login: None,
            agent_dir: Some(agent_dir),
            get_catalog_sources: None,
            remote_source: None,
            probe_override: None,
        });
        let prompt_admissions = crate::prompt_admission::WorkerAdmissions::new();
        let navigation = crate::session_navigation::SessionNavigation::new(
            std::sync::Arc::clone(&engine),
            Arc::clone(&core),
        );
        Worker {
            config,
            registration,
            supervisor_claims,
            core,
            engine,
            agent_engine,
            roster_delta_sequence,
            work_notify,
            idle_notify,
            events,
            model_catalog_refresh_gate: std::sync::Arc::new(
                crate::model_catalog::RefreshGate::default(),
            ),
            recovery,
            side_questions,
            peer_grants: PeerGrantStore::new(),
            compaction,
            tree_navigation,
            context_tree: std::sync::Arc::new(crate::context_tree_cache::ContextTreeCache::new()),
            exports,
            acp_mcp: std::sync::Arc::new(std::sync::Mutex::new(acp_mcp)),
            user_bash,
            roster_pushes,
            agent_messages: crate::agent_message_ingest::AgentMessageIngest::new(),
            input_pauses,
            navigation,
            prompt_admissions,
            scheduled,
            create_gate: tokio::sync::Mutex::new(()),
            replacement_gate: tokio::sync::Mutex::new(()),
        }
    }

    /// Serve worker connections until the process is asked to shut down.
    ///
    /// # Errors
    ///
    /// Returns an error when the recovery journal cannot be opened, the
    /// socket path cannot be prepared, the worker socket cannot be
    /// bound, or an accept fails.
    ///
    /// # Panics
    ///
    /// Panics when the recovery mutex is poisoned (a holder panicked
    /// while holding it).
    pub async fn serve(self: Arc<Self>) -> Result<()> {
        *self.recovery.lock().unwrap() = Some(WorkerRecoveryJournal::open(
            &self.config.recovery_journal_path,
        )?);
        // A worker spawned under a supervisor arms the orphan-exit monitor
        // (TS `startSupervisorMonitor`): nobody else reaps it if the
        // supervisor dies without a graceful stop.
        if !self.config.supervisor_socket_path.as_os_str().is_empty() {
            crate::supervisor_lost::start(self.clone());
        }
        crate::socket::prepare_socket_path(&self.config.socket_path).await?;
        let listener = bind_transport(&self.config.socket_path)
            .await
            .with_context(|| format!("bind worker socket {}", self.config.socket_path.display()))?;
        crate::socket::restrict_socket_path(&self.config.socket_path);
        loop {
            let stream = match listener.accept().await {
                Ok(accepted) => {
                    if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                        eprintln!("[worker {}] accepted connection", std::process::id());
                    }
                    accepted
                }
                Err(error) => return Err(anyhow!("worker accept: {error}")),
            };
            let worker = Arc::clone(&self);
            tokio::spawn(async move {
                if let Err(error) = worker.handle_connection(stream).await {
                    eprintln!("pa-daemon worker connection error: {error:#}");
                }
            });
        }
    }

    async fn handle_connection(self: Arc<Self>, stream: Box<dyn TransportStream>) -> Result<()> {
        let (reader, writer) = stream.split();
        let writer = Arc::new(tokio::sync::Mutex::new(writer));
        // The connection's event subscription and its entry sequence are
        // captured together (before any awaited write): every frame the
        // receiver can see has a sequence at or above `entry_seq`, which is
        // what the sink's flush barrier gates on.
        let subscription = self.events.subscribe();
        let entry_seq = self.events.current_seq() + 1;
        // The connection's outbound sink: the framed writer plus the
        // fan-out flush position (response writes wait on it; see
        // `ConnectionSink`).
        let sink = Arc::new(ConnectionSink::new(Arc::clone(&writer), entry_seq));
        // daemon_hello goes out immediately on every connection.
        let hello = DaemonOutbound::DaemonHello {
            socket_path: self.config.socket_path.to_string_lossy().to_string(),
            protocol: current_protocol_info(),
            schema_id: Some(DAEMON_SCHEMA_ID.to_string()),
            schema_revision: Some(DAEMON_SCHEMA_REVISION),
            app_version: Some(DAEMON_APP_VERSION.to_string()),
            runtime: None,
            supervisor_generation: None,
            supervisor_pid: Some(std::process::id() as u64),
            supervisor_owner_token: None,
            supervisor_process_start_id: None,
            supervisor_socket_path: None,
            // The worker's hello carries no resume contract (the
            // supervisor owns the boot restore pass).
            update_resume: None,
            client_id: crate::util::new_display_id(),
            server_capabilities: worker_server_capabilities(),
            rest: Map::default(),
        };
        let hello_bytes = serde_json::to_vec(&hello)?;
        // A supervisor liveness probe may connect and drop immediately; that
        // is not an error worth reporting (the peer simply went away first).
        if let Err(error) = self
            .write_frame(
                &writer,
                &json!({ "kind": "outbound", "outboundType": "daemon_hello" }),
                &hello_bytes,
            )
            .await
        {
            if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                eprintln!(
                    "[worker {}] hello write failed: {error:#}",
                    std::process::id()
                );
            }
            return Ok(());
        }

        // The connection's authenticated role, shared with the event
        // fan-out task (streaming is gated on it).
        let role = Arc::new(std::sync::Mutex::new(ConnectionRole::Unauthenticated));

        // Releases the supervisor claim this connection may take (see
        // `SupervisorClaimRelease`): the claim's lifetime is the
        // connection's, so every return path (EOF, auth failure, frame
        // error) goes through the same decrement.
        let _claim_release = SupervisorClaimRelease {
            role: Arc::clone(&role),
            claims: Arc::clone(&self.supervisor_claims),
        };

        // Connection-closed signal: the read loop fires it when the peer is
        // gone (EOF, auth failure) or drops it on return. The fan-out task
        // must not outlive the connection - the shared-socket write half it
        // holds keeps the socket fd open, and a per-connection fd leak here
        // (probes, direct clients, peer deliveries) ends in EMFILE for a
        // long-lived worker.
        let (closed_tx, closed_rx) = tokio::sync::watch::channel(false);

        // Event fan-out: this connection's subscription to the shared pump.
        // Only authenticated roles stream: the supervisor always, a session
        // client only while it holds an attach on the session.
        {
            let worker = Arc::clone(&self);
            let sink = Arc::clone(&sink);
            let role = Arc::clone(&role);
            let mut closed = closed_rx;
            tokio::spawn(async move {
                let mut events = subscription;
                loop {
                    tokio::select! {
                        // The read loop ended (or dropped its sender):
                        // release the subscription and the write half so
                        // the socket fd closes.
                        changed = closed.changed() => {
                            let _ = changed;
                            sink.mark_closed();
                            break;
                        }
                        received = events.recv() => {
                            match received {
                                Ok(frame) => {
                                    // A frame this role does not stream still
                                    // advances the flush position: it cannot be
                                    // delivered later, so a gated response must not
                                    // wait for it.
                                    if role.lock().unwrap().streams_events() {
                                        let active_session_id = active_session_id_of(&frame.payload);
                                        let header = json!({
                                            "kind": "outbound",
                                            "outboundType": frame.outbound_type,
                                            "activeSessionId": active_session_id,
                                        });
                                        if worker
                                            .write_frame(&sink.writer, &header, &frame.payload)
                                            .await
                                            .is_err()
                                        {
                                            sink.mark_closed();
                                            break;
                                        }
                                    }
                                    sink.mark_flushed(frame.seq);
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => {}
                                Err(broadcast::error::RecvError::Closed) => {
                                    sink.mark_closed();
                                    break;
                                }
                            }
                        }
                    }
                }
            });
        }

        let mut reader =
            crate::framing::PrivateFrameReader::new(reader, DEFAULT_PRIVATE_FRAME_LIMITS);
        loop {
            let frame: Option<crate::framing::PrivateFrame> = reader.read_frame().await?;
            let Some(frame) = frame else {
                // Peer closed: wake the fan-out so it drops the write half.
                let _ = closed_tx.send(true);
                break;
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
            let payload: Value = serde_json::from_slice(&frame.payload)
                .with_context(|| format!("invalid worker command JSON for {command_type}"))?;
            if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                eprintln!("[worker {}] got command {command_type}", std::process::id());
            }

            let current_role = role.lock().unwrap().clone();
            match current_role {
                ConnectionRole::Unauthenticated => {
                    // The first command authenticates the connection; a
                    // failed authentication ends it (TS worker branch).
                    let outcome = self
                        .authenticate_connection(&command_type, &payload, &request_id, &role, &sink)
                        .await;
                    if outcome == AuthOutcome::Failed {
                        // Failed auth ends the connection: wake the fan-out
                        // so it releases the write half (and the fd).
                        let _ = closed_tx.send(true);
                        break;
                    }
                }
                ConnectionRole::Supervisor { ref generation } => {
                    if command_type == "worker_register_peer_transport" {
                        let response =
                            self.handle_worker_register_peer_transport(&payload, generation);
                        self.write_response_frame(&sink, &request_id, &response)
                            .await;
                        continue;
                    }
                    // Shutdown stays sequential: the reply must precede the
                    // exit. Every other command runs concurrently, like the
                    // TS daemon's async handlers: a long-running command (a
                    // turn, a compaction) must not block aborts or state
                    // reads from other clients.
                    if command_type == "shutdown" {
                        let response = self.dispatch(&command_type, &payload).await;
                        self.write_response_frame(&sink, &request_id, &response)
                            .await;
                        if response.success {
                            self.exit_after_close();
                        }
                        continue;
                    }
                    let worker = Arc::clone(&self);
                    let sink = Arc::clone(&sink);
                    let request_id = request_id.clone();
                    let command_type = command_type.clone();
                    tokio::spawn(async move {
                        let response = worker.dispatch(&command_type, &payload).await;
                        worker
                            .write_response_frame(&sink, &request_id, &response)
                            .await;
                    });
                }
                ConnectionRole::SessionClient { ref session } => {
                    // A direct peer may only run session-plane commands for
                    // the grant's session (TS `peerClaims` gate).
                    if !peer_command_allowed(&command_type, &payload, &session.grant) {
                        let failure = response_failure(
                            Some(&request_id),
                            &command_type,
                            PEER_COMMAND_NOT_ALLOWED,
                            None,
                        );
                        self.write_response_frame(&sink, &request_id, &failure)
                            .await;
                        continue;
                    }
                    // Session-plane commands run concurrently for the same
                    // reason as the supervisor arm above.
                    let worker = Arc::clone(&self);
                    let sink = Arc::clone(&sink);
                    let request_id = request_id.clone();
                    let command_type = command_type.clone();
                    let session = Arc::clone(session);
                    tokio::spawn(async move {
                        let response = worker.dispatch(&command_type, &payload).await;
                        if response.success {
                            match command_type.as_str() {
                                "attach" => session.mark_attached(),
                                "detach" => session.mark_detached(),
                                _ => {}
                            }
                        }
                        worker
                            .write_response_frame(&sink, &request_id, &response)
                            .await;
                    });
                }
                ConnectionRole::PeerWorker { ref session } => {
                    // A peer worker delivers agent messages only, for the
                    // grant's session; everything else bounces with the TS
                    // gate string.
                    if !worker_peer_command_allowed(&command_type, &payload, &session.grant) {
                        let failure = response_failure(
                            Some(&request_id),
                            &command_type,
                            PEER_COMMAND_NOT_ALLOWED,
                            None,
                        );
                        self.write_response_frame(&sink, &request_id, &failure)
                            .await;
                        continue;
                    }
                    // Delivery runs concurrently, like the other planes.
                    let worker = Arc::clone(&self);
                    let sink = Arc::clone(&sink);
                    let request_id = request_id.clone();
                    let command_type = command_type.clone();
                    tokio::spawn(async move {
                        let response = worker.dispatch(&command_type, &payload).await;
                        worker
                            .write_response_frame(&sink, &request_id, &response)
                            .await;
                    });
                }
            }
        }
        Ok(())
    }

    /// Authenticate one connection's first command: `worker_auth` promotes
    /// the connection to the supervisor role, `peer_auth` to a session
    /// client role holding a burned single-use grant. Writes the response.
    async fn authenticate_connection(
        self: &Arc<Self>,
        command_type: &str,
        payload: &Value,
        request_id: &str,
        role: &Arc<std::sync::Mutex<ConnectionRole>>,
        sink: &ConnectionSink,
    ) -> AuthOutcome {
        if command_type == "peer_auth" {
            return self.handle_peer_auth(payload, request_id, role, sink).await;
        }
        if command_type != "worker_auth" {
            let failure = response_failure(
                Some(request_id),
                "worker_auth",
                "Worker authentication failed",
                None,
            );
            self.write_response_frame(sink, request_id, &failure).await;
            return AuthOutcome::Failed;
        }
        match self.authenticate(payload) {
            Ok(()) => {
                if std::env::var("PA_DAEMON_DEBUG").is_ok() {
                    eprintln!("[worker {}] auth ok", std::process::id());
                }
                let generation = payload
                    .get("supervisorGeneration")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                // The roster capability is always granted; the peer
                // transport capability rides on the worker instance
                // id, like the TS worker.
                let mut capabilities = vec!["agent_roster".to_string()];
                if !self.config.worker_instance_id.is_empty() {
                    capabilities.push("direct_peer_transport".to_string());
                }
                let success = response_success(
                    Some(request_id),
                    "worker_auth",
                    Some(json!({ "capabilities": capabilities })),
                );
                *role.lock().unwrap() = ConnectionRole::Supervisor { generation };
                self.supervisor_claims
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                self.write_response_frame(sink, request_id, &success).await;
                AuthOutcome::Authenticated
            }
            Err(error) => {
                let failure =
                    response_failure(Some(request_id), "worker_auth", &error.to_string(), None);
                self.write_response_frame(sink, request_id, &failure).await;
                AuthOutcome::Failed
            }
        }
    }

    fn authenticate(&self, payload: &Value) -> Result<()> {
        let token = payload
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // TS `worker_auth` validation: token, generation, pid, socket path are
        // mandatory; instance and process-start ids only checked when present.
        if token.is_empty() || token != self.config.token {
            return Err(anyhow!("Worker authentication failed"));
        }
        if payload
            .get("supervisorGeneration")
            .and_then(Value::as_str)
            .is_none()
        {
            return Err(anyhow!("Worker authentication failed"));
        }
        let pid = payload
            .get("supervisorPid")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if pid == 0 {
            return Err(anyhow!("Worker authentication failed"));
        }
        if payload
            .get("supervisorSocketPath")
            .and_then(Value::as_str)
            .is_none()
        {
            return Err(anyhow!("Worker authentication failed"));
        }
        if let Some(instance) = payload.get("workerInstanceId") {
            if !instance.is_null()
                && instance.as_str() != Some("")
                && instance.as_str().map(str::to_string)
                    != Some(self.config.worker_instance_id.clone())
            {
                return Err(anyhow!("Worker authentication failed"));
            }
        }
        Ok(())
    }

    pub(crate) async fn write_frame(
        &self,
        writer: &Arc<tokio::sync::Mutex<Box<dyn pa_types::platform::transport::AsyncWriteHalf>>>,
        header: &Value,
        payload: &[u8],
    ) -> Result<()> {
        let mut guard = writer.lock().await;
        write_frame(&mut *guard, header, payload, DEFAULT_PRIVATE_FRAME_LIMITS)
            .await
            .context("write private frame")
    }

    pub(crate) async fn write_response_frame(
        &self,
        sink: &ConnectionSink,
        request_id: &str,
        response: &DaemonResponse,
    ) {
        // Flush barrier: every event frame broadcast before this response
        // reaches the connection's writer first, so a command response
        // never overtakes the events its command emitted (the TS worker
        // gets this ordering for free from synchronous writes).
        sink.wait_flushed(self.events.current_seq()).await;
        let payload =
            serde_json::to_vec(&crate::protocol::response_line(response)).unwrap_or_default();
        let header = json!({
            "kind": "outbound",
            "requestId": request_id,
            "outboundType": "response",
        });
        if let Err(error) = self.write_frame(&sink.writer, &header, &payload).await {
            eprintln!("pa-daemon worker response write failed: {error:#}");
        }
        // A large frame (an attach snapshot, a full-history tree) carried
        // big transient Value trees; the frame is out, so return their
        // freed heap to the OS instead of letting the arenas hold the
        // phase's peak for the process lifetime.
        pa_types::memory_release::trim_freed_heap_if_large(payload.len());
    }

    pub(crate) fn summary_locked(&self, core: &SessionCore) -> SessionSummary {
        // The one summary composer (TS `summaryForActiveSession`): the
        // roster feed, `get_state`, and list rows all serve it, so the
        // live flags (`isRunningTools` from the core's in-flight tool
        // calls, `isBashRunning` from the user bash) never drift between
        // surfaces.
        let mut summary = session_summary(
            core,
            &self
                .engine
                .effective_thinking_level()
                .unwrap_or_else(|| "default".to_string()),
            self.engine.model_metadata(),
            self.engine.model_fallback_message(),
            self.user_bash.is_running(),
        );
        // The worker's roster-delta counter at snapshot time, and the
        // process instance that read it — the pair is one snapshot:
        // the supervisor's pull gate orders the summary against the
        // watermark of the generation that took it, so a delta still
        // in flight when the pull answered (a sequence at or below
        // the counter) is dropped instead of overwriting the pull's
        // fresher state. Both reads run under the caller's core
        // lock, and every push stamps its snapshot after the state
        // change it describes and before its counter increment, so
        // a counter this summary embeds already includes every
        // change the snapshot reflects. The PRE-first-push stamp of
        // zero is a sequenced counter (the supervisor gates it like
        // any other — a delayed pre-push pull never overwrites a
        // newer delta's state); only a summary that carries no
        // counter at all is the unsequenced legacy write.
        summary.roster_delta_sequence = Some(
            self.roster_delta_sequence
                .load(std::sync::atomic::Ordering::SeqCst),
        );
        summary.worker_instance_id = (!self.config.worker_instance_id.is_empty())
            .then(|| self.config.worker_instance_id.clone());
        summary
    }

    pub(crate) fn snapshot_locked(&self, core: &SessionCore) -> SessionActionSnapshot {
        session_snapshot(core)
    }

    /// Push one roster delta from a command arm (the model/thinking
    /// switch seams): the same frame the turn runner's busy flips push,
    /// so a switch reaches the subscribed roster surfaces (the agents
    /// view) without a turn — the TS roster-flush parity for
    /// `thinking_level_changed` and the `set_model`/`cycle_model`
    /// handlers.
    pub(crate) fn push_roster_delta(&self) {
        self.roster_pushes.push();
    }

    fn handle_attach(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("attach") {
            return response;
        }
        // Warm the context-tree cache at every (re)attach (the operators'
        // Esc agents-view round trip re-attaches): the background walk
        // fills the cache while the client rebuilds its view, so the
        // next `/context` finds it ready instead of walking the artifact
        // tree inline.
        self.poke_context_tree_refresh();
        let client_id = payload
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or("anonymous")
            .to_string();
        let capabilities = payload
            .get("capabilities")
            .and_then(Value::as_array)
            .map_or_else(default_client_capabilities, |array| {
                normalize_client_capabilities(
                    &array
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>(),
                )
            });
        let resume_cursor = payload
            .get("resumeCursor")
            .cloned()
            .filter(|value| !value.is_null())
            .and_then(|value| serde_json::from_value::<DaemonResumeCursor>(value).ok());

        let mut core = self.core.lock().unwrap();
        if !core.attached_client_ids.iter().any(|id| id == &client_id) {
            core.attached_client_ids.push(client_id.clone());
        }
        let summary = self.summary_locked(&core);
        let messages: Vec<Value> = core
            .store
            .as_ref()
            .map(super::session_store::SessionFile::messages)
            .unwrap_or_default();
        let state = self.connection_state_locked(&core);
        let last_event_sequence = core.last_event_sequence;
        let generation = core.generation.clone();
        let active_session_id = core.active_session_id.clone();
        drop(core);
        let replay =
            create_daemon_replay_info(resume_cursor.as_ref(), last_event_sequence, &generation);
        let cursor = json!({ "generation": generation, "sequence": last_event_sequence });
        let summary_value = serde_json::to_value(&summary).unwrap_or(Value::Null);
        let state_value = serde_json::to_value(&state).unwrap_or(Value::Null);
        // The messages move into the snapshot once: the old `json!` build
        // deep-copied them here and moved the original into the non-slim
        // top level, holding two message trees per attach.
        let mut snapshot = json!({
            "activeSessionId": active_session_id,
            "summary": summary_value,
            "state": state_value,
            "messages": Value::Null,
            "lastEventSequence": last_event_sequence,
            "lastEventCursor": cursor,
            // RLM child roster; empty for top-level daemon sessions.
            "children": [],
        });
        snapshot["messages"] = Value::Array(messages);
        // Slim clients read summary/messages from the snapshot; duplicating
        // them at the top level would serialize the history twice per attach
        // (port of `createAttachResult`).
        let slim = capabilities.iter().any(|cap| cap == "slim_attach");
        // TS `createAttachResult` key order: protocol, activeSessionId,
        // state?, messages? (non-slim), snapshot, replay,
        // lastEventSequence, lastEventCursor, client. The JSON map
        // preserves insertion order (the wire byte order), so the
        // non-slim keys insert at their TS positions, not appended.
        let mut result = json!({
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "activeSessionId": active_session_id,
        });
        if !slim {
            result["state"] = summary_value;
            // The non-slim top-level duplication (same wire bytes as
            // before): one message tree lives in the snapshot, the
            // duplicate is cloned out of it.
            result["messages"] = snapshot["messages"].clone();
        }
        result["snapshot"] = snapshot;
        result["replay"] = json!(replay);
        result["lastEventSequence"] = json!(last_event_sequence);
        result["lastEventCursor"] = cursor;
        result["client"] = json!({ "id": client_id, "capabilities": capabilities });

        response_success(None, "attach", Some(result))
    }

    fn handle_detach(&self, payload: &Value) -> DaemonResponse {
        let client_id = payload
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or("anonymous")
            .to_string();
        self.side_questions.abort_for_client(&client_id);
        // The detaching client's input-pause leases go with the detach
        // (TS worker `detach` arm releases the client's pauses).
        self.release_input_pauses_for_detach(&client_id);
        let mut core = self.core.lock().unwrap();
        core.attached_client_ids.retain(|id| id != &client_id);
        response_success(None, "detach", None)
    }

    async fn handle_prompt(&self, payload: &Value, wait: bool) -> DaemonResponse {
        if let Err(response) = self.require_created("prompt") {
            return response;
        }
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if message.is_empty() {
            return response_failure(None, "prompt", "Prompt cannot be empty", None);
        }
        let streaming_behavior = payload.get("streamingBehavior").and_then(Value::as_str);
        let custom_message = match parse_custom_message(payload.get("customMessage")) {
            Ok(custom_message) => custom_message,
            Err(error) => return response_failure(None, "prompt", &error, None),
        };
        // The reserved child-status kinds are daemon provenance (the
        // queue-fold anti-spoof): the notice injection rides the
        // follow-up route only, so a prompt row claiming one is always a
        // spoof — answered loudly, never parked.
        if let Some(row) = custom_message.as_ref() {
            if crate::child_status_notices::is_reserved_child_status_custom_type(row) {
                return response_failure(
                    None,
                    "prompt",
                    &crate::child_status_notices::reserved_intake_error(),
                    None,
                );
            }
        }
        let images = parse_prompt_images(payload);
        // TS daemon prompts map `resumeIfIdle` to
        // `command.streamingBehavior !== undefined`: while the queued-input
        // suspension is set (post `abort`/manual `compact`), a plain prompt
        // on an idle session is rejected with the TS admission error and a
        // prompt carrying `streamingBehavior` resumes the suspension
        // (TS `_prompt`'s `_resumeSessionInputAdmission()` +
        // `_assertSessionActionAdmissionAvailable()` pair).
        {
            let mut core = self.core.lock().unwrap();
            if core.queued_input_suspended && !core.busy {
                if streaming_behavior.is_none() {
                    drop(core);
                    return response_failure(
                        None,
                        if wait { "prompt_and_wait" } else { "prompt" },
                        QUEUED_INPUT_SUSPENDED,
                        None,
                    );
                }
                core.queued_input_suspended = false;
            }
        }
        // The prompt-admission bookkeeping (wave b9): a prompt carrying an
        // admission id registers it worker-side; the queued item carries
        // it so the turn runner commits the admission when its turn starts.
        let admission_id = payload
            .get("admissionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        if let Some(admission_id) = &admission_id {
            self.register_prompt_admission(admission_id);
        }
        let (done_tx, done_rx) = oneshot::channel();
        let done = if wait { Some(done_tx) } else { None };
        let (snapshot, queued_behind_work) = {
            let mut core = self.core.lock().unwrap();
            // An idle session runs the prompt immediately: the lane is the
            // work hand-off, not a queue, so the projection did not change
            // (TS prompt admission with queueIfBusy=false never queues).
            let queued_behind_work = core.busy;
            let lane = match streaming_behavior {
                Some("steer") => Lane::Steering,
                // Plain prompts admitted while busy drain when the run goes
                // idle, like `queueIfBusy` prompt admission; an idle
                // session's prompt IS the next run, so it takes the
                // steering lane - otherwise a steering delivery that
                // arrives in the same window would jump the prompt's turn
                // (the runner drains steering first).
                Some(_) | None => {
                    if core.busy {
                        Lane::FollowUp
                    } else {
                        Lane::Steering
                    }
                }
            };
            // This RPC command is human-origin only for a plain user row.
            // Caller-supplied custom rows never gain human priority.
            let item = QueuedItem {
                priority: if custom_message.is_some() {
                    QueuePriority::Background
                } else {
                    QueuePriority::Human
                },
                preview: None,
                message: message.to_string(),
                custom_message,
                agent_message: None,
                queue_key: None,
                admission_id: admission_id.clone(),
                images: images.clone(),
                done,
                queue_visible: queued_behind_work,
                policy: if queued_behind_work {
                    TurnPolicy::Queued
                } else {
                    TurnPolicy::Direct
                },
                forced_batch: false,
            };
            match lane {
                Lane::Steering => enqueue_priority(&mut core.steering, item),
                Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
            }
            let snapshot = self.snapshot_locked(&core);
            (snapshot, queued_behind_work)
        };
        // The admission checkpoint (TS `prompt_accepted`, busy=true): the
        // admitted prompt is undelivered live work until its turn
        // settles, and the lane snapshot rides the same locked read.
        self.checkpoint_queue(QueueCheckpoint::Admitted {
            operation: "prompt_accepted",
        });
        if queued_behind_work {
            let _ = self.emit_action_update(&snapshot);
        }
        self.work_notify.notify_one();
        if !wait {
            return response_success(None, "prompt", None);
        }
        match done_rx.await {
            Ok(settle) => match settle.wire_error() {
                None => response_success(None, "prompt_and_wait", None),
                Some(error) => response_failure(None, "prompt_and_wait", &error, None),
            },
            Err(_) => response_failure(None, "prompt_and_wait", "Prompt did not complete", None),
        }
    }

    fn handle_queue(&self, payload: &Value, lane: Lane) -> DaemonResponse {
        if let Err(response) = self.require_created(lane.as_str()) {
            return response;
        }
        // TS daemon `steer`/`follow_up` pass `resumeIfIdle: true`, and an
        // admitted turn with `wake: "immediate"` resumes the suspension:
        // these commands are resume sites.
        self.resume_queued_input();
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let custom_message = match parse_custom_message(payload.get("customMessage")) {
            Ok(custom_message) => custom_message,
            Err(error) => return response_failure(None, lane.as_str(), &error, None),
        };
        // The reserved child-status kinds are daemon provenance, not
        // client data (the queue-fold anti-spoof): a caller-supplied row
        // claiming one is answered loudly — it never parks, so the strip's
        // typed classification only ever sees daemon-authentic rows. The
        // daemon's own notice injection rides this same command with the
        // one-shot capability it minted in this process
        // (`child_status_notices`), the only thing the admission accepts.
        if let Some(row) = custom_message.as_ref() {
            if crate::child_status_notices::is_reserved_child_status_custom_type(row) {
                let minted = crate::child_status_notices::consume(
                    payload.get("rlmNoticeNonce").and_then(Value::as_str),
                );
                if !minted {
                    return response_failure(
                        None,
                        lane.as_str(),
                        &crate::child_status_notices::reserved_intake_error(),
                        None,
                    );
                }
            }
        }
        let mut core = self.core.lock().unwrap();
        let images = parse_prompt_images(payload);
        let item = QueuedItem {
            priority: if custom_message.is_some() {
                QueuePriority::Background
            } else {
                QueuePriority::Human
            },
            preview: None,
            message: message.to_string(),
            custom_message,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images,
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        };
        match lane {
            Lane::Steering => enqueue_priority(&mut core.steering, item),
            Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
        }
        let snapshot = self.snapshot_locked(&core);
        drop(core);
        // The queue-write checkpoint (busy=true): an undelivered lane is
        // live work. The operation names are TS's journal strings
        // (`steer_queued`/`follow_up_queued`), not this port's command
        // names, so the journals stay comparable record-for-record.
        let queued_operation = match lane {
            Lane::Steering => "steer_queued",
            Lane::FollowUp => "follow_up_queued",
        };
        self.checkpoint_queue(QueueCheckpoint::Admitted {
            operation: queued_operation,
        });
        let _ = self.emit_action_update(&snapshot);
        self.work_notify.notify_one();
        let command = if lane == Lane::Steering {
            "steer"
        } else {
            "follow_up"
        };
        response_success(None, command, Some(json!({ "queued": true })))
    }

    /// Agent-to-agent message delivery, routed by the supervisor's
    /// `send_message` arm: render the `[agent-message from ...]` prompt and
    /// queue it on the requested lane, carrying the `agent_message`
    /// custom row on the queued item (TS `acceptAgentSessionMessage` ->
    /// `acceptAgentMessagePrompt` with `customMessage`): the turn renders
    /// the collapsed agent-message card while the model still runs on the
    /// rendered prompt. Answers with the delivery receipt
    /// (`createAgentSessionMessageReceipt` shape): `queued` when a turn is
    /// running (`queueIfBusy` semantics), `delivered` when the prompt
    /// becomes the next run.
    fn handle_worker_deliver_message(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("worker_deliver_message") {
            return response;
        }
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Err(error) =
            pa_core::session_engine::agent_messaging::normalize_agent_session_message(message)
        {
            return response_failure(None, "worker_deliver_message", &error.to_string(), None);
        }
        // The paused gate (TS `sendAgentSessionMessage` refuses with the
        // same error while `agent_messages_pause` holds the flag).
        if let Err(response) = self.refuse_delivery_if_paused() {
            return response;
        }
        // TS `acceptAgentMessagePrompt` runs with `resumeIfIdle: false`: on
        // a suspended idle session the delivery is rejected with the same
        // admission error as a plain prompt, and only the busy carve-out
        // (`_isBusyForSessionInput`) queues it parked.
        {
            let core = self.core.lock().unwrap();
            if core.queued_input_suspended && !core.busy && !core.compacting {
                drop(core);
                return response_failure(
                    None,
                    "worker_deliver_message",
                    QUEUED_INPUT_SUSPENDED,
                    None,
                );
            }
        }
        let sender = payload.get("sender").cloned().unwrap_or(Value::Null);
        // A delivery from one of this session's RLM children counts as the
        // child's reply: the settle watcher withholds the no-reply notice.
        if let Some(child) = sender
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            self.engine.mark_child_reply(child);
        }
        // Sender label precedence (TS `createAgentSessionMessagePrompt`):
        // session name, session id, active session id, client id.
        let sender_name = ["sessionName", "sessionId", "activeSessionId", "clientId"]
            .iter()
            .find_map(|key| sender.get(*key).and_then(Value::as_str))
            .unwrap_or("unknown")
            .to_string();
        // The delivery's relationship label derives from the sender's
        // durable parent edge, never from the sender's runtime kind alone:
        // a subagent spawned by a DIFFERENT parent is not this session's
        // child, and its messages must not render as one. The core lock is
        // scoped to the read (a std MutexGuard never rides an await).
        let from_relationship = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            sender_is_child_of(&sender, &core).then_some(AgentFamilyRelationship::Child)
        };
        let prompt = pa_core::session_engine::agent_messaging::create_agent_session_message_prompt(
            &AgentMessagePromptPayload {
                message: message.to_string(),
                sender_name,
                from_relationship,
            },
        );
        let lane = if payload.get("deliveryMode").and_then(Value::as_str) == Some("follow_up") {
            Lane::FollowUp
        } else {
            Lane::Steering
        };
        let (id, queued, snapshot, target) = {
            let mut core = self.core.lock().unwrap();
            let pending = core.steering.len() + core.follow_up.len();
            if let Err(error) =
                pa_core::session_engine::agent_messaging::assert_agent_message_queue_capacity(
                    pending,
                    DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
                )
            {
                drop(core);
                return response_failure(None, "worker_deliver_message", &error.to_string(), None);
            }
            let id = pa_core::session_engine::agent_messaging::create_agent_session_message_id();
            let queued = core.busy;
            let summary = self.summary_locked(&core);
            // The receiving session's endpoint (TS
            // `createAgentSessionMessageEndpoint`): the receipt's `target`
            // and the delivered row's `details.target` share the one shape.
            let mut target = json!({
                "activeSessionId": summary.active_session_id.clone().unwrap_or_default(),
                "sessionId": summary.session_id,
                "runtimeKind": summary
                    .runtime_kind
                    .clone()
                    .unwrap_or_else(|| "top-level".to_string()),
            });
            if let Some(name) = summary.session_name.filter(|name| !name.is_empty()) {
                target["sessionName"] = json!(name);
            }
            // The receiving side's custom row (TS
            // `acceptAgentSessionMessage` -> `createAgentSessionMessage`,
            // riding `acceptAgentMessagePrompt`'s `customMessage`): the
            // queued turn carries the `agent_message` row so the
            // transcript renders the collapsed card instead of a plain
            // user row, while the row's `content` IS the rendered prompt -
            // the model context stays byte-identical to the
            // plain-prompt delivery.
            let custom_message =
                pa_core::session_engine::agent_messaging::create_agent_session_message_row(
                    &pa_core::session_engine::agent_messaging::AgentSessionMessageRowPayload {
                        id: &id,
                        prompt: &prompt,
                        message,
                        from: &sender,
                        from_relationship,
                        target: &target,
                        timestamp: crate::util::now_ms(),
                    },
                );
            let item = QueuedItem {
                priority: QueuePriority::Background,
                // The labeled queue-strip row (TS `queuedAgentMessagePreview`:
                // an agent-session-message custom row previews as
                // "Agent message received: <details.message>").
                preview: Some(format!(
                    "{}: {message}",
                    pa_core::session_engine::agent_messaging::AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL
                )),
                message: prompt,
                custom_message: Some(custom_message),
                // The agent-message marker: `agent_messages_clear` /
                // `agent_messages_pause` remove exactly these items.
                agent_message: Some(message.to_string()),
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
                forced_batch: false,
            };
            match lane {
                Lane::Steering => enqueue_priority(&mut core.steering, item),
                Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
            }
            let snapshot = self.snapshot_locked(&core);
            (id, queued, snapshot, target)
        };
        // The delivery checkpoint (busy=true): the queued agent message is
        // admitted live work — a restart must revive the worker to
        // deliver it (agent-to-agent messages have no client that
        // reopens the session). The operation names are TS's steer/follow-up
        // queue strings, matching the receipt's deliveryMode.
        self.checkpoint_queue(QueueCheckpoint::Admitted {
            operation: match lane {
                Lane::Steering => "steer_queued",
                Lane::FollowUp => "follow_up_queued",
            },
        });
        let _ = self.emit_action_update(&snapshot);
        self.work_notify.notify_one();
        let timestamp = crate::util::now_iso();
        let mut receipt = json!({
            "id": id,
            "source": AGENT_MESSAGE_SOURCE,
            "target": target,
            "message": message,
            // TS receipts always report `steer`; the follow-up lane is the
            // Rust extension for queue-behind-current-work delivery.
            "deliveryMode": if lane == Lane::FollowUp { "follow_up" } else { "steer" },
        });
        if queued {
            receipt["deliveryStatus"] = json!("queued");
            receipt["queuedAt"] = json!(timestamp);
        } else {
            receipt["deliveryStatus"] = json!("delivered");
            receipt["deliveredAt"] = json!(timestamp);
        }
        if !sender.is_null() {
            receipt["from"] = json!(sender);
        }
        response_success(None, "worker_deliver_message", Some(receipt))
    }

    /// `update_snapshot` (supervisor plane, update flow spec §8): a
    /// read-only capture of this session for the update roster. The worker
    /// persists its queue lanes to the recovery journal BEFORE replying, so
    /// the reported queue and the durable respawn state agree; the snapshot
    /// itself freezes nothing — a busy session keeps running (the supervisor
    /// gate already fences new mutations, and the graceful-stop budget owns
    /// the exit).
    ///
    /// In-flight granularity: the Rust engine exposes `busy` (a turn in
    /// flight) and `compacting` only; provider streaming, tool/bash work,
    /// and retries all live inside a busy turn and are reported through it
    /// (the roster's `bash_running`/`retrying`/`prompt_in_flight` flags are
    /// false on this build for that reason — restore treats `busy` as the
    /// continuation signal).
    fn handle_update_snapshot(&self) -> DaemonResponse {
        let (core_data, lanes) = {
            let core = self.core.lock().unwrap();
            let store = core.store.as_ref();
            let data = json!({
                "activeSessionId": core.active_session_id,
                "sessionId": store.map(super::session_store::SessionFile::session_id).unwrap_or_default(),
                "sessionFile": core
                    .store
                    .as_ref()
                    .map(|s| s.path.to_string_lossy().to_string()),
                "cwd": core.cwd,
                "generation": core.generation,
                "runtimeMetadata": {
                    "kind": core.runtime_kind,
                    "rlmChildId": core.rlm_child_id,
                    "parentSessionId": core.parent_session_id,
                    "rlmDepth": core.rlm_depth,
                },
                "queue": {
                    "actions": serde_json::to_value(session_snapshot(&core)).ok(),
                    "steering": core.steering.iter().map(|item| item.message.clone()).collect::<Vec<_>>(),
                    "followUps": core.follow_up.iter().map(|item| item.message.clone()).collect::<Vec<_>>(),
                },
                "busy": core.busy,
                "compacting": core.compacting,
            });
            (data, queue_lanes(&core))
        };
        // Journal the lanes after releasing the core lock (record paths take
        // the locks in the opposite order).
        self.persist_queue_snapshot(
            core_data["activeSessionId"].as_str().unwrap_or_default(),
            &lanes,
        );
        response_success(None, "update_snapshot", Some(core_data))
    }

    /// Graceful stop: the connection loop exits the process after replying.
    /// The session's telemetry finalizes first (TS dispose callback:
    /// `agent session ended` + one flush), bounded by the sink timeouts.
    async fn handle_shutdown(&self) -> DaemonResponse {
        // TS `shutdown` -> `closeSession(state, "shutdown")`: the session is
        // closing, so the continuation mint sites and their settle-hook
        // retries bail (a stopped session never continues) — but unlike a
        // kill the close KEEPS the resume entry: no job cancel, no
        // `archived` state, the scheduled jobs survive for the later wake
        // (TS `closeKeepsResumeEntry("shutdown")`).
        if let Some(agent_engine) = &self.agent_engine {
            agent_engine.mark_session_closed();
        }
        // TS `shutdown` -> `closeSession` aborts the session's side questions
        // per attached client before anything else closes, and each run's
        // `done` chain writes its cancelled event while the client sockets
        // are still open. Without this the restarted daemon never emits a
        // terminal side_question_event, and the reattached client's pane
        // wedges on a running turn no event will ever settle.
        self.side_questions
            .abort_all_and_settle(SIDE_QUESTION_SETTLE_TIMEOUT)
            .await;
        {
            let mut core = self.core.lock().unwrap();
            core.shutdown_requested = true;
            core.abort_requested = true;
        }
        // TS `shutdown` closes through `session.abort()` -> `requestAbort()`:
        // the in-flight turn's fetch cancels now, not at its next event.
        self.engine.abort_in_flight_turn();
        self.work_notify.notify_one();
        // TS `shutdown` closes every session through `closeSession` ->
        // `session.abort()` (which awaits the in-flight turn and compaction)
        // before the runtime dispose. The settle + kernel teardown must
        // happen before the process exit this reply unlocks: `std::process`
        // exit runs no destructors, so an undisposed kernel would be
        // orphaned here (the #235 daemon-worker leak class).
        self.compaction.abort();
        self.tree_navigation.abort();
        self.await_session_work_settled().await;
        // The runtime dispose at shutdown runs the hosted-subagent
        // disposal with it (TS `closeSessionOnce("shutdown")` ->
        // `runtime.dispose` -> `disposeHostedSubagentRuntimes`): the
        // children close before the process exits, so the close's kills
        // never race the exit. Best-effort: an unreachable child must not
        // block the worker's own exit. The children close with the
        // `shutdown` reason too: their resume entries and scheduled jobs
        // survive (a daemon shutdown preserves the wake model).
        if let Err(error) = self
            .close_rlm_children(crate::rlm_children::ChildCloseReason::Shutdown)
            .await
        {
            eprintln!("pa-daemon: RLM child close at shutdown failed: {error:#}");
        }
        if let Some(agent_engine) = &self.agent_engine {
            agent_engine.dispose_kernel().await;
        }
        self.engine.end_telemetry().await;
        let lease = self
            .core
            .lock()
            .unwrap()
            .store
            .as_mut()
            .and_then(|store| store.lease.take());
        drop(lease);
        response_success(None, "shutdown", None)
    }

    /// The durable tail of a successful close: the resume entry, the
    /// worker's own socket cleanup, and the process exit. The routed
    /// `shutdown` arm and the registration-retirement path share it
    /// (`std::process::exit` runs no destructors, so the caller must
    /// have settled the close first).
    fn exit_after_close(&self) -> ! {
        // Shutdown keeps the resume entry and exits the process, like the
        // TS close path (`closeKeepsResumeEntry("shutdown")`).
        let _ = self.record_recovery(false, "shutdown");
        // A graceful exit owns its socket file: remove it now so a respawn
        // does not wait out the stale-socket path (a killed worker cannot
        // clean up, but its killer relaunches through
        // `prepare_socket_path`).
        crate::socket::cleanup_socket_path(
            &self.config.socket_path,
            crate::socket::socket_identity(&self.config.socket_path),
        );
        std::process::exit(0)
    }

    /// The refused-registration self-heal: the supervisor definitively
    /// rejected this worker's identity (the unknown-worker verdict — no
    /// descriptor exists for it), so no daemon will ever adopt or route to
    /// this process again. The worker retires with the same graceful
    /// close a routed `shutdown` runs — abort and settle the session,
    /// dispose the kernel, keep the resume entry — releasing the runtime
    /// session lease its session file needs back: a retired worker that
    /// kept running would hold the lease against every future resume
    /// while staying invisible to every roster, the leftover-holder
    /// [`crate::boot_reap`] documents and clears on `/proc` platforms.
    pub(crate) async fn exit_refused_registration(&self) {
        eprintln!(
            "pa-daemon worker {}: registration refused (the supervisor no longer owns this identity); retiring",
            std::process::id()
        );
        let _ = self.handle_shutdown().await;
        self.exit_after_close();
    }

    /// Wait until no turn or compaction run is in flight (the awaited
    /// `session.abort()` half of the TS close path). The caller requests
    /// the aborts first — `abort_requested` stops an in-flight turn's event
    /// consumption, `CompactionManager::abort` settles the run — then this
    /// parks on the idle notify until the runner parks; the kernel dispose
    /// must never race a live run that holds kernel execution state.
    async fn await_session_work_settled(&self) {
        loop {
            // Register the permit before the flag check: a run that settles
            // between the check and the await still wakes this waiter
            // (`notify_waiters` only reaches already-registered futures).
            let notified = self.idle_notify.notified();
            {
                let core = self.core.lock().unwrap();
                if !core.busy && !core.compacting {
                    return;
                }
            }
            notified.await;
        }
    }

    /// The TS replacement teardown (`teardownForReplacement`): the
    /// whole-runtime replacement flows (`new_session` /
    /// `switch_session` / `import_jsonl` / `fork`) retire the live
    /// session before swapping onto the replacement file. The settle
    /// cancels the queued session actions first (TS dispose rejects every
    /// queued action, and the turn runner clears the abort flag when it
    /// pops an item, so the cancel must land before the park), aborts the
    /// compaction and branch-summary runs, and parks until the turn and
    /// compaction settle; then the engine retires the runtime - the
    /// kernel disposes (its final namespace snapshot flushes before the
    /// process exits) and the built session drops, so the replacement
    /// rebuilds a fresh session against the moved file exactly like the
    /// TS fresh runtime. The teardown then closes the session's RLM
    /// children (TS `teardownCurrent` ->
    /// `disposeHostedSubagentRuntimes`): a parent that replaces its
    /// runtime disposes its children, and the replacement session's
    /// roster starts empty. The tree moves (`navigate_tree`) never run
    /// this: TS rebuilds the branch context in place and the kernel
    /// stays warm.
    pub(crate) async fn teardown_for_replacement(&self) -> anyhow::Result<()> {
        // The retired session is closing: mark it before the children close,
        // exactly like the kill/shutdown closes — each child's settle retry
        // fires while the old runtime is still installed, and the marker
        // keeps those retries from minting continuations into the retiring
        // session (a replaced session never continues either).
        if let Some(agent_engine) = &self.agent_engine {
            agent_engine.mark_session_closed();
        }
        {
            let mut core = self.core.lock().unwrap();
            core.steering.clear();
            core.follow_up.clear();
        }
        self.compaction.abort();
        self.tree_navigation.abort();
        self.await_replacement_settled().await;
        self.engine.teardown_for_replacement().await;
        // TS `teardownCurrent` ends with `disposeHostedSubagentRuntimes`:
        // the session's runtime is disposed first (the kernel retire
        // above), then the hosted RLM subagent runtimes close with it -
        // the daemon host's `disposeRlmSubagentRuntimes` runs
        // `closeChildSessions(parentState, "replaced")`. A close failure
        // rethrows out of the teardown exactly like TS (the replacement
        // fails with the old runtime already retired).
        self.close_rlm_children(crate::rlm_children::ChildCloseReason::Replaced)
            .await
    }

    /// Close this session's supervisor-backed RLM children (TS
    /// `closeChildSessions(parentState, reason)` through
    /// `disposeHostedSubagentRuntimes`). Runs at every runtime teardown
    /// that ends the session - the replacement retire, `kill`, and the
    /// worker `shutdown` - because the TS daemon closes resident children
    /// on every session close and at the replacement teardown, cascading
    /// to grandchildren through each child worker's own close with the
    /// same close reason.
    async fn close_rlm_children(
        &self,
        reason: crate::rlm_children::ChildCloseReason,
    ) -> anyhow::Result<()> {
        let children = self
            .agent_engine
            .as_ref()
            .and_then(|engine| engine.children.clone());
        match children {
            Some(children) => children.close_children(reason).await,
            None => Ok(()),
        }
    }

    /// Wait until the replacement teardown can retire the runtime: no
    /// turn and no compaction in flight. Like the navigation settle, the
    /// park rides a timeout backstop - the turn runner notifies the idle
    /// notify when a run settles, but a compaction settle does not, so a
    /// missed wake must not hang the replacement.
    async fn await_replacement_settled(&self) {
        loop {
            let busy = {
                let mut core = self.core.lock().unwrap();
                let busy = core.busy || core.compacting;
                if busy {
                    core.abort_requested = true;
                }
                busy
            };
            if !busy {
                return;
            }
            // The parked flag gates the turn's events; the engine abort
            // cancels the in-flight fetch (TS `requestAbort` -> `agent.abort()`)
            // so the settle does not wait out a pending provider response.
            self.engine.abort_in_flight_turn();
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(50),
                self.idle_notify.notified(),
            )
            .await;
        }
    }

    /// The replacement rebuild (TS `buildAndApplyReplacement` ->
    /// `createRuntime`, which prewarms the new session's kernel): the
    /// fresh session builds in the background like the create-time build,
    /// so the replacement session's kernel prewarm fires at the
    /// replacement, not at the first turn. The build gate deduplicates it
    /// against any racing demand seam, and a build failure surfaces on
    /// the first demand seam. Scripted harness engines have no session
    /// to build.
    pub(crate) fn prewarm_replacement_session(&self) {
        if let Some(agent_engine) = &self.agent_engine {
            let engine = std::sync::Arc::clone(agent_engine);
            tokio::spawn(async move {
                let Ok(model) = engine.resolve_model() else {
                    return;
                };
                let _ = engine.ensure_core_session_async(&model).await;
            });
        }
    }

    /// Rebind the worker onto the replacement session's cwd (TS
    /// `createRuntime({ cwd: sessionManager.getCwd() })` in
    /// `switchSession` / `importFromJsonl`): the core's cwd (the wire
    /// summary, the settings reads, the user-bash guard, the schedule
    /// catalog's binding) and the engine's cwd slot (the rebuilt session's
    /// kernel-resident tools, its settings and MCP discovery) move onto
    /// the target session's recorded working directory. The teardown has
    /// already retired the live session, so nothing old observes the move;
    /// the rebuild that follows builds cold in the new cwd.
    pub(crate) fn rebind_worker_cwd(&self, cwd: &str) {
        {
            let mut core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            core.cwd = cwd.to_string();
        }
        self.engine.set_cwd(std::path::PathBuf::from(cwd));
    }

    /// Refresh the replacement session's derived state (TS
    /// `refreshReplacedSessionState` on the `sessionReplaced` event): the
    /// moved-to session's depth re-seeds the worker core and the engine's
    /// RLM identity (a resumed subagent keeps its persisted depth). The schedule
    /// catalog rebind runs separately (`bind_scheduled_jobs`), like the
    /// TS dispatch handlers that call `rebindCronJobsToState` after the
    /// runtime call.
    pub(crate) fn refresh_replaced_session_state(&self) {
        let (rlm_depth, summary, child_script) = {
            let mut core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // The moved-to file's persisted depth wins (TS
            // `config.rlmDepth ?? header.rlmDepth`; the replacement carries
            // no create-config depth).
            let rlm_depth = core
                .store
                .as_ref()
                .and_then(SessionFile::rlm_depth)
                .unwrap_or(0);
            core.rlm_depth = rlm_depth;
            let child_script = core.child_script.clone();
            (rlm_depth, self.summary_locked(&core), child_script)
        };
        // No thinking flag rides the rebind (the create command's level is
        // already resolved on the engine), and the TS replacement runtime
        // carries no inherited max-depth: the moved-to session's persisted
        // chat override, the global setting, the env, or the default
        // resolve it (`_resolveRlmMaxDepth` precedence). The harness's
        // child engine file rides along: TS children inherit the
        // replacement runtime's `sessionConfig`, which the runtime keeps
        // across its swaps.
        if let Err(error) = self
            .engine
            .configure_rlm_identity(crate::engine::RlmSessionIdentity {
                rlm_depth,
                rlm_max_depth: None,
                cwd: Some(summary.cwd.clone()),
                session_id: Some(summary.session_id.clone()),
                session_file: summary.session_file.clone(),
                thinking: None,
                child_script,
            })
        {
            eprintln!("pa-daemon: replacement identity rebind failed: {error:#}");
        }
        if let Ok(summary_value) = serde_json::to_value(&summary) {
            self.engine.set_session_summary(summary_value);
        }
    }

    /// Bind the live session's schedule catalog (TS `rebindCronJobsToState`):
    /// register the session's artifact partition, rebind the stored jobs onto
    /// the live ids, and start (or wake) the scheduler. Runs at create and
    /// after every replacement swap (`new_session` / `switch_session` /
    /// `import_jsonl` / fork) - the jobs follow the live session onto the
    /// moved-to file, exactly like the TS rebind on the runtime swap.
    pub(crate) async fn bind_scheduled_jobs(&self) {
        let binding = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            crate::scheduled_jobs::live_binding(&core)
        };
        if let Some((binding, artifact_dir)) = binding {
            self.scheduled.bind_session(binding, artifact_dir).await;
        }
    }

    /// Clear the queued-input suspension (TS `_resumeSessionInputAdmission`,
    /// reached through `resumeQueuedWork()` and the resume sites) and wake
    /// the turn runner so parked lanes drain. Every resume site also runs
    /// the goal arm of TS `resumeQueuedWork()`: a continuation owed behind
    /// the suspension or descendant work re-evaluates here.
    pub(crate) fn resume_queued_input(&self) {
        {
            let mut core = self.core.lock().unwrap();
            if core.queued_input_suspended {
                core.queued_input_suspended = false;
            }
        }
        self.work_notify.notify_one();
        if let Some(engine) = self.agent_engine.as_ref() {
            engine.retry_owed_goal_continuation();
        }
    }

    /// `compact` (TS handler): run one compaction and answer with the TS
    /// `CompactionResult` wire shape; skips, aborts, and failures answer
    /// with the session's error message exactly like the TS daemon catch.
    async fn handle_compaction(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("compact") {
            return response;
        }
        let custom_instructions = payload
            .get("customInstructions")
            .and_then(Value::as_str)
            .map(str::to_string);
        {
            // TS `compact()` aborts first (`await this.abort()` ->
            // `requestAbort()`), which suspends queued-input admission:
            // the suspension outlives skip/failure/abort outcomes and is
            // cleared below only for the TS `didCompact` + active-goal
            // branch.
            let mut core = self.core.lock().unwrap();
            core.queued_input_suspended = true;
        }
        let outcome = self
            .compaction
            .run(custom_instructions, &self.idle_notify)
            .await;
        // The TS `compact()` `didCompact` + active-goal branch
        // (agent-session.ts): with `this._goalState.status === "active"`
        // and the run not aborted,
        //   this._goalContinuationAwaitsRlmWork ||= !this.agent.hasQueuedMessages();
        //   this.resumeQueuedWork();
        //   if (this.agent.hasQueuedMessages()) this._schedulePostCompactionContinue();
        // `resumeQueuedWork()` delivers the owed goal continuation (a
        // queued follow-up) and clears the queued-input suspension; the
        // scheduled continue then drives the queued turn once idle. The
        // worker mirror: mint the continuation only when no queued work
        // parked (`agent.hasQueuedMessages()` spans both lanes — TS's
        // `||=` sets the owed flag exactly there), queue it behind the
        // still-set suspension, and let the resume site below clear the
        // #234 gate and wake the turn runner — the runner IS the
        // scheduled continue, and the queued continuation crosses the
        // suspension gate only through this resume site.
        let mut goal_continue_scheduled = false;
        if let crate::engine::CompactionOutcome::Compacted { .. } = &outcome {
            let goal_active = self
                .engine
                .goal_state_value()
                .get("status")
                .and_then(Value::as_str)
                == Some("active");
            if goal_active {
                let has_queued = {
                    let core = self.core.lock().unwrap();
                    !core.steering.is_empty() || !core.follow_up.is_empty()
                };
                if !has_queued {
                    // The engine call takes the engine session lock and
                    // blocks on the engine runtime, so it runs on a
                    // blocking thread like every other engine call; a
                    // join failure leaves the continuation un-minted
                    // (logged, never silent) — the session still resumes.
                    let engine = std::sync::Arc::clone(&self.engine);
                    let continuation = tokio::task::spawn_blocking(move || {
                        engine.mint_post_compaction_goal_continuation()
                    })
                    .await
                    .unwrap_or_else(|error| {
                        eprintln!(
                            "pa-daemon: post-compaction goal continuation mint failed: {error}"
                        );
                        None
                    });
                    if let Some(continuation) = continuation {
                        // The mint's `goal_update` surfaces at the moment
                        // the state changes (TS `_setGoalState` ->
                        // `_emitGoalUpdate`), before the continuation turn
                        // is admitted — and the state change is durable
                        // before the announcement (TS `_persistGoalState`
                        // appends + flushes the `thread_goal_state` custom
                        // entry; the mint runs outside a turn, so the
                        // store write rides here, not the turn's emit
                        // closure).
                        if let Some(goal) = continuation.goal_update {
                            {
                                let mut core = self.core.lock().unwrap();
                                if let Some(store) = core.store.as_mut() {
                                    let _ = store.persist_entry(
                                        "custom",
                                        json!({
                                            "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
                                            "data": goal,
                                        }),
                                    );
                                }
                            }
                            self.emit_worker_event(json!({
                                "type": "goal_update",
                                "goal": goal,
                            }));
                        }
                        {
                            let mut core = self.core.lock().unwrap();
                            core.follow_up.push_back(QueuedItem {
                                priority: QueuePriority::Background,
                                preview: None,
                                message: continuation.request.message,
                                custom_message: continuation.request.custom_message,
                                agent_message: None,
                                queue_key: None,
                                admission_id: None,
                                images: continuation.request.images,
                                done: None,
                                queue_visible: false,
                                policy: TurnPolicy::Injected,
                                forced_batch: false,
                            });
                        }
                        // The admission checkpoint (busy=true): the
                        // post-compaction continuation is admitted while
                        // the session is idle, so without this record a
                        // kill before the turn's settle would park it on
                        // a plain boot (the runner records nothing at
                        // pickup).
                        self.checkpoint_queue(QueueCheckpoint::Admitted {
                            operation: "follow_up_queued",
                        });
                    }
                }
                // The resume site: clears the suspension and wakes the
                // runner, which drains the queued continuation (or the
                // already-parked queued work) as the post-compaction
                // continue's turn.
                self.resume_queued_input();
                goal_continue_scheduled = true;
            }
        }
        match outcome {
            crate::engine::CompactionOutcome::Compacted { run } => {
                let run = *run;
                // TS `compact()` schedules the compact-trigger auto-refine
                // review after every successful compaction and the
                // background round runs while the session is idle: the
                // command consumed it here (the busy gates keep it armed
                // for the next turn boundary when work is queued), and
                // the outcome surfaces through the same rows the
                // `refine` command emits.
                // The goal-continue branch defers like TS
                // `_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction
                // = true)` -> `_compactAutoRefinePending = true`: a
                // continuation (or parked queued work) is about to run,
                // so the review services at that turn's quiescent boundary
                // instead of interleaving before it — skip the immediate
                // consume and leave the trigger armed.
                let engine = std::sync::Arc::clone(&self.engine);
                let refined = if goal_continue_scheduled {
                    Ok(None)
                } else {
                    // The engine round runs on a blocking thread like
                    // every other engine call (it takes the engine session
                    // lock and blocks on the engine runtime).
                    tokio::task::spawn_blocking(move || engine.consume_compact_auto_refine())
                        .await
                        .unwrap_or_else(|error| {
                            Err(anyhow::anyhow!("auto-refinement task failed: {error}"))
                        })
                };
                match refined {
                    Ok(Some(result)) => {
                        let outcome_row =
                            pa_core::session_engine::refine::create_refinement_outcome_message(
                                &result,
                            );
                        if let Ok(value) = serde_json::to_value(
                            pa_types::session::AgentMessage::Custom(outcome_row),
                        ) {
                            self.emit_custom_row(value);
                        }
                        if result.applied_edits.iter().any(|edit| edit.applied) {
                            let notice =
                                pa_core::session_engine::refine::create_refinement_notice_message(
                                    &result,
                                    pa_core::session_engine::refine::RefinementSource::Auto,
                                );
                            if let Ok(value) = serde_json::to_value(
                                pa_types::session::AgentMessage::Custom(notice),
                            ) {
                                self.emit_custom_row(value);
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("pa-daemon: auto-refinement after compaction failed: {error:#}");
                    }
                }
                response_success(None, "compact", Some(run.result))
            }
            crate::engine::CompactionOutcome::Skipped { message } => {
                response_failure(None, "compact", &message, None)
            }
            crate::engine::CompactionOutcome::Aborted => {
                response_failure(None, "compact", "Compaction cancelled", None)
            }
            crate::engine::CompactionOutcome::Failed { error } => {
                response_failure(None, "compact", &error, None)
            }
        }
    }

    async fn handle_wait_for_idle(&self) -> DaemonResponse {
        loop {
            {
                let core = self.core.lock().unwrap();
                if !core.busy && core.steering.is_empty() && core.follow_up.is_empty() {
                    return response_success(None, "wait_for_idle", None);
                }
            }
            self.idle_notify.notified().await;
        }
    }

    /// `wait_for_headless_completion` (TS daemon command): settle the
    /// headless run first (same idle wait as `wait_for_idle`), then answer
    /// the autonomous-run accounting snapshot (`DaemonAutonomousStatus`).
    async fn handle_wait_for_headless_completion(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("wait_for_headless_completion") {
            return response;
        }
        loop {
            {
                let core = self.core.lock().unwrap();
                if !core.busy && core.steering.is_empty() && core.follow_up.is_empty() {
                    break;
                }
            }
            self.idle_notify.notified().await;
        }
        // The idle wait finished, so no turn holds the accounting state;
        // the snapshot read cannot interleave with a running turn.
        let status = self
            .engine
            .autonomous_status()
            .await
            .unwrap_or_else(pa_core::autonomous::disabled_autonomous_status);
        response_success(
            None,
            "wait_for_headless_completion",
            Some(serde_json::to_value(&status).unwrap_or(Value::Null)),
        )
    }

    pub(crate) fn connection_state_locked(&self, core: &SessionCore) -> AgentConnectionState {
        let store = core.store.as_ref();
        let model = self.engine.model_metadata();
        let model_fast_mode = model
            .as_ref()
            .and_then(|model| model.get("id"))
            .and_then(Value::as_str)
            .is_some_and(supports_fast_mode);
        AgentConnectionState {
            is_streaming: core.busy,
            is_compacting: core.compacting,
            active_session_id: Some(core.active_session_id.clone()),
            cwd: core.cwd.clone(),
            model,
            thinking_level: self
                .engine
                .effective_thinking_level()
                .unwrap_or_else(|| "default".to_string()),
            // The effective tier: the preference clamped to the model's
            // fast-mode support (`priority` degrades to `default`).
            service_tier: crate::setting_switches::service_tier_wire_name(
                effective_service_tier(core.service_tier, model_fast_mode)
                    .unwrap_or(pa_types::ai::ServiceTier::Auto),
            )
            .to_string(),
            // The resolved model's supported levels (TS `getSupportedThinkingLevels`
            // in `getState`): a non-reasoning model reports ["off"], which the
            // client treats as no thinking surface.
            available_thinking_levels: self
                .engine
                .supported_thinking_levels()
                .unwrap_or_else(|| vec!["off".to_string()]),
            is_bash_running: self.user_bash.is_running(),
            retry_attempt: 0,
            steering_mode: core.steering_mode.clone(),
            follow_up_mode: core.follow_up_mode.clone(),
            session_file: store.map(|s| s.path.to_string_lossy().to_string()),
            session_id: store
                .map(|s| s.session_id().to_string())
                .unwrap_or_default(),
            session_name: store.and_then(|s| s.session_name().map(str::to_string)),
            session_dir: store
                .and_then(|s| s.path.parent())
                .map(|p| p.to_string_lossy().to_string()),
            leaf_id: store.and_then(|s| s.leaf_id().map(str::to_string)),
            auto_compaction_enabled: core.auto_compaction_enabled,
            message_count: store.map_or(0, super::session_store::SessionFile::message_count) as u32,
            session_actions: session_snapshot(core),
            compaction_count: store.map_or(0, |store| store.compaction_count() as u32),
            goal: self.engine.goal_state_value(),
            scoped_models: core.scoped_models.clone(),
            active_tool_names: Vec::new(),
            context_usage: None,
        }
    }

    /// Persist the queue lanes to the worker recovery journal (crash-safe
    /// queue recovery; TS keeps session files free of daemon bookkeeping).
    /// Call after releasing the core lock: `record_recovery` takes the locks
    /// in the opposite order.
    pub(crate) fn persist_queue_snapshot(&self, active_session_id: &str, lanes: &QueueLanes) {
        let mut guard = self.recovery.lock().unwrap();
        let Some(journal) = guard.as_mut() else {
            return;
        };
        let _ = journal.record_queue_snapshot(active_session_id, &lanes.steering, &lanes.follow_up);
    }

    /// One queue-lane recovery checkpoint through the worker's own
    /// journal: the lane snapshot and the busy verdict ride one locked
    /// read (`checkpoint_queue_recovery`).
    pub(crate) fn checkpoint_queue(&self, checkpoint: QueueCheckpoint) {
        checkpoint_queue_recovery(&self.recovery, &self.core, checkpoint);
    }

    pub(crate) fn record_recovery(&self, busy: bool, operation: &str) -> Result<()> {
        let mut guard = self.recovery.lock().unwrap();
        let Some(journal) = guard.as_mut() else {
            return Ok(());
        };
        let core = self.core.lock().unwrap();
        let store = core.store.as_ref();
        journal.record(
            &core.active_session_id,
            store.map_or("", super::session_store::SessionFile::session_id),
            store
                .map(|s| s.path.to_string_lossy().to_string())
                .as_deref(),
            busy,
            operation,
        )
    }

    /// Sequence and broadcast one `session_event` frame at the worker
    /// level (the TS `_emit` backing for switch notifications).
    pub(crate) fn emit_worker_event(&self, event: Value) {
        emit_worker_event_with(&self.core, &self.events, event);
    }

    /// Record one durable custom row and broadcast its
    /// `message_start`/`message_end` pair (the TS `_emit` for rows the
    /// session appends outside a turn: `append_custom_message`, the
    /// `refine` outcome and notice, restored prefix rows).
    pub(crate) fn emit_custom_row(&self, message: Value) {
        {
            let mut core = self.core.lock().unwrap();
            if let Some(store) = core.store.as_mut() {
                let _ = store.persist_entry(
                    "custom_message",
                    json!({
                        "customType": message.get("customType").cloned().unwrap_or(Value::Null),
                        "content": message.get("content").cloned().unwrap_or(Value::Null),
                        "display": message.get("display").cloned().unwrap_or(Value::Bool(true)),
                        "details": message.get("details").cloned().unwrap_or(Value::Null),
                    }),
                );
            }
        }
        self.emit_worker_event(json!({ "type": "message_start", "message": message }));
        self.emit_worker_event(json!({ "type": "message_end", "message": message }));
    }

    /// Sequence and broadcast one `session_event` for the queue projection.
    pub(crate) fn emit_action_update(&self, snapshot: &SessionActionSnapshot) -> Result<()> {
        let mut core = self.core.lock().unwrap();
        // TS `_emitQueueUpdate`: an unchanged projection stays silent (an
        // empty queue before and after a turn is not an update).
        if core.last_action_snapshot.as_ref() == Some(snapshot) {
            return Ok(());
        }
        core.last_action_snapshot = Some(snapshot.clone());
        let sequence = core.last_event_sequence + 1;
        core.last_event_sequence = sequence;
        let meta = create_daemon_event_meta(
            &core.active_session_id,
            sequence,
            None,
            Some(&core.generation),
        );
        let outbound = DaemonOutbound::SessionEvent {
            active_session_id: core.active_session_id.clone(),
            event: json!({ "type": "session_action_update", "actions": snapshot }),
            meta: Some(meta),
            rest: Map::default(),
        };
        let payload = serde_json::to_vec(&outbound)?;
        drop(core);
        self.events.send(OutboundFrame::session_event(payload));
        Ok(())
    }

    fn emit_session_closed(
        &self,
        active_session_id: &str,
        reason: DaemonSessionClosedReason,
    ) -> Result<()> {
        let mut core = self.core.lock().unwrap();
        let sequence = core.last_event_sequence + 1;
        core.last_event_sequence = sequence;
        let meta = create_daemon_event_meta(
            &core.active_session_id,
            sequence,
            None,
            Some(&core.generation),
        );
        let outbound = DaemonOutbound::SessionClosed {
            active_session_id: active_session_id.to_string(),
            reason,
            meta: Some(meta),
            rest: Map::default(),
        };
        let payload = serde_json::to_vec(&outbound)?;
        drop(core);
        self.events.send(OutboundFrame::session_event(payload));
        Ok(())
    }
}

/// The pending queue lanes of a session (journal persistence payload):
/// the full parked rows — message text, labeled preview, injected custom
/// row, queue key, and visibility — so crash/respawn recovery restores a
/// queued heartbeat as the heartbeat component, not a plain prompt.
pub(crate) struct QueueLanes {
    pub(crate) steering: Vec<crate::journal::WorkerQueueItemRecord>,
    pub(crate) follow_up: Vec<crate::journal::WorkerQueueItemRecord>,
}

/// Read the pending lanes off a locked core.
/// The wire `customMessage` of a prompt/follow-up command: an injected
/// custom row (`role: "custom"` with a non-empty `customType`) that
/// replaces the turn's user row. `Err` rejects the command loudly — a
/// malformed notice must not silently degrade into a plain prompt.
fn parse_custom_message(value: Option<&Value>) -> Result<Option<Value>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let invalid = "Invalid customMessage: expected a custom message object with a customType";
    let Some(object) = value.as_object() else {
        return Err(invalid.to_string());
    };
    if object.get("role").and_then(Value::as_str) != Some("custom") {
        return Err(invalid.to_string());
    }
    let custom_type = object
        .get("customType")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty());
    if custom_type.is_none() {
        return Err(invalid.to_string());
    }
    Ok(Some(value.clone()))
}

/// One queue-lane recovery checkpoint. The verdict and the persisted
/// lane snapshot come from one locked read, so a concurrent
/// enqueue/clear cannot be overwritten by a stale verdict and a stale
/// snapshot cannot resurrect cleared lanes.
#[derive(Clone, Copy)]
pub(crate) enum QueueCheckpoint {
    /// The lanes hold admitted live work: `busy = true` (TS
    /// `prompt_accepted` / `steer_queued` / `follow_up_queued` /
    /// `actions_restored`).
    Admitted { operation: &'static str },
    /// The verdict follows the lanes: `busy = whether lanes remain
    /// queued` (TS `turn_end` computes the same verdict over live
    /// work). Also used by queue mutations with no TS record (a clear,
    /// an edit, an agent-message drain) so the journal never keeps a
    /// stale verdict over a changed queue.
    Settle { operation: &'static str },
}

/// Write one queue-lane recovery checkpoint: under the recovery lock
/// (then the core lock, the documented order) the lanes are snapshotted
/// into the journal and the busy verdict is recorded from the same
/// read. Shared by the worker (`prompt` admission,
/// `steer`/`follow_up`/agent-message delivery, `restore_actions`, queue
/// clears/edits) and the turn runner (`turn_end` settle), which own the
/// same fields.
pub(crate) fn checkpoint_queue_recovery(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core_lock: &std::sync::Mutex<SessionCore>,
    checkpoint: QueueCheckpoint,
) {
    let mut guard = recovery.lock().unwrap();
    let Some(journal) = guard.as_mut() else {
        return;
    };
    // The lanes are read under the recovery lock (a microsecond core
    // hold — never across the journal's fsyncs, which would block every
    // concurrent command behind the write): every queue mutation that
    // persists lands its own snapshot under this same recovery lock, so
    // no persist can interleave between this read and the appends, and a
    // mutating non-persist (a runner pop) is corrected by the next
    // checkpoint's fresh read.
    let (active_session_id, session_id, session_file, lanes, turn_in_flight) = {
        let core = core_lock.lock().unwrap();
        (
            core.active_session_id.clone(),
            core.store
                .as_ref()
                .map(|s| s.session_id().to_string())
                .unwrap_or_default(),
            core.store
                .as_ref()
                .map(|s| s.path.to_string_lossy().to_string()),
            queue_lanes(&core),
            core.busy,
        )
    };
    let (busy, operation) = match checkpoint {
        QueueCheckpoint::Admitted { operation } => (true, operation),
        // TS computes a settled verdict from live session work
        // (`hasLiveSessionWork` — an active session counts — plus retries
        // and accepted prompts), never from the lanes alone: a withdrawal
        // landing mid-turn (queue purge, clear, drop) must not flip the
        // journal to idle while the turn still streams, or a crash in
        // that window parks live work. The turn's own settle reads the
        // idle flip first, so `turn_in_flight` is false at `turn_end`.
        QueueCheckpoint::Settle { operation } => (
            turn_in_flight || !lanes.steering.is_empty() || !lanes.follow_up.is_empty(),
            operation,
        ),
    };
    // The verdict never publishes over a snapshot that did not persist:
    // busy=true evidence must not promise a queue the journal cannot
    // replay (a skipped settled verdict keeps the previous record — the
    // worst case parks like any uncheckpointed session).
    if journal
        .record_queue_snapshot(&active_session_id, &lanes.steering, &lanes.follow_up)
        .is_err()
    {
        return;
    }
    let _ = journal.record(
        &active_session_id,
        &session_id,
        session_file.as_deref(),
        busy,
        operation,
    );
}

pub(crate) fn queue_lanes(core: &SessionCore) -> QueueLanes {
    fn items(lane: &VecDeque<QueuedItem>) -> Vec<crate::journal::WorkerQueueItemRecord> {
        lane.iter()
            .map(|item| crate::journal::WorkerQueueItemRecord {
                message: item.message.clone(),
                priority: Some(item.priority),
                preview: item.preview.clone(),
                custom_message: item.custom_message.clone(),
                queue_key: item.queue_key.clone(),
                queue_visible: item.queue_visible,
                policy: item.policy.journal_value().to_string(),
            })
            .collect()
    }
    QueueLanes {
        steering: items(&core.steering),
        follow_up: items(&core.follow_up),
    }
}

/// TS `_pumpSessionInputs`'s batch gathering: the lane's front item
/// anchors the delivery; under queue mode "all" — or the forced steering
/// batch armed by `abort_and_send_queued` (TS `abortAndSendQueued`'s
/// `_forcedAllSteeringActionIds`) — the same-class prefix behind it joins
/// as co-delivered rows of ONE turn (TS `turnExecutionPoliciesEqual` +
/// the mode/armed-set gates).
///
/// Joining gates: the same turn-execution class; a plain user row (an
/// injected custom row always delivers solo — it replaces its turn's
/// user row); not a queued session command (TS batches only `turn`-kind
/// actions); and membership of the armed set while the forced batch
/// governs this delivery. The front item anchors regardless — a
/// non-batchable front delivers solo, exactly like TS's `first`.
fn gather_delivery_batch(core: &mut SessionCore, lane: Lane) -> Vec<QueuedItem> {
    let (items, mode) = match lane {
        Lane::Steering => (&mut core.steering, core.steering_mode.as_str()),
        Lane::FollowUp => (&mut core.follow_up, core.follow_up_mode.as_str()),
    };
    let Some(first) = items.front() else {
        return Vec::new();
    };
    // TS `_forcedAllSteeringBatch(first)`: the armed set forces "all" only
    // when the front item is armed; an un-armed front disarms the batch
    // once no armed item remains queued (a delivered item leaves the lane
    // with its flag, so the armed prefix exhausts itself). The read runs
    // before the front's delivery class — every pickup disarms an
    // exhausted arm, whatever it delivers.
    let forced = lane == Lane::Steering && core.forced_all_steering && first.forced_batch;
    let mut batch = Vec::new();
    if lane == Lane::Steering
        && core.forced_all_steering
        && !forced
        && !items.iter().any(|item| item.forced_batch)
    {
        core.forced_all_steering = false;
    }
    // The front's own delivery class decides the turn's shape before any
    // gathering (TS: the direct prompt hand-off never queues, an injected
    // custom row replaces its turn's user row, and a queued session
    // command runs as the command — none of those turns carry co-delivered
    // rows, so the front delivers solo).
    if first.custom_message.is_some()
        || first.policy == TurnPolicy::Direct
        || crate::session_commands::parse_prompt_session_command(&first.message).is_some()
    {
        batch.push(items.pop_front().expect("front checked"));
        return batch;
    }
    let first_policy = first.policy;
    batch.push(items.pop_front().expect("front checked"));
    if forced || mode == "all" {
        while let Some(next) = items.front() {
            if next.policy != first_policy
                || next.custom_message.is_some()
                || (forced && !next.forced_batch)
                || crate::session_commands::parse_prompt_session_command(&next.message).is_some()
            {
                break;
            }
            batch.push(items.pop_front().expect("front checked"));
        }
    }
    batch
}

/// Queue snapshot restore from the worker recovery journal (crash/respawn
/// recovery): the latest persisted lanes for this session.
fn restore_queue_snapshot(
    journal: &WorkerRecoveryJournal,
    active_session_id: &str,
) -> (VecDeque<QueuedItem>, VecDeque<QueuedItem>) {
    fn pending(lanes: Vec<crate::journal::WorkerQueueItemRecord>) -> VecDeque<QueuedItem> {
        // Images on a queued prompt do not survive the worker restart:
        // the recovery journal stores the delivery rows without the
        // process-local attachments (the TS command-recovery journal
        // keeps the same text-only shape for its lanes). Everything the
        // turn needs to deliver identically — the labeled preview, the
        // injected custom row, the queue key, the visibility flag —
        // rides the item record, so a restored queued heartbeat still
        // runs and persists as the `heartbeat_prompt` component.
        lanes
            .into_iter()
            .map(|record| {
                let policy = record.policy();
                QueuedItem {
                    preview: record.preview,
                    message: record.message,
                    priority: record.priority.unwrap_or_else(|| {
                        if record.custom_message.is_some() {
                            QueuePriority::Background
                        } else {
                            QueuePriority::Human
                        }
                    }),
                    custom_message: record.custom_message,
                    agent_message: None,
                    queue_key: record.queue_key,
                    admission_id: None,
                    images: Vec::new(),
                    done: None,
                    queue_visible: record.queue_visible,
                    policy,
                    forced_batch: false,
                }
            })
            .collect()
    }

    let mut steering = VecDeque::new();
    let mut follow_up = VecDeque::new();
    if let Some((steering_lanes, follow_up_lanes)) =
        journal.latest_queue_snapshot(active_session_id)
    {
        steering = pending(steering_lanes);
        follow_up = pending(follow_up_lanes);
    }
    (steering, follow_up)
}

/// The turn runner: drains the queue one turn at a time, running the session
/// engine and emitting the agent-loop event lifecycle.
/// Sequence and broadcast one `session_event` frame at the worker
/// level: sequence + meta under the core lock, then one broadcast (the
/// free-standing form of `Worker::emit_worker_event`, shared with the
/// goal admission sink).
/// Record one durable custom row of the background compact-trigger
/// review and broadcast its `message_start`/`message_end` pair (the TS
/// `_emit` for rows the session appends outside a turn): the same shape
/// `Worker::emit_custom_row` persists for the `/refine` command's rows.
///
/// `review_session_id` fences the row against the session moves a branch
/// navigation or replacement makes while the review's model call was in
/// flight (the round's branch-version check already drops its harness
/// edits; this drops the ROWS): the worker's live store answers with a
/// different session id — the review resolved against the abandoned
/// conversation, so its rows never persist or broadcast into the
/// moved-to session. Returns whether the row landed.
fn emit_refinement_row(
    core: &Arc<Mutex<SessionCore>>,
    events: &Arc<EventPump>,
    review_session_id: &str,
    message: Value,
) -> bool {
    {
        let mut core = core.lock().unwrap();
        let Some(store) = core.store.as_mut() else {
            return false;
        };
        if store.session_id() != review_session_id {
            pa_core::session_engine::compaction_trace::trace(
                "autorefine.rows_dropped_session_moved",
                serde_json::Value::Null,
            );
            return false;
        }
        let _ = store.persist_entry(
            "custom_message",
            json!({
                "customType": message.get("customType").cloned().unwrap_or(Value::Null),
                "content": message.get("content").cloned().unwrap_or(Value::Null),
                "display": message.get("display").cloned().unwrap_or(Value::Bool(true)),
                "details": message.get("details").cloned().unwrap_or(Value::Null),
            }),
        );
    }
    emit_worker_event_with(
        core,
        events,
        json!({ "type": "message_start", "message": message }),
    );
    emit_worker_event_with(
        core,
        events,
        json!({ "type": "message_end", "message": message }),
    );
    true
}

pub(crate) fn emit_worker_event_with(
    core: &Arc<Mutex<SessionCore>>,
    events: &Arc<EventPump>,
    event: Value,
) {
    let mut core = core.lock().unwrap();
    let sequence = core.last_event_sequence + 1;
    core.last_event_sequence = sequence;
    let meta = create_daemon_event_meta(
        &core.active_session_id,
        sequence,
        None,
        Some(&core.generation),
    );
    let active_session_id = core.active_session_id.clone();
    let outbound = DaemonOutbound::SessionEvent {
        active_session_id,
        event,
        meta: Some(meta),
        rest: Map::default(),
    };
    let payload = serde_json::to_vec(&outbound).unwrap_or_default();
    drop(core);
    events.send(OutboundFrame::session_event(payload));
}

/// Admit one engine-minted goal follow-up (TS `_queuePreparedPrompt`'s
/// steer arm and the queued `followUp` admission behind
/// `_getGoalContinuationMessages` / `_maybeResumeGoalContinuationAfterRlmWork`):
/// the mint's `goal_update` surfaces at the moment the state changed
/// (durable `thread_goal_state` entry first, then the broadcast), the
/// minted turn queues into its lane (the steering lane for the
/// budget-limit wrap-up steer, the follow-up lane for the continuation),
/// and the runner wakes (`resumeIfIdle`).
/// Admit one held autonomous continuation through the follow-up lane (TS
/// `_queueAutonomousContinuationForThresholdCompaction`'s queued `followUp`
/// admission): the runner wakes, the item runs as its own queue item after
/// the current run settles.
pub(crate) fn admit_autonomous_follow_up(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<Notify>,
    text: String,
) {
    {
        let mut core = core.lock().unwrap();
        core.follow_up.push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: text,
            custom_message: None,
            agent_message: None,
            queue_key: Some(AUTONOMOUS_QUEUE_KEY.to_string()),
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: false,
            policy: TurnPolicy::Injected,
            forced_batch: false,
        });
    }
    // The admission checkpoint (busy=true): an injected continuation
    // admitted while idle (after the previous settle) is undelivered
    // live work the journal must prove — the runner records nothing at
    // pickup, so a kill between this admission and the turn's settle
    // would otherwise read as idle and park the continuation on a
    // plain boot.
    checkpoint_queue_recovery(
        recovery,
        core,
        QueueCheckpoint::Admitted {
            operation: "follow_up_queued",
        },
    );
    work_notify.notify_waiters();
}

pub(crate) fn admit_goal_follow_up(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    events: &Arc<EventPump>,
    work_notify: &Arc<Notify>,
    work: crate::engine::GoalTurnEndWork,
) {
    let (lane, follow_up) = match work {
        crate::engine::GoalTurnEndWork::BudgetLimitSteer(follow_up) => (Lane::Steering, follow_up),
        crate::engine::GoalTurnEndWork::Continuation(follow_up) => (Lane::FollowUp, follow_up),
    };
    if let Some(goal) = &follow_up.goal_update {
        {
            let mut guard = core.lock().unwrap();
            if let Some(store) = guard.store.as_mut() {
                let _ = store.persist_entry(
                    "custom",
                    json!({
                        "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
                        "data": goal,
                    }),
                );
            }
        }
        emit_worker_event_with(core, events, json!({ "type": "goal_update", "goal": goal }));
    }
    {
        let mut core = core.lock().unwrap();
        let item = QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: follow_up.request.message,
            custom_message: follow_up.request.custom_message,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: follow_up.request.images,
            done: None,
            queue_visible: false,
            policy: TurnPolicy::Injected,
            forced_batch: false,
        };
        match lane {
            Lane::Steering => enqueue_priority(&mut core.steering, item),
            Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
        }
    }
    // The admission checkpoint (busy=true, TS's queue strings by lane):
    // a minted follow-up admitted while idle is undelivered live work
    // the journal must prove until its turn settles (same gap as the
    // autonomous continuation above).
    checkpoint_queue_recovery(
        recovery,
        core,
        QueueCheckpoint::Admitted {
            operation: match lane {
                Lane::Steering => "steer_queued",
                Lane::FollowUp => "follow_up_queued",
            },
        },
    );
    // `resumeIfIdle`: the runner re-checks the queue at its loop head, so
    // the minted turn runs as the next admitted turn.
    work_notify.notify_one();
}

/// Admit one detached kernel bash completion notice (TS
/// `bash.completed` -> `_promptInjectedMessage(message, {
/// streamingBehavior: "steer", queueIfBusy: true, resumeIfIdle: true })`):
/// the `[bash-done pid:N exit:M]` row queues on the steering lane — a
/// busy session keeps a visible steer row, an idle session wakes into
/// the turn that runs on the row. The admission carries the recovery
/// busy-evidence checkpoint, so a crash between the notice and its
/// delivery revives the worker with the row replaying (the wake
/// survives worker re-adoption and revival).
pub(crate) fn admit_bash_completion_notice(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<Notify>,
    notice: crate::engine::BashCompletionNotice,
    session_is_closed: impl Fn() -> bool,
) {
    let row = pa_core::session_engine::messages::create_async_bash_completion_message(
        notice.pid,
        &notice.command,
        notice.exit_code,
        crate::util::now_ms(),
    );
    let content = match &row.content {
        pa_types::ai::UserContent::Text(text) => text.clone(),
        pa_types::ai::UserContent::Blocks(_) => String::new(),
    };
    // TS `queueVisible: visibleQueued` + the schedule's execution policy:
    // busy sessions queue a visible row, idle sessions wake on an
    // invisible injected turn. The busy sample and the push share ONE
    // critical section: a turn starting between a separate sample and
    // the push would queue an invisible row for a busy session.
    let mut core_guard = core.lock().unwrap();
    // The close paths mark the session and then clear the lanes in their
    // own core section: a notice that raced past the sink's first check
    // is refused here (the marker is visible by now), or the close's
    // clear wipes it — never a completion turn for a closed session.
    if session_is_closed() {
        return;
    }
    let (policy, queue_visible) = if core_guard.busy {
        (TurnPolicy::Queued, true)
    } else {
        (TurnPolicy::Injected, false)
    };
    {
        core_guard.steering.push_back(QueuedItem {
            priority: QueuePriority::Background,
            // TS `previewLabel` (`injectedMessagePreviewLabel` ->
            // `ASYNC_BASH_COMPLETION_PREVIEW_LABEL`): the queue strip
            // reads `Background command finished: <content>` (the TUI's
            // labeled-preview prefix).
            preview: Some(format!(
                "{}: {content}",
                pa_core::session_engine::messages::ASYNC_BASH_COMPLETION_PREVIEW_LABEL
            )),
            message: content,
            custom_message: Some(crate::session_commands::custom_message_value(&row)),
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible,
            policy,
            forced_batch: false,
        });
    }
    // The checkpoint re-locks the core (documented order: recovery lock
    // first), so the admission's guard must release first.
    drop(core_guard);
    // The fire checkpoint (busy=true, TS's steering queue string): the
    // notice is undelivered live work until its turn settles — the same
    // evidence the goal/autonomous continuations record.
    checkpoint_queue_recovery(
        recovery,
        core,
        QueueCheckpoint::Admitted {
            operation: "steer_queued",
        },
    );
    // `resumeIfIdle`: the runner re-checks the queue at its loop head.
    work_notify.notify_one();
}

/// Withdraw one queued bash completion notice (TS `bash.consumed` ->
/// `_withdrawAsyncBashCompletionNotice`): the kernel read the finished
/// command's result before the notice delivered, so the undelivered row
/// cancels — one read withdraws one notice, and pids are reused across
/// handles, so the command disambiguates (`_isAsyncBashCompletionActionFor`).
pub(crate) fn withdraw_bash_completion_notice(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    notice: crate::engine::BashConsumedNotice,
) {
    let removed = {
        let mut core_guard = core.lock().unwrap();
        let before = core_guard.steering.len() + core_guard.follow_up.len();
        // TS withdraws ONE row per read ("pid reuse can queue an
        // identical key twice, and the read belongs to the older
        // handle, which is the earlier notice"): the front-most match
        // across the two lanes, never the whole set.
        let mut withdrawn = false;
        let mut withdraw_one = |item: &QueuedItem| {
            if !withdrawn && is_bash_completion_notice_for(item, &notice) {
                withdrawn = true;
                false
            } else {
                true
            }
        };
        core_guard.steering.retain(&mut withdraw_one);
        core_guard.follow_up.retain(withdraw_one);
        before != core_guard.steering.len() + core_guard.follow_up.len()
    };
    if removed {
        // The withdrawal refreshes the verdict (and the snapshot) so a
        // consumed notice cannot keep busy=true promising a revive the
        // withdrawn row would replay (a mid-turn withdrawal stays busy
        // through the in-flight turn).
        checkpoint_queue_recovery(
            recovery,
            core,
            QueueCheckpoint::Settle {
                operation: "queue_purged",
            },
        );
    }
}

/// Whether one queued item is the async-bash-completion notice for this
/// pid+command (TS `_isAsyncBashCompletionActionFor`: the custom row's
/// details carry both — pids alone are reused).
fn is_bash_completion_notice_for(
    item: &QueuedItem,
    notice: &crate::engine::BashConsumedNotice,
) -> bool {
    let Some(row) = item.custom_message.as_ref() else {
        return false;
    };
    if row.get("customType").and_then(Value::as_str)
        != Some(pa_core::session_engine::messages::ASYNC_BASH_COMPLETION_CUSTOM_TYPE)
    {
        return false;
    }
    let details = row.get("details").unwrap_or(&Value::Null);
    details.get("pid").and_then(Value::as_u64) == Some(notice.pid as u64)
        && details.get("command").and_then(Value::as_str) == Some(notice.command.as_str())
}

/// Whether one queued item is a minted goal-context turn (TS's
/// `_clearQueuedGoalContexts` predicate on the injected custom row).
fn is_goal_context_item(item: &QueuedItem) -> bool {
    item.custom_message.as_ref().is_some_and(|row| {
        row.get("customType").and_then(Value::as_str)
            == Some(pa_core::goals::GOAL_CONTEXT_CUSTOM_TYPE)
    })
}

/// Entry point for the worker process.
///
/// # Errors
///
/// Returns an error when the worker role env is missing (it must be
/// `WORKER_ROLE_ENV=1`), the worker env pair cannot be read, or the
/// serve loop fails.
pub async fn run_worker() -> Result<()> {
    if std::env::var(WORKER_ROLE_ENV).unwrap_or_default() != "1" {
        return Err(anyhow!("worker mode requires {WORKER_ROLE_ENV}=1"));
    }
    let config = WorkerConfig::from_env()?;
    // Self-registration: the supervisor's roster survives its own restarts
    // because workers re-present their identity (liveness watch + backoff).
    let registration = crate::registration::start(&config);
    let worker = Arc::new(Worker::new(config, registration));
    // The refused-registration self-heal: a supervisor that destroyed this
    // worker's durable identity (its descriptor) can never adopt it again,
    // so the registration loop's definitive rejection retires the worker —
    // the graceful close releasing its session lease instead of the
    // invisible lease-holder it would otherwise remain (the macOS case of
    // the leftover-holder the boot reap cannot enumerate).
    if let Some(handle) = worker.registration.clone() {
        let worker = Arc::clone(&worker);
        tokio::spawn(async move {
            handle.retired().await;
            worker.exit_refused_registration().await;
        });
    }
    worker.serve().await
}

/// The session summary for one core (TS `summaryForActiveSession`): the
/// shared shape `get_state`, the roster, and list rows all serve. Free so
/// the turn runner can push roster deltas without the worker handle; the
/// thinking level rides in from the engine (the core has no engine access).
/// TS `activeLifecycleForSession`: lifecycle drives agents-view visibility
/// and is message-based. A resident subagent is a spawned worker, visible
/// before its first message lands; a message-less top-level session is a
/// draft the view hides (config like a renamed model is preserved on disk,
/// it just never surfaces a conversation-less row). A busy turn is live
/// even before the store flushes its user message: TS computes the same
/// summary from the runtime's in-memory messages, which hold the prompt
/// the moment the turn starts, so the busy-flip roster delta a mid-turn
/// view reads must never classify the running session as a draft.
fn active_lifecycle(runtime_kind: &str, messageless: bool, busy: bool) -> &'static str {
    if runtime_kind == "subagent" || !messageless || busy {
        "live"
    } else {
        "draft"
    }
}

/// The worker's roster-delta push (the Rust-native form of the TS
/// `roster_delta` worker frame): the fresh session summary rides the
/// supervisor link, so subscribed roster surfaces (the agents view) see a
/// state change without polling. Shared by the turn runner's busy flips
/// and the worker's command arms (the model/thinking switches). The
/// supervisor's roster refresh still backstops every push, so this stays
/// fire-and-forget: a dead link reconnects on the next push, and a
/// supervisor restart re-seeds the entry from registration.
///
/// The TS worker flushes its roster deltas over ONE ordered supervisor
/// client socket (a coalesced window re-reads the current state), so a
/// delayed older frame can never overwrite a newer one. The Rust
/// supervisor link dials an independent socket per request — the pushes
/// arrive unordered — so every delta carries the worker's monotonic
/// counter and the supervisor's stale-delta gate drops the delayed older
/// snapshots.
pub(crate) struct RosterPushContext {
    pub(crate) core: Arc<Mutex<SessionCore>>,
    pub(crate) engine: std::sync::Arc<dyn SessionEngine>,
    pub(crate) user_bash: std::sync::Arc<crate::user_bash::UserBash>,
    pub(crate) roster_link: std::sync::Arc<crate::supervisor_link::SupervisorLink>,
    pub(crate) worker_token: String,
    pub(crate) worker_instance_id: String,
    pub(crate) roster_delta_sequence: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub(crate) roster_push_order: std::sync::Arc<std::sync::Mutex<()>>,
}

pub(crate) fn push_roster_delta(context: &RosterPushContext) {
    if std::env::var_os("PA_WORKER_DISABLE_ROSTER_PUSH").is_some() {
        return;
    }
    if context.worker_token.is_empty() || context.roster_link.socket_path().as_os_str().is_empty() {
        return;
    }
    // The push-order lock holds the snapshot and its sequence stamp
    // together: a busy-flip push racing a switch push must never let the
    // older snapshot carry the newer sequence (the supervisor would then
    // keep the stale row and drop the fresh one), so the pair is atomic
    // and the pairs themselves order — sequence order is snapshot order.
    let _order = context.roster_push_order.lock().unwrap();
    let mut summary = {
        let core = context.core.lock().unwrap();
        session_summary(
            &core,
            &context
                .engine
                .effective_thinking_level()
                .unwrap_or_else(|| "default".to_string()),
            context.engine.model_metadata(),
            context.engine.model_fallback_message(),
            context.user_bash.is_running(),
        )
    };
    // The embedded counter is the pre-stamp value read under the order
    // lock: every sequence this worker stamped before the snapshot is at
    // or below it. The supervisor's authoritative pulls raise their
    // watermark to it, so a delta still in flight when the pull answered
    // is dropped instead of overwriting the pull's fresher state.
    summary.roster_delta_sequence = Some(
        context
            .roster_delta_sequence
            .load(std::sync::atomic::Ordering::SeqCst),
    );
    let summary = serde_json::to_value(&summary).unwrap_or(serde_json::Value::Null);
    let link = std::sync::Arc::clone(&context.roster_link);
    let worker_token = context.worker_token.clone();
    let worker_instance_id = context.worker_instance_id.clone();
    let sequence_value = context
        .roster_delta_sequence
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    tokio::spawn(async move {
        let command = serde_json::json!({
            "type": "worker_roster_delta",
            "workerToken": worker_token,
            "summary": summary,
            "sequence": sequence_value,
            "workerInstanceId": worker_instance_id,
        });
        let _ = link
            .request(command, std::time::Duration::from_secs(10))
            .await;
    });
}

pub(crate) fn session_summary(
    core: &SessionCore,
    thinking_level: &str,
    model: Option<Value>,
    model_fallback_message: Option<String>,
    bash_running: bool,
) -> SessionSummary {
    let store = core.store.as_ref();
    let streaming = core.busy;
    let compacting = core.compacting;
    let queued = core.steering.len() + core.follow_up.len();
    // `modified` is the session file mtime; `lastActivityAt` prefers the
    // newest message timestamp (port of `summaryForActiveSession`).
    let modified = store
        .and_then(|store| std::fs::metadata(&store.path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .map(|time| {
            crate::util::iso_from_unix_ms(
                time.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or_default(),
            )
        });
    let messages = store
        .map(super::session_store::SessionFile::messages)
        .unwrap_or_default();
    let last_activity_at = messages
        .iter()
        .rev()
        .find_map(crate::types::message_timestamp_ms)
        .map(crate::util::iso_from_unix_ms)
        .or_else(|| modified.clone())
        .or_else(|| store.map(|store| store.header.timestamp.clone()));
    // Usage: summed assistant usage (`sessionUsageSummaryFrom`), absent
    // when everything is zero.
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cost = 0.0f64;
    for message in &messages {
        if crate::types::message_role(message) != Some("assistant") {
            continue;
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };
        input_tokens += usage
            .get("input")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        input_tokens += usage
            .get("cacheRead")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        input_tokens += usage
            .get("cacheWrite")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        output_tokens += usage
            .get("output")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        cost += usage
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or_default();
    }
    let usage = (input_tokens > 0 || output_tokens > 0 || cost > 0.0).then(
        || json!({ "inputTokens": input_tokens, "outputTokens": output_tokens, "cost": cost }),
    );
    SessionSummary {
        id: core.active_session_id.clone(),
        lifecycle: active_lifecycle(&core.runtime_kind, messages.is_empty(), streaming).to_string(),
        activity: if streaming || compacting {
            "working"
        } else {
            "idle"
        }
        .to_string(),
        is_session_active: streaming || compacting || queued > 0,
        has_registered_cron_job: Some(false),
        last_activity_at,
        rlm_depth: Some(core.rlm_depth),
        active_session_id: Some(core.active_session_id.clone()),
        session_id: store
            .map(|s| s.session_id().to_string())
            .unwrap_or_default(),
        session_file: store.map(|s| s.path.to_string_lossy().to_string()),
        session_name: store.and_then(|s| s.session_name().map(str::to_string)),
        cwd: core.cwd.clone(),
        thinking_level: Some(thinking_level.to_string()),
        is_streaming: streaming,
        is_compacting: compacting,
        is_bash_running: Some(bash_running),
        is_running_tools: streaming && !core.running_tool_calls.is_empty(),
        attached_clients: core.attached_client_ids.len() as u32,
        message_count: store.map_or(0, super::session_store::SessionFile::message_count) as u32,
        session_actions: session_snapshot(core),
        streaming_message: None,
        created: store.map(|s| s.header.timestamp.clone()),
        modified,
        first_message: store.and_then(super::session_store::SessionFile::first_message),
        parent_session_path: store.and_then(|store| store.header.parent_session.clone()),
        parent_active_session_id: core.parent_active_session_id.clone(),
        parent_session_id: core.parent_session_id.clone(),
        rlm_child_id: core.rlm_child_id.clone(),
        usage,
        worker_state: Some("ready".to_string()),
        worker_pid: Some(std::process::id()),
        // Set by the caller when the snapshot backs a roster push (the
        // push-order lock reads the pre-stamp counter); authoritative
        // pulls embed the live counter in `summary_locked` instead.
        // The push's sending instance rides the frame envelope, so the
        // summary itself never carries one here.
        roster_delta_sequence: None,
        worker_instance_id: None,
        model,
        model_fallback_message,
        runtime_kind: Some(core.runtime_kind.clone()),
        unfinished_action_count: Some(0),
    }
}

/// The queue snapshot for one core (TS `sessionActions`).
fn session_snapshot(core: &SessionCore) -> SessionActionSnapshot {
    // TS `queuedAgentMessagePreview`: a parked row reads the
    // delivery's labeled preview when it carries one, else the
    // message text.
    let lane = |items: &std::collections::VecDeque<QueuedItem>| {
        items
            .iter()
            .map(|item| item.preview.clone().unwrap_or_else(|| item.message.clone()))
            .collect::<Vec<String>>()
    };
    // The RLM child status notices fold by TYPED provenance: the indices
    // derive from the parked rows' injected custom rows, so the
    // classification rides the wire and a user-typed message that
    // merely looks like a notice preview never marks.
    let rlm_child_status = |items: &std::collections::VecDeque<QueuedItem>| {
        items
            .iter()
            .enumerate()
            .filter(|(_, item)| is_rlm_child_status_item(item))
            .map(|(index, _)| index)
            .collect::<Vec<usize>>()
    };
    SessionActionSnapshot {
        queued_count: (core.steering.len() + core.follow_up.len()) as u32,
        steering: lane(&core.steering),
        follow_ups: lane(&core.follow_up),
        rlm_child_status: crate::types::RlmChildStatusIndices {
            steering: rlm_child_status(&core.steering),
            follow_up: rlm_child_status(&core.follow_up),
        },
        active: core.active_action.clone(),
    }
}

/// Whether one parked queue item is an RLM child status notice: the
/// injected custom row's kind (the terminal-notice and failure custom
/// types) proves it — client command surfaces answer any
/// caller-supplied row claiming either reserved kind LOUDLY (the
/// prompt/steer/follow-up parse and the `restore_actions` validation),
/// and the one producer (`rlm_children::deliver_terminal_notice`) rides
/// the same follow-up route with a one-shot minted capability
/// (`child_status_notices`), so within the queue the kinds are
/// daemon-authentic: a client-steered message can never carry the row.
/// This is the queue strip's typed provenance: the notice previews stay
/// the raw `[child-exited: ...]` texts, so nothing about the string
/// decides the classification.
fn is_rlm_child_status_item(item: &QueuedItem) -> bool {
    let Some(row) = item.custom_message.as_ref() else {
        return false;
    };
    // One reserved-kind predicate, owned by the intake module (review
    // round 3): the queue's classification and every client surface read
    // the same exact match, so the kinds can never desync.
    crate::child_status_notices::is_reserved_child_status_custom_type(row)
}

/// The active action's queue label (TS `compactRlmText(text, 160)`):
/// collapse whitespace and cap at 160 chars with an ellipsis.
fn compact_action_label(text: &str) -> String {
    const MAX_CHARS: usize = 160;
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= MAX_CHARS {
        return compact;
    }
    let kept: String = compact.chars().take(MAX_CHARS - 3).collect();
    format!("{}...", kept.trim_end())
}

#[cfg(test)]
#[path = "worker_resume_settings_tests.rs"]
mod worker_resume_settings_tests;

#[cfg(test)]
mod agent_message_tests;

#[cfg(test)]
mod prompt_image_tests;

#[cfg(test)]
mod update_snapshot_tests {
    use super::*;

    async fn snapshot_after_create() -> (Arc<Worker>, DaemonResponse) {
        let dir = std::env::temp_dir().join(format!("pa-worker-us-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "target-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        // The journal is opened in `serve()`; tests open it directly so the
        // snapshot flush has the same durable sink as production.
        *worker.recovery.lock().unwrap() =
            Some(WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap());
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
            )
            .await;
        assert!(created.success, "create must succeed: {created:?}");
        let response = worker.dispatch("update_snapshot", &json!({})).await;
        (worker, response)
    }

    /// TS `queuedAgentMessagePreview`: the queue action rows serve a
    /// delivery's labeled preview when it carries one, while the raw
    /// steering lane keeps the message text (TS `getSteeringMessages`).
    #[tokio::test]
    async fn queue_action_rows_serve_the_labeled_preview() {
        let (worker, _) = snapshot_after_create().await;
        {
            let mut core = worker.core.lock().unwrap();
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Background,
                message: "[heartbeat: every 10m run#0]\n\nnudge the mission".to_string(),
                preview: Some(
                    "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge the mission"
                        .to_string(),
                ),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
                forced_batch: false,
            });
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Human,
                message: "plain queued prompt".to_string(),
                preview: None,
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
            });
        }
        let response = worker.dispatch("update_snapshot", &json!({})).await;
        assert!(response.success);
        let data = response.data.expect("snapshot data");
        assert_eq!(
            data["queue"]["actions"]["steering"],
            json!([
                "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge the mission",
                "plain queued prompt",
            ]),
            "the action rows must serve the labeled preview"
        );
        assert_eq!(
            data["queue"]["steering"],
            json!([
                "[heartbeat: every 10m run#0]\n\nnudge the mission",
                "plain queued prompt",
            ]),
            "the raw lane keeps the message text"
        );
        assert_eq!(data["queue"]["actions"]["queuedCount"], 2);
    }

    #[tokio::test]
    async fn update_snapshot_reports_the_session_and_flushes_the_journal() {
        let (worker, response) = snapshot_after_create().await;
        assert!(response.success, "snapshot must succeed: {response:?}");
        let data = response.data.expect("snapshot data");
        // The no-session worker has no durable session file: the active id
        // still identifies the worker's session.
        assert_eq!(data["activeSessionId"], "target-session");
        assert_eq!(data["cwd"], "/tmp");
        assert_eq!(data["busy"], false);
        assert_eq!(data["compacting"], false);
        assert_eq!(data["runtimeMetadata"]["kind"], "top-level");
        assert!(data["queue"]["actions"].is_object());
        // The flush happened before the reply: the recovery journal has a
        // queue snapshot record for this session.
        let snapshot = WorkerRecoveryJournal::read_queue_snapshot(
            &worker.config.recovery_journal_path,
            "target-session",
        )
        .expect("journal is readable");
        assert!(snapshot.is_some(), "the queue lanes were flushed");
    }

    #[tokio::test]
    async fn update_snapshot_reflects_queued_work() {
        let (worker, _) = snapshot_after_create().await;
        worker
            .dispatch("steer", &json!({ "message": "finish the build" }))
            .await;
        let response = worker.dispatch("update_snapshot", &json!({})).await;
        let data = response.data.expect("snapshot data");
        assert_eq!(data["queue"]["steering"][0], "finish the build");
        assert_eq!(
            data["queue"]["actions"]["steering"][0], "finish the build",
            "the lane snapshot and the actions projection agree"
        );
    }
    /// The wire text of one RLM child terminal notice (the exact row
    /// `rlm_children::deliver_terminal_notice` rides): the follow-up
    /// command's `message` plus the injected custom row.
    fn child_status_notice_wire(kind: &str) -> Value {
        let notice = if kind == "failure" {
            pa_core::session_engine::rlm_notices::create_rlm_child_failure_message(
                "sub-1", "lane", "boom", 1_000,
            )
        } else {
            pa_core::session_engine::rlm_notices::create_rlm_child_terminal_notice(
                &pa_core::session_engine::rlm_notices::RlmChildTerminalNotice::CompletedWithoutReply {
                    child_id: "sub-1".to_string(),
                    session_name: "lane".to_string(),
                    last_assistant_text_preview: Some("done".to_string()),
                },
                1_000,
            )
        };
        serde_json::to_value(pa_types::session::AgentMessage::Custom(notice)).unwrap()
    }

    fn queued_user_item(message: &str) -> QueuedItem {
        QueuedItem {
            priority: QueuePriority::Human,
            message: message.to_string(),
            preview: None,
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        }
    }

    /// The queue-fold bug (operator 2026-09-25): parked RLM child status
    /// notices projected as user-like rows — one per exited child behind
    /// a busy turn. The snapshot now carries TYPED provenance: the lane
    /// strings stay the raw notice texts (the TS
    /// `queuedAgentMessagePreview` projection is unchanged), and the
    /// `rlmChildStatus` rider holds the indices of exactly the injected
    /// rows — a user-typed row with the same text never flags.
    #[tokio::test]
    async fn the_action_snapshot_flags_parked_child_status_notices() {
        let (worker, _) = snapshot_after_create().await;
        let notice_text =
            "[child-exited: no-reply child:lane]\n\nLast assistant text: done".to_string();
        let failure_text = "[child-failed child:lane]\n\nboom".to_string();
        {
            let mut core = worker.core.lock().unwrap();
            core.steering.push_back(queued_user_item("turn right"));
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Background,
                message: notice_text.clone(),
                custom_message: Some(child_status_notice_wire("terminal")),
                ..queued_user_item(&notice_text)
            });
            // A user-typed row with the exact notice text: unflagged.
            core.steering.push_back(queued_user_item(&notice_text));
            core.follow_up.push_back(QueuedItem {
                priority: QueuePriority::Background,
                message: failure_text.clone(),
                custom_message: Some(child_status_notice_wire("failure")),
                ..queued_user_item(&failure_text)
            });
            core.follow_up.push_back(queued_user_item("then summarize"));
        }
        let snapshot = {
            let core = worker.core.lock().unwrap();
            worker.snapshot_locked(&core)
        };
        assert_eq!(
            snapshot.steering,
            vec!["turn right", notice_text.as_str(), notice_text.as_str()],
            "the lane strings stay the raw texts"
        );
        assert_eq!(
            snapshot.follow_ups,
            vec![failure_text.as_str(), "then summarize"],
        );
        assert_eq!(
            snapshot.rlm_child_status.steering,
            vec![1],
            "only the injected terminal-notice row flags"
        );
        assert_eq!(
            snapshot.rlm_child_status.follow_up,
            vec![0],
            "the failure row flags on the follow-up lane"
        );
        assert_eq!(snapshot.queued_count, 5);
    }

    /// The real delivery route: the notice rides the follow-up command
    /// with the one-shot capability the daemon mints in this same worker
    /// process, and the parked row carries the typed provenance. The
    /// exact spoofs are answered loudly instead — the same command
    /// without a mint, and a replay of the consumed mint — while the
    /// same-text user row still parks as a plain row. That user row is
    /// human class while the minted notice is background, so admission
    /// priority parks the user row ahead of the notice; the rider names
    /// only the notice's lane slot, whichever position it holds.
    #[tokio::test]
    async fn a_follow_up_notice_parks_with_typed_provenance() {
        let (worker, _) = snapshot_after_create().await;
        let content =
            "[child-exited: no-reply child:lane]\n\nLast assistant text: done".to_string();
        let nonce = crate::child_status_notices::mint();
        let notice = worker
            .dispatch(
                "follow_up",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                    "rlmNoticeNonce": nonce,
                }),
            )
            .await;
        assert!(notice.success, "the notice follow-up parks: {notice:?}");
        let replay = worker
            .dispatch(
                "follow_up",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                    "rlmNoticeNonce": nonce,
                }),
            )
            .await;
        assert!(
            !replay.success,
            "the consumed mint is replay-proof: {replay:?}"
        );
        let spoofed = worker
            .dispatch(
                "follow_up",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                }),
            )
            .await;
        assert!(
            !spoofed.success,
            "a caller-supplied reserved-kind row is rejected, never parked: {spoofed:?}"
        );
        let plain = worker
            .dispatch("follow_up", &json!({ "message": content }))
            .await;
        assert!(plain.success, "the plain follow-up parks: {plain:?}");
        let snapshot = {
            let core = worker.core.lock().unwrap();
            worker.snapshot_locked(&core)
        };
        assert_eq!(
            snapshot.follow_ups,
            vec![content.as_str(), content.as_str()],
            "the notice and the same-text user row park their raw text"
        );
        assert_eq!(
            snapshot.rlm_child_status.follow_up,
            vec![1],
            "only the minted notice row flags: the same-text human row parks ahead of it"
        );
    }

    /// The spoof matrix (the operator's anti-spoof mandate): the exact
    /// reserved kinds are refused on every client admission surface —
    /// with no mint, with a guessed mint, and on `steer`/`prompt`
    /// regardless — while lookalike kinds (prefix, case, and fused
    /// variants) park as ordinary custom rows that never flag.
    #[tokio::test]
    async fn reserved_kind_spoofs_reject_and_lookalikes_park_unflagged() {
        let (worker, _) = snapshot_after_create().await;
        let content = "[child-exited: no-reply child:lane]".to_string();
        // No mint: both queue lanes refuse the exact reserved kinds.
        for command in ["steer", "follow_up"] {
            let spoof = worker
                .dispatch(
                    command,
                    &json!({
                        "message": content,
                        "customMessage": child_status_notice_wire("failure"),
                    }),
                )
                .await;
            assert!(
                !spoof.success,
                "{command} refuses the exact reserved kind: {spoof:?}"
            );
        }
        // A guessed mint is not a live mint.
        let guessed = worker
            .dispatch(
                "follow_up",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                    "rlmNoticeNonce": "00000000-0000-4000-8000-000000000000",
                }),
            )
            .await;
        assert!(
            !guessed.success,
            "a guessed nonce is no capability: {guessed:?}"
        );
        // The notice route is follow-up only: `prompt` refuses the
        // reserved kinds outright.
        let prompted = worker
            .dispatch(
                "prompt",
                &json!({
                    "message": content,
                    "customMessage": child_status_notice_wire("terminal"),
                }),
            )
            .await;
        assert!(
            !prompted.success,
            "prompt refuses the reserved kinds: {prompted:?}"
        );
        // Lookalike kinds are ordinary custom rows: they park, and the
        // rider never flags them (exact, case-sensitive matching).
        for lookalike in [
            "rlm_child_terminal_notice_v2",
            "RLM_CHILD_TERMINAL_NOTICE",
            "rlmchildterminalnotice",
        ] {
            let parked = worker
                .dispatch(
                    "follow_up",
                    &json!({
                        "message": content,
                        "customMessage": {
                            "role": "custom",
                            "customType": lookalike,
                            "content": "spoof",
                        },
                    }),
                )
                .await;
            assert!(
                parked.success,
                "the lookalike {lookalike} parks as an ordinary row: {parked:?}"
            );
        }
        let snapshot = {
            let core = worker.core.lock().unwrap();
            worker.snapshot_locked(&core)
        };
        assert_eq!(
            snapshot.follow_ups.len(),
            3,
            "the three lookalikes parked their raw text"
        );
        assert!(
            snapshot.rlm_child_status.follow_up.is_empty(),
            "no lookalike ever flags as child status"
        );
    }

    /// The rider serializes only when a notice is parked: a notice-free
    /// projection keeps the TS wire shape byte-for-byte (the field is
    /// skipped), and a parked notice rides the camelCase indices.
    #[test]
    fn the_rider_serializes_only_when_a_notice_is_parked() {
        let empty = SessionActionSnapshot::default();
        let wire = serde_json::to_value(&empty).unwrap();
        assert!(
            wire.get("rlmChildStatus").is_none(),
            "a notice-free projection stays the TS wire shape: {wire}"
        );
        let parked = SessionActionSnapshot {
            queued_count: 1,
            steering: vec!["[child-exited: no-reply child:lane]".to_string()],
            follow_ups: Vec::new(),
            rlm_child_status: crate::types::RlmChildStatusIndices {
                steering: vec![0],
                follow_up: Vec::new(),
            },
            active: None,
        };
        let wire = serde_json::to_value(&parked).unwrap();
        assert_eq!(
            wire["rlmChildStatus"],
            json!({ "steering": [0] }),
            "the rider carries the lane indices in camelCase, the empty lane omitted"
        );
    }

    /// The journal round-trip preserves the typed provenance: the restore
    /// re-derives the flag from the parked row's injected custom row (the
    /// record carries it), so a respawned worker's strip still folds the
    /// notice (operator safeguard: journal restore must preserve that).
    #[tokio::test]
    async fn restored_lane_rows_keep_the_child_status_provenance() {
        let (worker, _) = snapshot_after_create().await;
        let content =
            "[child-exited: no-reply child:lane]\n\nLast assistant text: done".to_string();
        worker.persist_queue_snapshot(
            "target-session",
            &QueueLanes {
                steering: vec![crate::journal::WorkerQueueItemRecord {
                    priority: Some(QueuePriority::Background),
                    message: content,
                    preview: None,
                    custom_message: Some(child_status_notice_wire("terminal")),
                    queue_key: None,
                    queue_visible: true,
                    policy: "queued".to_string(),
                }],
                follow_up: Vec::new(),
            },
        );
        let journal = WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap();
        let (steering, follow_up) = restore_queue_snapshot(&journal, "target-session");
        assert_eq!(steering.len(), 1);
        assert!(follow_up.is_empty());
        assert!(
            is_rlm_child_status_item(&steering[0]),
            "the restored row is still a flagged notice"
        );
        {
            let mut core = worker.core.lock().unwrap();
            core.steering = steering;
        }
        let snapshot = {
            let core = worker.core.lock().unwrap();
            worker.snapshot_locked(&core)
        };
        assert_eq!(snapshot.rlm_child_status.steering, vec![0]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn priority_test_item(message: &str, policy: TurnPolicy) -> QueuedItem {
        QueuedItem {
            message: message.to_string(),
            priority: QueuePriority::Human,
            preview: None,
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy,
            forced_batch: false,
        }
    }

    /// The delivery's relationship label is edge-derived: a subagent
    /// sender whose durable parent edge points at this session is a
    /// child; a subagent from another family never is, no matter its
    /// runtime kind (the mislabeled-ack regression — sibling lanes'
    /// messages must not render "from child:").
    #[test]
    fn sender_child_edge_decides_the_relationship_label() {
        let true_child = json!({
            "activeSessionId": "ddd444",
            "runtimeKind": "subagent",
            "parentSessionId": "sess-a",
        });
        assert!(sender_parent_edge_is(
            &true_child,
            Some("sess-a"),
            "aaa111",
            None
        ));
        let live_child = json!({
            "activeSessionId": "eee555",
            "runtimeKind": "subagent",
            "parentActiveSessionId": "aaa111",
        });
        assert!(sender_parent_edge_is(
            &live_child,
            Some("sess-a"),
            "aaa111",
            None
        ));
        let foreign_child = json!({
            "activeSessionId": "fff666",
            "runtimeKind": "subagent",
            "parentSessionId": "sess-zz",
        });
        assert!(!sender_parent_edge_is(
            &foreign_child,
            Some("sess-a"),
            "aaa111",
            None
        ));
        let edgeless = json!({ "activeSessionId": "ggg777", "runtimeKind": "subagent" });
        assert!(!sender_parent_edge_is(
            &edgeless,
            Some("sess-a"),
            "aaa111",
            None
        ));
        let moved_child = json!({
            "activeSessionId": "hhh888",
            "runtimeKind": "subagent",
            "parentSessionPath": "/old/root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl",
        });
        assert!(sender_parent_edge_is(
            &moved_child,
            Some("sess-a"),
            "aaa111",
            Some(std::path::Path::new(
                "/new/root/sessions/01a0d0a5-e954-71b7-8479-8dc7980768a1.jsonl"
            )),
        ));
    }

    /// A message-less top-level session is a draft (hidden from the agents
    /// view); a session with messages is live; a resident subagent is live
    /// before its first message (TS `activeLifecycleForSession`).
    #[test]
    fn summary_lifecycle_is_message_based() {
        let empty = SessionCore::test_core(None, "/tmp".to_string());
        assert_eq!(
            session_summary(&empty, "default", None, None, /*bash_running=*/ false).lifecycle,
            "draft"
        );
        let mut subagent = SessionCore::test_core(None, "/tmp".to_string());
        subagent.runtime_kind = "subagent".to_string();
        assert_eq!(
            session_summary(&subagent, "default", None, None, /*bash_running=*/ false).lifecycle,
            "live"
        );
        // The busy-flip roster delta fires before the store flushes the
        // admitted prompt; a busy turn is live at that wire moment (TS
        // reads the runtime's in-memory messages, which already hold it).
        let mut busy = SessionCore::test_core(None, "/tmp".to_string());
        busy.busy = true;
        busy.running_tool_calls.insert("call-1".to_string());
        // `isRunningTools` is the streaming gate over the in-flight tool
        // set (TS `isStreaming && pendingToolCalls.size > 0`): tools in
        // flight read true only while the turn streams.
        assert!(
            session_summary(&busy, "default", None, None, /*bash_running=*/ false).is_running_tools
        );
        busy.running_tool_calls.clear();
        assert!(
            !session_summary(&busy, "default", None, None, /*bash_running=*/ false)
                .is_running_tools
        );
        busy.running_tool_calls.insert("call-1".to_string());
        busy.busy = false;
        assert!(
            !session_summary(&busy, "default", None, None, /*bash_running=*/ false)
                .is_running_tools
        );
        // The user bash state rides the summary as its own flag (TS
        // `session.isBashRunning`).
        assert_eq!(
            session_summary(&busy, "default", None, None, /*bash_running=*/ true).is_bash_running,
            Some(true)
        );
        busy.busy = true;
        assert_eq!(
            session_summary(&busy, "default", None, None, /*bash_running=*/ false).lifecycle,
            "live"
        );
        let dir = std::env::temp_dir().join(format!("pa-worker-lc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
        let path = dir.join(crate::session_store::session_file_name(
            session.session_id(),
        ));
        session.set_path(path);
        session.append_message(serde_json::json!({
            "role": "user", "content": "hi", "timestamp": 1u64
        }));
        session.rewrite().unwrap();
        let with_message = SessionCore::test_core(Some(session), "/tmp".to_string());
        assert_eq!(
            session_summary(
                &with_message,
                "default",
                None,
                None,
                /*bash_running=*/ false
            )
            .lifecycle,
            "live"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- post-abort/post-compact queued-input suspension (TS parity) ---

    /// A created worker over the scripted engine (the dispatch surface the
    /// suspension tests drive).
    async fn created_dispatch_worker() -> std::sync::Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-susp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "suspension-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "suspension" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// `abort` (TS `requestAbort`) suspends queued-input admission: a plain
    /// prompt is rejected with the TS admission error until a resume site
    /// fires (a `steer` carries `resumeIfIdle: true`), after which a plain
    /// prompt is admitted again.
    #[tokio::test]
    async fn abort_suspends_plain_prompts_until_steer_resumes() {
        let worker = created_dispatch_worker().await;
        let aborted = worker.dispatch("abort", &json!({})).await;
        assert!(aborted.success, "abort failed: {aborted:?}");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert!(!rejected.success, "admitted while suspended: {rejected:?}");
        assert_eq!(rejected.command, "prompt_and_wait");
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
        let rejected_prompt = worker
            .dispatch(
                "prompt",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert_eq!(
            rejected_prompt.error.as_deref(),
            Some(QUEUED_INPUT_SUSPENDED)
        );
        // A prompt carrying streamingBehavior is a resume site (TS
        // `resumeIfIdle: command.streamingBehavior !== undefined`).
        let admitted_with_behavior = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "suspension-session",
                    "message": "steered",
                    "streamingBehavior": "steer"
                }),
            )
            .await;
        assert!(
            admitted_with_behavior.success,
            "steer not admitted: {admitted_with_behavior:?}"
        );
        let plain = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "plain again" }),
            )
            .await;
        assert!(plain.success, "still suspended after steer: {plain:?}");
    }

    /// A manual `compact` aborts first (TS `compact()`), so the
    /// suspension is set whatever the compaction outcome (the scripted
    /// engine always compacts; TS skips only "Session is too short" and
    /// the skip path leaves the suspension set too);
    /// `resume_queue` clears it before answering the empty queue (TS
    /// `resumeQueuedWork()` runs `_resumeSessionInputAdmission()`
    /// unconditionally).
    #[tokio::test]
    async fn compact_suspends_and_resume_queue_clears() {
        let worker = created_dispatch_worker().await;
        let compact = worker
            .dispatch(
                "compact",
                &json!({ "activeSessionId": "suspension-session" }),
            )
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
        let resumed = worker.dispatch("resume_queue", &json!({})).await;
        assert!(
            !resumed.success,
            "resume_queue on the empty queue must still answer the TS failure: {resumed:?}"
        );
        assert_eq!(resumed.error.as_deref(), Some("No queued work to resume"));
        let plain = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "after resume" }),
            )
            .await;
        assert!(
            plain.success,
            "still suspended after resume_queue: {plain:?}"
        );
    }

    /// `abort_and_send_queued` (TS `abortAndSendQueued`, schema 29): with
    /// visible steering parked at a running turn's boundary, the interrupt
    /// aborts the run AND delivers the parked queue right after the aborted
    /// turn settles (TS `requestAbort()` + `resumeQueuedWork()`); the
    /// follow-up lane drains too, once the session goes idle. The aborted
    /// turn's row surfaces with the aborted shape.
    #[tokio::test]
    // the faux registry is process-global: the guard must span the async flow
    #[allow(clippy::await_holding_lock)]
    async fn abort_and_send_queued_delivers_the_parked_queue_at_the_boundary() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-abort-send-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "abort-send-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "text": "held reply", "delayMs": 60000 },
                    "steering one reply",
                    "steering two reply",
                    "follow-up reply",
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "abort-send" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        // The held turn parks the queue behind it (60s fetch hold).
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "abort-send-session",
                    "message": "held turn for the abort-and-send probe",
                }),
            )
            .await;
        assert!(prompt.success, "prompt failed: {prompt:?}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if worker.core.lock().unwrap().busy {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the held turn was never admitted"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // Parked steering and one follow-up behind the running turn.
        for message in ["steering one", "steering two"] {
            let steered = worker
                .dispatch("steer", &json!({ "message": message }))
                .await;
            assert!(steered.success, "steer failed: {steered:?}");
        }
        let follow = worker
            .dispatch("follow_up", &json!({ "message": "follow-up now" }))
            .await;
        assert!(follow.success, "follow_up failed: {follow:?}");
        // The interrupt: abort the run and send the parked queue.
        let aborted = worker.dispatch("abort_and_send_queued", &json!({})).await;
        assert!(aborted.success, "abort_and_send_queued failed: {aborted:?}");
        assert_eq!(aborted.command, "abort_and_send_queued");
        let idle = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            worker.dispatch("wait_for_idle", &json!({})),
        )
        .await;
        assert!(idle.is_ok(), "the session never went idle after the abort");
        assert!(idle.unwrap().success, "wait_for_idle failed");
        // The held turn aborted (its row carries the aborted shape) and
        // the parked queue delivered: steering one, steering two, then the
        // follow-up, each answered by its scripted reply.
        let messages = worker.dispatch("get_messages", &json!({})).await;
        assert!(messages.success, "get_messages failed: {messages:?}");
        let wire_messages = messages
            .data
            .as_ref()
            .and_then(|data| data.get("messages"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let texts: Vec<String> = wire_messages
            .iter()
            .filter(|message| crate::types::message_role(message) == Some("user"))
            .map(crate::types::message_text)
            .collect();
        assert_eq!(
            texts,
            [
                "held turn for the abort-and-send probe",
                "steering one",
                "steering two",
                "follow-up now",
            ],
            "the parked queue never delivered in order: {texts:?}"
        );
        // The one-batched-turn granularity (the steer-family lane's
        // supersede of this test's original reply-granularity
        // expectations): the two parked steers deliver as ONE co-delivered
        // turn — a single `agent_start` for both rows and ONE assistant
        // reply for the whole batch — exactly TS `abortAndSendQueued`'s
        // armed batch (`_forcedAllSteeringActionIds` +
        // `_startPreparedTurnActions`); the follow-up stays a turn of its
        // own behind it.
        let events = session_events_since(&mut subscription);
        let agent_starts = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .count();
        assert_eq!(
            agent_starts, 3,
            "the held turn, the steers' ONE batched turn, the follow-up's: {events:?}"
        );
        let replies: Vec<String> = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"].get("stopReason").and_then(Value::as_str) != Some("aborted")
            })
            .filter_map(|event| {
                let message = event.get("message")?;
                let content = message.get("content")?;
                content
                    .as_array()
                    .and_then(|parts| parts.first())
                    .and_then(|part| part.get("text"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        // The batch's one reply is the next scripted response; the
        // follow-up's turn takes the one after it - the steers never
        // consume one reply each.
        assert_eq!(
            replies,
            [
                "steering one reply".to_string(),
                "steering two reply".to_string()
            ],
            "ONE reply for the whole steers' batch, one for the follow-up: {events:?}"
        );
        assert!(
            events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == "aborted"
            }),
            "the held turn never surfaced its aborted row: {events:?}"
        );
        // The queue drained and the suspension is gone (a plain prompt is
        // admissible again, unlike the plain-abort path).
        let queue = worker.dispatch("get_queue", &json!({})).await;
        assert!(queue.success, "get_queue failed: {queue:?}");
        let lanes = queue.data.as_ref().expect("the queue lanes");
        assert_eq!(lanes["steering"], json!([]), "queue: {queue:?}");
        assert_eq!(lanes["followUp"], json!([]), "queue: {queue:?}");
        assert!(
            !worker.core.lock().unwrap().queued_input_suspended,
            "the abort-and-send suspension never cleared"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The abort-only arm: `abort_and_send_queued` with no visible steering
    /// parked is a plain abort (TS `queuedSteering.length === 0` ->
    /// `requestAbort()` + `return false`) - the queued-input suspension
    /// stays set, so a plain prompt is rejected until a resume site fires.
    #[tokio::test]
    async fn abort_and_send_queued_with_an_empty_queue_is_a_plain_abort() {
        let worker = created_dispatch_worker().await;
        let aborted = worker.dispatch("abort_and_send_queued", &json!({})).await;
        assert!(aborted.success, "abort_and_send_queued failed: {aborted:?}");
        assert_eq!(aborted.command, "abort_and_send_queued");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert!(
            !rejected.success,
            "admitted after the abort-only abort: {rejected:?}"
        );
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
    }

    /// A follow-up-only queue keeps flowing after the abort (the
    /// sanctioned divergence): the abort ends the running turn cleanly
    /// and the OLDEST queued follow-up starts the next turn right after
    /// the aborted turn settles; later follow-ups stay queued and drain
    /// one per completed turn, each row delivered exactly once, in
    /// enqueue order.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    async fn abort_and_send_queued_with_only_follow_ups_starts_the_oldest() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!("pa-worker-abort-fu-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "abort-fu-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "text": "held reply", "delayMs": 60000 },
                    { "text": "follow-up one reply", "delayMs": 1500 },
                    "follow-up two reply",
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "abort-fu" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "abort-fu-session",
                    "message": "held turn for the follow-up abort probe",
                }),
            )
            .await;
        assert!(prompt.success, "prompt failed: {prompt:?}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if worker.core.lock().unwrap().busy {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the held turn was never admitted"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // Two follow-ups park behind the running turn and the steering
        // lane stays empty — the interrupt keeps nothing armable, the
        // exact shape of the follow-up-only abort.
        for message in ["follow-up one", "follow-up two"] {
            let follow = worker
                .dispatch("follow_up", &json!({ "message": message }))
                .await;
            assert!(follow.success, "follow_up failed: {follow:?}");
        }
        // The interrupt: the abort ends the held turn and the queue
        // keeps flowing — the follow-up lane never parks behind the
        // abort's suspension.
        let aborted = worker.dispatch("abort_and_send_queued", &json!({})).await;
        assert!(aborted.success, "abort_and_send_queued failed: {aborted:?}");
        assert_eq!(aborted.command, "abort_and_send_queued");
        assert!(
            !worker.core.lock().unwrap().queued_input_suspended,
            "the abort must resume a follow-up-only queue"
        );
        // The OLDEST follow-up starts the next turn right after the
        // aborted turn settles (its paced reply holds the turn open):
        // while it runs, the second follow-up stays queued — the lane
        // drains one turn per completed turn, never as one batch.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let (busy, queued) = {
                let core = worker.core.lock().unwrap();
                (core.busy, core.follow_up.len())
            };
            if busy && queued == 1 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the oldest follow-up never started while the second stayed queued"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let queue = worker.dispatch("get_queue", &json!({})).await;
        assert!(queue.success, "get_queue failed: {queue:?}");
        assert_eq!(
            queue.data.as_ref().expect("the queue lanes")["followUp"],
            json!(["follow-up two"]),
            "the second follow-up must stay queued behind the first: {queue:?}"
        );
        let idle = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            worker.dispatch("wait_for_idle", &json!({})),
        )
        .await;
        assert!(
            idle.is_ok(),
            "the follow-up-only queue never drained after the abort"
        );
        assert!(idle.unwrap().success, "wait_for_idle failed");
        // Both follow-ups delivered in enqueue order, each row exactly
        // once, each in its own turn behind the aborted run.
        let messages = worker.dispatch("get_messages", &json!({})).await;
        assert!(messages.success, "get_messages failed: {messages:?}");
        let wire_messages = messages
            .data
            .as_ref()
            .and_then(|data| data.get("messages"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let texts: Vec<String> = wire_messages
            .iter()
            .filter(|message| crate::types::message_role(message) == Some("user"))
            .map(crate::types::message_text)
            .collect();
        assert_eq!(
            texts,
            [
                "held turn for the follow-up abort probe",
                "follow-up one",
                "follow-up two",
            ],
            "the follow-ups never drained in enqueue order: {texts:?}"
        );
        let events = session_events_since(&mut subscription);
        let agent_start_indexes: Vec<usize> = events
            .iter()
            .enumerate()
            .filter(|(_, event)| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(
            agent_start_indexes.len(),
            3,
            "one turn per follow-up, never a merged batch: {events:?}"
        );
        let aborted_row = events
            .iter()
            .position(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"].get("stopReason").and_then(Value::as_str) == Some("aborted")
            })
            .expect("the held turn never surfaced its aborted row");
        assert!(
            aborted_row < agent_start_indexes[1],
            "the abort must end the held turn before the first follow-up's turn starts: {events:?}"
        );
        let replies: Vec<String> = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"].get("stopReason").and_then(Value::as_str) != Some("aborted")
            })
            .filter_map(|event| {
                let message = event.get("message")?;
                let content = message.get("content")?;
                content
                    .as_array()
                    .and_then(|parts| parts.first())
                    .and_then(|part| part.get("text"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        assert_eq!(
            replies,
            [
                "follow-up one reply".to_string(),
                "follow-up two reply".to_string()
            ],
            "one reply per follow-up turn: {events:?}"
        );
        {
            let core = worker.core.lock().unwrap();
            assert!(
                core.steering.is_empty() && core.follow_up.is_empty(),
                "the queue must fully drain"
            );
            assert!(
                !core.queued_input_suspended,
                "the resume never cleared the suspension"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A scripted goal session's dispatch worker (the goal section feeds
    /// `goal_state_value` and the post-compaction mint).
    async fn goal_dispatch_worker(goal: serde_json::Value) -> std::sync::Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-goal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "goal-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "responses": ["ack"],
                "goal": goal,
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "goal" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// The session events seen by an attached client since `mark`, in wire
    /// order (the frames carry one `event` payload each).
    fn session_events_since(
        subscription: &mut tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
    ) -> Vec<Value> {
        let mut events = Vec::new();
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type == "session_event" {
                if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                    events.push(outbound["event"].clone());
                }
            }
        }
        events
    }

    /// TS `compact()`'s `didCompact` + active-goal branch: a successful
    /// compact on a session with an active goal mints the owed goal
    /// continuation (`resumeQueuedWork()`'s
    /// `_maybeResumeGoalContinuationAfterRlmWork` — the minted follow-up
    /// with the goal-context row), clears the queued-input suspension, and
    /// the scheduled continue drives the turn: the continuation runs
    /// (agent rows on the wire), the queue drains, and the session is
    /// admitted for plain prompts again (the resume site crossed the #234
    /// suspension gate).
    #[tokio::test]
    async fn compact_with_active_goal_schedules_the_continue() {
        let worker = goal_dispatch_worker(json!({
            "status": "active",
            "objective": "land the post-compact continue",
            "message": "[goal: continuation]\n\nkeep pursuing the goal",
        }))
        .await;
        let mut subscription = worker.events.subscribe();
        let compact = worker
            .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        // The scheduled continue drives the continuation turn; the idle
        // wait settles only after it ran.
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        let events = session_events_since(&mut subscription);
        // The mint's `goal_update` surfaces at the moment the state
        // changed, then the continuation turn: the goal-context custom row
        // plus its model turn (the scripted engine's rows).
        let goal_updates: Vec<&Value> = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("goal_update"))
            .collect();
        assert_eq!(goal_updates.len(), 1, "events: {events:?}");
        assert_eq!(goal_updates[0]["goal"]["status"], "active");
        let custom_rows: Vec<&Value> = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["customType"] == "goal_context"
            })
            .collect();
        assert_eq!(custom_rows.len(), 1, "events: {events:?}");
        assert_eq!(
            custom_rows[0]["message"]["content"],
            "[goal: continuation]\n\nkeep pursuing the goal"
        );
        assert!(
            events
                .iter()
                .any(|event| event.get("type").and_then(Value::as_str) == Some("turn_end")),
            "the continuation turn never ran: {events:?}"
        );
        // The resume site crossed the #234 suspension gate: a plain prompt
        // is admitted again.
        let plain = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "goal-session", "message": "after the continue" }),
            )
            .await;
        assert!(plain.success, "still suspended: {plain:?}");
    }

    /// Queued work parked at compact time owns the continue (TS's `||=`
    /// sets the owed-continuation flag only when the agent has NO queued
    /// messages): no fresh goal continuation is minted, the resume site
    /// releases the parked work, and the parked turn runs instead.
    #[tokio::test]
    async fn compact_with_active_goal_and_parked_work_skips_the_mint() {
        let worker = goal_dispatch_worker(json!({
            "status": "active",
            "objective": "land the post-compact continue",
        }))
        .await;
        let mut subscription = worker.events.subscribe();
        {
            // Park one queued follow-up behind the suspension gate, like a
            // steer that arrived mid-compact-window.
            let mut core = worker.core.lock().unwrap();
            core.queued_input_suspended = true;
            core.follow_up.push_back(QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "parked queued work".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
            });
        }
        let compact = worker
            .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        let events = session_events_since(&mut subscription);
        // The parked item's turn ran (its user row), not a minted
        // continuation (no goal_context row, no goal_update).
        assert!(
            events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["role"] == "user"
                    && event["message"]["content"] == "parked queued work"
            }),
            "the parked item never ran: {events:?}"
        );
        assert!(
            !events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["customType"] == "goal_context"
            }),
            "a continuation was minted over the parked work: {events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|event| event.get("type").and_then(Value::as_str) == Some("goal_update")),
            "a mint emitted a goal_update: {events:?}"
        );
    }

    /// Only an ACTIVE goal schedules the continue (TS checks
    /// `this._goalState.status === "active"`): a paused goal leaves the
    /// post-compact suspension set and mints nothing.
    #[tokio::test]
    async fn compact_with_paused_goal_never_continues() {
        let worker = goal_dispatch_worker(json!({
            "status": "paused",
            "objective": "land the post-compact continue",
        }))
        .await;
        let mut subscription = worker.events.subscribe();
        let compact = worker
            .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "goal-session", "message": "hi" }),
            )
            .await;
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
        let events = session_events_since(&mut subscription);
        assert!(
            !events
                .iter()
                .any(|event| event.get("type").and_then(Value::as_str) == Some("goal_update")),
            "a paused goal minted a continuation: {events:?}"
        );
    }

    /// The goal continuation loop at the natural turn end (TS
    /// `_getGoalContinuationMessages` + `_getContinuationMessages`): a
    /// multi-continuation goal session driven to completion end to end
    /// through the worker. The turn runner's queue drives each minted
    /// continuation (the engine consults at every settled boundary, the
    /// admission sink queues the follow-up, the runner wakes), the
    /// budget-free loop keeps prompting until the kernel's
    /// `goal.complete()` (the scripted ipython tool call, the f18
    /// completion surface) settles the goal, and the completion's
    /// boundary mints nothing more. The completing cell needs a
    /// bootable kernel: a sandbox gate run must provide uv and
    /// `PI_PACKAGE_DIR` at the checkout (the guard inside names the
    /// recipe when the cell fails instead of letting the loop drain
    /// the faux script into a misleading count mismatch).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn goal_turn_end_loop_runs_to_completion() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-goal-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "goal-loop-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    "first pursuit turn",
                    "second pursuit turn",
                    { "content": [
                        { "type": "toolCall", "name": "ipython",
                          "arguments": { "code": "import goal; await goal.complete()" } },
                    ] },
                    "wrap-up after the completion",
                    "after the loop settled",
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "goal-loop" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        let start = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "goal-loop-session",
                    "message": "/goal drive the loop to completion",
                }),
            )
            .await;
        assert!(start.success, "the goal start failed: {start:?}");
        // The loop owns the session until the goal settles: the idle wait
        // returns only when the completion turn's boundary minted nothing.
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "the goal loop never settled: {idle:?}");
        let events = session_events_since(&mut subscription);
        // A gate run without the kernel environment (uv on PATH and
        // PI_PACKAGE_DIR at the checkout — docs/parity-battery.md,
        // "Sandbox-built rust binary + kernel runtime") fails the
        // completing ipython cell: the goal stays active and the loop
        // keeps minting (TS parity: goal continuations are unbounded while
        // the goal is active) until the faux script runs dry. Fail with
        // the diagnosis instead of the misleading continuation-count
        // mismatch.
        let kernel_failure = events.iter().find(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_end")
                && event["message"]["role"] == "toolResult"
                && event["message"]["isError"] == json!(true)
        });
        if let Some(failure) = kernel_failure {
            panic!(
                "the completing ipython cell failed — this test needs the kernel \
                 environment (uv on PATH and PI_PACKAGE_DIR at the checkout; \
                 docs/parity-battery.md, \"Sandbox-built rust binary + kernel \
                 runtime\"): {failure:?}"
            );
        }
        // Each minted continuation ran as a queued follow-up turn: the
        // start row plus two continuation rows (the completion turn is the
        // second continuation's turn).
        let goal_rows: Vec<&Value> = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["customType"] == "goal_context"
            })
            .collect();
        assert_eq!(goal_rows.len(), 3, "events: {events:?}");
        assert_eq!(goal_rows[0]["message"]["details"]["kind"], "continuation");
        assert_eq!(goal_rows[1]["message"]["details"]["continuationsUsed"], 1);
        assert_eq!(goal_rows[2]["message"]["details"]["continuationsUsed"], 2);
        // The model turns all settled: the start turn, two continuation
        // turns, and the completing tool-call turn's own assistant
        // segments ride the wire as assistant rows.
        let assistant_rows = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
            })
            .count();
        assert!(assistant_rows >= 4, "events: {events:?}");
        // The goal state settled complete (the kernel completion through
        // the worker's host handlers), with the loop's counts on the books.
        let complete_update = events
            .iter()
            .rev()
            .find(|event| {
                event.get("type").and_then(Value::as_str) == Some("goal_update")
                    && event["goal"]["status"] == "complete"
            })
            .expect("the completion surfaced as a goal_update");
        assert_eq!(
            complete_update["goal"]["objective"],
            "drive the loop to completion"
        );
        assert_eq!(complete_update["goal"]["continuationsUsed"], 2);
        assert!(
            complete_update["goal"]["tokensUsed"].as_u64().unwrap_or(0) > 0,
            "usage accounting ran: {complete_update:?}"
        );
        // The completion's boundary mints nothing: the queue is empty and
        // a plain prompt is admitted again.
        let queue = worker
            .dispatch(
                "get_queue",
                &json!({ "activeSessionId": "goal-loop-session" }),
            )
            .await;
        assert!(queue.success, "queue read failed: {queue:?}");
        let plain = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "goal-loop-session",
                    "message": "after the loop",
                }),
            )
            .await;
        assert!(plain.success, "a post-goal prompt failed: {plain:?}");
    }

    /// The aborted turn's row through the worker gate (the #245 flagged
    /// gap: TS broadcasts AND persists it, the gate used to drop it): a
    /// turn aborted mid-provider-wait settles on its aborted assistant
    /// row, and the gate forwards the row — the attached client sees the
    /// row's `message_start/message_end` pair (stopReason "aborted", the
    /// abort error, EMPTY usage) and the session file holds the same
    /// row — while the active goal's accounting skips it (the state the
    /// goal-start turn left is unchanged after the abort).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn aborted_turn_row_broadcasts_and_persists_through_the_worker_gate() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-aborted-row-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "aborted-row-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    "goal start reply",
                    { "text": "held reply", "delayMs": 60000 },
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "aborted-row" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        // `/goal`: the goal-start continuation turn runs to completion
        // inside the prompt, its usage accounted.
        let start = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "aborted-row-session",
                    "message": "/goal land the aborted row accounting",
                }),
            )
            .await;
        assert!(start.success, "the goal start failed: {start:?}");
        let goal_before = worker.engine.goal_state_value();
        assert_eq!(
            goal_before["status"],
            json!("active"),
            "state: {goal_before:?}"
        );
        assert!(
            goal_before["tokensUsed"].as_u64().unwrap_or(0) > 0,
            "the goal-start turn's usage accounted: {goal_before:?}"
        );
        // The turn-end mint queues the next continuation; the runner
        // admits it and its goal-context row rides the wire, then the
        // provider fetch holds (the 60s reply).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let events = session_events_since(&mut subscription);
            let admitted = events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["customType"] == "goal_context"
                    && event["message"]["details"]["continuationsUsed"] == json!(1)
            });
            if admitted {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the continuation turn was never admitted"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        // Let the admitted turn reach the provider: the held reply keeps
        // the fetch in flight, so the abort lands mid-provider-wait (the
        // eager fetch cancel) and the turn settles on its aborted row.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let abort = worker.dispatch("abort", &json!({})).await;
        assert!(abort.success, "abort failed: {abort:?}");
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        // The attached client saw the row's pair: the row's own start
        // frame (a no-partial abort begins a new message) and the settled
        // end frame with the aborted shape.
        let events = session_events_since(&mut subscription);
        let aborted_start = events
            .iter()
            .find(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_start")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == json!("aborted")
            })
            .cloned()
            .expect("the aborted row's start frame reached the wire");
        assert_eq!(
            aborted_start["message"]["errorMessage"],
            json!("Request was aborted")
        );
        let aborted_end = events
            .iter()
            .rev()
            .find(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == json!("aborted")
            })
            .cloned()
            .expect("the aborted row's end frame reached the wire");
        let row = &aborted_end["message"];
        assert_eq!(row["errorMessage"], json!("Request was aborted"));
        assert_eq!(row["usage"]["totalTokens"], json!(0));
        assert_eq!(row["usage"]["input"], json!(0));
        assert_eq!(row["usage"]["output"], json!(0));
        assert_eq!(row["content"], json!([{ "type": "text", "text": "" }]));
        // The terminal `turn_end` frame follows the row's pair (TS
        // `turn_end` on an aborted turn): the aborted assistant row is
        // the frame's payload with the turn's empty tool-result list, and
        // the trailing `Done` stays silent (no second, bare frame).
        let aborted_turn_end = events
            .iter()
            .rev()
            .find(|event| event.get("type").and_then(Value::as_str) == Some("turn_end"))
            .cloned()
            .expect("the aborted turn's turn_end frame reached the wire");
        assert_eq!(aborted_turn_end["message"], *row);
        assert_eq!(aborted_turn_end["toolResults"], json!([]));
        assert_eq!(aborted_turn_end.get("error"), None);
        // No bare trailing frame after the payload one: the aborted
        // turn's terminal `turn_end` is the only frame of this window's
        // aborted turn (the `Done` fallback stays silent).
        let bare_turn_end_count = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("turn_end")
                    && event.get("message").is_none()
            })
            .count();
        assert_eq!(
            bare_turn_end_count, 0,
            "no bare turn_end frames: {events:?}"
        );
        // The row persisted: the session file holds the same aborted
        // assistant row (TS `appendMessage` at the message_end hook).
        let store_row = {
            let core = worker.core.lock().unwrap();
            core.store
                .as_ref()
                .expect("the worker owns a session file")
                .messages()
                .into_iter()
                .rev()
                .find(|message| {
                    message.get("role").and_then(Value::as_str) == Some("assistant")
                        && message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                })
                .expect("the aborted row persisted in the session file")
        };
        assert_eq!(store_row["errorMessage"], json!("Request was aborted"));
        assert_eq!(store_row["usage"]["totalTokens"], json!(0));
        assert_eq!(
            store_row["content"],
            json!([{ "type": "text", "text": "" }])
        );
        // The goal accounting skipped the row (TS
        // `_accountGoalUsageForAssistantMessage`'s aborted guard): the
        // accounting fields are the state the goal-start turn left (the
        // wall-clock fields are time-based).
        let goal_after = worker.engine.goal_state_value();
        assert_eq!(
            goal_after["status"],
            json!("active"),
            "state: {goal_after:?}"
        );
        assert_eq!(goal_after["tokensUsed"], goal_before["tokensUsed"]);
        assert_eq!(
            goal_after["continuationsUsed"],
            goal_before["continuationsUsed"]
        );
        assert_eq!(goal_after["objective"], goal_before["objective"]);
    }

    /// The killed close's schedule cancel (TS `cancelScheduledJobsForSession`
    /// at `closeSessionOnce("killed")`): a session with an active heartbeat
    /// job dies at kill — the job cancels durably and the session file
    /// archives, so no scheduled wake can revive the stopped session (the
    /// zombie fix's stop-side gate).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn kill_cancels_the_sessions_scheduled_jobs() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-kill-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sessions_dir = dir.join("sessions");
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "kill-jobs-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "engine": "faux", "responses": [] })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({
                    "cwd": dir.to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                    "name": "kill-jobs",
                }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let data = created.data.expect("the create answers a summary");
        let session_id = data.get("sessionId").and_then(Value::as_str).expect("id");
        let session_file = data
            .get("sessionFile")
            .and_then(Value::as_str)
            .expect("session file");
        // A lane-liveness heartbeat on the session's artifact store.
        let job = worker
            .scheduled
            .store()
            .create(&pa_core::cron::store::CreateAgentCronJobInput {
                active_session_id: "kill-jobs-session".to_string(),
                session_id: session_id.to_string(),
                session_file: session_file.to_string(),
                cwd: dir.to_string_lossy().to_string(),
                prompt: "lane-liveness ping".to_string(),
                schedule_text: "every 10s".to_string(),
                source: Some("rlm_heartbeat".to_string()),
                now: Some(1),
                ..Default::default()
            })
            .expect("the store creates the job");
        assert_eq!(job.status, pa_core::cron::JobStatus::Active);

        let killed = worker.dispatch("kill", &json!({})).await;
        assert!(killed.success, "kill failed: {killed:?}");

        // The job cancelled durably: no later fire can wake the session.
        let stored = worker.scheduled.store().list();
        let cancelled = stored
            .iter()
            .find(|candidate| candidate.id == job.id)
            .expect("the job stays in the store");
        assert_eq!(cancelled.status, pa_core::cron::JobStatus::Cancelled);
        assert_eq!(cancelled.next_run_at, None);
        // The close archived the session file (the wake scan's state gate).
        let info =
            crate::session_store::read_session_info(std::path::Path::new(session_file)).unwrap();
        assert_eq!(info.state.as_deref(), Some("archived"));
    }

    /// The `kill` path (the #247 residue, probe-verified): TS
    /// `closeSessionOnce("killed")` fires `session.abort()` —
    /// `requestAbort()` -> `agent.abort()` — whose run-cancel lands before
    /// every close step that can wait on the running turn, so a kill during
    /// a mid-provider-wait turn cancels the fetch immediately instead of
    /// streaming the held reply out and answering the kill only after the
    /// turn settled naturally (the probe showed the blocked archive
    /// holding the kill 15s past the request). The #247 matrix holds:
    /// the aborted row still broadcasts and persists, the `archived`
    /// lifecycle entry lands ahead of the row in the session file (TS
    /// `archiveSession` precedes the abort), and the close reaches the
    /// wire as a `session_closed` frame.
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn kill_cancels_a_mid_provider_wait_turn_and_surfaces_the_aborted_row() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-kill-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "kill-path-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "text": "held reply", "delayMs": 60000 },
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "kill-path" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        // The turn runs detached (`prompt` answers immediately): its fetch
        // holds on the 60s reply, so the kill below lands mid-provider-wait.
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "kill-path-session",
                    "message": "held turn for the kill probe",
                }),
            )
            .await;
        assert!(prompt.success, "prompt failed: {prompt:?}");
        // The turn is mid-provider-wait once the runner is busy on it: the
        // held reply (60s) keeps the fetch in flight, so no assistant
        // message_start arrives before the kill (the row only starts at
        // the abort). The busy flag is the runner's own admission marker
        // (`await_session_work_settled` parks on the same flag).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if worker.core.lock().unwrap().busy {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the held turn was never admitted"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // The kill must answer on the cancelled turn, not the 60s hold:
        // the abort funnel fires before the archive/dispose work waits on
        // the session mutex the turn holds.
        let started = std::time::Instant::now();
        let killed = worker.dispatch("kill", &json!({})).await;
        assert!(killed.success, "kill failed: {killed:?}");
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(15),
            "kill waited out the held provider response ({elapsed:?})"
        );
        // The aborted row surfaced (the #247 matrix): the wire carries its
        // message_start/message_end pair with the aborted shape. Drain
        // every session-event frame: wrapped session events expose their
        // inner `event`; the close rides the same outbound type as the
        // whole frame (`emit_session_closed` sends the SessionClosed
        // payload without an `event` wrapper), so it must surface whole.
        let mut events = Vec::new();
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type != "session_event" {
                continue;
            }
            let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) else {
                continue;
            };
            match outbound.get("event") {
                Some(event) if event.is_object() => events.push(event.clone()),
                _ => events.push(outbound),
            }
        }
        let aborted_end = events
            .iter()
            .rev()
            .find(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == json!("aborted")
            })
            .cloned()
            .expect("the aborted row's end frame reached the wire");
        assert_eq!(
            aborted_end["message"]["errorMessage"],
            json!("Request was aborted")
        );
        // The close reached the wire as `session_closed` (reason "killed").
        assert!(
            events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("session_closed")
                    && event.get("reason").and_then(Value::as_str) == Some("killed")
            }),
            "the kill closed the session on the wire: {events:?}"
        );
        // The durable store: the aborted assistant row persisted, and the
        // `archived` lifecycle entry lands ahead of it (TS
        // `archiveSession` -> `appendSessionState` runs before the abort
        // settles the row).
        let entries = {
            let core = worker.core.lock().unwrap();
            core.store
                .as_ref()
                .expect("the worker owns a session file")
                .entries()
                .to_vec()
        };
        let archived_at = entries
            .iter()
            .position(|entry| {
                entry.type_ == "session_state"
                    && entry.fields["state"]["status"] == json!("archived")
            })
            .expect("the session archived on kill");
        let aborted_at = entries
            .iter()
            .position(|entry| {
                entry.type_ == "message"
                    && entry.fields["message"]["role"] == json!("assistant")
                    && entry.fields["message"]["stopReason"] == json!("aborted")
            })
            .expect("the aborted row persisted in the session file");
        assert!(
            archived_at < aborted_at,
            "the archived lifecycle entry must precede the aborted row"
        );
        assert_eq!(
            entries[aborted_at].fields["message"]["errorMessage"],
            json!("Request was aborted")
        );
        // The session is closed: `created` fell with the archive.
        assert!(!worker.core.lock().unwrap().created);
    }

    /// The compact path swallows the interrupted turn's aborted row (TS
    /// `compact()` detaches from agent events — `_disconnectFromAgent()`
    /// — before the abort, so the row never reaches the wire or the
    /// session file): a turn aborted by the `compact` command's
    /// interrupt-and-settle shows no aborted assistant row on either
    /// surface, while the same abort through the `abort` command
    /// broadcasts it (the previous test).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn compact_interrupt_swallows_the_aborted_row() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-compact-abort-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "compact-abort-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [{ "text": "held reply", "delayMs": 60000 }],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "compact-abort" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        let turn = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "compact-abort-session",
                    "message": "held turn for the compact interrupt",
                }),
            )
            .await;
        assert!(turn.success, "the prompt failed: {turn:?}");
        // Let the admitted turn reach the provider (the 60s hold), then
        // compact: the interrupt aborts the in-flight fetch and the
        // aborted row must stay off the wire (TS `_disconnectFromAgent`).
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let compact = worker
            .dispatch(
                "compact",
                &json!({ "activeSessionId": "compact-abort-session" }),
            )
            .await;
        // The scripted faux engine's compact outcome is not the claim
        // here; either way the turn settled before it.
        let _ = compact;
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        let events = session_events_since(&mut subscription);
        let aborted_rows = events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("message_end")
                    && event["message"]["role"] == "assistant"
                    && event["message"]["stopReason"] == "aborted"
            })
            .count();
        assert_eq!(
            aborted_rows, 0,
            "the compact path swallows the aborted row: {events:?}"
        );
        // The suppressed run's `agent_end` stays off the wire entirely (TS
        // `_disconnectFromAgent` before the abort: no `turn_end`, no
        // `agent_end` for the interrupted run) — neither the engine's
        // per-run frame (the abort gate swallows it) nor the worker's
        // trailing fallback.
        let agent_ends = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_end"))
            .count();
        assert_eq!(
            agent_ends, 0,
            "the compact path emits no agent_end for the suppressed run: {events:?}"
        );
        // And out of the session file.
        let aborted_store_rows = {
            let core = worker.core.lock().unwrap();
            core.store
                .as_ref()
                .expect("the worker owns a session file")
                .messages()
                .into_iter()
                .filter(|message| {
                    message.get("role").and_then(Value::as_str) == Some("assistant")
                        && message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                })
                .count()
        };
        assert_eq!(
            aborted_store_rows, 0,
            "the compact path never persists the aborted row"
        );
    }

    /// The pause withdraws the queued minted continuation (TS
    /// `_pauseGoal` -> `_clearQueuedGoalContexts`): a prompt arriving right
    /// after the goal start runs within a turn or two of the loop, the
    /// pause purges the queued goal-context turn, and the loop goes quiet
    /// (the f18 battery's pause pattern).
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn goal_pause_withdraws_the_queued_continuation() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-goal-pause-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "goal-pause-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    "start turn",
                    "one continuation turn at most",
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "goal-pause" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let start = worker
            .dispatch(
                "prompt_and_wait",
                &json!({
                    "activeSessionId": "goal-pause-session",
                    "message": "/goal pause right after the start",
                }),
            )
            .await;
        assert!(start.success, "the goal start failed: {start:?}");
        let pause = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "goal-pause-session", "message": "/goal pause" }),
            )
            .await;
        assert!(pause.success, "the pause never ran: {pause:?}");
        // The loop is quiet: the idle wait settles without consuming
        // further turns (a live continuation would starve it).
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "the loop never went quiet: {idle:?}");
        let goal = worker.engine.goal_state_value();
        assert_eq!(goal["status"], "paused", "goal state: {goal}");
        // A settled paused goal consumed at most the start turn and one
        // continuation turn's worth of slots.
        assert!(
            goal["continuationsUsed"].as_u64().unwrap_or(0) <= 2,
            "the pause never withdrew the loop: {goal}"
        );
    }

    /// A scripted goal session's dispatch worker with a durable session
    /// file (the `noSession` create keeps everything in memory; this
    /// variant lands the store on disk so the `thread_goal_state` mirror
    /// is observable).
    async fn goal_dispatch_worker_with_store(
        goal: serde_json::Value,
    ) -> (std::sync::Arc<Worker>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pa-worker-goal-{}", uuid::Uuid::new_v4()));
        let session_dir = dir.join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "goal-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "responses": ["ack"],
                "goal": goal,
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({
                    "cwd": dir.to_string_lossy(),
                    "name": "goal",
                    "sessionDir": session_dir.to_string_lossy(),
                }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let file = std::fs::read_dir(&session_dir)
            .expect("session dir readable")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .expect("session file created");
        (worker, file)
    }

    /// The session file's `thread_goal_state` custom rows, in order.
    fn thread_goal_state_rows(path: &std::path::Path) -> Vec<Value> {
        crate::session_store::parse_session_entries(&std::fs::read_to_string(path).expect("read"))
            .into_iter()
            .filter(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("custom")
                    && entry.get("customType").and_then(Value::as_str)
                        == Some(pa_core::goals::GOAL_STATE_CUSTOM_TYPE)
            })
            .collect()
    }

    /// A goal-state change announced mid-turn (TS `_setGoalState` ->
    /// `_emitGoalUpdate`) mirrors into the worker session file as a
    /// `thread_goal_state` custom row: the engine's in-memory branch is
    /// not the durable store, so the mirror is what a recovery rebuild
    /// replays.
    #[tokio::test]
    async fn goal_update_events_mirror_the_durable_goal_row() {
        let (worker, file) = goal_dispatch_worker_with_store(json!({
            "emitUpdateOnPrompt": true,
            "state": {
                "active": true,
                "status": "active",
                "goalId": "goal-1",
                "objective": "ship the port",
                "tokensUsed": 340,
                "timeUsedSeconds": 9,
                "continuationsUsed": 2,
            },
        }))
        .await;
        let prompt = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "goal-session", "message": "work" }),
            )
            .await;
        assert!(prompt.success, "prompt failed: {prompt:?}");
        let rows = thread_goal_state_rows(&file);
        assert_eq!(rows.len(), 1, "rows: {rows:?}");
        assert_eq!(rows[0]["data"]["status"], "active");
        assert_eq!(rows[0]["data"]["objective"], "ship the port");
        assert_eq!(rows[0]["data"]["goalId"], "goal-1");
        assert_eq!(rows[0]["data"]["tokensUsed"], 340);
        assert_eq!(rows[0]["data"]["continuationsUsed"], 2);
    }

    /// The post-compaction mint's state change (the compact branch runs
    /// outside a turn) persists its `thread_goal_state` row before the
    /// `goal_update` announcement, so the continuation count survives a
    /// worker crash mid-goal.
    #[tokio::test]
    async fn compact_mint_persists_the_goal_state_row() {
        let (worker, file) = goal_dispatch_worker_with_store(json!({
            "status": "active",
            "objective": "ship the port",
            "state": {
                "active": true,
                "status": "active",
                "goalId": "goal-1",
                "objective": "ship the port",
                "tokensUsed": 340,
                "timeUsedSeconds": 9,
                "continuationsUsed": 1,
            },
        }))
        .await;
        let compact = worker
            .dispatch("compact", &json!({ "activeSessionId": "goal-session" }))
            .await;
        assert!(compact.success, "scripted compact failed: {compact:?}");
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
        let rows = thread_goal_state_rows(&file);
        assert_eq!(rows.len(), 1, "rows: {rows:?}");
        assert_eq!(rows[0]["data"]["status"], "active");
        assert_eq!(rows[0]["data"]["continuationsUsed"], 1);
        assert_eq!(rows[0]["data"]["objective"], "ship the port");
    }

    /// `abort_and_clear_queue` suspends like the bare `abort` (TS
    /// `requestAbort` in that arm): a plain prompt is rejected afterwards
    /// and a `follow_up` (a resume site) is admitted.
    #[tokio::test]
    async fn abort_and_clear_queue_suspends_plain_prompts() {
        let worker = created_dispatch_worker().await;
        let cleared = worker.dispatch("abort_and_clear_queue", &json!({})).await;
        assert!(cleared.success, "abort_and_clear_queue failed: {cleared:?}");
        let rejected = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "suspension-session", "message": "hi" }),
            )
            .await;
        assert_eq!(rejected.error.as_deref(), Some(QUEUED_INPUT_SUSPENDED));
        let resumed = worker
            .dispatch(
                "follow_up",
                &json!({
                    "activeSessionId": "suspension-session",
                    "message": "queued resume"
                }),
            )
            .await;
        assert!(resumed.success, "follow_up failed: {resumed:?}");
        let idle = worker.dispatch("wait_for_idle", &json!({})).await;
        assert!(idle.success, "never went idle: {idle:?}");
    }

    #[test]
    fn display_ids_are_twelve_hex() {
        let id = crate::util::new_display_id();
        assert_eq!(id.len(), 12);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn queue_priority_interleaves_lanes_fifo_and_preserves_explicit_order() {
        let mut core = SessionCore::test_core(None, "/tmp".to_string());
        core.steering_mode = "one-at-a-time".to_string();
        core.follow_up_mode = "one-at-a-time".to_string();
        let add = |core: &mut SessionCore, lane: Lane, text: &str, priority| {
            let mut item = priority_test_item(text, TurnPolicy::Queued);
            item.priority = priority;
            match lane {
                Lane::Steering => enqueue_priority(&mut core.steering, item),
                Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
            }
        };
        add(
            &mut core,
            Lane::FollowUp,
            "machine follow 1",
            QueuePriority::Background,
        );
        add(
            &mut core,
            Lane::Steering,
            "machine steer 1",
            QueuePriority::Background,
        );
        add(
            &mut core,
            Lane::FollowUp,
            "human follow 1",
            QueuePriority::Human,
        );
        add(
            &mut core,
            Lane::Steering,
            "human steer 1",
            QueuePriority::Human,
        );
        add(
            &mut core,
            Lane::Steering,
            "machine steer 2",
            QueuePriority::Background,
        );
        add(
            &mut core,
            Lane::FollowUp,
            "human follow 2",
            QueuePriority::Human,
        );
        add(
            &mut core,
            Lane::Steering,
            "human steer 2",
            QueuePriority::Human,
        );
        assert_eq!(
            session_snapshot(&core).steering,
            [
                "human steer 1",
                "human steer 2",
                "machine steer 1",
                "machine steer 2"
            ]
        );
        assert_eq!(
            session_snapshot(&core).follow_ups,
            ["human follow 1", "human follow 2", "machine follow 1"]
        );
        core.steering.swap(0, 2); // explicit user reorder crosses priority boundary
        add(
            &mut core,
            Lane::Steering,
            "human steer 3",
            QueuePriority::Human,
        );
        assert_eq!(
            session_snapshot(&core).steering,
            [
                "machine steer 1",
                "human steer 2",
                "human steer 1",
                "human steer 3",
                "machine steer 2"
            ]
        );
        assert_eq!(
            gather_delivery_batch(&mut core, Lane::Steering)[0].message,
            "machine steer 1"
        );
        assert_eq!(
            gather_delivery_batch(&mut core, Lane::Steering)[0].message,
            "human steer 2"
        );
        core.steering.clear();
        assert_eq!(
            gather_delivery_batch(&mut core, Lane::FollowUp)[0].message,
            "human follow 1"
        );
    }

    #[test]
    fn queue_priority_drains_four_tiers_and_pinned_front() {
        let mut core = SessionCore::test_core(None, "/tmp".to_string());
        core.steering_mode = "one-at-a-time".to_string();
        core.follow_up_mode = "one-at-a-time".to_string();
        for (lane, text, priority) in [
            (Lane::FollowUp, "machine follow", QueuePriority::Background),
            (Lane::Steering, "machine steer", QueuePriority::Background),
            (Lane::FollowUp, "human follow", QueuePriority::Human),
            (Lane::Steering, "human steer", QueuePriority::Human),
            (Lane::FollowUp, "pinned follow", QueuePriority::Pinned),
        ] {
            let mut item = priority_test_item(text, TurnPolicy::Queued);
            item.priority = priority;
            match lane {
                Lane::Steering => enqueue_priority(&mut core.steering, item),
                Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
            }
        }
        let mut delivered = Vec::new();
        while !core.steering.is_empty() || !core.follow_up.is_empty() {
            let lane = if core.steering.is_empty() {
                Lane::FollowUp
            } else {
                Lane::Steering
            };
            delivered.push(gather_delivery_batch(&mut core, lane).remove(0).message);
        }
        assert_eq!(
            delivered,
            [
                "human steer",
                "machine steer",
                "pinned follow",
                "human follow",
                "machine follow"
            ]
        );
    }

    #[tokio::test]
    async fn rpc_custom_rows_do_not_gain_human_queue_priority() {
        let worker = created_dispatch_worker().await;
        let pause = worker.dispatch("acquire_session_input_pause", &json!({
            "activeSessionId": "suspension-session", "leaseKey": "source-test", "clientId": "test"
        })).await;
        assert!(pause.success, "pause failed: {pause:?}");
        let custom = |content: &str| {
            json!({
                "role": "custom", "customType": "user", "content": content
            })
        };
        for (command, message, row) in [
            (
                "steer",
                "machine via steer",
                Some(custom("machine via steer")),
            ),
            (
                "prompt",
                "machine via prompt",
                Some(custom("machine via prompt")),
            ),
            ("steer", "human via steer", None),
            ("prompt", "human via prompt", None),
        ] {
            let mut payload =
                json!({ "activeSessionId": "suspension-session", "message": message });
            if let Some(row) = row {
                payload["customMessage"] = row;
            }
            let admitted = worker.dispatch(command, &payload).await;
            assert!(admitted.success, "{command}: {admitted:?}");
        }
        let core = worker.core.lock().unwrap();
        assert_eq!(
            session_snapshot(&core).steering,
            [
                "human via steer",
                "human via prompt",
                "machine via steer",
                "machine via prompt"
            ]
        );
        assert_eq!(
            core.steering
                .iter()
                .map(|item| item.priority)
                .collect::<Vec<_>>(),
            [
                QueuePriority::Human,
                QueuePriority::Human,
                QueuePriority::Background,
                QueuePriority::Background,
            ]
        );
    }

    #[tokio::test]
    async fn waiting_rpc_prompt_overtakes_background_steer_and_settles() {
        let worker = created_dispatch_worker().await;
        let pause = worker.dispatch("acquire_session_input_pause", &json!({
            "activeSessionId": "suspension-session", "leaseKey": "priority-test", "clientId": "test"
        })).await;
        assert!(pause.success, "pause failed: {pause:?}");
        {
            let mut core = worker.core.lock().unwrap();
            core.busy = true; // a prompt admitted behind work is queue-visible
            let mut background = priority_test_item("machine steer", TurnPolicy::Injected);
            background.priority = QueuePriority::Background;
            enqueue_priority(&mut core.steering, background);
        }
        let waiting_worker = std::sync::Arc::clone(&worker);
        let waiting = tokio::spawn(async move {
            waiting_worker
                .dispatch(
                    "prompt_and_wait",
                    &json!({
                        "activeSessionId": "suspension-session",
                        "message": "human steer",
                        "streamingBehavior": "steer",
                    }),
                )
                .await
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if worker.core.lock().unwrap().steering.len() == 2 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "waiting prompt was not queued"
            );
            tokio::task::yield_now().await;
        }
        {
            let core = worker.core.lock().unwrap();
            assert_eq!(
                session_snapshot(&core).steering,
                ["human steer", "machine steer"]
            );
        }
        let released = worker.dispatch("release_session_input_pause", &json!({
            "activeSessionId": "suspension-session", "pauseId": pause.data.as_ref().unwrap()["pauseId"],
            "clientId": "test"
        })).await;
        assert!(released.success, "release failed: {released:?}");
        let settled = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("prompt_and_wait did not settle")
            .expect("dispatch task panicked");
        assert!(settled.success, "waiting prompt failed: {settled:?}");
    }

    #[test]
    fn legacy_queue_record_priority_defaults_by_row_and_keeps_order() {
        let dir = std::env::temp_dir().join(format!("pa-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("priority-recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&path).unwrap();
        let machine: crate::journal::WorkerQueueItemRecord = serde_json::from_value(json!({
            "message": "machine", "custom_message": {"role": "custom", "customType": "notice"}
        }))
        .unwrap();
        let human: crate::journal::WorkerQueueItemRecord = serde_json::from_value(json!({
            "message": "human"
        }))
        .unwrap();
        let future: crate::journal::WorkerQueueItemRecord = serde_json::from_value(json!({
            "message": "future machine", "priority": "new_tier"
        }))
        .unwrap();
        journal
            .record_queue_snapshot("legacy", &[machine, human, future], &[])
            .unwrap();
        let reopened = WorkerRecoveryJournal::open(&path).unwrap();
        let (lane, _) = restore_queue_snapshot(&reopened, "legacy");
        assert_eq!(
            lane.iter()
                .map(|item| item.message.as_str())
                .collect::<Vec<_>>(),
            ["machine", "human", "future machine"]
        );
        assert_eq!(lane[0].priority, QueuePriority::Background);
        assert_eq!(lane[1].priority, QueuePriority::Human);
        assert_eq!(lane[2].priority, QueuePriority::Background);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn queue_snapshot_round_trips_through_the_recovery_journal() {
        let dir = std::env::temp_dir().join(format!("pa-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let journal_path = dir.join("recovery.jsonl");
        let mut journal = WorkerRecoveryJournal::open(&journal_path).unwrap();
        // A parked heartbeat rides the journal with its full delivery row
        // (labeled preview, injected custom row, queue key), so a respawned
        // worker restores the heartbeat component instead of a plain user
        // message.
        let content = "[heartbeat: every 10m run#0]\n\nnudge the mission";
        let labeled_preview = format!(
            "{}: {content}",
            pa_core::session_engine::messages::HEARTBEAT_PROMPT_PREVIEW_LABEL
        );
        let heartbeat = crate::journal::WorkerQueueItemRecord {
            message: content.to_string(),
            priority: Some(QueuePriority::Background),
            preview: Some(labeled_preview),
            custom_message: Some(json!({
                "role": "custom",
                "customType": "heartbeat_prompt",
                "content": content,
                "display": true,
                "details": { "jobId": "hb-1" },
            })),
            queue_key: Some("heartbeat:hb-1".to_string()),
            queue_visible: true,
            policy: "injected".to_string(),
        };
        let plain = crate::journal::WorkerQueueItemRecord {
            message: "follow-me".to_string(),
            priority: Some(QueuePriority::Human),
            preview: None,
            custom_message: None,
            queue_key: None,
            queue_visible: true,
            policy: "queued".to_string(),
        };
        journal
            .record_queue_snapshot(
                "session-a",
                std::slice::from_ref(&heartbeat),
                std::slice::from_ref(&plain),
            )
            .unwrap();
        // A reopen (respawned worker) reads the latest snapshot per session.
        let reloaded = WorkerRecoveryJournal::open(&journal_path).unwrap();
        let (steering, follow_up) = restore_queue_snapshot(&reloaded, "session-a");
        assert_eq!(steering.len(), 1);
        assert_eq!(steering[0].message, heartbeat.message);
        assert_eq!(steering[0].priority, QueuePriority::Background);
        assert_eq!(steering[0].preview, heartbeat.preview);
        assert_eq!(steering[0].custom_message, heartbeat.custom_message);
        assert_eq!(steering[0].queue_key, heartbeat.queue_key);
        assert!(steering[0].queue_visible);
        assert_eq!(follow_up.len(), 1);
        assert_eq!(follow_up[0].message, "follow-me");
        assert_eq!(follow_up[0].priority, QueuePriority::Human);
        // Compaction (triggered by an all-idle record) keeps the snapshot
        // with its full rows.
        let mut compacting = WorkerRecoveryJournal::open(&journal_path).unwrap();
        compacting
            .record("session-a", "s1", None, false, "idle")
            .unwrap();
        let compacted = WorkerRecoveryJournal::open(&journal_path).unwrap();
        let (steering, _) = restore_queue_snapshot(&compacted, "session-a");
        assert_eq!(steering.len(), 1);
        assert_eq!(steering[0].custom_message, heartbeat.custom_message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A version-1 queue snapshot (the pre-item text lanes a prior binary
    /// wrote) still restores as plain rows.
    #[test]
    fn a_version_one_queue_snapshot_restores_as_plain_rows() {
        let dir = std::env::temp_dir().join(format!("pa-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let journal_path = dir.join("recovery.jsonl");
        std::fs::write(
            &journal_path,
            "{\"version\":1,\"type\":\"queue_snapshot\",\"active_session_id\":\"session-b\",\"steering\":[\"steer-me\"],\"follow_up\":[\"follow-me\"],\"recorded_at\":\"2026-09-22T00:00:00.000Z\"}\n",
        )
        .unwrap();
        let journal = WorkerRecoveryJournal::open(&journal_path).unwrap();
        let (steering, follow_up) = restore_queue_snapshot(&journal, "session-b");
        assert_eq!(steering.len(), 1);
        assert_eq!(steering[0].message, "steer-me");
        assert_eq!(steering[0].preview, None);
        assert_eq!(steering[0].custom_message, None);
        assert_eq!(steering[0].queue_key, None);
        assert!(steering[0].queue_visible);
        assert_eq!(follow_up.len(), 1);
        assert_eq!(follow_up[0].message, "follow-me");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The forced-batch arming classification (TS `abortAndSendQueued`'s
    /// `queuedSteering` filter): only the visible plain-user steering items
    /// arm — queue-visible rows whose delivery record is a user message;
    /// agent-message deliveries and injected custom rows never join, and an
    /// empty (or all-injected) lane arms nothing.
    #[tokio::test]
    async fn forced_batch_arming_classifies_the_visible_plain_rows() {
        let worker = created_dispatch_worker().await;
        {
            let mut core = worker.core.lock().unwrap();
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "steer one".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
            });
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Background,
                preview: None,
                message: "agent message row".to_string(),
                custom_message: None,
                agent_message: Some("agent message row".to_string()),
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
                forced_batch: false,
            });
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Background,
                preview: None,
                message: "injected custom row".to_string(),
                custom_message: Some(json!({ "role": "custom", "customType": "x" })),
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
                forced_batch: false,
            });
            core.steering.push_back(QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "steer two".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
            });
        }
        assert!(
            worker.arm_forced_all_steering(),
            "the armable rows exist: the arm fired"
        );
        {
            let core = worker.core.lock().unwrap();
            assert!(core.forced_all_steering, "the forced batch is armed");
            let armed: Vec<bool> = core.steering.iter().map(|item| item.forced_batch).collect();
            assert_eq!(
                armed,
                vec![true, false, false, true],
                "only the visible plain-user rows armed: {armed:?}"
            );
        }
        // A lane with nothing armable arms nothing new — the armed state
        // itself persists (TS's armed set survives until a pump selection
        // consumes or disarms it; a later abort with an empty lane runs
        // the plain `requestAbort` arm and touches nothing).
        worker.core.lock().unwrap().steering.clear();
        assert!(
            !worker.arm_forced_all_steering(),
            "an empty lane arms nothing"
        );
        {
            let core = worker.core.lock().unwrap();
            assert!(core.forced_all_steering, "the armed state persists");
            assert!(
                core.steering.iter().all(|item| !item.forced_batch),
                "no item carries the armed flag"
            );
        }
    }
}

#[cfg(test)]
mod turn_stream_tests;

#[cfg(test)]
mod replacement_gate_tests {
    use super::*;
    use crate::engine::SessionEngine;
    use std::path::Path;

    /// A recording engine whose session-model restore holds open for a
    /// fixed window (the restore's readiness awaits): the event log proves
    /// whether two concurrent replacement commands interleave their
    /// teardown/swap/restore/rebuild critical sections.
    struct RecordingEngine {
        events: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl SessionEngine for RecordingEngine {
        fn restore_session_model(
            &self,
            session_path: &std::path::Path,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
            let events = std::sync::Arc::clone(&self.events);
            let path = session_path.display().to_string();
            Box::pin(async move {
                events.lock().unwrap().push(format!("restore-enter {path}"));
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                events.lock().unwrap().push(format!("restore-exit {path}"));
            })
        }

        fn rebuild_session_context(
            &self,
            _: Vec<pa_types::session::FileEntry>,
            _: pa_core::session_engine::goal_driver::GoalBranchReload,
        ) -> anyhow::Result<()> {
            self.events.lock().unwrap().push("rebuild".to_string());
            Ok(())
        }

        fn run_prompt(
            &self,
            _: usize,
            _: PromptRequest,
            _: &dyn Fn() -> bool,
            _: &mut dyn FnMut(EngineEvent) -> bool,
        ) {
        }

        fn run_side_question(
            &self,
            request: crate::engine::SideQuestionRequest,
            signal: &pa_agent::abort::AbortSignal,
            sink: &pa_core::session_engine::side_question::SideQuestionSink,
        ) -> crate::engine::SideQuestionOutcome {
            ScriptedEngine::default().run_side_question(request, signal, sink)
        }

        fn run_compaction(
            &self,
            request: crate::engine::CompactionRequest,
            signal: &pa_agent::abort::AbortSignal,
        ) -> crate::engine::CompactionOutcome {
            ScriptedEngine::default().run_compaction(request, signal)
        }

        fn run_branch_summary(
            &self,
            request: crate::engine::BranchSummaryRequest,
            signal: &pa_agent::abort::AbortSignal,
        ) -> crate::engine::BranchSummaryOutcome {
            ScriptedEngine::default().run_branch_summary(request, signal)
        }
    }

    fn written_session_file(dir: &Path, name: &str) -> PathBuf {
        let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
        let path = dir.join(name);
        session.set_path(path.clone());
        session.rewrite().unwrap();
        path
    }

    fn recording_worker(
        dir: &Path,
        events: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) -> Worker {
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "replacement-gate".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({ "responses": ["ack"] })),
        };
        let mut worker = Worker::new(config, None);
        let engine: std::sync::Arc<dyn SessionEngine> =
            std::sync::Arc::new(RecordingEngine { events });
        let core = std::sync::Arc::clone(&worker.core);
        worker.engine = std::sync::Arc::clone(&engine);
        worker.navigation = crate::session_navigation::SessionNavigation::new(engine, core);
        worker
    }

    /// Two concurrent `switch_session` commands must not interleave their
    /// replacement critical sections: the teardown, the store/file swap,
    /// the restore, and the rebuild move the worker onto one session as a
    /// unit — the second command runs only after the first settles, so
    /// the restore windows never overlap (an overlap would leave the
    /// store, the branch context, and the model from different sessions).
    #[tokio::test]
    async fn concurrent_replacements_never_interleave_their_critical_sections() {
        let dir = std::env::temp_dir().join(format!(
            "pa-replacement-gate-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let worker = recording_worker(&dir, std::sync::Arc::clone(&events));
        let created = worker
            .dispatch("create", &json!({ "noSession": true, "cwd": "/tmp" }))
            .await;
        assert!(created.success, "create failed: {created:?}");

        let file_a = written_session_file(&dir, "session-a.jsonl");
        let file_b = written_session_file(&dir, "session-b.jsonl");
        let payload_a = json!({ "sessionPath": file_a.to_string_lossy(), "cwdOverride": "/tmp" });
        let payload_b = json!({ "sessionPath": file_b.to_string_lossy(), "cwdOverride": "/tmp" });
        let (first, second) = tokio::join!(
            worker.dispatch("switch_session", &payload_a),
            worker.dispatch("switch_session", &payload_b)
        );
        assert!(first.success, "first switch failed: {first:?}");
        assert!(second.success, "second switch failed: {second:?}");

        // The restore windows never overlap: no restore may enter while
        // another is still open.
        let log = events.lock().unwrap().clone();
        let mut open = false;
        for event in &log {
            if event.starts_with("restore-enter") {
                assert!(
                    !open,
                    "a replacement restored while another was in flight: {log:?}"
                );
                open = true;
            } else if event.starts_with("restore-exit") {
                open = false;
            }
        }
        assert_eq!(
            log.iter().filter(|e| e.starts_with("rebuild")).count(),
            2,
            "both replacements rebuilt: {log:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A failed existing-session `create` (a held lease, an unreadable
    /// file) must never bind the engine to the failed path: the
    /// session-model restore runs only after the file opened, so a later
    /// create on a different session never resolves against the failed
    /// path's model or records it in its creation prefix.
    #[tokio::test]
    async fn a_failed_existing_session_create_never_binds_the_engine() {
        let dir =
            std::env::temp_dir().join(format!("pa-create-bind-{}-{}", std::process::id(), line!()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let worker = recording_worker(&dir, std::sync::Arc::clone(&events));

        // An unreadable "session file" (a directory at the path): the
        // existing-session arm fails its windowed open.
        let held = dir.join("held.jsonl");
        std::fs::create_dir_all(&held).expect("directory at the session path");

        let failed = worker
            .dispatch(
                "create",
                &json!({ "sessionPath": held.to_string_lossy(), "cwd": "/tmp" }),
            )
            .await;
        assert!(
            !failed.success,
            "the unreadable path must fail the create: {failed:?}"
        );

        // The engine never bound to the failed path: no restore ran for
        // it.
        let log = events.lock().unwrap().clone();
        assert!(
            log.iter().all(|event| !event.starts_with("restore-enter")),
            "a failed open never restores the failed path: {log:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod recovery_verdict_tests {
    use super::*;

    fn worker_with_journal() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-verdict-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "target-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        // The journal is opened in `serve()`; tests open it directly so the
        // checkpoints have the same durable sink as production.
        *worker.recovery.lock().unwrap() =
            Some(WorkerRecoveryJournal::open(&worker.config.recovery_journal_path).unwrap());
        worker
    }

    async fn created_worker_with_journal() -> Arc<Worker> {
        let worker = worker_with_journal();
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    fn latest_record(worker: &Worker) -> crate::journal::WorkerRecoveryRecord {
        WorkerRecoveryJournal::read_latest(&worker.config.recovery_journal_path)
            .unwrap()
            .into_iter()
            .find(|record| record.active_session_id == "target-session")
            .expect("session record")
    }

    /// An idle-time injected continuation is journal busy evidence: the
    /// admission (not the pickup) proves the work, so a plain boot revives
    /// the worker to deliver it.
    #[tokio::test]
    async fn idle_time_injected_admission_is_busy_evidence() {
        let worker = created_worker_with_journal().await;
        // Settle first: the create record's busy=true must not mask the
        // admission's verdict.
        worker.dispatch("clear_queue", &json!({})).await;
        assert!(
            !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
            "the settled session proves nothing"
        );
        let notify = Arc::new(Notify::new());
        admit_autonomous_follow_up(
            &worker.recovery,
            &worker.core,
            &notify,
            "continue the mission".to_string(),
        );
        assert!(
            WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
            "the injected admission is live work"
        );
        let latest = latest_record(&worker);
        assert_eq!(latest.operation, "follow_up_queued");
        let (steering, follow_up) = WorkerRecoveryJournal::read_queue_snapshot(
            &worker.config.recovery_journal_path,
            "target-session",
        )
        .unwrap()
        .expect("the admission flushed its snapshot");
        assert!(steering.is_empty(), "steering: {steering:?}");
        assert_eq!(follow_up[0].message, "continue the mission");
        let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
    }

    /// The detached bash completion notice admits through the steering
    /// lane: an idle session wakes on an invisible injected row, and the
    /// admission is journal busy evidence (the crash between the notice
    /// and its delivery revives the worker with the row replaying — the
    /// wake survives re-adoption and revival alike).
    #[tokio::test]
    async fn a_bash_completion_notice_admits_the_steering_lane_with_busy_evidence() {
        let worker = created_worker_with_journal().await;
        worker.dispatch("clear_queue", &json!({})).await;
        let notify = Arc::new(Notify::new());
        admit_bash_completion_notice(
            &worker.recovery,
            &worker.core,
            &notify,
            crate::engine::BashCompletionNotice {
                pid: 4321,
                command: "sleep 12; echo RW_WAKE_DONE".to_string(),
                exit_code: 0,
            },
            || false,
        );
        let core = worker.core.lock().unwrap();
        let item = core
            .steering
            .front()
            .expect("the notice queues on the steering lane");
        let row = item.custom_message.as_ref().expect("the injected row");
        assert_eq!(
            row.get("customType").and_then(Value::as_str),
            Some("async_bash_completion"),
            "the row is the async-bash-completion notice: {row}"
        );
        assert_eq!(
            row["details"]["pid"],
            json!(4321),
            "the notice carries its pid: {row}"
        );
        assert!(
            item.message.starts_with("[bash-done pid:4321 exit:0]"),
            "the turn runs on the notice content: {item:?}"
        );
        assert!(
            item.preview
                .as_deref()
                .is_some_and(|preview| preview.starts_with("Background command finished: ")),
            "the queue row carries the TS preview label: {item:?}"
        );
        // TS `queueVisible: visibleQueued`: an idle session's wake is an
        // invisible injected turn.
        assert!(!item.queue_visible, "the idle wake stays invisible");
        drop(core);
        assert!(
            WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
            "the notice admission is live work"
        );
        let latest = latest_record(&worker);
        assert_eq!(latest.operation, "steer_queued");
        let (steering, _) = WorkerRecoveryJournal::read_queue_snapshot(
            &worker.config.recovery_journal_path,
            "target-session",
        )
        .unwrap()
        .expect("the admission flushed its snapshot");
        assert_eq!(
            steering[0].message,
            "[bash-done pid:4321 exit:0]\n\nCommand: \"sleep 12; echo RW_WAKE_DONE\""
        );
        let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
    }

    /// A busy session queues the notice as a visible steer row (TS
    /// `queueIfBusy`), the same row with the queued delivery class.
    #[tokio::test]
    async fn a_bash_completion_notice_on_a_busy_session_queues_a_visible_steer_row() {
        let worker = created_worker_with_journal().await;
        worker.core.lock().unwrap().busy = true;
        let notify = Arc::new(Notify::new());
        admit_bash_completion_notice(
            &worker.recovery,
            &worker.core,
            &notify,
            crate::engine::BashCompletionNotice {
                pid: 99,
                command: "make gates".to_string(),
                exit_code: 2,
            },
            || false,
        );
        let core = worker.core.lock().unwrap();
        let item = core.steering.front().expect("the queued notice");
        assert!(item.queue_visible, "the busy session keeps a visible row");
        assert_eq!(item.policy, TurnPolicy::Queued);
        drop(core);
        let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
    }

    /// The kernel read the result first: the undelivered notice withdraws
    /// (pid+command — pids are reused), and the withdrawal settles the
    /// busy evidence so the journal never promises a replay the row left.
    #[tokio::test]
    async fn bash_consumed_withdraws_the_undelivered_notice_and_settles() {
        let worker = created_worker_with_journal().await;
        worker.dispatch("clear_queue", &json!({})).await;
        let notify = Arc::new(Notify::new());
        admit_bash_completion_notice(
            &worker.recovery,
            &worker.core,
            &notify,
            crate::engine::BashCompletionNotice {
                pid: 4321,
                command: "sleep 12; echo RW_WAKE_DONE".to_string(),
                exit_code: 0,
            },
            || false,
        );
        assert!(
            WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
            "the notice admission is live work"
        );
        // A different command under a reused pid must not withdraw (TS
        // `_isAsyncBashCompletionActionFor` matches both).
        withdraw_bash_completion_notice(
            &worker.recovery,
            &worker.core,
            crate::engine::BashConsumedNotice {
                pid: 4321,
                command: "another command".to_string(),
            },
        );
        assert!(
            worker.core.lock().unwrap().steering.len() == 1,
            "the mismatched withdrawal kept the row"
        );
        assert!(
            WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
            "the kept row stays live work"
        );
        withdraw_bash_completion_notice(
            &worker.recovery,
            &worker.core,
            crate::engine::BashConsumedNotice {
                pid: 4321,
                command: "sleep 12; echo RW_WAKE_DONE".to_string(),
            },
        );
        {
            let core = worker.core.lock().unwrap();
            assert!(
                core.steering.is_empty() && core.follow_up.is_empty(),
                "the consumed notice withdrew"
            );
        }
        assert!(
            !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
            "the withdrawal settled the busy evidence"
        );
        let latest = latest_record(&worker);
        assert_eq!(latest.operation, "queue_purged");
        let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
    }

    /// Dropping a cancelled admission settles the verdict: the cancelled
    /// rows leave no busy evidence and no replayable snapshot.
    #[tokio::test]
    async fn cancelled_admission_drop_settles_the_verdict() {
        let worker = created_worker_with_journal().await;
        worker.dispatch("clear_queue", &json!({})).await;
        let admitted = worker
            .dispatch("prompt", &json!({ "admissionId": "a1", "message": "go" }))
            .await;
        assert!(admitted.success, "prompt failed: {admitted:?}");
        assert!(
            WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
            "the admitted prompt is live work"
        );
        worker.drop_queued_admitted_prompt("a1");
        assert!(
            !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
            "the dropped rows leave no busy evidence"
        );
        let latest = latest_record(&worker);
        assert_eq!(latest.operation, "queue_dropped");
        let (steering, follow_up) = WorkerRecoveryJournal::read_queue_snapshot(
            &worker.config.recovery_journal_path,
            "target-session",
        )
        .unwrap()
        .expect("the drop flushed its snapshot");
        assert!(
            steering.is_empty() && follow_up.is_empty(),
            "lanes: {steering:?} {follow_up:?}"
        );
        let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
    }

    /// A withdrawal landing mid-turn settles the rows but never the
    /// verdict: the in-flight turn is live work (TS computes settled
    /// busy from `isSessionActive`, never from the lanes alone), so a
    /// crash after the withdrawal still reads interrupted. Only the
    /// turn's own `turn_end` — after the runner's idle flip — settles
    /// the same empty lanes back to idle.
    #[tokio::test]
    async fn mid_turn_withdrawal_keeps_the_in_flight_turn_busy() {
        let worker = created_worker_with_journal().await;
        // Mid-turn: the runner is streaming, and the withdrawal leaves
        // nothing queued behind it.
        worker.core.lock().unwrap().busy = true;
        worker.dispatch("clear_queue", &json!({})).await;
        let latest = latest_record(&worker);
        assert_eq!(latest.operation, "queue_cleared");
        assert!(
            latest.busy,
            "the in-flight turn keeps the withdrawal's verdict busy"
        );
        let (steering, follow_up) = WorkerRecoveryJournal::read_queue_snapshot(
            &worker.config.recovery_journal_path,
            "target-session",
        )
        .unwrap()
        .expect("the withdrawal flushed its snapshot");
        assert!(
            steering.is_empty() && follow_up.is_empty(),
            "the withdrawn rows left the snapshot: {steering:?} {follow_up:?}"
        );
        // The turn ends: the runner's idle flip precedes its settle, so
        // the same empty lanes now record busy=false.
        worker.core.lock().unwrap().busy = false;
        worker.dispatch("clear_queue", &json!({})).await;
        let latest = latest_record(&worker);
        assert_eq!(latest.operation, "queue_cleared");
        assert!(!latest.busy, "the settled turn leaves the session idle");
        assert!(
            !WorkerRecoveryJournal::read_interrupted(&worker.config.recovery_journal_path),
            "the settled session proves nothing"
        );
        let _ = std::fs::remove_dir_all(worker.config.socket_path.parent().unwrap());
    }
}
