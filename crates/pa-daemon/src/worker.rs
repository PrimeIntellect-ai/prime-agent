//! Session worker runtime: one process, one session.
//!
//! Port of the TS daemon's worker mode (`modes/daemon/daemon-mode.ts` worker
//! branch, `modes/session-worker/*`): the worker owns the session - the
//! append-only store, the queue lanes, event sequencing, and turn execution.
//! Supervisors connect over a private-framed Unix socket and authenticate
//! with the bootstrap token before any command.

use serde_json::Map;
use std::collections::VecDeque;
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

/// The close reason one `kill` carries (TS `DaemonSessionClosedReason` at
/// `closeSessionOnce`): the plain client kill is `killed`; a parent's
/// child-close cascade passes `shutdown` or `replaced` through the
/// `rlmCloseReason` rest marker, and the close arms differ exactly like
/// TS — `killed` cancels the session's scheduled jobs and archives the
/// state, `shutdown` keeps the resume entry (the jobs survive for the
/// later wake), `replaced` keeps the plain cron jobs but cancels the RLM
/// heartbeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KillCloseReason {
    Killed,
    Shutdown,
    Replaced,
}

impl KillCloseReason {
    /// The `rlmCloseReason` marker of a child-close cascade (the plain
    /// client kill carries none).
    fn from_payload(payload: &Value) -> Self {
        match payload.get("rlmCloseReason").and_then(Value::as_str) {
            Some("shutdown") => Self::Shutdown,
            Some("replaced") => Self::Replaced,
            _ => Self::Killed,
        }
    }

    /// The wire `session_closed` reason.
    fn session_closed_reason(self) -> DaemonSessionClosedReason {
        match self {
            Self::Killed => DaemonSessionClosedReason::Killed,
            Self::Shutdown => DaemonSessionClosedReason::Shutdown,
            Self::Replaced => DaemonSessionClosedReason::Replaced,
        }
    }

    /// The recovery journal's close operation.
    fn recovery_operation(self) -> &'static str {
        match self {
            Self::Killed => "killed",
            Self::Shutdown => "shutdown",
            Self::Replaced => "replaced",
        }
    }
}
use crate::setting_switches::{effective_service_tier, supports_fast_mode};
use crate::types::{AgentConnectionState, SessionActionSnapshot, SessionSummary};

/// TS-parity worker environment variables (`daemon-worker-protocol.ts`).
pub const WORKER_ROLE_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER";
pub const WORKER_TOKEN_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN";
pub const WORKER_INSTANCE_ID_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_INSTANCE_ID";
pub const WORKER_ACTIVE_SESSION_ID_ENV: &str =
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
/// Worker process cwd (the create command's `cwd`).
pub const WORKER_CWD_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_CWD";
pub const WORKER_SUPERVISOR_SOCKET_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET";
pub const WORKER_RECOVERY_JOURNAL_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL";
/// Scripted-engine script file for faux sessions (integration harness).
pub const WORKER_SCRIPT_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_SCRIPT";
/// Worker socket path (supervisor passes it explicitly).
pub const WORKER_SOCKET_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_SOCKET";
/// Telemetry opt-out for the worker's sessions (supervisor passes the create
/// command's `telemetryDisabled` through here, TS descriptor parity).
pub const WORKER_TELEMETRY_DISABLED_ENV: &str =
    "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TELEMETRY_DISABLED";
/// Supervisor-lost exit window (ms): a session worker whose supervisor
/// socket stays unreachable for this long exits instead of lingering
/// orphaned (TS `WORKER_SUPERVISOR_LOST_EXIT_MS_ENV` wire parity; the
/// supervisor's environment flows to the workers it spawns).
pub const WORKER_SUPERVISOR_LOST_EXIT_MS_ENV: &str =
    "PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS";

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub socket_path: PathBuf,
    pub supervisor_socket_path: PathBuf,
    pub token: String,
    pub worker_instance_id: String,
    pub active_session_id: String,
    pub agent_dir: PathBuf,
    pub recovery_journal_path: PathBuf,
    pub script: Option<Value>,
    /// Telemetry opt-out inherited from the create command ("1" = disabled;
    /// absent/other = enabled). Sessions created on this worker install no
    /// telemetry subscriber.
    pub telemetry_disabled: Option<bool>,
}

impl WorkerConfig {
    /// Read the worker spawn env pair into a config: the socket path,
    /// the authentication token, the root active session id, and the
    /// agent dir; the script, the telemetry-disabled flag, the supervisor
    /// socket path, and the recovery journal path all default when unset
    /// or unreadable.
    ///
    /// # Errors
    ///
    /// Returns an error when a required env pair is missing (the socket
    /// path, the authentication token, or the root active session id),
    /// or the agent dir cannot be resolved.
    pub fn from_env() -> Result<Self> {
        let socket_path: PathBuf = std::env::var_os(WORKER_SOCKET_ENV)
            .map(PathBuf::from)
            .ok_or_else(|| anyhow!("worker socket path is required ({WORKER_SOCKET_ENV})"))?;
        let token =
            std::env::var(WORKER_TOKEN_ENV).context("worker authentication token is required")?;
        let active_session_id = std::env::var(WORKER_ACTIVE_SESSION_ID_ENV)
            .context("worker root active session id is required")?;
        let supervisor_socket_path = std::env::var_os(WORKER_SUPERVISOR_SOCKET_ENV)
            .map(PathBuf::from)
            .unwrap_or_default();
        let agent_dir = paths::agent_dir()?;
        let recovery_journal_path = std::env::var_os(WORKER_RECOVERY_JOURNAL_ENV).map_or_else(
            || {
                agent_dir
                    .join("daemon-workers")
                    .join(format!("{active_session_id}.recovery.jsonl"))
            },
            PathBuf::from,
        );
        let script = std::env::var_os(WORKER_SCRIPT_ENV)
            .map(PathBuf::from)
            .and_then(|path| {
                let content = std::fs::read_to_string(path).ok()?;
                serde_json::from_str::<Value>(&content).ok()
            });
        let telemetry_disabled =
            std::env::var_os(WORKER_TELEMETRY_DISABLED_ENV).map(|value| value == "1");
        Ok(WorkerConfig {
            socket_path,
            supervisor_socket_path,
            token,
            worker_instance_id: std::env::var(WORKER_INSTANCE_ID_ENV).unwrap_or_default(),
            active_session_id,
            agent_dir,
            recovery_journal_path,
            script,
            telemetry_disabled,
        })
    }
}

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

#[derive(Debug)]
pub(crate) struct QueuedItem {
    pub(crate) message: String,
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

/// The live session: store, queue, sequencing. Shared by the connection tasks,
/// the turn runner, and the compaction manager; every access is through the
/// core mutex.
pub(crate) struct SessionCore {
    pub(crate) active_session_id: String,
    pub(crate) generation: String,
    pub(crate) last_event_sequence: u64,
    pub(crate) store: Option<SessionFile>,
    pub(crate) cwd: String,
    pub(crate) steering: VecDeque<QueuedItem>,
    pub(crate) follow_up: VecDeque<QueuedItem>,
    pub(crate) busy: bool,
    pub(crate) created: bool,
    attached_client_ids: Vec<String>,
    pub(crate) abort_requested: bool,
    /// A flow that detaches from the interrupted turn's events (TS
    /// `compact()`'s `_disconnectFromAgent()` before `abort()` — and the
    /// branch-navigation interrupt, the same teardown shape) swallowed the
    /// aborted turn's assistant row on the TS wire and in the session
    /// file, so the gate's aborted-row exception stays closed while such a
    /// flow settles its turn. Owned by the interrupt-and-settle helper that
    /// set it; cleared once the turn settled.
    pub(crate) suppress_aborted_row: bool,
    pub(crate) shutdown_requested: bool,
    /// True while a compaction run is in flight (TS `isCompacting`).
    pub(crate) compacting: bool,
    /// The turn's tool calls in flight, keyed by tool-call id (TS
    /// `session.state.pendingToolCalls`): the tool-execution frames add
    /// and remove ids, and the roster summary derives `isRunningTools`
    /// (`isStreaming && pendingToolCalls.size > 0`) from its size.
    pub(crate) running_tool_calls: std::collections::HashSet<String>,
    /// TS `autoCompactionEnabled` (settings default: on).
    pub(crate) auto_compaction_enabled: bool,
    /// The last broadcast queue snapshot (TS `_lastSessionActionSnapshot`):
    /// `session_action_update` fires only when the projection changed.
    last_action_snapshot: Option<SessionActionSnapshot>,
    /// This session's RLM recursion depth (children run at depth + 1).
    rlm_depth: u32,
    /// `top-level` | `subagent` (summary `runtimeKind`).
    pub(crate) runtime_kind: String,
    /// The subagent runtime identity (create `runtimeMetadata`): the child
    /// id under its parent and the parent's live/persisted ids, carried on
    /// every summary so the roster keys children `parentPath#childId`.
    pub(crate) rlm_child_id: Option<String>,
    parent_active_session_id: Option<String>,
    parent_session_id: Option<String>,
    /// The create command's harness `childScript` (the TS child runtime
    /// inherits the parent's `sessionConfig`; the Rust replacement keeps
    /// the seam across the runtime swap so a replacement session's
    /// children stay scripted). `None` for product sessions.
    pub(crate) child_script: Option<String>,
    /// The session's service-tier preference (TS `_serviceTierPreference`;
    /// `None` is the settings default "auto"). The effective tier clamps
    /// `priority` to `default` on models without fast mode.
    pub(crate) service_tier: Option<pa_types::ai::ServiceTier>,
    /// The queue delivery modes (TS `agent.steeringMode` / `followUpMode`):
    /// `"all"` or `"one-at-a-time"`. The steering default is `"all"`
    /// (every queued steer co-delivers as ONE turn at the next
    /// tool-call boundary; `"one-at-a-time"` stays selectable via the
    /// setting). The follow-up default is `"one-at-a-time"` (follow-ups
    /// drain when the session goes idle, one per turn).
    pub(crate) steering_mode: String,
    pub(crate) follow_up_mode: String,
    /// The one-shot forced steering batch (TS `_forcedAllSteeringActionIds`
    /// on the session, armed by `abortAndSendQueued`): while armed, armed
    /// steering items co-deliver as ONE batched turn at the next boundary
    /// — even under queue mode "one-at-a-time". Disarms when no armed
    /// item remains queued (TS `_forcedAllSteeringBatch`'s disarm read).
    pub(crate) forced_all_steering: bool,
    /// The scoped model list (TS `_scopedModels`): wire entries
    /// `{ model, thinkingLevel? }` the model cycler cycles within.
    pub(crate) scoped_models: Vec<Value>,
    /// A retry in flight was aborted (`abort_retry`); the turn's abort
    /// probe reads it and the next turn start clears it.
    pub(crate) retry_abort_requested: bool,
    /// TS `_sessionInputPumpSuspended`: `requestAbort`/`abortForUpdateRestart`
    /// (and manual `compact()`, which aborts first) suspend queued-input
    /// admission. While set, the turn runner drains nothing and a plain
    /// prompt (`prompt`/`prompt_and_wait` without `streamingBehavior`, TS
    /// `resumeIfIdle: command.streamingBehavior !== undefined`) is rejected
    /// with the TS admission error. Cleared by the TS resume sites: a
    /// `steer`/`follow_up` command or a prompt carrying
    /// `streamingBehavior`, `resume_queue`, an applied queued-message
    /// mutation, a cron/heartbeat fire (TS `promptHeartbeat` passes
    /// `resumeIfIdle: true`), and a successful compact with an active
    /// goal (TS `compact()`'s `resumeQueuedWork()` branch).
    pub(crate) queued_input_suspended: bool,
    /// Restored next-turn rows (TS `_pendingNextTurnMessages`,
    /// `restore_next_turn`): delivered as prefix rows with the next turn.
    pub(crate) pending_next_turn: Vec<Value>,
    /// The queue projection's active action (TS `getSessionActionSnapshot`
    /// reads the store's first active action): the runner sets the phase
    /// transitions of a queue-visible delivery (`preparing` at pickup,
    /// `committing` at the turn's first row — the prompt becomes visible
    /// in the conversation then, TS's commit fence — `running` at the
    /// turn's first assistant frame) and clears it once the delivered
    /// turn settles. The `preparing` projection is what a client renders
    /// as the queued strip's "Starting" row (TS #2063). The label rides
    /// the snapshot (TS #2063 `compactRlmText(queuedAgentMessagePreview(
    /// active))`: the delivery's labeled preview, else the message text).
    pub(crate) active_action: Option<crate::types::SessionActionActive>,
}

impl SessionCore {
    /// Whether a turn, compaction, or queued action is in flight — the TS
    /// `hasOngoingSessionWork` predicate. An active run owns the worker a
    /// little longer; the supervisor-lost exit waits for it to settle.
    pub(crate) fn has_ongoing_work(&self) -> bool {
        self.busy || self.compacting || !self.steering.is_empty() || !self.follow_up.is_empty()
    }

    /// A created session core for command modules' unit tests (the private
    /// bookkeeping fields stay owned here).
    #[cfg(test)]
    pub(crate) fn test_core(store: Option<SessionFile>, cwd: String) -> Self {
        SessionCore {
            active_session_id: store.as_ref().map_or_else(
                || "test-session".to_string(),
                |store| store.session_id().to_string(),
            ),
            generation: String::new(),
            last_event_sequence: 0,
            store,
            cwd,
            steering: VecDeque::new(),
            follow_up: VecDeque::new(),
            busy: false,
            created: true,
            attached_client_ids: Vec::new(),
            abort_requested: false,
            suppress_aborted_row: false,
            shutdown_requested: false,
            compacting: false,
            running_tool_calls: std::collections::HashSet::new(),
            auto_compaction_enabled: true,
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
        }
    }
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
    }

    pub(crate) async fn dispatch(&self, command_type: &str, payload: &Value) -> DaemonResponse {
        // Only operations that inspect or change historical branches need hydration.
        // Cancellation is deliberately excluded: it must reach the live turn immediately.
        if matches!(
            command_type,
            "get_session_tree"
                | "get_context_tree"
                | "get_user_messages_for_forking"
                | "set_session_entry_label"
                | "navigate_tree"
                | "fork"
                | "export_html"
                | "export_jsonl"
        ) && self
            .core
            .lock()
            .unwrap()
            .store
            .as_ref()
            .is_some_and(|store| store.window.is_some())
        {
            let path = self
                .core
                .lock()
                .unwrap()
                .store
                .as_ref()
                .unwrap()
                .path
                .clone();
            let load_path = path.clone();
            let hydrated = tokio::task::spawn_blocking(move || SessionFile::open(&load_path))
                .await
                .map_err(anyhow::Error::from)
                .and_then(|result| result);
            match hydrated {
                Ok(full) => {
                    let mut core = self.core.lock().unwrap();
                    if let Some(store) = core.store.as_mut().filter(|store| store.path == path) {
                        store.install_full_history(full);
                    }
                }
                Err(error) => {
                    return response_failure(None, command_type, &error.to_string(), None);
                }
            }
        }
        match command_type {
            "create" => self.handle_create(payload).await,
            "attach" => self.handle_attach(payload),
            "detach" => self.handle_detach(payload),
            "prompt" => self.handle_prompt(payload, false).await,
            "prompt_and_wait" => self.handle_prompt(payload, true).await,
            "steer" => self.handle_queue(payload, Lane::Steering),
            "follow_up" => self.handle_queue(payload, Lane::FollowUp),
            "abort" => self.handle_abort(),
            "abort_and_send_queued" => self.handle_abort_and_send_queued(),
            "start_side_question" => {
                if let Err(response) = self.require_created("start_side_question") {
                    return response;
                }
                self.side_questions.start(payload)
            }
            "abort_side_question" => {
                if let Err(response) = self.require_created("abort_side_question") {
                    return response;
                }
                self.side_questions.abort(payload)
            }
            "compact" => self.handle_compaction(payload).await,
            "abort_compaction" => {
                self.compaction.abort();
                response_success(None, "abort_compaction", None)
            }
            "set_auto_compaction" => self.handle_set_auto_compaction(payload),
            "wait_for_idle" => self.handle_wait_for_idle().await,
            "wait_for_headless_completion" => self.handle_wait_for_headless_completion().await,
            "get_state" => self.handle_get_state(),
            "get_messages" => self.handle_get_messages(),
            "get_session_header" => self.handle_get_session_header(),
            "get_session_stats" => self.handle_get_session_stats(),
            "get_model_catalog" => self.handle_get_model_catalog().await,
            "get_queue" => self.handle_get_queue(),
            "clear_queue" => self.handle_clear_queue(),
            "abort_and_clear_queue" => self.handle_abort_and_clear_queue(),
            "get_last_assistant_text" => self.handle_get_last_assistant_text(),
            "get_connection_state" => self.handle_get_connection_state(),
            "get_mcp_connections" => self.handle_get_mcp_connections().await,
            "set_mcp_static_token" => self.handle_set_mcp_static_token(payload).await,
            "remove_mcp_connection" => self.handle_remove_mcp_connection(payload).await,
            "get_rlm_children" => self.handle_get_rlm_children().await,
            "get_context_tree" => self.handle_get_context_tree().await,
            "get_commands" => self.handle_get_commands().await,
            "get_resource_snapshot" => self.handle_get_resource_snapshot().await,
            "get_session_context" => self.handle_get_session_context(),
            "get_system_prompt" => self.handle_get_system_prompt().await,
            "get_tool_definition" => self.handle_get_tool_definition(payload).await,
            "get_rlm_max_depth_status" => self.handle_get_rlm_max_depth_status(),
            "get_available_models" => self.handle_get_available_models(),
            "worker_deliver_message" => self.handle_worker_deliver_message(payload),
            "update_snapshot" => self.handle_update_snapshot(),
            "kill" => self.handle_kill(payload).await,
            "shutdown" => self.handle_shutdown().await,
            "rename" => self.handle_rename("rename", payload),
            "set_session_name" => self.handle_rename("set_session_name", payload),
            "rename_saved_session" => self.handle_rename_saved_session(payload).await,
            "delete_saved_session" => self.handle_delete_saved_session(payload).await,
            "replace_acp_mcp_servers" => self.handle_replace_acp_mcp_servers(payload),
            "set_model" => self.handle_set_model(payload).await,
            "set_thinking_level" => self.handle_set_thinking_level(payload).await,
            "cycle_model" => self.handle_cycle_model(payload).await,
            "set_scoped_models" => self.handle_set_scoped_models(payload),
            "cycle_thinking_level" => self.handle_cycle_thinking_level().await,
            "set_service_tier" => self.handle_set_service_tier(payload),
            "set_transport" => self.handle_set_transport(payload),
            "set_steering_mode" => self.handle_set_queue_mode("set_steering_mode", payload),
            "set_follow_up_mode" => self.handle_set_queue_mode("set_follow_up_mode", payload),
            "set_auto_retry" => self.handle_set_auto_retry(payload),
            "abort_retry" => self.handle_abort_retry(),
            "get_session_tree" => self.tree_navigation.get_session_tree(),
            "get_user_messages_for_forking" => self.tree_navigation.get_user_messages_for_forking(),
            "set_session_entry_label" => self.tree_navigation.set_session_entry_label(payload),
            "navigate_tree" => self.handle_navigate_tree(payload).await,
            "fork" => self.handle_fork(payload).await,
            "abort_branch_summary" => {
                self.tree_navigation.abort();
                response_success(None, "abort_branch_summary", None)
            }
            "export_html" => self.exports.export_html(payload).await,
            "export_jsonl" => self.exports.export_jsonl(payload),
            "mutate_queued_message" => self.handle_mutate_queued_message(payload),
            "resume_queue" => self.handle_resume_queue(),
            "execute_bash" => self.handle_execute_bash(payload),
            "execute_bash_and_wait" => self.handle_execute_bash_and_wait(payload).await,
            "abort_bash" => self.handle_abort_bash().await,
            "list_kernel_bash" | "tail_kernel_bash" | "kill_kernel_bash" => {
                self.handle_kernel_bash_activity(command_type, payload)
                    .await
            }
            "append_custom_message" => self.handle_append_custom_message(payload),
            "restore_next_turn" => self.handle_restore_next_turn(payload),
            "restore_actions" => self.handle_restore_actions(payload),
            "refine" => self.handle_refine(payload).await,
            "reload" => self.handle_reload().await,
            "extension_ui_response" => self.handle_extension_ui_response(payload),
            "cancel_rlm_child" => self.handle_cancel_rlm_child(payload).await,
            "delete_rlm_subagent" => self.handle_delete_rlm_subagent(payload).await,
            // The engine call blocks on the engine runtime (the durable
            // `rlm_max_depth_state` write takes the engine session lock),
            // so it runs on a blocking thread like every other engine
            // call — a direct call would block_on from inside this async
            // task and die.
            "set_rlm_max_depth" => self.handle_set_rlm_max_depth(payload).await,
            "acquire_session_input_pause" => self.handle_acquire_session_input_pause(payload),
            "release_session_input_pause" => self.handle_release_session_input_pause(payload),
            "cancel_prompt_admission" => self.handle_cancel_prompt_admission(payload),
            "new_session" => self.handle_new_session(payload).await,
            "switch_session" => self.handle_switch_session(payload).await,
            "import_jsonl" => self.handle_import_jsonl(payload).await,
            "agent_messages_status" => self.handle_agent_messages_status(),
            "agent_messages_pause" => self.handle_agent_messages_pause(),
            "agent_messages_resume" => self.handle_agent_messages_resume(),
            "agent_messages_clear" => self.handle_agent_messages_clear(),
            "cron_list" => self.handle_cron_list(payload).await,
            "heartbeats_list" => self.handle_heartbeats_list(),
            "heartbeat_manage" => self.handle_heartbeat_manage(payload).await,
            "cron_add" => self.handle_cron_add(payload).await,
            "cron_cancel" => self.handle_cron_cancel(payload).await,
            "heartbeat_get" => self.handle_heartbeat_get(payload),
            "heartbeat_set" => self.handle_heartbeat_set(payload).await,
            "heartbeat_update" => self.handle_heartbeat_update(payload).await,
            other => response_failure(
                None,
                command_type,
                &format!("Unknown worker command: {other}"),
                None,
            ),
        }
    }

    #[allow(clippy::result_large_err)]
    pub(crate) fn require_created(&self, command_type: &str) -> Result<(), DaemonResponse> {
        let core = self.core.lock().unwrap();
        if !core.created {
            return Err(response_failure(
                None,
                command_type,
                "Session is still initializing",
                None,
            ));
        }
        Ok(())
    }

    /// `navigate_tree` with the reload's announcement (TS
    /// `_reloadGoalStateFromBranch` -> `_emitGoalUpdate`): a tree move
    /// that reloaded the goal state announces the change at the moment it
    /// happened — before the navigation's response reaches the client —
    /// so attached surfaces never show the pre-navigation goal. The
    /// engine owns the on-change dedupe, so an unchanged reload (or a
    /// no-op leaf move, which never rebuilds) stays silent.
    async fn handle_navigate_tree(&self, payload: &Value) -> DaemonResponse {
        let response = self.tree_navigation.navigate_tree(payload).await;
        if response.success {
            if let Some(goal) = self.engine.goal_update_after_rebuild() {
                self.emit_worker_event(json!({
                    "type": "goal_update",
                    "goal": goal,
                }));
            }
        }
        response
    }

    /// `replace_acp_mcp_servers` (TS daemon-mode.ts case): the session's
    /// owner-fenced ACP MCP store. The ACP transport resolves and validates
    /// the servers before sending them; the worker only fences ownership,
    /// guards the busy turn, and rolls back a failed replacement.
    fn handle_replace_acp_mcp_servers(&self, payload: &Value) -> DaemonResponse {
        let owner_id = payload
            .get("ownerId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if owner_id.is_empty() {
            return response_failure(
                None,
                "replace_acp_mcp_servers",
                "ACP MCP owner id is required",
                None,
            );
        }
        let servers: Vec<pa_core::mcp::AcpMcpServerConfig> = payload
            .get("servers")
            .cloned()
            .map(|servers| serde_json::from_value(servers).unwrap_or_default())
            .unwrap_or_default();
        // The agent cannot adopt a different MCP tool list mid-turn (TS
        // `session.isStreaming` guard).
        if !servers.is_empty() && self.core.lock().unwrap().busy {
            return response_failure(
                None,
                "replace_acp_mcp_servers",
                "Cannot replace ACP MCP servers while the agent is running",
                None,
            );
        }
        // The real agent engine owns the session's MCP store (one store
        // for admission and prompt gating); scripted harness engines fall
        // back to the worker-level store.
        let manager = self
            .engine
            .acp_mcp_manager()
            .unwrap_or_else(|| std::sync::Arc::clone(&self.acp_mcp));
        let manager = manager.lock().unwrap();
        match manager.replace_acp_servers(&servers, owner_id) {
            // An unchanged list (same owner, identical servers) is a no-op
            // success, like the TS manager's unchanged short-circuit.
            Ok(_) => response_success(None, "replace_acp_mcp_servers", None),
            Err(error) => {
                // Roll back any partially applied configuration with the
                // owner-scoped clear, exactly like the TS rollback, before
                // surfacing the failure.
                if manager.can_release_acp_servers(owner_id) {
                    let _ = manager.replace_acp_servers(&[], owner_id);
                }
                response_failure(None, "replace_acp_mcp_servers", &error.to_string(), None)
            }
        }
    }

    async fn handle_create(&self, payload: &Value) -> DaemonResponse {
        // One create in flight at a time (TS `openingSessions`): the
        // created check, the session-model restore's awaits, and the core
        // initialization below are one serialized critical section, so a
        // concurrent create joins this open and answers with the created
        // summary below instead of racing a second initialization.
        let _create_gate = self.create_gate.lock().await;
        {
            let core = self.core.lock().unwrap();
            if core.created {
                // Idempotent re-create after a supervisor restart or respawn.
                let summary = self.summary_locked(&core);
                return response_success(
                    None,
                    "create",
                    Some(serde_json::to_value(&summary).unwrap_or(Value::Null)),
                );
            }
        }
        let session_path = match payload.get("sessionPath").and_then(Value::as_str) {
            Some(path) => match paths::expand_tilde(path) {
                Ok(expanded) => Some(expanded),
                Err(error) => return response_failure(None, "create", &error.to_string(), None),
            },
            None => None,
        };
        let no_session = payload
            .get("noSession")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let name = payload.get("name").and_then(Value::as_str);
        let flagged_model = payload.get("model").and_then(Value::as_str).is_some();
        // TS createAgentSession's restored-from-session step: a revived
        // session (an existing session file — scheduled wake, update
        // restore, worker relaunch) restores the model its file pins
        // before the startup chain. The bounded readiness wait covers the
        // daemon boot's catalog fetch, so the revived session keeps the
        // model it was running on instead of silently landing on the
        // featured default while the catalog settles. An explicit model
        // flag on the create wins instead (TS `options.model` takes
        // priority over the saved session model): the restore is skipped
        // entirely, so a flagged create never eats the readiness window or
        // records a fallback that would not be used.
        // Explicit model flags from the create config are authoritative for
        // this worker's session runtime config (TS runtime-config
        // propagation): the engine rebinds its selection instead of
        // falling back to a process-wide model, and the folded flags
        // survive every session replacement (TS `sessionConfig`).
        let requested_thinking = match payload.get("thinking") {
            None => None,
            Some(Value::String(level)) => {
                match pa_ai::models::thinking_level_from_str(level) {
                    Some(level) => Some(level),
                    // The wire contract takes validated levels only: reject
                    // the create loudly instead of silently dropping it.
                    None => {
                        return response_failure(
                            None,
                            "create",
                            &format!("Invalid thinking level \"{level}\". Valid values: off, minimal, low, medium, high, xhigh, max"),
                            None,
                        );
                    }
                }
            }
            Some(_) => {
                return response_failure(
                    None,
                    "create",
                    "Invalid thinking level: expected a string",
                    None,
                );
            }
        };
        self.engine.configure_create_model(EngineModelSelection {
            provider: payload
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string),
            model: payload
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            api_key: payload
                .get("apiKey")
                .and_then(Value::as_str)
                .map(str::to_string),
            thinking: requested_thinking,
        });
        let cwd = payload
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("/")
            .to_string();
        let session_dir = match payload.get("sessionDir").and_then(Value::as_str) {
            Some(dir) => match paths::expand_tilde(dir) {
                Ok(expanded) => expanded,
                Err(error) => return response_failure(None, "create", &error.to_string(), None),
            },
            None => match paths::sessions_dir(&self.config.agent_dir) {
                Ok(dir) => dir,
                Err(error) => return response_failure(None, "create", &error.to_string(), None),
            },
        };
        // RLM recursion identity (children of an RLM parent run at depth+1):
        // the durable create replays these so a respawned child keeps them.
        let (rlm_depth, rlm_max_depth) = match create_payload_rlm_depth(payload) {
            Ok(identity) => identity,
            Err(error) => return response_failure(None, "create", &error, None),
        };
        let parent_session_path = payload
            .get("parentSessionPath")
            .and_then(Value::as_str)
            .map(str::to_string);
        // The subagent runtime identity (TS `runtimeMetadata` on the create
        // command): the child id and the parent's live/persisted ids ride
        // the session summaries so the roster can key children
        // `parentPath#childId` like TS `rosterAgentIdForSummary`.
        let (rlm_child_id, parent_active_session_id, parent_session_id) = match payload
            .get("runtimeMetadata")
        {
            Some(metadata) if metadata.get("kind").and_then(Value::as_str) == Some("subagent") => (
                metadata
                    .get("rlmChildId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                metadata
                    .get("parentActiveSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                metadata
                    .get("parentSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            ),
            _ => (None, None, None),
        };
        let thinking = payload
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::to_string);
        // Verification seam (the TS child runtime inherits the parent's
        // `sessionConfig`): a scripted parent session passes its children's
        // engine file down the recursion. Product creates carry `None`.
        let child_script = payload
            .get("childScript")
            .and_then(Value::as_str)
            .map(str::to_string);

        let mut store = match (&session_path, no_session) {
            (Some(path), false) if path.exists() => {
                let loaded = {
                    let path = path.clone();
                    let agent_dir = self.config.agent_dir.clone();
                    tokio::task::spawn_blocking(move || {
                        let lease = crate::lease::acquire_runtime_session_lease(&path, &agent_dir)?;
                        let mut store = SessionFile::open_windowed(&path)?;
                        store.lease = Some(Arc::new(lease));
                        Ok(store)
                    })
                    .await
                    .map_err(anyhow::Error::from)
                    .and_then(|result| result)
                };
                match loaded {
                    Ok(mut opened) => {
                        // The engine owns the file from here on (the open
                        // succeeded): the session-model restore binds the
                        // engine and records its decision only for a path
                        // this worker actually opened — a failed open (a
                        // held lease, an unreadable file) never leaks the
                        // binding into a later create's session. The
                        // create's own flags were folded before this; a
                        // flagged create still skips the restore (an
                        // explicit model wins end-to-end, TS
                        // `options.model`).
                        self.engine.set_session_file(path.clone());
                        if !flagged_model {
                            self.engine.restore_session_model(path).await;
                        }
                        let restored = opened.restored_settings();
                        // TS createAgentSession restores the session
                        // file's saved thinking level when the create
                        // carries no explicit flag (sdk.ts
                        // `hasThinkingEntry ? existingSession.thinkingLevel`).
                        // The saved MODEL restores through the engine's
                        // session-model restore (the bounded readiness
                        // window, the exact-match path, the published
                        // fallback) — never this direct adoption, which
                        // would bypass the window the fleet-kill
                        // forensics pinned.
                        self.engine.configure_model(EngineModelSelection {
                            provider: None,
                            model: None,
                            api_key: None,
                            thinking: requested_thinking.or_else(|| {
                                opened
                                    .has_thinking_level()
                                    .then(|| {
                                        pa_ai::models::thinking_level_from_str(
                                            &restored.thinking_level,
                                        )
                                    })
                                    .flatten()
                            }),
                        });
                        let append_start = opened.entries.len();
                        append_creation_prefix(
                            &mut opened,
                            self.engine.as_ref(),
                            &self.config.agent_dir,
                            &cwd,
                            false,
                        );
                        let _ = opened.append_session_state("active");
                        let persisted = if opened.window.is_some() {
                            opened.persist_appended(append_start)
                        } else {
                            opened.rewrite()
                        };
                        if let Err(error) = persisted {
                            return response_failure(None, "create", &error.to_string(), None);
                        }
                        opened
                    }
                    Err(error) => return crate::hold_refusal::create_failure_response(&error),
                }
            }
            (Some(path), false) => {
                let mut created = SessionFile::create(
                    &cwd,
                    parent_session_path.as_deref(),
                    rlm_depth.unwrap_or(0),
                );
                created.set_path(path.clone());
                let acquired = {
                    let path = path.clone();
                    let agent_dir = self.config.agent_dir.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::lease::acquire_runtime_session_lease(&path, &agent_dir)
                    })
                    .await
                    .map_err(anyhow::Error::from)
                    .and_then(|lease| lease)
                };
                match acquired {
                    Ok(lease) => created.lease = Some(Arc::new(lease)),
                    Err(error) => return crate::hold_refusal::create_failure_response(&error),
                }
                if let Err(error) = created.rewrite() {
                    return response_failure(None, "create", &error.to_string(), None);
                }
                append_creation_prefix(
                    &mut created,
                    self.engine.as_ref(),
                    &self.config.agent_dir,
                    &cwd,
                    true,
                );
                let _ = created.append_session_state("active");
                if let Err(error) = created.rewrite() {
                    return response_failure(None, "create", &error.to_string(), None);
                }
                created
            }
            // In-memory session: no file, like the TS `noSession` create.
            (None, true) => {
                let mut created = SessionFile::create(
                    &cwd,
                    parent_session_path.as_deref(),
                    rlm_depth.unwrap_or(0),
                );
                append_creation_prefix(
                    &mut created,
                    self.engine.as_ref(),
                    &self.config.agent_dir,
                    &cwd,
                    true,
                );
                created
            }
            (None, false) => {
                let mut created = SessionFile::create(
                    &cwd,
                    parent_session_path.as_deref(),
                    rlm_depth.unwrap_or(0),
                );
                let path = session_dir.join(session_file_name(created.session_id()));
                created.set_path(path.clone());
                let acquired = {
                    let path = path.clone();
                    let agent_dir = self.config.agent_dir.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::lease::acquire_runtime_session_lease(&path, &agent_dir)
                    })
                    .await
                    .map_err(anyhow::Error::from)
                    .and_then(|lease| lease)
                };
                match acquired {
                    Ok(lease) => created.lease = Some(Arc::new(lease)),
                    Err(error) => return crate::hold_refusal::create_failure_response(&error),
                }
                if let Err(error) = created.rewrite() {
                    return response_failure(None, "create", &error.to_string(), None);
                }
                append_creation_prefix(
                    &mut created,
                    self.engine.as_ref(),
                    &self.config.agent_dir,
                    &cwd,
                    true,
                );
                let _ = created.append_session_state("active");
                if let Err(error) = created.rewrite() {
                    return response_failure(None, "create", &error.to_string(), None);
                }
                created
            }
            (Some(_), true) => {
                return response_failure(
                    None,
                    "create",
                    "Session cannot be both no-session and session-pathed",
                    None,
                )
            }
        };

        if let Some(name) = name.filter(|n| !n.trim().is_empty()) {
            if let Err(error) = store.persist_entry("session_info", json!({ "name": name.trim() }))
            {
                return response_failure(None, "create", &error.to_string(), None);
            }
        }
        let restored_tier = store
            .has_service_tier()
            .then(|| store.restored_settings().service_tier);
        // Restore the persisted queue snapshot (crash/respawn recovery) from
        // the worker recovery journal.
        let (steering, follow_up) = {
            let guard = self.recovery.lock().unwrap();
            match guard.as_ref() {
                Some(journal) => restore_queue_snapshot(journal, &self.config.active_session_id),
                None => (VecDeque::new(), VecDeque::new()),
            }
        };
        // The worker owns the session file; the engine reads it for the
        // system prompt's conversation-log path and the local harness dir.
        if !store.path.as_os_str().is_empty() {
            self.engine.set_session_file(store.path.clone());
        }
        // The session's settings-seeded switches (TS createAgentSession:
        // the service tier, the queue delivery modes, and the auto-compaction
        // toggle come from the settings manager; the durable prefix records
        // the same tier). The TS connection state reads the settings value,
        // so a restarted session re-seeds its flag from the persisted
        // `compaction.enabled`.
        let (service_tier, steering_mode, follow_up_mode, auto_compaction_enabled) = {
            let settings = pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir);
            let queue_mode = |mode: pa_core::settings::QueueModeSetting| -> String {
                match mode {
                    pa_core::settings::QueueModeSetting::All => "all".to_string(),
                    pa_core::settings::QueueModeSetting::OneAtATime => "one-at-a-time".to_string(),
                }
            };
            (
                settings.get_default_service_tier(),
                queue_mode(settings.get_steering_mode()),
                queue_mode(settings.get_follow_up_mode()),
                settings.get_compaction_enabled(),
            )
        };
        self.engine
            .configure_service_tier(restored_tier.unwrap_or(Some(service_tier)));
        // The abort supervision's terminal record (the supervisor declared
        // a wedged run aborted and injected it into this create replay):
        // the rebuilt transcript discloses the abort with the same
        // `compaction_outcome` row the worker's own auto-abort arms
        // persist. A manual run persists nothing — TS `compact()`'s abort
        // arm writes no durable row. The row is identity-stamped with the
        // declaration (`declaredAt`): a replacement that persisted it and
        // died before the supervisor consumed the record replays the same
        // declaration. The dedup matches the row's fields alone — a
        // worker that persisted its own cancelled row for the same run
        // (its abort arm ran, then the worker died before its
        // `compaction_end` reached the supervisor) carries the persist-
        // time stamp, not the declaration, and the replay must recognize
        // it instead of appending a second row for the one abort.
        let interrupted_compaction_requested = payload.get("interruptedCompaction").is_some();
        let interrupted_compaction = crate::compaction::interrupted_compaction_disclosure(payload);
        // The disclosure row's landing state for this replay: `true` when
        // the rebuilt transcript now holds the exact row (persisted here,
        // or already present from an earlier crash-replay), `false` when
        // the persist failed — the create reply carries it so the
        // supervisor consumes the terminal record only once the
        // disclosure is durable; a failed persist keeps it pending for
        // the next replacement to retry. A requested record with no
        // disclosure row (a manual run — TS `compact()`'s abort arm
        // writes none) is vacuously durable and reports `true`, so the
        // record is consumed instead of re-injecting forever. No
        // requested record adds no key: client-facing create replies
        // stay byte-identical to the TS shape.
        let mut interrupted_compaction_persisted = interrupted_compaction_requested;
        // The core lock stays inside this block: everything after it may
        // await (the schedule-catalog bind), and a std MutexGuard must
        // never ride an await point.
        let (summary, rlm_depth) = {
            let mut core = self.core.lock().unwrap();
            core.cwd = cwd;
            core.steering = steering;
            core.follow_up = follow_up;
            core.store = Some(store);
            if let Some(disclosure) = &interrupted_compaction {
                if let Some(store) = core.store.as_mut() {
                    let already_disclosed = store.entries().iter().any(|entry| {
                        entry.type_ == "custom_message" && entry.fields == disclosure.row
                    });
                    if !already_disclosed
                        && store
                            .persist_entry_at(
                                "custom_message",
                                disclosure.row.clone(),
                                &disclosure.declared_at,
                            )
                            .is_err()
                    {
                        interrupted_compaction_persisted = false;
                    }
                }
            }
            core.created = true;
            core.abort_requested = false;
            // A fresh (or replaced) session starts live: the previous
            // close's `session_closed` marker clears with the new session
            // (TS's fresh runtime starts un-disposed).
            if let Some(agent_engine) = &self.agent_engine {
                agent_engine.clear_session_closed();
            }
            core.auto_compaction_enabled = auto_compaction_enabled;
            core.service_tier = restored_tier.unwrap_or(Some(service_tier));
            core.steering_mode.clone_from(&steering_mode);
            core.follow_up_mode.clone_from(&follow_up_mode);
            core.forced_all_steering = false;
            core.scoped_models = Vec::new();
            core.retry_abort_requested = false;
            // The session's depth falls back to the opened file's header (TS
            // `config.rlmDepth ?? header.rlmDepth`): a resumed saved subagent
            // session keeps its persisted depth. The runtime kind keeps the
            // create's runtime identity (TS `metadata.kind`) — a resumed
            // subagent file is a top-level runtime that merely carries its
            // persisted depth, so the roster does not re-nest it under its
            // original parent.
            let rlm_depth = rlm_depth
                .or_else(|| core.store.as_ref().and_then(SessionFile::rlm_depth))
                .unwrap_or(0);
            core.rlm_depth = rlm_depth;
            core.runtime_kind = if rlm_child_id.is_some() {
                "subagent".to_string()
            } else {
                "top-level".to_string()
            };
            core.rlm_child_id = rlm_child_id;
            core.parent_active_session_id = parent_active_session_id;
            core.parent_session_id = parent_session_id;
            core.child_script.clone_from(&child_script);
            (self.summary_locked(&core), rlm_depth)
        };
        // TS `sdk.ts` seeds the Agent's queue modes from the settings
        // manager at session create (`steeringMode`/`followUpMode`): the
        // engine's agent-level queues drain per the same modes the worker
        // lane delivers by. Scripted harness engines keep the no-op.
        self.engine
            .set_queue_modes(Some(&steering_mode), Some(&follow_up_mode));
        // Seed the engine's RLM identity: recursion depth and bound, this
        // session's persistence ids, the default thinking level its
        // children inherit, and the harness's child engine file.
        if let Err(error) = self.engine.configure_rlm_identity(RlmSessionIdentity {
            rlm_depth,
            rlm_max_depth,
            cwd: Some(summary.cwd.clone()),
            session_id: Some(summary.session_id.clone()),
            session_file: summary.session_file.clone(),
            thinking,
            child_script: child_script.clone(),
        }) {
            return response_failure(None, "create", &error.to_string(), None);
        }
        // The engine renders this summary into the sender identity block
        // of worker-to-worker agent messages.
        if let Ok(summary_value) = serde_json::to_value(&summary) {
            self.engine.set_session_summary(summary_value);
        }
        // TS create builds the AgentSession eagerly
        // (`createAgentSessionFromServices` inside the create handler —
        // where the kernel prewarm fires). The Rust worker keeps the
        // create response model-independent, so the build runs in the
        // background instead: the prewarm starts at create, the build
        // gate deduplicates it against any racing demand seam, and a
        // build failure still surfaces on the first demand seam exactly
        // as before. Scripted harness engines have no session to build.
        if let Some(agent_engine) = &self.agent_engine {
            let engine = std::sync::Arc::clone(agent_engine);
            tokio::spawn(async move {
                let Ok(model) = engine.resolve_model() else {
                    return;
                };
                let _ = engine.ensure_core_session_async(&model).await;
            });
        }
        // Bind the schedule catalog onto the session (artifact partition,
        // job rebind, scheduler start) — TS `rebindCronJobsToState`.
        self.bind_scheduled_jobs().await;
        // Recovery journal writes must not happen while holding the core
        // lock: record_recovery locks the core to read the store.
        let _ = self.record_recovery(true, "create");
        let session_id = summary.session_id.clone();
        if let Some(registration) = &self.registration {
            registration.notify_session_created(session_id);
        }
        // TS session boot resolves the initial model through
        // `refreshAvailableModels`, which also fetches the live Prime
        // Inference catalog in the background and caches it on disk. Fire
        // the same refresh here: the effect is the cache file (fresh
        // registries read it), and failures fall back to the cached or
        // bundled catalog without touching the session.
        let agent_dir = self.config.agent_dir.clone();
        tokio::spawn(async move {
            let auth = pa_core::auth::AuthStorage::create(&agent_dir);
            let mut registry =
                pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
            let _ = registry.refresh_available_models().await;
        });
        self.work_notify.notify_one();
        // Warm the context-tree cache at session open: the background walk
        // fills the cache while the client settles, so an early `/context`
        // answers from it instead of walking the artifact tree inline.
        self.poke_context_tree_refresh();
        // The delete boundary invalidates the cache's rows for the deleted
        // child immediately (the next background refresh would otherwise
        // keep its last row through the settled-children backfill).
        if let Some(agent_engine) = &self.agent_engine {
            if let Some(children) = &agent_engine.children {
                let cache = std::sync::Arc::clone(&self.context_tree);
                children.set_delete_notifier(std::sync::Arc::new(move |child_id| {
                    cache.invalidate_child(child_id);
                }));
            }
        }
        let mut data = serde_json::to_value(&summary).unwrap_or(Value::Null);
        if interrupted_compaction_requested {
            data["interruptedCompactionPersisted"] =
                serde_json::json!(interrupted_compaction_persisted);
        }
        response_success(None, "create", Some(data))
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
        let snapshot = json!({
            "activeSessionId": active_session_id,
            "summary": summary_value,
            "state": state_value,
            "messages": messages,
            "lastEventSequence": last_event_sequence,
            "lastEventCursor": cursor,
            // RLM child roster; empty for top-level daemon sessions.
            "children": [],
        });
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
            result["messages"] = Value::Array(messages);
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
            let item = QueuedItem {
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
                Lane::Steering => core.steering.push_back(item),
                Lane::FollowUp => core.follow_up.push_back(item),
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
        let mut core = self.core.lock().unwrap();
        let images = parse_prompt_images(payload);
        match lane {
            Lane::Steering => &mut core.steering,
            Lane::FollowUp => &mut core.follow_up,
        }
        .push_back(QueuedItem {
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
        });
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
            match lane {
                Lane::Steering => &mut core.steering,
                Lane::FollowUp => &mut core.follow_up,
            }
            .push_back(QueuedItem {
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
            });
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

    /// Arm the one-shot forced steering batch (TS `abortAndSendQueued`'s
    /// `_forcedAllSteeringActionIds = new Set(queuedSteering.map(...))`):
    /// the visible plain-user steering items — queue-visible rows whose
    /// delivery record is a user message, not an accepted agent message or
    /// an injected custom row — deliver as ONE batched turn at the next
    /// boundary, even under queue mode "one-at-a-time". Returns whether
    /// anything armed; an empty lane (or an all-injected one) arms
    /// nothing and the caller decides from the surviving queue whether
    /// the abort keeps the pump flowing.
    // Called by the `abort_and_send_queued` funnel (the wire command's
    // body, #2599's handler once rebased).
    pub(crate) fn arm_forced_all_steering(&self) -> bool {
        let mut core = self.core.lock().unwrap();
        let armable = |item: &QueuedItem| {
            item.queue_visible && item.agent_message.is_none() && item.custom_message.is_none()
        };
        if !core.steering.iter().any(armable) {
            return false;
        }
        core.forced_all_steering = true;
        for item in &mut core.steering {
            if armable(item) {
                item.forced_batch = true;
            }
        }
        true
    }

    /// `abort_and_send_queued` (TS `abortAndSendQueued`, schema 29): abort
    /// the active run and keep the queue flowing behind the settled turn
    /// — the armed plain-user steering rows co-deliver as the next
    /// batched turn, then the follow-up lane drains when the session
    /// goes idle, one turn per completed turn. `steeringMode` is never
    /// changed, and the follow-up lane never merges into the batch.
    ///
    /// Abort-only — the queue parks behind the suspension, like the bare
    /// `abort` — when no queue-visible work survives or the scheduler
    /// must stay parked (a held admission pause or a pending shutdown —
    /// TS `canResume`).
    ///
    /// SANCTIONED DIVERGENCE (operator ruling 2026-09-25): TS parks the
    /// queue whenever the steering lane has nothing armable
    /// (`queuedSteering.length === 0`), so a follow-up-only queue sits
    /// parked until an outside resume site fires; here the abort
    /// resumes whenever queue-visible work survived, and a follow-up
    /// parked behind an aborted turn starts promptly once the turn
    /// settles. The bare `abort` command keeps the TS park.
    ///
    /// The `abort_and_send_queued` wire command (schema 29) and the
    /// Ctrl+C trigger dispatch through this funnel
    /// (`handle_abort_and_send_queued` below — the abort-parity lane's
    /// command surface, #2599). Returns whether the queue was resumed
    /// to drain behind the abort (the abort-only arm answers `false`).
    pub(crate) fn abort_and_send_queued(&self) -> bool {
        // TS `canResume`: no disposal in flight, no admission pause held —
        // and the arm only fires in the send arm (`queuedSteering.length
        // === 0 || !canResume` runs the plain `requestAbort()` without
        // touching the armed set).
        let can_resume =
            !self.input_pauses.paused() && !self.core.lock().unwrap().shutdown_requested;
        if !can_resume {
            self.request_abort();
            return false;
        }
        // TS `queuedSteering` + the arm: the visible plain-user steering
        // rows carry the forced-batch flag; an empty (or all-injected)
        // lane arms nothing.
        self.arm_forced_all_steering();
        // TS runs `requestAbort()` in both arms (the suspension parks the
        // queue). The cancel sweep keeps only the queue-visible rows, so
        // the emptiness read below measures exactly the work the abort
        // leaves behind.
        self.request_abort();
        // The resume gate: the abort keeps the queue flowing whenever
        // queue-visible work survived — the armed steering batch or a
        // follow-up-only lane alike. The resumed pump — not this funnel —
        // owns the delivery at the settled turn's boundary: steers first
        // (one batched turn), then the follow-up lane.
        let queued_work = {
            let core = self.core.lock().unwrap();
            !core.steering.is_empty() || !core.follow_up.is_empty()
        };
        if !queued_work {
            return false;
        }
        self.resume_queued_input();
        true
    }

    /// TS `requestAbort()`: the abort funnel behind both abort commands
    /// (`abort` and `abort_and_send_queued`) - suspend queued-input
    /// admission, cancel the queue-invisible turn actions, abort the
    /// in-flight compaction, and cancel the running turn.
    fn request_abort(&self) {
        {
            let mut core = self.core.lock().unwrap();
            core.abort_requested = true;
            // TS `requestAbort()` suspends queued-input admission: the
            // queue parks and a plain prompt is rejected until a resume
            // site fires.
            core.queued_input_suspended = true;
        }
        // TS `requestAbort()`'s `_cancelSessionActions`: queue-INVISIBLE
        // turn actions cancel with "Prompt aborted before delivery." - a
        // direct prompt admitted on an idle session never became a queue
        // row, so the abort must resolve its waiting response instead of
        // parking it behind the suspension forever (the ACP cancel wedge:
        // the prompt item sat in the lane with no resume site, the
        // `prompt_and_wait` response hung). The queue-visible lanes
        // (steer/follow-up, agent-message deliveries, prompt-behind-work,
        // heartbeat fires) survive parked - the suspension defers the
        // pump, it never drops the queue (the abort-ownership probe).
        {
            let mut core = self.core.lock().unwrap();
            let cancel = |lane: &mut VecDeque<QueuedItem>| {
                let mut kept = VecDeque::new();
                while let Some(item) = lane.pop_front() {
                    if item.queue_visible {
                        kept.push_back(item);
                    } else {
                        if let Some(id) = &item.admission_id {
                            let _ = self.prompt_admissions.cancel(id);
                        }
                        if let Some(done) = item.done {
                            let _ = done.send(TurnSettle::Withdrawn(
                                PROMPT_ABORTED_BEFORE_DELIVERY.to_string(),
                            ));
                        }
                    }
                }
                *lane = kept;
            };
            cancel(&mut core.steering);
            cancel(&mut core.follow_up);
        };
        // TS `requestAbort()` also aborts the compaction in flight (manual
        // and automatic): the interrupt key cancels a compacting session.
        self.compaction.abort();
        // `requestAbort()` closes with `this.agent.abort()`: the in-flight
        // turn's fetch cancels now, not at its next streamed event.
        self.engine.abort_in_flight_turn();
    }

    fn handle_abort(&self) -> DaemonResponse {
        self.request_abort();
        response_success(None, "abort", None)
    }

    /// `abort_and_send_queued` (TS `abortAndSendQueued`, schema 29): abort
    /// the active run and keep the queue flowing at the boundary — the
    /// armed steering rows deliver as ONE co-delivered turn, then the
    /// follow-up lane drains one turn per completed turn; abort-only
    /// when no queue-visible work survives or the scheduler must stay
    /// parked (the abort-only arm leaves the suspension set, so an
    /// emptied queue stays parked like the bare `abort`).
    fn handle_abort_and_send_queued(&self) -> DaemonResponse {
        // The funnel above owns the arm, the abort, and the conditional
        // resume; the response acknowledges the abort itself, never the
        // deliveries the resumed pump runs asynchronously at the settled
        // turn's boundary.
        self.abort_and_send_queued();
        response_success(None, "abort_and_send_queued", None)
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

    fn handle_get_state(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_state") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let summary = self.summary_locked(&core);
        response_success(
            None,
            "get_state",
            Some(serde_json::to_value(&summary).unwrap_or(Value::Null)),
        )
    }

    /// `get_session_header`: the persisted session header line (TS wraps it
    /// in `{ header: ... }`).
    fn handle_get_session_header(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_session_header") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let Some(store) = core.store.as_ref() else {
            return response_failure(
                None,
                "get_session_header",
                "Session is still initializing",
                None,
            );
        };
        response_success(
            None,
            "get_session_header",
            Some(json!({ "header": crate::session_store::session_header_line(&store.header) })),
        )
    }

    /// `get_session_stats`: counts, token totals, and the context-usage
    /// estimate over the persisted branch (TS `getSessionStats`).
    fn handle_get_session_stats(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_session_stats") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let Some(store) = core.store.as_ref() else {
            return response_failure(
                None,
                "get_session_stats",
                "Session is still initializing",
                None,
            );
        };
        let stats = crate::session_stats::session_stats(store, self.engine.model_context_window());
        response_success(None, "get_session_stats", Some(stats))
    }

    /// `get_model_catalog` (TS daemon-mode `get_model_catalog` →
    /// `session.modelRegistry.refreshModelCatalog`): refresh the registry —
    /// the live Prime Inference catalog fetch plus the private-model
    /// entitlements — then return the full catalog and the providers with
    /// configured auth. The fetch itself runs in the background inside the
    /// refresh (the first response after a daemon boot can still show the
    /// disk-cache/bundled snapshot; the client refreshes again when the
    /// menu is open, exactly like TS).
    async fn handle_get_model_catalog(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_model_catalog") {
            return response;
        }
        let agent_dir = self.config.agent_dir.clone();
        let auth = pa_core::auth::AuthStorage::create(&agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
        let available = registry.refresh_available_models().await;
        let configured_providers: Vec<String> = {
            let mut providers: Vec<String> = available
                .iter()
                .map(|model| model.provider.clone())
                .collect();
            providers.sort();
            providers.dedup();
            providers
        };
        let available_keys: std::collections::HashSet<String> = available
            .iter()
            .map(|model| format!("{}/{}", model.provider, model.id))
            .collect();
        // The catalog keeps every model except private Prime Inference
        // models the current credentials do not authorize.
        let models: Vec<&pa_types::ai::Model> = registry
            .get_all()
            .iter()
            .filter(|model| {
                !pa_core::models::is_private_prime_inference_model(model)
                    || available_keys.contains(&format!("{}/{}", model.provider, model.id))
            })
            .collect();
        let models: Vec<Value> = models
            .into_iter()
            .map(|model| serde_json::to_value(model).unwrap_or(Value::Null))
            .collect();
        response_success(
            None,
            "get_model_catalog",
            Some(json!({
                "models": models,
                "configuredProviders": configured_providers,
            })),
        )
    }

    fn handle_get_messages(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_messages") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let messages: Vec<Value> = core
            .store
            .as_ref()
            .map(super::session_store::SessionFile::messages)
            .unwrap_or_default();
        response_success(None, "get_messages", Some(json!({ "messages": messages })))
    }

    fn handle_get_queue(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_queue") {
            return response;
        }
        let core = self.core.lock().unwrap();
        // TS `get_queue` serves `getSteeringMessagePreviews` /
        // `getFollowUpMessagePreviews`: the labeled preview when the
        // delivery carries one, else the message text.
        response_success(
            None,
            "get_queue",
            Some(json!({
                "steering": core.steering.iter().map(|item| item.preview.clone().unwrap_or_else(|| item.message.clone())).collect::<Vec<_>>(),
                "followUp": core.follow_up.iter().map(|item| item.preview.clone().unwrap_or_else(|| item.message.clone())).collect::<Vec<_>>(),
            })),
        )
    }

    fn handle_clear_queue(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("clear_queue") {
            return response;
        }
        let mut core = self.core.lock().unwrap();
        let steering: Vec<String> = core.steering.drain(..).map(|item| item.message).collect();
        let follow_up: Vec<String> = core.follow_up.drain(..).map(|item| item.message).collect();
        let snapshot = self.snapshot_locked(&core);
        drop(core);
        // The cleared lanes are idle again: the verdict refresh rides the
        // same checkpoint as the snapshot (a stale busy=true from the
        // cleared items' admission must not revive an empty session; a
        // clear mid-turn keeps the verdict busy through the turn).
        self.checkpoint_queue(QueueCheckpoint::Settle {
            operation: "queue_cleared",
        });
        let _ = self.emit_action_update(&snapshot);
        response_success(
            None,
            "clear_queue",
            Some(json!({ "steering": steering, "followUp": follow_up })),
        )
    }

    fn handle_abort_and_clear_queue(&self) -> DaemonResponse {
        let cleared = self.handle_clear_queue();
        if !cleared.success {
            return cleared;
        }
        let mut core = self.core.lock().unwrap();
        core.abort_requested = true;
        // The same TS `requestAbort()` suspension as the bare `abort`.
        core.queued_input_suspended = true;
        drop(core);
        // And the same eager agent abort.
        self.engine.abort_in_flight_turn();
        response_success(None, "abort_and_clear_queue", cleared.data)
    }

    fn handle_get_last_assistant_text(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_last_assistant_text") {
            return response;
        }
        let core = self.core.lock().unwrap();
        let text = core.store.as_ref().and_then(|store| {
            store
                .messages()
                .into_iter()
                .rev()
                .find(|message| crate::types::message_role(message) == Some("assistant"))
                .map(|message| crate::types::message_text(&message))
        });
        response_success(
            None,
            "get_last_assistant_text",
            Some(json!({ "text": text })),
        )
    }

    async fn handle_kill(&self, payload: &Value) -> DaemonResponse {
        let reason = KillCloseReason::from_payload(payload);
        // The session is closing: the continuation mint sites and their
        // settle-hook retries bail from here on (TS `_disposed ||
        // _disposing` in the goal/autonomous resume sites). A stopped
        // session never continues.
        if let Some(agent_engine) = &self.agent_engine {
            agent_engine.mark_session_closed();
        }
        // TS `closeSession` aborts the side questions per attached client
        // before `closeSessionOnce`'s arms run.
        self.side_questions
            .abort_all_and_settle(SIDE_QUESTION_SETTLE_TIMEOUT)
            .await;
        // TS `closeSessionOnce`'s first act: `killed` cancels the session's
        // scheduled jobs (`cancelScheduledJobsForSession` — the queued
        // heartbeat follow-ups' purge included); `replaced` keeps the plain
        // cron jobs but cancels the subagent's RLM heartbeats
        // (`cancelSubagentRlmHeartbeats`); `shutdown` keeps them all (the
        // jobs survive the close for the later scheduled wake). The store
        // cancel is durable, so the stopped session's own heartbeats can
        // never revive it (the zombie fix).
        match reason {
            KillCloseReason::Killed => self.cancel_session_scheduled_jobs().await,
            KillCloseReason::Replaced => self.cancel_session_rlm_heartbeats().await,
            KillCloseReason::Shutdown => {}
        }
        // TS `closeSessionOnce(reason)` cascades the close to the
        // session's resident children with the SAME reason before the
        // session's own archive and dispose; a close failure is swallowed
        // here exactly like the daemon-mode kill handler's
        // `.catch(() => undefined)`.
        let child_reason = match reason {
            KillCloseReason::Killed => crate::rlm_children::ChildCloseReason::Killed,
            KillCloseReason::Shutdown => crate::rlm_children::ChildCloseReason::Shutdown,
            KillCloseReason::Replaced => crate::rlm_children::ChildCloseReason::Replaced,
        };
        if let Err(error) = self.close_rlm_children(child_reason).await {
            eprintln!("pa-daemon: RLM child close at kill failed: {error:#}");
        }
        // The persist (TS `archiveSession` -> `appendSessionState`, before
        // `session.abort()`): synchronous in TS, so the `archived` entry
        // lands while the turn still holds its provider wait. The turn can
        // only append its aborted row once the abort flag below opens the
        // gate, so the file order (archived, then the aborted row) stays
        // the TS one. `shutdown` keeps the resume entry (TS
        // `closeKeepsResumeEntry`), so its file stays live on disk. The
        // core lock never blocks on the in-flight turn: the turn runner
        // holds it only for the instants it persists an event, never
        // across the provider wait. The guard rides a block, not an
        // explicit drop: a `drop(core)` does not end the guard's slot in
        // an async generator, so the later awaits would make the future
        // non-Send.
        {
            let mut core = self.core.lock().unwrap();
            // `shutdown` keeps the resume entry (TS
            // `closeKeepsResumeEntry`), so its file stays live on disk;
            // the killed and replaced closes archive (the base's
            // `persist_entry` write).
            if reason != KillCloseReason::Shutdown {
                if let Some(store) = core.store.as_mut() {
                    if let Err(error) = store.persist_entry(
                        "session_state",
                        json!({ "state": { "status": "archived" } }),
                    ) {
                        return response_failure(None, "kill", &error.to_string(), None);
                    }
                }
            }
            core.created = false;
        }
        // The abort funnel fires BEFORE every close step that can wait on
        // the session mutex the running turn holds across its provider
        // wait. TS `session.abort()` starts with `requestAbort()` ->
        // `agent.abort()`, which cancels the in-flight fetch immediately,
        // so the later awaits in the close (the settle, the telemetry
        // archive, the kernel dispose) settle on an already-cancelled
        // turn instead of waiting out the stream. TS dispose cancels the
        // queued session actions and clears the agent queues
        // (`requestAbort` parks the input pump, `dispose` rejects every
        // queued action): nothing may feed another turn after the close
        // below (and the turn runner clears the abort flag when it pops
        // an item, so the cancel must land first).
        {
            let mut core = self.core.lock().unwrap();
            core.abort_requested = true;
            core.steering.clear();
            core.follow_up.clear();
        }
        self.work_notify.notify_one();
        self.compaction.abort();
        self.tree_navigation.abort();
        self.engine.abort_in_flight_turn();
        // The awaited `session.abort()` settles the cancelled in-flight
        // turn and compaction: the aborted turn's row broadcasts and
        // persists here (the #247 gate's aborted-row exception), and only
        // then does the runtime dispose run — the kernel teardown must
        // not race a live run.
        self.await_session_work_settled().await;
        // `session archived` (schema v1) + the session-ended finalization:
        // kill disposes the session like the TS dispose callback, which
        // TS runs AFTER the awaited `session.abort()` — so the ended-run
        // accounting includes the aborted turn, and the settle above has
        // released the turn's hold on the session mutex: this never waits
        // out a pending provider response.
        self.engine.archive_session_telemetry().await;
        // The runtime dispose of the TS close path
        // (`closeSessionOnce` -> `runtime.dispose()` ->
        // `session.disposeAsync` -> `IpythonKernelProvisioner.dispose`,
        // default snapshot policy): the session's kernel dies with the
        // session. The worker keeps the engine object, so the engine-drop
        // teardown from #235 cannot run yet — dispose it explicitly.
        if let Some(agent_engine) = &self.agent_engine {
            agent_engine.dispose_kernel().await;
        }
        let active_session_id = self.core.lock().unwrap().active_session_id.clone();
        let _ = self.emit_session_closed(&active_session_id, reason.session_closed_reason());
        let _ = self.record_recovery(false, reason.recovery_operation());
        let lease = self
            .core
            .lock()
            .unwrap()
            .store
            .as_mut()
            .and_then(|store| store.lease.take());
        drop(lease);
        response_success(None, "kill", None)
    }

    pub(crate) fn handle_rename(&self, command: &str, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created(command) {
            return response;
        }
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
        if name.trim().is_empty() {
            return response_failure(None, command, "Session name cannot be empty", None);
        }
        let mut core = self.core.lock().unwrap();
        if let Some(store) = core.store.as_mut() {
            if let Err(error) = store.persist_entry("session_info", json!({ "name": name })) {
                return response_failure(None, command, &error.to_string(), None);
            }
        }
        let summary = self.summary_locked(&core);
        drop(core);
        // TS `session.setSessionName` emits `session_info_changed` so every
        // attached client re-reads the name (the interactive mode patches
        // its connection state from the event).
        self.emit_worker_event(serde_json::json!({
            "type": "session_info_changed",
            "name": name,
        }));
        // The sender identity follows the live name.
        if let Ok(summary_value) = serde_json::to_value(&summary) {
            self.engine.set_session_summary(summary_value);
        }
        response_success(
            None,
            command,
            Some(serde_json::to_value(&summary).unwrap_or(Value::Null)),
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

/// The compaction cut budget the engine ran with
/// (`compaction.keepRecentTokens` from settings, TS default 20k): the
/// durable boundary re-cut in the turn callback must walk with the same
/// budget to pin the same cut.
fn keep_recent_tokens(cwd: &str, agent_dir: &std::path::Path) -> u64 {
    pa_core::settings::SettingsManager::create(cwd, agent_dir)
        .settings()
        .compaction
        .clone()
        .unwrap_or_default()
        .keep_recent_tokens
        .unwrap_or(pa_core::session_engine::compaction::DEFAULT_KEEP_RECENT_TOKENS)
}

fn active_session_id_of(payload: &[u8]) -> String {
    serde_json::from_slice::<Value>(payload)
        .ok()
        .and_then(|value| {
            value
                .get("activeSessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn worker_server_capabilities() -> Vec<String> {
    default_server_capabilities()
}

/// RLM depth fields of a create payload: `(depth, max_depth)`. Values must
/// be non-negative integers that fit a u32; anything else fails the create
/// instead of silently truncating.
fn create_payload_rlm_depth(payload: &Value) -> Result<(Option<u32>, Option<u32>), String> {
    fn parse(payload: &Value, key: &str) -> Result<Option<u32>, String> {
        match payload.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .map(Some)
                .ok_or_else(|| format!("create {key} must be a non-negative integer")),
        }
    }
    let depth = parse(payload, "rlmDepth")?;
    let max_depth = parse(payload, "rlmMaxDepth")?;
    Ok((depth, max_depth))
}

/// Creation prefix for a daemon-hosted session file (TS `createAgentSession`
/// in the worker process): fresh files record `model_change` (when the engine
/// resolves a model), `thinking_level_change`, and `service_tier_change`; a
/// reopened session records the thinking level and service tier only when no
/// earlier entry set them. The recorded thinking level is the engine's
/// effective one — the create-config flag (else settings default/medium)
/// clamped to the model's supported levels; engines without a model
/// resolution (the scripted harness) record "off".
fn append_creation_prefix(
    store: &mut SessionFile,
    engine: &dyn SessionEngine,
    agent_dir: &std::path::Path,
    cwd: &str,
    fresh: bool,
) {
    let has_thinking_entry = store.has_thinking_level();
    let has_service_tier_entry = store.has_service_tier();
    let thinking_level = engine
        .effective_thinking_level()
        .unwrap_or_else(|| "off".to_string());
    if fresh {
        if let Some((provider, model_id)) = engine.creation_model() {
            store.append_model_change(&provider, &model_id);
        }
        store.append_thinking_level_change(&thinking_level);
    } else if !has_thinking_entry {
        store.append_thinking_level_change(&thinking_level);
    }
    if fresh || !has_service_tier_entry {
        let settings = pa_core::settings::SettingsManager::create(cwd, agent_dir);
        let service_tier = settings.get_default_service_tier();
        store.append_entry(
            "service_tier_change",
            json!({ "serviceTier": service_tier }),
        );
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
            Lane::Steering => core.steering.push_back(item),
            Lane::FollowUp => core.follow_up.push_back(item),
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

struct TurnRunner {
    pub(crate) core: Arc<Mutex<SessionCore>>,
    /// The input-pause table (the admission gate holds queued input).
    input_pauses: crate::session_input_pause::InputPauseTable,
    /// The prompt-admission registry: a queued admitted prompt commits
    /// when its turn starts and clears when the turn settles.
    prompt_admissions: crate::prompt_admission::WorkerAdmissions,
    work_notify: Arc<Notify>,
    idle_notify: Arc<Notify>,
    pub(crate) events: Arc<EventPump>,
    engine: std::sync::Arc<dyn SessionEngine>,
    /// Shared worker recovery journal (queue snapshot persistence).
    recovery: Arc<Mutex<Option<WorkerRecoveryJournal>>>,
    active_session_id: String,
    /// The coalescing roster push queue: the busy flips enqueue here and
    /// the queue's consumer composes and ships the summary (the
    /// event-driven arm lives in [`crate::roster_activity`]).
    roster_pushes: crate::roster_activity::RosterPushQueue,
}

impl TurnRunner {
    async fn run(self) {
        loop {
            let engine = self.engine.clone();
            let item: Option<Vec<QueuedItem>> = {
                let mut core = self.core.lock().unwrap();
                if core.shutdown_requested {
                    drop(core);
                    // The shutdown handler waits on the idle notify for
                    // the in-flight run to settle before it disposes the
                    // kernel; this is the runner's last chance to fire it
                    // (the parking arm below never runs once shutdown is
                    // requested, and the runner always reaches this point
                    // with the previous run already settled).
                    self.idle_notify.notify_waiters();
                    return;
                }
                // The input-admission gate (TS
                // `_sessionInputAdmissionPauses`): held pauses keep
                // queued input queued until the release wakes the runner.
                // The abort-suspension gate (TS `_sessionInputPumpSuspended`,
                // which parks the pump after `requestAbort`/manual `compact`):
                // already-queued items survive parked until a resume site
                // clears the flag.
                if self.input_pauses.paused() || core.queued_input_suspended {
                    core.busy = false;
                    None
                } else if core.steering.front().is_some() {
                    let items = gather_delivery_batch(&mut core, Lane::Steering);
                    core.busy = true;
                    core.abort_requested = false;
                    core.retry_abort_requested = false;
                    // The run starts with no tool calls in flight (TS
                    // resets `pendingToolCalls` at run start).
                    core.running_tool_calls.clear();
                    Some(items)
                } else if core.follow_up.front().is_some() {
                    let items = gather_delivery_batch(&mut core, Lane::FollowUp);
                    core.busy = true;
                    core.abort_requested = false;
                    core.retry_abort_requested = false;
                    core.running_tool_calls.clear();
                    Some(items)
                } else {
                    core.busy = false;
                    None
                }
            };
            if let Some(items) = item {
                // No pickup checkpoint by design: every path that
                // admits work into the lanes has already recorded its
                // busy=true evidence at admission (`prompt_accepted`,
                // `steer_queued`/`follow_up_queued`, `actions_restored`),
                // so the whole in-flight window reads as interrupted
                // work without another journal write on the runner; the
                // settle's `turn_end` verdict is what parks the session
                // later.
                // The pickup projection (TS `_pumpSessionInputs` emits the
                // queue update at the action's `preparing` transition): the
                // delivered item leaves the queue projection BEFORE its
                // turn starts, so a client's queue strip drops the row at
                // delivery time. Without it the strip keeps the delivered
                // message for the whole turn (dogfood P0: the steered
                // message sends but still shows in the queue) and a browse
                // edit addressed at the stale row is rejected as changed.
                // A queue-visible delivery carries the active action
                // through its TS phase transitions: `preparing` projects
                // here at pickup, then `committing` at the turn's first
                // row (the moment the prompt becomes visible in the
                // conversation — TS's commit fence) and `running` at the
                // turn's first assistant frame, both emitted by the
                // runner's event path, cleared at the settle. The
                // `preparing` projection is what a client renders as the
                // queued strip's "Starting" row (TS #2063): the prompt
                // left its lane, and until the turn's rows land the strip
                // is the only place it is visible. An invisible item (an
                // idle session's direct prompt admission, injected goal
                // and autonomous continuations) projects the plain pickup
                // like TS's `queueVisible` filter, so an all-invisible
                // batch sets no active action at all.
                // The active label is the delivery's labeled preview when
                // it carries one (TS #2063 `queuedAgentMessagePreview`:
                // `payload.preview ?? payload.text`) — an agent-message
                // delivery shows its "Agent message received: ..." row,
                // not the raw envelope.
                let visible_index = items.iter().position(|item| item.queue_visible);
                let anchor = visible_index.map(|index| &items[index]);
                {
                    let mut core = self.core.lock().unwrap();
                    if let Some(anchor) = anchor {
                        core.active_action = Some(crate::types::SessionActionActive {
                            kind: "turn".to_string(),
                            phase: "preparing".to_string(),
                            label: Some(compact_action_label(
                                anchor.preview.as_deref().unwrap_or(&anchor.message),
                            )),
                        });
                    }
                    let snapshot = self.snapshot_from(&core);
                    drop(core);
                    let _ = self.emit_action_update(&snapshot);
                }
                // The busy flip reaches the supervisor's roster before the
                // turn runs (TS pushes the same transition).
                self.push_roster_delta();
                self.run_turn(engine, items).await;
            } else {
                self.idle_notify.notify_waiters();
                self.work_notify.notified().await;
            }
        }
    }

    /// Push one roster delta to the supervisor (the Rust-native form of
    /// the TS `roster_delta` worker frame): the worker's summary after a
    /// busy flip, so subscribed clients see live status without polling.
    /// The queue's consumer composes and ships the summary, coalescing
    /// this request with any event-driven flush that raced the flip; a
    /// dead link reconnects on the next flush, and a supervisor restart
    /// re-seeds the entry from registration.
    pub(crate) fn push_roster_delta(&self) {
        self.roster_pushes.push();
    }

    /// One delivery: a single item, or the batch the pump gathered (TS
    /// `_startPreparedTurnActions`): the first item anchors the turn and
    /// the rest ride as co-delivered user rows of the same run.
    async fn run_turn(&self, engine: std::sync::Arc<dyn SessionEngine>, items: Vec<QueuedItem>) {
        let Some((first, batched)) = items.split_first() else {
            return;
        };
        // An admitted prompt's turn started: its prompt admission commits
        // (TS `commitAdmission`) — one per batched item, in delivery order.
        for admission_id in items.iter().filter_map(|item| item.admission_id.as_ref()) {
            self.prompt_admissions.commit(admission_id);
        }
        self.emit_turn_event(json!({ "type": "agent_start" }));
        self.emit_turn_event(json!({ "type": "turn_start" }));

        let prompt_index = {
            let core = self.core.lock().unwrap();
            core.store
                .as_ref()
                .map_or(0, super::session_store::SessionFile::message_count)
                / 2
        };
        let request = PromptRequest {
            batch: batched
                .iter()
                .map(|item| crate::engine::PromptBatchRow {
                    text: item.message.clone(),
                    images: item.images.clone(),
                })
                .collect(),
            message: first.message.clone(),
            images: first.images.clone(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: first.custom_message.clone(),
        };
        // Live token-stream coalescing for this turn: the emit path parks
        // `message_update` frames in a single slot and a flusher task
        // broadcasts at most one parked snapshot per interval, while every
        // other frame goes out directly (flushing the parked update first,
        // so wire order matches event-sequence order exactly).
        let coalescer = {
            let core = self.core.lock().unwrap();
            Arc::new(crate::streaming::TurnStreamCoalescer::new(
                core.active_session_id.clone(),
                core.generation.clone(),
            ))
        };
        let flusher = {
            let coalescer = Arc::clone(&coalescer);
            let events = self.events.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(crate::streaming::UPDATE_FLUSH_INTERVAL).await;
                    if !coalescer.flush_pending(&events) {
                        break;
                    }
                }
            })
        };
        let engine = engine.clone();
        let core = Arc::clone(&self.core);
        let events = self.events.clone();
        let turn_coalescer = Arc::clone(&coalescer);
        let agent_dir = crate::paths::agent_dir().unwrap_or_default();
        // The settle tail's background compact-trigger servicing owns its
        // own engine clone (the turn closure below moves the shadowing
        // clone), and fences its rows on the session identity it serviced
        // (a branch move or replacement swaps the store mid-review).
        let review_engine = std::sync::Arc::clone(&engine);
        let review_session_id = {
            let core = self.core.lock().unwrap();
            core.store
                .as_ref()
                .map(|store| store.session_id().to_string())
                .unwrap_or_default()
        };
        // The turn's settled outcome reaches the waiting prompt only
        // after the runner flipped the session back to idle (TS
        // `promptAndWait` resolves after the full settle): the blocking
        // task parks the result in this slot and `run_turn` resolves the
        // waiter once the turn is fully unwound. Resolving at the `Done`
        // event instead (the pre-fix behavior) let a follow-up request
        // land in the pre-idle window where `core.busy` is still set, so
        // the suspension gate queued it behind the (indefinite)
        // suspension instead of rejecting it — the f7 suspension
        // sequence's post-abort prompt hung exactly there.
        // The batch's waiting prompts (TS `promptAndWait`): one waiter per
        // queued `prompt_and_wait` item in the delivery, each resolved at
        // the same fully-settled point. The settled admissions clear at the
        // same point (collected before the items are consumed).
        let settled_admissions: Vec<String> = items
            .iter()
            .filter_map(|item| item.admission_id.clone())
            .collect();
        let items_done: Vec<oneshot::Sender<TurnSettle>> =
            items.into_iter().filter_map(|item| item.done).collect();
        let turn_outcome = Arc::new(std::sync::Mutex::new(None::<TurnSettle>));
        let turn_outcome_slot = Arc::clone(&turn_outcome);
        // Whether the engine surfaced any `agent_end` boundary this item
        // (each agent run ends with one — retried and continued runs
        // included). The worker's trailing synthesized frame is a fallback
        // for runs that ended without a model turn (session commands,
        // pre-model failures) and stays silent once a run's own frame
        // arrived — or was swallowed by the abort gate, which TS mirrors
        // by showing no `agent_end` at all (the compact path's detached
        // run).
        let engine_agent_end = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine_agent_end_seen = Arc::clone(&engine_agent_end);
        let turn = tokio::task::spawn_blocking(move || {
            // Whether the engine already emitted its own terminal
            // `turn_end` frame this run (the loop emits one per turn —
            // settled, aborted, and failed alike). The trailing `Done`
            // fallback frame stays silent then; it exists only for runs
            // that end without a model turn (session commands, pre-model
            // failures).
            let mut engine_turn_ended = false;
            // TS #2063: whether this run's active action already flipped
            // to `committing`/`running` — each flip rides the first event
            // that marks the moment (the turn's first row commits it, the
            // first assistant frame runs it), so the queue's `preparing`
            // projection spans the real pickup -> rows-land window a
            // client renders as the strip's "Starting" row.
            let mut active_committed = false;
            let mut active_running = false;
            // Restored next-turn rows ride this delivery as PREFIX rows
            // (before the accepted prompt): they render in the
            // conversation, but they are not the prompt's rows-land moment
            // — the "Starting" row must survive them and drop at the
            // accepted row (the bots' commit-fence finding). The flip
            // closure reads the flag while the prefix loop writes it, so
            // it is a Cell (the runner is single-threaded here).
            let emitting_prefix_rows = std::cell::Cell::new(false);
            // The last error of the active retry episode (the
            // `auto_retry_start` errorMessage): the episode's durable
            // outcome row names it on success too — the final event
            // carries no error then (SANCTIONED DIVERGENCE, operator
            // ruling 2026-09-23: one outcome row replaces the per-attempt
            // error rows TS keeps).
            let mut last_retry_error: Option<String> = None;
            let mut emit = |mut event: EngineEvent| -> bool {
                // Sequence + persist under the core lock, then broadcast.
                // The abort flag lives on the session core (`abort`
                // command): a cancelled turn stops consuming its own
                // events — except the frames TS still broadcasts for an
                // interrupted turn. TS applies no post-abort gate at all:
                // the agent abort cancels the provider fetch and turns the
                // in-flight tool into an error result, and the frames that
                // settle the cancelled run reach the listeners and the
                // session store (the tool-phase probe: `abort` mid-kernel
                // cell broadcasts tool_execution_end + the aborted
                // toolResult row pair + turn_end + agent_end, exactly like
                // a settled turn). The only post-abort noise TS never
                // shows is the cancelled fetch's stream stragglers (the
                // provider stream stops at the cancel, and TS tool
                // updates stop at `acceptingUpdates = false`), so the gate
                // drops the stream-update family and forwards:
                // - the aborted assistant row (`createAbortedAssistantMessage`:
                //   the pair broadcasts, `appendMessage` persists, the
                //   trailing `turn_end` and `agent_end` carry the row),
                //   closed by `suppress_aborted_row` for the detached-run
                //   paths (TS `compact`/branch navigation);
                // - the aborted tool's settle frames (the error
                //   tool_execution_end, the toolResult row pair, the
                //   cancelled run's own turn_end/agent_end);
                // - the engine's trailing `Done` outcome, which parks the
                //   turn result so a waiting `prompt_and_wait` resolves at
                //   the settle (a dropped Done hung the response forever —
                //   the abort UX probe).
                if matches!(event, EngineEvent::TurnEnd { .. }) {
                    engine_turn_ended = true;
                }
                if matches!(event, EngineEvent::AgentEnd { .. }) {
                    engine_agent_end_seen.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                let aborted_row = matches!(
                    &event,
                    EngineEvent::AssistantMessage(message)
                        | EngineEvent::AssistantUpdate { message, .. }
                        | EngineEvent::TurnEnd { message, .. }
                        if message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                ) || matches!(
                    &event,
                    EngineEvent::AgentEnd { messages }
                        if messages.iter().any(|message| {
                            message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                        })
                );
                let abort_settle = matches!(
                    &event,
                    EngineEvent::ToolExecutionEnd { .. }
                        | EngineEvent::ToolResultMessage(_)
                        | EngineEvent::TurnEnd { .. }
                        | EngineEvent::AgentEnd { .. }
                        | EngineEvent::Done(_)
                        | EngineEvent::DoneAborted
                );
                let mut core = core.lock().unwrap();
                if core.abort_requested
                    && (core.suppress_aborted_row || !(abort_settle || aborted_row))
                {
                    return false;
                }
                // The engine cuts its in-memory entries; its
                // `firstKeptEntryId` never matches this store's file ids,
                // so a verbatim copy retains nothing on the durable read.
                // Re-pin the boundary to the durable cut (TS: one store,
                // ids match by construction) before persist + broadcast.
                if let EngineEvent::Compaction {
                    ref mut entry,
                    event: ref mut payload,
                } = event
                {
                    if !entry.is_null() {
                        let repin_started = std::time::Instant::now();
                        let durable_entries = core
                            .store
                            .as_ref()
                            .and_then(|store| store.branch().len().checked_sub(1))
                            .unwrap_or(0);
                        if let Some(id) = core.store.as_ref().and_then(|store| {
                            store.durable_first_kept_entry_id(keep_recent_tokens(
                                &core.cwd, &agent_dir,
                            ))
                        }) {
                            entry["firstKeptEntryId"] = json!(id);
                            if let Some(result) =
                                payload.get_mut("result").and_then(Value::as_object_mut)
                            {
                                result.insert("firstKeptEntryId".to_string(), json!(id));
                            }
                        }
                        pa_core::session_engine::compaction_trace::trace(
                            "emit.compaction_repin",
                            serde_json::json!({
                                "durableEntries": durable_entries,
                                "micros": repin_started.elapsed().as_micros(),
                            }),
                        );
                    }
                }
                match &event {
                    // The session-file form of a tool result: a `message`
                    // entry with the `role: "toolResult"` payload (TS
                    // `_processAgentEvent` appendMessage path).
                    EngineEvent::UserMessage(message)
                    | EngineEvent::AssistantMessage(message)
                    | EngineEvent::ToolResultMessage(message) => {
                        if let Some(store) = core.store.as_mut() {
                            let _ = store.persist_entry("message", json!({ "message": message }));
                        }
                    }
                    // The in-flight tool-call set (TS
                    // `session.state.pendingToolCalls`): the summary's
                    // `isRunningTools` derives from its size, and the
                    // update happens under the same core lock the frames
                    // sequence under, so the roster feed composed from a
                    // broadcast trigger frame never reads a half-applied
                    // transition.
                    EngineEvent::ToolExecutionStart { tool_call_id, .. } => {
                        core.running_tool_calls.insert(tool_call_id.clone());
                    }
                    EngineEvent::ToolExecutionEnd { tool_call_id, .. } => {
                        core.running_tool_calls.remove(tool_call_id);
                    }
                    // The session-file form of a custom row (TS
                    // `appendCustomMessageEntry`: customType/content/display/
                    // details fields on a `custom_message` entry).
                    EngineEvent::CustomMessage(message) => {
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
                    EngineEvent::Compaction { entry, .. } => {
                        // A skipped compaction carries a null entry (the
                        // skip shape): publish the event, never persist it.
                        if let Some(store) = core.store.as_mut().filter(|_| !entry.is_null()) {
                            let persist_started = std::time::Instant::now();
                            let _ = store.persist_entry("compaction", entry.clone());
                            pa_core::session_engine::compaction_trace::trace(
                                "emit.compaction_persist",
                                serde_json::json!({
                                    "micros": persist_started.elapsed().as_micros(),
                                }),
                            );
                        }
                    }
                    // The durable mirror of a goal-state change (TS
                    // `_setGoalState` -> `_persistGoalState`: the
                    // `thread_goal_state` custom entry + flush, one store
                    // with the transcript). The announcement only fires on
                    // a real state change, so each row is the new state.
                    EngineEvent::GoalUpdate { goal } => {
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
                    _ => {}
                }
                // TS #2063: the active action's `committing`/`running`
                // transitions ride the events that mark the moments — the
                // turn's first row commits it (the prompt becomes visible
                // in the conversation exactly then, the boundary TS's
                // strip drops its "Starting" row at: the commit fence),
                // the first assistant frame runs it.
                let mut action_frame: Option<SessionActionSnapshot> = None;
                if !emitting_prefix_rows.get()
                    && !active_committed
                    && matches!(
                        event,
                        EngineEvent::UserMessage(_) | EngineEvent::CustomMessage(_)
                    )
                {
                    active_committed = true;
                    if let Some(active) = core.active_action.as_mut() {
                        active.phase = "committing".to_string();
                    }
                    action_frame = Some(session_snapshot(&core));
                } else if !active_running
                    && matches!(
                        event,
                        EngineEvent::AssistantUpdate { .. } | EngineEvent::AssistantMessage(_)
                    )
                {
                    active_running = true;
                    if let Some(active) = core.active_action.as_mut() {
                        active.phase = "running".to_string();
                    }
                    action_frame = Some(session_snapshot(&core));
                }
                let done_result = match &event {
                    EngineEvent::Done(result) => {
                        // The turn boundary releases RLM child prompt tasks
                        // waiting on it (the parent's continuation request
                        // is in flight before any child's first turn).
                        engine.on_turn_done();
                        pa_core::session_engine::compaction_trace::trace(
                            "turn.done_emitted",
                            serde_json::json!({
                                "ok": matches!(result, Ok(())),
                            }),
                        );
                        Some(match result {
                            Ok(()) => TurnSettle::Completed,
                            Err(error) => TurnSettle::Failed(error.clone()),
                        })
                    }
                    // The aborted settle carries its classification
                    // structurally, not through the error text.
                    EngineEvent::DoneAborted => {
                        engine.on_turn_done();
                        Some(TurnSettle::Aborted)
                    }
                    _ => None,
                };
                // One event may map to several wire frames (a custom row
                // is a message_start + message_end pair).
                let mut frames: Vec<Value> = match event {
                    EngineEvent::UserMessage(message) => {
                        // TS emits the accepted user message as a
                        // message_start + message_end pair (the row is
                        // complete the moment it is accepted).
                        vec![
                            json!({ "type": "message_start", "message": message }),
                            json!({ "type": "message_end", "message": message }),
                        ]
                    }
                    EngineEvent::AssistantUpdate {
                        message,
                        stream_event,
                    } => {
                        // A provider `start` begins a new assistant message;
                        // later stream events update it (TS message_start vs
                        // message_update).
                        let starts_message = stream_event
                            .as_ref()
                            .and_then(|event| event.get("type"))
                            .and_then(Value::as_str)
                            == Some("start");
                        let mut event = json!({
                            "type": if starts_message { "message_start" } else { "message_update" },
                            "message": message,
                        });
                        if let Some(stream_event) = stream_event {
                            event["assistantMessageEvent"] = stream_event;
                        }
                        vec![event]
                    }
                    EngineEvent::AssistantMessage(message) => {
                        vec![json!({ "type": "message_end", "message": message })]
                    }
                    EngineEvent::ToolExecutionStart {
                        tool_call_id,
                        tool_name,
                        args,
                    } => vec![json!({
                        "type": "tool_execution_start",
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "args": args,
                    })],
                    EngineEvent::ToolExecutionUpdate {
                        tool_call_id,
                        partial_result,
                    } => vec![json!({
                        "type": "tool_execution_update",
                        "toolCallId": tool_call_id,
                        "partialResult": partial_result,
                    })],
                    EngineEvent::ToolExecutionEnd {
                        tool_call_id,
                        result,
                        is_error,
                    } => vec![json!({
                        "type": "tool_execution_end",
                        "toolCallId": tool_call_id,
                        "result": result,
                        "isError": is_error,
                    })],
                    EngineEvent::ToolResultMessage(message)
                    | EngineEvent::CustomMessage(message) => vec![
                        json!({ "type": "message_start", "message": message }),
                        json!({ "type": "message_end", "message": message }),
                    ],
                    EngineEvent::CompactionStart { event }
                    | EngineEvent::Compaction { event, .. } => vec![event],
                    EngineEvent::GoalUpdate { goal } => vec![json!({
                        "type": "goal_update",
                        "goal": goal,
                    })],
                    // The loop's run-boundary frames (TS `agent_start`/
                    // `agent_end`): the run's whole message set rides
                    // `agent_end` (one frame per agent run — retried and
                    // continued runs included); the rows themselves
                    // already went out through their own events, so no
                    // persist here.
                    EngineEvent::AgentStart => vec![json!({ "type": "agent_start" })],
                    EngineEvent::AgentEnd { messages } => vec![json!({
                        "type": "agent_end",
                        "messages": messages,
                    })],
                    // The loop's turn-boundary frames (TS `turn_start`/
                    // `turn_end`): the terminal assistant message and the
                    // turn's tool-result messages ride `turn_end`; the rows
                    // themselves already went out through their own events,
                    // so no persist here.
                    EngineEvent::TurnStart => vec![json!({ "type": "turn_start" })],
                    EngineEvent::TurnEnd {
                        message,
                        tool_results,
                    } => vec![json!({
                        "type": "turn_end",
                        "message": message,
                        "toolResults": tool_results,
                    })],
                    // The fallback terminal frame for runs that ended
                    // without the engine's own `turn_end` (session
                    // commands, pre-model failures): unchanged shape, and
                    // silent once the engine's frame covered the run.
                    EngineEvent::Done(Ok(())) if !engine_turn_ended => {
                        vec![json!({ "type": "turn_end" })]
                    }
                    EngineEvent::Done(Err(error)) if !engine_turn_ended => {
                        vec![json!({ "type": "turn_end", "error": error })]
                    }
                    EngineEvent::DoneAborted if !engine_turn_ended => vec![json!({
                        "type": "turn_end",
                        "error": ABORTED_TURN_SETTLE_ERROR,
                    })],
                    EngineEvent::Done(Ok(()) | Err(_)) | EngineEvent::DoneAborted => Vec::new(),
                    EngineEvent::AutoRetryStart {
                        attempt,
                        max_attempts,
                        delay_ms,
                        error_message,
                        reason,
                    } => {
                        // The episode remembers its latest error so the
                        // outcome row can name it on success (the end event
                        // carries no error then).
                        last_retry_error = Some(error_message.clone());
                        let mut event = json!({
                            "type": "auto_retry_start",
                            "attempt": attempt,
                            "maxAttempts": max_attempts,
                            "delayMs": delay_ms,
                            "errorMessage": error_message,
                        });
                        match reason {
                            pa_core::session_engine::auto_retry::RetryStartReason::Quick => {}
                            pa_core::session_engine::auto_retry::RetryStartReason::Backup {
                                backup_model,
                            } => {
                                event["reason"] = json!("backup");
                                event["backupModel"] = json!(backup_model);
                            }
                        }
                        vec![event]
                    }
                    EngineEvent::AutoRetryEnd {
                        success,
                        attempt,
                        final_error,
                        restored_model,
                    } => {
                        let mut event = json!({
                            "type": "auto_retry_end",
                            "success": success,
                            "attempt": attempt,
                        });
                        if let Some(final_error) = &final_error {
                            event["finalError"] = json!(final_error);
                        }
                        if let Some(restored_model) = restored_model {
                            event["restoredModel"] = json!(restored_model);
                        }
                        // The episode's ONE durable outcome row (SANCTIONED
                        // DIVERGENCE, operator ruling 2026-09-23): the
                        // chat keeps a single resolved/terminal line for
                        // the whole episode — live, through the message
                        // pair below, and rebuilt, through the session
                        // transcript — instead of one error row per failed
                        // attempt. On success the row names the error the
                        // starts reported (the end event carries none).
                        let error = final_error
                            .or_else(|| last_retry_error.take())
                            .unwrap_or_else(|| "Unknown error".to_string());
                        last_retry_error = None;
                        let outcome = pa_core::session_engine::messages::
                            create_provider_retry_outcome_message(success, attempt, &error);
                        let outcome = crate::session_commands::custom_message_value(&outcome);
                        if outcome.is_object() {
                            if let Some(store) = core.store.as_mut() {
                                let _ = store.persist_entry(
                                    "custom_message",
                                    json!({
                                        "customType": outcome.get("customType").cloned().unwrap_or(Value::Null),
                                        "content": outcome.get("content").cloned().unwrap_or(Value::Null),
                                        "display": outcome.get("display").cloned().unwrap_or(Value::Bool(true)),
                                        "details": outcome.get("details").cloned().unwrap_or(Value::Null),
                                    }),
                                );
                            }
                        }
                        vec![
                            event,
                            json!({ "type": "message_start", "message": outcome }),
                            json!({ "type": "message_end", "message": outcome }),
                        ]
                    }
                };
                // The phase flip's queue-update frame rides the same batch
                // (after the row frames it follows, so a client sees the
                // prompt land and then the strip drop its "Starting" row):
                // an unchanged projection stays silent, like every queue
                // emit (TS `_emitQueueUpdate`).
                if let Some(snapshot) = action_frame {
                    if core.last_action_snapshot.as_ref() != Some(&snapshot) {
                        core.last_action_snapshot = Some(snapshot.clone());
                        frames.push(json!({
                            "type": "session_action_update",
                            "actions": snapshot,
                        }));
                    }
                }
                // Verification seam: dump the emitted session events for
                // harness debugging (PA_DAEMON_EVENT_LOG=<path>).
                if let Ok(path) = std::env::var("PA_DAEMON_EVENT_LOG") {
                    use std::io::Write;
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&path)
                    {
                        for frame in &frames {
                            let _ = writeln!(file, "{frame}");
                        }
                    }
                }
                let mut direct_payloads: Vec<Vec<u8>> = Vec::new();
                for event_json in frames {
                    let is_stream_update =
                        event_json.get("type").and_then(Value::as_str) == Some("message_update");
                    // A block-end stream event (`text_end` and friends)
                    // settles the parked delta run: it must supersede
                    // nothing, so it travels direct (flushing the parked
                    // update first, in order).
                    let stream_kind = event_json
                        .get("assistantMessageEvent")
                        .and_then(|event| event.get("type"))
                        .and_then(Value::as_str);
                    let flushes_pending = matches!(
                        stream_kind,
                        Some("text_end" | "thinking_end" | "toolcall_end")
                    );
                    if is_stream_update && !flushes_pending {
                        let sequence = core.last_event_sequence + 1;
                        core.last_event_sequence = sequence;
                        // Streaming updates park in the coalescer (the
                        // newest full-partial snapshot wins, the delta run
                        // merges); `park_update` only returns false after
                        // the turn joined, which cannot race this closure.
                        let delta = event_json
                            .get("assistantMessageEvent")
                            .and_then(|event| event.get("delta"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let parked = turn_coalescer.park_update(
                            event_json.get("message").cloned().unwrap_or(Value::Null),
                            stream_kind.unwrap_or_default(),
                            delta,
                            sequence,
                        );
                        if !parked {
                            return false;
                        }
                        continue;
                    }
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
                        event: event_json,
                        meta: Some(meta),
                        rest: Map::default(),
                    };
                    let payload = serde_json::to_vec(&outbound).unwrap_or_default();
                    direct_payloads.push(payload);
                }
                drop(core);
                // A batch that carries direct frames goes out immediately
                // (flushing the parked update first, preserving
                // event-sequence order); a pure-update batch leaves its
                // frame parked for the flusher.
                if !direct_payloads.is_empty() {
                    turn_coalescer.send_direct(&direct_payloads, &events);
                }
                // Park the turn's settled outcome for the post-idle
                // resolution: the waiting response must observe the
                // frames' sequences (see `ConnectionSink`) and may not be
                // written while the session is still mid-unwind (the
                // runner resolves the waiter after the idle flip).
                if let Some(result) = done_result {
                    *turn_outcome_slot.lock().unwrap() = Some(result);
                }
                true
            };
            let aborted_probe = {
                let core = Arc::clone(&core);
                // `abort_retry` stops an in-flight retry without aborting
                // the turn itself (TS `abortRetry` only reaches the retry
                // controller).
                move || {
                    core.lock().unwrap().abort_requested
                        || core.lock().unwrap().retry_abort_requested
                }
            };
            // Restored next-turn rows ride this delivery (TS
            // `prefixMessages`): emitted before the accepted prompt, the
            // same durable-row path as in-turn custom rows. They are not
            // the delivery's rows-land moment, so the committing flip
            // waits for the accepted row behind them.
            let parked = {
                let mut core = core.lock().unwrap();
                std::mem::take(&mut core.pending_next_turn)
            };
            emitting_prefix_rows.set(!parked.is_empty());
            for row in parked {
                if !emit(EngineEvent::CustomMessage(row)) {
                    break;
                }
            }
            emitting_prefix_rows.set(false);
            engine.run_prompt(prompt_index, request, &aborted_probe, &mut emit);
        });
        let _ = turn.await;
        // The turn's emit path is joined: nothing parks from here on, a
        // stale parked partial must not surface after the settle events,
        // and the flusher task stops on its next tick.
        coalescer.close();
        flusher.abort();

        {
            let mut core = self.core.lock().unwrap();
            core.busy = false;
            core.active_action = None;
        }
        self.push_roster_delta();
        // The fallback `agent_end` for runs that ended without a model
        // turn (session commands, pre-model failures): the engine's own
        // per-run frames (one per agent run, retried and continued runs
        // included — the TS `agent_end` `messages` payload) are the real
        // frames, and a run whose `agent_end` the abort gate swallowed
        // stays silent exactly like TS (the compact path's detached run).
        if !engine_agent_end.load(std::sync::atomic::Ordering::SeqCst) {
            self.emit_turn_event(json!({ "type": "agent_end" }));
        }
        let snapshot = {
            let core = self.core.lock().unwrap();
            self.snapshot_from(&core)
        };
        // The settle checkpoint (TS `turn_end`, busy computed): the
        // journal's latest record must track liveness, not the last
        // structural write. The idle flip above precedes it, so the
        // settle's in-flight term reads false here: a turn that settled
        // with empty lanes leaves the session idle, so an unclean kill
        // from here on must NOT read as interrupted work; undelivered
        // lanes stay busy (they are admitted work a revive must
        // redeliver). The busy verdict and the queue snapshot come from
        // one locked read, so a concurrent enqueue cannot be overwritten
        // by a stale idle verdict.
        checkpoint_queue_recovery(
            &self.recovery,
            &self.core,
            QueueCheckpoint::Settle {
                operation: "turn_end",
            },
        );
        let _ = self.emit_action_update(&snapshot);
        self.idle_notify.notify_waiters();
        // The settled prompts' admissions clear (TS `clearAdmission` in
        // the prompt arm's finally).
        for admission_id in settled_admissions {
            self.prompt_admissions.clear(&admission_id);
        }
        // The turn is fully unwound (idle flip, roster, boundary frames,
        // queue projection, admission bookkeeping): the waiting prompt now
        // resolves — TS `promptAndWait`'s response lands at the same
        // fully-settled point, so a client's next request always observes
        // the idle session.
        let settled_outcome = turn_outcome.lock().unwrap().take();
        if let Some(result) = settled_outcome {
            for done in items_done {
                let _ = done.send(result.clone());
            }
        }
        // The compact-trigger review a compaction armed this run services
        // off the settle (TS `_scheduleAutoRefineAfterCompaction` ->
        // `setTimeout(0)` background `_maybeAutoRefine("compact")`): the
        // turn settled and the waiting prompts resolved, so the review's
        // model call runs as a background round and the queued next
        // prompt's admission never waits on it. The round's own gates
        // (the armed trigger, queued work) keep the trigger armed for the
        // next settle when work is queued mid-review.
        {
            let engine = review_engine;
            let core = Arc::clone(&self.core);
            let events = self.events.clone();
            let review_session_id = review_session_id.clone();
            tokio::spawn(async move {
                // The pending pre-check and the round both take the
                // engine's session mutex (`blocking_lock`): they run on
                // the blocking pool, never on this async task — a
                // `blocking_lock` from the runtime thread deadlocks the
                // settle when the mutex is contended.
                let refined = tokio::task::spawn_blocking(move || {
                    pa_core::session_engine::compaction_trace::trace(
                        "autorefine.review_started",
                        serde_json::Value::Null,
                    );
                    let outcome = engine.consume_compact_auto_refine();
                    pa_core::session_engine::compaction_trace::trace(
                        "autorefine.review_done",
                        serde_json::json!({ "ran": outcome.is_ok() }),
                    );
                    outcome
                })
                .await
                .unwrap_or_else(|error| {
                    Err(anyhow::anyhow!("auto-refinement task failed: {error}"))
                });
                match refined {
                    Ok(Some(result)) => {
                        // TS `refine()` appends the TUI outcome row and
                        // the model-facing notice (when edits applied) as
                        // durable rows: persist both to the session file
                        // and broadcast their message pairs like the
                        // `/refine` command — each row fenced on the
                        // session identity the review serviced (a branch
                        // move or replacement swaps the store mid-review;
                        // the row never lands on the moved-to session).
                        let outcome_row =
                            pa_core::session_engine::refine::create_refinement_outcome_message(
                                &result,
                            );
                        if let Ok(value) = serde_json::to_value(
                            pa_types::session::AgentMessage::Custom(outcome_row),
                        ) {
                            emit_refinement_row(&core, &events, &review_session_id, value);
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
                                emit_refinement_row(&core, &events, &review_session_id, value);
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("pa-daemon: auto-refinement after compaction failed: {error:#}");
                    }
                }
            });
        }
    }

    /// The post-turn queue projection (TS `_emitQueueUpdate`): an unchanged
    /// snapshot stays silent.
    fn emit_action_update(&self, snapshot: &SessionActionSnapshot) -> Result<()> {
        let mut core = self.core.lock().unwrap();
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

    fn snapshot_from(&self, core: &SessionCore) -> SessionActionSnapshot {
        session_snapshot(core)
    }

    fn emit_turn_event(&self, event: Value) {
        let mut core = self.core.lock().unwrap();
        let sequence = core.last_event_sequence + 1;
        core.last_event_sequence = sequence;
        let meta = create_daemon_event_meta(
            &core.active_session_id,
            sequence,
            None,
            Some(&core.generation),
        );
        let outbound = DaemonOutbound::SessionEvent {
            active_session_id: self.active_session_id.clone(),
            event,
            meta: Some(meta),
            rest: Map::default(),
        };
        let payload = serde_json::to_vec(&outbound).unwrap_or_default();
        drop(core);
        self.events.send(OutboundFrame::session_event(payload));
    }
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
    SessionActionSnapshot {
        queued_count: (core.steering.len() + core.follow_up.len()) as u32,
        // TS `queuedAgentMessagePreview`: a parked row reads the
        // delivery's labeled preview when it carries one, else the
        // message text.
        steering: core
            .steering
            .iter()
            .map(|item| item.preview.clone().unwrap_or_else(|| item.message.clone()))
            .collect(),
        follow_ups: core
            .follow_up
            .iter()
            .map(|item| item.preview.clone().unwrap_or_else(|| item.message.clone()))
            .collect(),
        active: core.active_action.clone(),
    }
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
}

#[cfg(test)]
mod agent_message_tests {
    use super::*;

    fn test_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-am-{}", uuid::Uuid::new_v4()));
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
        Arc::new(Worker::new(config, None))
    }

    async fn created_worker() -> Arc<Worker> {
        let worker = test_worker();
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    fn queue_texts(core: &Mutex<SessionCore>, lane: Lane) -> Vec<String> {
        let core = core.lock().unwrap();
        match lane {
            Lane::Steering => &core.steering,
            Lane::FollowUp => &core.follow_up,
        }
        .iter()
        .map(|item| item.message.clone())
        .collect()
    }

    /// Receipt shape (`createAgentSessionMessageReceipt`): id, source,
    /// target endpoint, sender echo, delivered status and timestamp while
    /// the session is idle, and the rendered prompt on the steering lane.
    #[tokio::test]
    async fn deliver_message_answers_the_ts_receipt_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "target-session",
                    "message": "ping from the first session",
                    "sender": {
                        "activeSessionId": "source-session",
                        "sessionId": "source-file",
                        "sessionName": "source-agent",
                        "runtimeKind": "top-level",
                        "clientId": "cli-1",
                    },
                }),
            )
            .await;
        assert!(response.success, "deliver failed: {response:?}");
        assert_eq!(response.command, "worker_deliver_message");
        let data = response.data.expect("receipt data");
        assert!(
            data["id"]
                .as_str()
                .unwrap_or_default()
                .starts_with("agentmsg_"),
            "receipt id: {data}"
        );
        assert_eq!(data["source"], "agent_message");
        assert_eq!(data["message"], "ping from the first session");
        assert_eq!(data["deliveryStatus"], "delivered");
        assert_eq!(data["deliveryMode"], "steer");
        assert!(
            data["deliveredAt"].as_str().is_some(),
            "deliveredAt: {data}"
        );
        assert!(
            data.get("queuedAt").is_none(),
            "queuedAt on delivery: {data}"
        );
        assert_eq!(data["target"]["activeSessionId"], "target-session");
        assert_eq!(data["target"]["sessionName"], "target");
        assert!(!data["target"]["sessionId"]
            .as_str()
            .unwrap_or_default()
            .is_empty());
        assert_eq!(data["from"]["sessionName"], "source-agent");
        assert_eq!(
            queue_texts(&worker.core, Lane::Steering),
            vec!["[agent-message from source-agent]\n\nping from the first session"],
            "steering lane"
        );
        assert!(queue_texts(&worker.core, Lane::FollowUp).is_empty());
    }

    /// The queued delivery carries the `agent_message` custom row (TS
    /// `acceptAgentSessionMessage` rides `acceptAgentMessagePrompt`'s
    /// `customMessage`): the row's content is the rendered prompt, the
    /// details carry the identity the collapsed card reads, and the
    /// agent-message marker still targets `agent_messages_clear`/`pause`.
    #[tokio::test]
    async fn deliver_message_carries_the_agent_message_custom_row() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "target-session",
                    "message": "the research is done",
                    "sender": {
                        "activeSessionId": "source-session",
                        "sessionId": "source-file",
                        "sessionName": "research-lane",
                        "runtimeKind": "subagent",
                        // The child label derives from this parent edge,
                        // never from the runtime kind alone.
                        "parentActiveSessionId": "target-session",
                    },
                }),
            )
            .await;
        assert!(response.success, "deliver failed: {response:?}");
        let data = response.data.expect("receipt data");
        let prompt = "[agent-message from child:research-lane]\n\nthe research is done";
        let (custom, message, agent_message, preview) = {
            let core = worker.core.lock().unwrap();
            let item = core.steering.front().expect("the delivery queued");
            (
                item.custom_message
                    .clone()
                    .expect("the agent_message row rides the delivery"),
                item.message.clone(),
                item.agent_message.clone(),
                item.preview.clone(),
            )
        };
        // The queue strip serves the TS labeled preview.
        assert_eq!(
            preview.as_deref(),
            Some("Agent message received: the research is done")
        );
        assert_eq!(custom["role"], "custom");
        assert_eq!(custom["customType"], "agent_message");
        assert_eq!(custom["content"], prompt);
        assert_eq!(custom["display"], true);
        assert_eq!(custom["details"]["id"], data["id"]);
        assert_eq!(custom["details"]["message"], "the research is done");
        assert_eq!(
            custom["details"]["from"]["activeSessionId"],
            "source-session"
        );
        assert_eq!(custom["details"]["fromRelationship"], "child");
        assert_eq!(
            custom["details"]["target"]["activeSessionId"],
            "target-session"
        );
        // The turn still runs on the rendered prompt, and the marker the
        // clear/pause arms read is untouched.
        assert_eq!(message, prompt);
        assert_eq!(agent_message.as_deref(), Some("the research is done"));
    }

    /// An explicit `follow_up` delivery mode queues behind current work
    /// instead of steering, and a subagent sender renders the relationship.
    #[tokio::test]
    async fn deliver_message_follow_up_lane_and_subagent_sender() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "target-session",
                    "message": "queue me",
                    "sender": {
                        "activeSessionId": "source-session",
                        "sessionName": "source-agent",
                        "runtimeKind": "subagent",
                        // The child label derives from this parent edge,
                        // never from the runtime kind alone.
                        "parentActiveSessionId": "target-session",
                    },
                    "deliveryMode": "follow_up",
                }),
            )
            .await;
        assert!(response.success, "deliver failed: {response:?}");
        let data = response.data.expect("receipt data");
        assert_eq!(data["deliveryMode"], "follow_up");
        assert_eq!(
            queue_texts(&worker.core, Lane::FollowUp),
            vec!["[agent-message from child:source-agent]\n\nqueue me"],
            "follow-up lane"
        );
        assert!(queue_texts(&worker.core, Lane::Steering).is_empty());
    }

    /// A busy session reports `queued` with `queuedAt` (`queueIfBusy`).
    #[tokio::test]
    async fn deliver_message_while_busy_queues() {
        let worker = created_worker().await;
        worker.core.lock().unwrap().busy = true;
        let response = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "target-session",
                    "message": "while busy",
                    "sender": { "activeSessionId": "source-session" },
                }),
            )
            .await;
        assert!(response.success, "deliver failed: {response:?}");
        let data = response.data.expect("receipt data");
        assert_eq!(data["deliveryStatus"], "queued");
        assert!(data["queuedAt"].as_str().is_some(), "queuedAt: {data}");
        assert!(
            data.get("deliveredAt").is_none(),
            "deliveredAt while queued: {data}"
        );
    }

    /// The pending-capacity guard fails with the TS error string.
    #[tokio::test]
    async fn deliver_message_respects_the_pending_capacity() {
        let worker = created_worker().await;
        {
            let mut core = worker.core.lock().unwrap();
            for _ in 0..DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION {
                core.follow_up.push_back(QueuedItem {
                    preview: None,
                    message: "occupied".to_string(),
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
            }
        }
        let response = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "target-session",
                    "message": "over the limit",
                    "sender": { "activeSessionId": "source-session" },
                }),
            )
            .await;
        assert!(!response.success, "deliver should fail: {response:?}");
        assert_eq!(
            response.error.as_deref(),
            Some("Target session has too many pending messages: 20 unfinished, limit is 20")
        );
    }
}

#[cfg(test)]
mod prompt_image_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_wire_images_and_drops_incomplete_entries() {
        let payload = json!({
            "message": "look",
            "images": [
                { "type": "image", "data": "QUJD", "mimeType": "image/png" },
                { "type": "image", "mimeType": "image/png" },
                { "type": "image", "data": "QQ==" },
                { "type": "text", "text": "not an image" }
            ]
        });
        let images = parse_prompt_images(&payload);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].data, "QUJD");
        assert_eq!(images[0].mime_type, "image/png");
    }

    #[test]
    fn missing_or_empty_images_admit_text_only() {
        assert!(parse_prompt_images(&json!({ "message": "plain" })).is_empty());
        assert!(parse_prompt_images(&json!({ "images": [] })).is_empty());
        assert!(parse_prompt_images(&json!({ "images": null })).is_empty());
    }

    fn test_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-img-{}", uuid::Uuid::new_v4()));
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
        Arc::new(Worker::new(config, None))
    }

    /// A `prompt` command with wire images queues the attachments with the
    /// message (they ride the queue item into the engine as multimodal
    /// user content).
    #[tokio::test]
    async fn prompt_with_images_queues_the_images_with_the_message() {
        let worker = test_worker();
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        // Busy session: the prompt lands on the follow-up lane.
        worker.core.lock().unwrap().busy = true;
        let response = worker
            .dispatch(
                "prompt",
                &json!({
                    "message": "look at this",
                    "images": [
                        { "type": "image", "data": "QUJD", "mimeType": "image/png" }
                    ],
                }),
            )
            .await;
        assert!(response.success, "prompt failed: {response:?}");
        let images = {
            let core = worker.core.lock().unwrap();
            core.follow_up
                .iter()
                .map(|item| item.images.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(images.len(), 1, "one queued item");
        assert_eq!(
            images[0],
            vec![pa_agent::types::ImageContent {
                data: "QUJD".to_string(),
                mime_type: "image/png".to_string(),
            }],
            "the attachment rides the queue item"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
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
        assert_eq!(steering[0].preview, heartbeat.preview);
        assert_eq!(steering[0].custom_message, heartbeat.custom_message);
        assert_eq!(steering[0].queue_key, heartbeat.queue_key);
        assert!(steering[0].queue_visible);
        assert_eq!(follow_up.len(), 1);
        assert_eq!(follow_up[0].message, "follow-me");
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
mod turn_stream_tests {
    use super::*;
    use crate::engine::{
        CompactionOutcome, CompactionRequest, PromptRequest, SessionEngine, SideQuestionOutcome,
        SideQuestionRequest,
    };

    /// One scripted turn that streams `deltas` partial-message updates
    /// (one full-snapshot `message_update` frame per provider delta, the
    /// wire shape a fast provider produces on a big turn) and settles
    /// with one final assistant message. `spacing_ms` paces the deltas so
    /// the flusher tick can interleave (the realistic case: a provider
    /// that outruns 20 updates/second).
    struct BurstStreamEngine {
        deltas: usize,
        spacing_ms: u64,
    }

    impl BurstStreamEngine {
        fn message_with(text: &str) -> Value {
            json!({
                "role": "assistant",
                "provider": "faux",
                "model": "faux-1",
                "content": [{ "type": "text", "text": text }],
            })
        }

        fn delta_text(&self, index: usize) -> String {
            "x".repeat((index + 1) * 4)
        }

        fn full_text(&self) -> String {
            self.delta_text(self.deltas)
        }
    }

    /// A turn that settles without a model turn (the session-command /
    /// pre-model-failure shape): only the trailing `Done` reaches the
    /// worker, so the run closes on the bare fallback frames.
    struct DoneOnlyEngine;

    impl SessionEngine for DoneOnlyEngine {
        fn run_prompt(
            &self,
            _prompt_index: usize,
            _request: PromptRequest,
            _aborted: &dyn Fn() -> bool,
            emit: &mut dyn FnMut(EngineEvent) -> bool,
        ) {
            emit(EngineEvent::Done(Ok(())));
        }

        fn run_side_question(
            &self,
            _request: SideQuestionRequest,
            _signal: &pa_agent::abort::AbortSignal,
            _sink: &pa_core::session_engine::side_question::SideQuestionSink,
        ) -> SideQuestionOutcome {
            SideQuestionOutcome::Failed {
                answer: String::new(),
                error: "unsupported".to_string(),
            }
        }

        fn run_compaction(
            &self,
            _request: CompactionRequest,
            _signal: &pa_agent::abort::AbortSignal,
        ) -> CompactionOutcome {
            CompactionOutcome::Skipped {
                message: "nothing to compact".to_string(),
            }
        }

        fn run_branch_summary(
            &self,
            _request: crate::engine::BranchSummaryRequest,
            _signal: &pa_agent::abort::AbortSignal,
        ) -> crate::engine::BranchSummaryOutcome {
            crate::engine::BranchSummaryOutcome::Failed {
                error: "unsupported".to_string(),
            }
        }

        fn rebuild_session_context(
            &self,
            _branch_entries: Vec<pa_types::session::FileEntry>,
            _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    impl SessionEngine for BurstStreamEngine {
        fn run_prompt(
            &self,
            _prompt_index: usize,
            _request: PromptRequest,
            _aborted: &dyn Fn() -> bool,
            emit: &mut dyn FnMut(EngineEvent) -> bool,
        ) {
            for index in 0..=self.deltas {
                let message = Self::message_with(&self.delta_text(index));
                let stream_event = if index == 0 {
                    json!({ "type": "start" })
                } else {
                    json!({ "type": "text_delta", "delta": "xxxx" })
                };
                if !emit(EngineEvent::AssistantUpdate {
                    message,
                    stream_event: Some(stream_event),
                }) {
                    return;
                }
                if self.spacing_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(self.spacing_ms));
                }
            }
            if !emit(EngineEvent::AssistantMessage(Self::message_with(
                &self.full_text(),
            ))) {
                return;
            }
            emit(EngineEvent::Done(Ok(())));
        }

        fn run_side_question(
            &self,
            _request: SideQuestionRequest,
            _signal: &pa_agent::abort::AbortSignal,
            _sink: &pa_core::session_engine::side_question::SideQuestionSink,
        ) -> SideQuestionOutcome {
            SideQuestionOutcome::Failed {
                answer: String::new(),
                error: "unsupported".to_string(),
            }
        }

        fn run_compaction(
            &self,
            _request: CompactionRequest,
            _signal: &pa_agent::abort::AbortSignal,
        ) -> CompactionOutcome {
            CompactionOutcome::Skipped {
                message: "nothing to compact".to_string(),
            }
        }

        fn run_branch_summary(
            &self,
            _request: crate::engine::BranchSummaryRequest,
            _signal: &pa_agent::abort::AbortSignal,
        ) -> crate::engine::BranchSummaryOutcome {
            crate::engine::BranchSummaryOutcome::Failed {
                error: "unsupported".to_string(),
            }
        }

        fn rebuild_session_context(
            &self,
            _branch_entries: Vec<pa_types::session::FileEntry>,
            _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    /// A minimal turn runner over a fresh session core: exactly what
    /// `run_turn` touches (the store stays `None`, the roster push is a
    /// no-op link, no supervisor socket).
    fn burst_runner(engine: Arc<dyn SessionEngine>) -> TurnRunner {
        let core = Arc::new(Mutex::new(SessionCore {
            active_session_id: "burst-session".to_string(),
            generation: "gen".to_string(),
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
        }));
        TurnRunner {
            core,
            input_pauses: crate::session_input_pause::InputPauseTable::new(),
            prompt_admissions: crate::prompt_admission::WorkerAdmissions::new(),
            work_notify: Arc::new(Notify::new()),
            idle_notify: Arc::new(Notify::new()),
            events: Arc::new(EventPump::new()),
            engine,
            recovery: Arc::new(Mutex::new(None)),
            active_session_id: "burst-session".to_string(),
            roster_pushes: crate::roster_activity::RosterPushQueue::disabled(),
        }
    }

    /// Run one scripted turn and return its session-event frames in wire
    /// order.
    /// The suspension parks the turn runner (TS `_scheduleSessionInputPump`
    /// refuses while `_sessionInputPumpSuspended`): a queued steering item
    /// survives undelivered until the flag clears, then runs.
    #[tokio::test]
    async fn suspended_runner_parks_a_queued_item_until_resumed() {
        let engine = ScriptedEngine::default();
        let runner = burst_runner(Arc::new(engine));
        let (done_tx, mut done_rx) = oneshot::channel();
        {
            let mut core = runner.core.lock().unwrap();
            core.queued_input_suspended = true;
            core.steering.push_back(QueuedItem {
                preview: None,
                message: "parked steer".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: Some(done_tx),
                queue_visible: true,
                policy: TurnPolicy::Queued,
                forced_batch: false,
            });
        }
        let parked = std::sync::Arc::clone(&runner.core);
        let work_notify = std::sync::Arc::clone(&runner.work_notify);
        let running = tokio::spawn(async move { runner.run().await });
        // The runner idles through the suspension window without
        // starting the queued turn.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        {
            let core = parked.lock().unwrap();
            assert!(!core.busy, "the runner started a turn while suspended");
            assert_eq!(
                core.steering.len(),
                1,
                "the queued item was consumed while suspended"
            );
        }
        // A resume site clears the flag and wakes the runner: the parked
        // turn completes.
        {
            let mut core = parked.lock().unwrap();
            core.queued_input_suspended = false;
        }
        work_notify.notify_one();
        let done = tokio::time::timeout(std::time::Duration::from_secs(5), &mut done_rx).await;
        assert!(done.is_ok(), "the parked turn never ran after resume");
        running.abort();
    }

    /// The session-event frames off the runner's event pump (the same
    /// wire shape the outer tests' `session_events_since` collects).
    fn runner_events(
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

    /// A queued plain-prompt item for the pump tests.
    fn queued_prompt(message: &str, policy: TurnPolicy) -> QueuedItem {
        QueuedItem {
            preview: None,
            message: message.to_string(),
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

    /// Run the pump until both lanes drain (the runner keeps idling; the
    /// task is aborted by the test's end).
    async fn drain_pump(core: &Arc<Mutex<SessionCore>>, work_notify: &Arc<Notify>) {
        work_notify.notify_one();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            {
                let core = core.lock().unwrap();
                let drained = core.steering.is_empty() && core.follow_up.is_empty() && !core.busy;
                if drained {
                    return;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the pump never drained the lanes"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// The settled user/assistant rows of the session events, in wire
    /// order (the `message_end` frames; the scripted engine carries the
    /// text as a plain string content, the real engine as content parts).
    fn delivered_rows(events: &[Value]) -> Vec<(String, String)> {
        events
            .iter()
            .filter_map(|event| {
                if event.get("type").and_then(Value::as_str) != Some("message_end") {
                    return None;
                }
                let message = event.get("message")?;
                let row_role = message.get("role").and_then(Value::as_str)?.to_string();
                let content = message.get("content")?;
                let text = content
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| {
                        content
                            .as_array()
                            .and_then(|parts| parts.first())
                            .and_then(|part| part.get("text"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .or_else(|| {
                        content
                            .as_array()
                            .and_then(|parts| {
                                parts.iter().find(|part| {
                                    part.get("type").and_then(Value::as_str) == Some("text")
                                })
                            })
                            .and_then(|part| part.get("text"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })?;
                Some((row_role, text))
            })
            .collect()
    }

    /// TS `_pumpSessionInputs` under queue mode "all"
    /// (`turnExecutionPoliciesEqual` + the mode gate): the same-lane
    /// same-class prefix co-delivers as ONE batched turn — one
    /// `agent_start`/`turn_start` pair, every user row in delivery order,
    /// one assistant reply for the whole batch.
    #[tokio::test]
    async fn steering_mode_all_batches_the_queued_prefix_into_one_turn() {
        let engine: Arc<dyn SessionEngine> = Arc::new(
            ScriptedEngine::from_value(json!({ "responses": ["batched reply"] }))
                .unwrap_or_default(),
        );
        let runner = burst_runner(Arc::clone(&engine));
        {
            let mut core = runner.core.lock().unwrap();
            core.steering_mode = "all".to_string();
            core.steering
                .push_back(queued_prompt("steer one", TurnPolicy::Queued));
            core.steering
                .push_back(queued_prompt("steer two", TurnPolicy::Queued));
            core.steering
                .push_back(queued_prompt("steer three", TurnPolicy::Queued));
        }
        let mut subscription = runner.events.subscribe();
        let core = std::sync::Arc::clone(&runner.core);
        let work_notify = std::sync::Arc::clone(&runner.work_notify);
        let running = tokio::spawn(async move { runner.run().await });
        drain_pump(&core, &work_notify).await;
        running.abort();

        let events = runner_events(&mut subscription);
        let starts = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .count();
        let turn_starts = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("turn_start"))
            .count();
        assert_eq!(starts, 1, "one agent_start for the whole batch");
        assert_eq!(turn_starts, 1, "one turn_start for the whole batch");
        let rows = delivered_rows(&events);
        assert_eq!(
            rows,
            vec![
                ("user".to_string(), "steer one".to_string()),
                ("user".to_string(), "steer two".to_string()),
                ("user".to_string(), "steer three".to_string()),
                ("assistant".to_string(), "batched reply".to_string()),
            ],
            "the batched prefix delivered as one turn: {rows:?}"
        );
    }

    /// The product default: with no explicit mode set, the steering
    /// lane co-delivers the queued same-class prefix as ONE batched turn
    /// at the boundary.
    #[tokio::test]
    async fn the_default_mode_co_delivers_the_queued_steering_prefix() {
        let engine: Arc<dyn SessionEngine> = Arc::new(
            ScriptedEngine::from_value(json!({ "responses": ["batched reply"] }))
                .unwrap_or_default(),
        );
        let runner = burst_runner(Arc::clone(&engine));
        {
            let mut core = runner.core.lock().unwrap();
            assert_eq!(core.steering_mode, "all", "the default is the batched mode");
            core.steering
                .push_back(queued_prompt("steer one", TurnPolicy::Queued));
            core.steering
                .push_back(queued_prompt("steer two", TurnPolicy::Queued));
            core.steering
                .push_back(queued_prompt("steer three", TurnPolicy::Queued));
        }
        let mut subscription = runner.events.subscribe();
        let core = std::sync::Arc::clone(&runner.core);
        let work_notify = std::sync::Arc::clone(&runner.work_notify);
        let running = tokio::spawn(async move { runner.run().await });
        drain_pump(&core, &work_notify).await;
        running.abort();

        let events = runner_events(&mut subscription);
        let starts = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .count();
        assert_eq!(
            starts, 1,
            "the default batches the whole prefix: {events:?}"
        );
        let rows = delivered_rows(&events);
        assert_eq!(
            rows,
            vec![
                ("user".to_string(), "steer one".to_string()),
                ("user".to_string(), "steer two".to_string()),
                ("user".to_string(), "steer three".to_string()),
                ("assistant".to_string(), "batched reply".to_string()),
            ],
            "the default mode co-delivers every parked steer: {rows:?}"
        );
    }

    /// Queue mode "one-at-a-time" (selectable via the `steeringMode`
    /// setting; the product default is "all"): each queued steer is its
    /// own turn — one reply each, delivered in order.
    #[tokio::test]
    async fn one_at_a_time_delivers_each_queued_steer_as_its_own_turn() {
        // The burst harness has no session store, so the scripted engine
        // serves its first response for EVERY turn (prompt_index stays
        // 0): the turns are discriminated by the agent_start count and
        // the user-row order, not the reply text.
        let engine: Arc<dyn SessionEngine> = Arc::new(
            ScriptedEngine::from_value(json!({ "responses": ["settled reply"] }))
                .unwrap_or_default(),
        );
        let runner = burst_runner(Arc::clone(&engine));
        {
            let mut core = runner.core.lock().unwrap();
            core.steering_mode = "one-at-a-time".to_string();
            core.steering
                .push_back(queued_prompt("steer one", TurnPolicy::Queued));
            core.steering
                .push_back(queued_prompt("steer two", TurnPolicy::Queued));
        }
        let mut subscription = runner.events.subscribe();
        let core = std::sync::Arc::clone(&runner.core);
        let work_notify = std::sync::Arc::clone(&runner.work_notify);
        let running = tokio::spawn(async move { runner.run().await });
        drain_pump(&core, &work_notify).await;
        running.abort();

        let events = runner_events(&mut subscription);
        let starts = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .count();
        assert_eq!(starts, 2, "one agent_start per steer: {events:?}");
        let rows = delivered_rows(&events);
        assert_eq!(
            rows,
            vec![
                ("user".to_string(), "steer one".to_string()),
                ("assistant".to_string(), "settled reply".to_string()),
                ("user".to_string(), "steer two".to_string()),
                ("assistant".to_string(), "settled reply".to_string()),
            ],
            "one-at-a-time delivers in order, one turn each: {rows:?}"
        );
    }

    /// The forced steering batch (TS `abortAndSendQueued`'s
    /// `_forcedAllSteeringActionIds`): the armed prefix co-delivers as ONE
    /// turn even under queue mode "one-at-a-time" (pinned explicitly —
    /// the product default is "all"); an item queued after the arm stays
    /// out of the batch and delivers next.
    #[tokio::test]
    async fn forced_batch_delivers_the_armed_prefix_as_one_turn() {
        // (The burst harness serves the first scripted response for every
        // turn — see one_at_a_time above.)
        let engine: Arc<dyn SessionEngine> = Arc::new(
            ScriptedEngine::from_value(json!({ "responses": ["batch reply"] })).unwrap_or_default(),
        );
        let runner = burst_runner(Arc::clone(&engine));
        {
            let mut core = runner.core.lock().unwrap();
            core.steering_mode = "one-at-a-time".to_string();
            core.steering
                .push_back(queued_prompt("armed one", TurnPolicy::Queued));
            core.steering
                .push_back(queued_prompt("armed two", TurnPolicy::Queued));
            core.forced_all_steering = true;
            for item in &mut core.steering {
                item.forced_batch = true;
            }
            // An un-armed steer queued behind the armed prefix (a steer
            // that arrived after the abort): it never joins the batch.
            core.steering
                .push_back(queued_prompt("late steer", TurnPolicy::Queued));
        }
        let mut subscription = runner.events.subscribe();
        let core = std::sync::Arc::clone(&runner.core);
        let work_notify = std::sync::Arc::clone(&runner.work_notify);
        let running = tokio::spawn(async move { runner.run().await });
        drain_pump(&core, &work_notify).await;
        running.abort();

        let events = runner_events(&mut subscription);
        let starts = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .count();
        assert_eq!(
            starts, 2,
            "the armed batch runs as one turn, the late steer its own"
        );
        let rows = delivered_rows(&events);
        assert_eq!(
            rows,
            vec![
                ("user".to_string(), "armed one".to_string()),
                ("user".to_string(), "armed two".to_string()),
                ("assistant".to_string(), "batch reply".to_string()),
                ("user".to_string(), "late steer".to_string()),
                ("assistant".to_string(), "batch reply".to_string()),
            ],
            "the armed prefix batched; the late steer never joined: {rows:?}"
        );
    }

    /// TS `turnExecutionPoliciesEqual`: mode "all" never batches across
    /// turn-execution classes — a client steer and an injected heartbeat
    /// row deliver as separate turns even under "all".
    #[tokio::test]
    async fn mode_all_never_batches_across_policy_classes() {
        // (The burst harness serves the first scripted response for every
        // turn — see one_at_a_time above.)
        let engine: Arc<dyn SessionEngine> = Arc::new(
            ScriptedEngine::from_value(json!({ "responses": ["lane reply"] })).unwrap_or_default(),
        );
        let runner = burst_runner(Arc::clone(&engine));
        {
            let mut core = runner.core.lock().unwrap();
            core.steering_mode = "all".to_string();
            core.steering
                .push_back(queued_prompt("client steer", TurnPolicy::Queued));
            core.steering
                .push_back(queued_prompt("nudge the mission", TurnPolicy::Injected));
        }
        let mut subscription = runner.events.subscribe();
        let core = std::sync::Arc::clone(&runner.core);
        let work_notify = std::sync::Arc::clone(&runner.work_notify);
        let running = tokio::spawn(async move { runner.run().await });
        drain_pump(&core, &work_notify).await;
        running.abort();

        let events = runner_events(&mut subscription);
        let starts = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .count();
        assert_eq!(starts, 2, "policy classes never share a turn");
        let rows = delivered_rows(&events);
        assert_eq!(
            rows,
            vec![
                ("user".to_string(), "client steer".to_string()),
                ("assistant".to_string(), "lane reply".to_string()),
                ("user".to_string(), "nudge the mission".to_string()),
                ("assistant".to_string(), "lane reply".to_string()),
            ],
            "each policy class delivered its own turn: {rows:?}"
        );
    }

    /// The follow-up lane batches under its own mode (TS `followUpMode`):
    /// two queued follow-ups co-deliver as one turn with "all".
    #[tokio::test]
    async fn follow_up_mode_all_batches_the_follow_up_lane() {
        let engine: Arc<dyn SessionEngine> = Arc::new(
            ScriptedEngine::from_value(json!({ "responses": ["follow-up batch reply"] }))
                .unwrap_or_default(),
        );
        let runner = burst_runner(Arc::clone(&engine));
        {
            let mut core = runner.core.lock().unwrap();
            core.follow_up_mode = "all".to_string();
            core.follow_up
                .push_back(queued_prompt("follow up one", TurnPolicy::Queued));
            core.follow_up
                .push_back(queued_prompt("follow up two", TurnPolicy::Queued));
        }
        let mut subscription = runner.events.subscribe();
        let core = std::sync::Arc::clone(&runner.core);
        let work_notify = std::sync::Arc::clone(&runner.work_notify);
        let running = tokio::spawn(async move { runner.run().await });
        drain_pump(&core, &work_notify).await;
        running.abort();

        let events = runner_events(&mut subscription);
        let starts = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_start"))
            .count();
        assert_eq!(starts, 1, "the follow-up lane batched under mode all");
        let rows = delivered_rows(&events);
        assert_eq!(
            rows,
            vec![
                ("user".to_string(), "follow up one".to_string()),
                ("user".to_string(), "follow up two".to_string()),
                ("assistant".to_string(), "follow-up batch reply".to_string()),
            ],
            "the follow-up prefix batched into one turn: {rows:?}"
        );
    }

    /// Kevin's acceptance case (the multi-steer abort flow, TS
    /// `abortAndSendQueued` + `interactive-mode.ts`'s Ctrl+C path): on the
    /// abort of a streaming turn, ALL visible queued plain-user steering
    /// messages send together as the next batched turn — the follow-up
    /// lane stays queued behind it (never discarded, never merged), then
    /// runs in order once the session goes idle; the arm co-delivers
    /// under any mode (the product default is "all"), and the queue
    /// parks only when the abort leaves nothing visible behind (the
    /// plain-abort shape).
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    async fn abort_and_send_queued_delivers_the_steering_batch_then_the_follow_ups() {
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
            active_session_id: "abort-send-family".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "text": "held reply", "delayMs": 600_000 },
                    "batch reply",
                    "follow-up reply"
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "abort-send-family" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        // The held turn parks the queue behind it (the 600s fetch hold).
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "abort-send-family",
                    "message": "held turn for the batch abort",
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
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        // Two steering messages and one follow-up behind the streaming
        // turn (the real wire admission path: queue-visible, policy-queued
        // rows).
        for message in ["steering one", "steering two"] {
            let steered = worker
                .dispatch("steer", &json!({ "message": message }))
                .await;
            assert!(steered.success, "steer failed: {steered:?}");
        }
        let follow = worker
            .dispatch(
                "follow_up",
                &json!({ "message": "follow up after the batch" }),
            )
            .await;
        assert!(follow.success, "follow_up failed: {follow:?}");
        // The funnel (the wire command's body — #2599's handler calls it):
        // arm the visible plain-user steering, abort the run, resume the
        // pump. The arm carries the batch under any mode; the default
        // itself is asserted below (the product default "all").
        let sent = worker.abort_and_send_queued();
        assert!(sent, "the armed steering batch sent with the abort");
        let idle = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            worker.dispatch("wait_for_idle", &json!({})),
        )
        .await;
        assert!(idle.is_ok(), "the session never went idle after the abort");
        assert!(idle.unwrap().success, "wait_for_idle failed");
        // The aborted turn's row + the batched steers + the follow-up, in
        // order: the two steers share ONE turn (one reply), the follow-up
        // runs after it as its own turn.
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
                "held turn for the batch abort",
                "steering one",
                "steering two",
                "follow up after the batch",
            ],
            "the steering batch sent as one turn; the follow-up ran after it: {texts:?}"
        );
        // The reply granularity: the aborted row, then ONE assistant
        // reply for the whole steering batch, then the follow-up's own
        // reply (never one per steer).
        let replies: Vec<String> = wire_messages
            .iter()
            .filter(|message| crate::types::message_role(message) == Some("assistant"))
            .map(crate::types::message_text)
            .collect();
        assert_eq!(
            replies.len(),
            3,
            "the aborted row, the batch's one reply, the follow-up's reply: {replies:?}"
        );
        assert_eq!(
            &replies[1..],
            &["batch reply".to_string(), "follow-up reply".to_string()],
            "one reply for the batch, one for the follow-up: {replies:?}"
        );
        // The wire frames: each batched user row broadcasts exactly once
        // (the accepted-row emission — never the engine's loop re-emission).
        let events = runner_events(&mut subscription);
        let wire_user_starts: Vec<String> = events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("message_start"))
            .filter(|event| {
                let message = event.get("message").unwrap_or(&Value::Null);
                message.get("role").and_then(Value::as_str) == Some("user")
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
            wire_user_starts,
            vec![
                "held turn for the batch abort".to_string(),
                "steering one".to_string(),
                "steering two".to_string(),
                "follow up after the batch".to_string(),
            ],
            "every user row broadcast exactly once: {wire_user_starts:?}"
        );
        {
            let core = worker.core.lock().unwrap();
            assert!(
                core.steering.is_empty() && core.follow_up.is_empty(),
                "both lanes drained in order"
            );
            assert_eq!(
                core.steering_mode, "all",
                "the default mode is the batched-at-the-boundary product default"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The abort's acknowledgment never waits for the queue's delivery:
    /// with the aborted turn AND the queued follow-up's reply both held,
    /// `abort_and_send_queued` answers immediately and the resumed pump
    /// starts the follow-up's own turn behind the ack. A second, bare
    /// `abort` (the API surface) then ends that turn cleanly, delivers
    /// no duplicate of the follow-up's row, and parks the emptied queue
    /// behind the suspension like the TS plain abort.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    async fn abort_and_send_queued_acks_before_the_follow_up_delivery() {
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir =
            std::env::temp_dir().join(format!("pa-worker-abort-ack-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "abort-ack-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "text": "held reply", "delayMs": 60000 },
                    { "text": "follow-up reply", "delayMs": 60000 },
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "abort-ack" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "abort-ack-session",
                    "message": "held turn for the ack probe",
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
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let follow = worker
            .dispatch("follow_up", &json!({ "message": "ack follow-up" }))
            .await;
        assert!(follow.success, "follow_up failed: {follow:?}");
        // The ack: the aborted turn's settle AND the follow-up's own
        // reply are both held, so a funnel that awaited the settle or
        // the delivery would never answer inside the bound.
        let aborted = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            worker.dispatch("abort_and_send_queued", &json!({})),
        )
        .await;
        assert!(
            aborted.is_ok(),
            "the abort ack never arrived while everything downstream was held"
        );
        let aborted = aborted.unwrap();
        assert!(aborted.success, "abort_and_send_queued failed: {aborted:?}");
        assert_eq!(aborted.command, "abort_and_send_queued");
        // The follow-up starts promptly behind the ack: its turn runs
        // (the paced reply holds it) and its row left the queue.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let (busy, queued) = {
                let core = worker.core.lock().unwrap();
                (core.busy, core.follow_up.len())
            };
            if busy && queued == 0 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the follow-up never started after the abort ack"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let messages = worker.dispatch("get_messages", &json!({})).await;
        assert!(messages.success, "get_messages failed: {messages:?}");
        let texts: Vec<String> = messages
            .data
            .as_ref()
            .and_then(|data| data.get("messages"))
            .and_then(Value::as_array)
            .map(|wire| {
                wire.iter()
                    .filter(|message| crate::types::message_role(message) == Some("user"))
                    .map(crate::types::message_text)
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(
            texts,
            [
                "held turn for the ack probe".to_string(),
                "ack follow-up".to_string()
            ],
            "the follow-up row must deliver exactly once: {texts:?}"
        );
        // The API abort surface: a bare `abort` ends the follow-up's
        // own turn cleanly and parks the emptied queue behind the
        // suspension (the TS plain-abort park the Ctrl+C funnel
        // deliberately does not take).
        let aborted_again = worker.dispatch("abort", &json!({})).await;
        assert!(
            aborted_again.success,
            "the bare abort failed: {aborted_again:?}"
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while worker.core.lock().unwrap().busy {
            assert!(
                std::time::Instant::now() < deadline,
                "the follow-up's turn never settled on the bare abort"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        {
            let core = worker.core.lock().unwrap();
            assert!(
                core.steering.is_empty() && core.follow_up.is_empty(),
                "the queue must stay drained"
            );
            assert!(
                core.queued_input_suspended,
                "the bare abort parks the queue behind the suspension"
            );
        }
        // The second abort ends the follow-up's turn — it never
        // re-delivers or duplicates the follow-up's row.
        let messages = worker.dispatch("get_messages", &json!({})).await;
        assert!(messages.success, "get_messages failed: {messages:?}");
        let texts: Vec<String> = messages
            .data
            .as_ref()
            .and_then(|data| data.get("messages"))
            .and_then(Value::as_array)
            .map(|wire| {
                wire.iter()
                    .filter(|message| crate::types::message_role(message) == Some("user"))
                    .map(crate::types::message_text)
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(
            texts,
            [
                "held turn for the ack probe".to_string(),
                "ack follow-up".to_string()
            ],
            "the follow-up row survived the bare abort exactly once: {texts:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The waiting prompt resolves only after the turn fully unwinds (TS
    /// `promptAndWait` settles the completion after the whole turn settle):
    /// the `done` waiter fires after the idle flip and the queue projection,
    /// so a client's follow-up request never lands in the pre-idle window
    /// where the suspension gate would queue it behind the suspension
    /// instead of rejecting it (the f7 suspension sequence's post-abort
    /// prompt hung exactly there).
    #[tokio::test]
    async fn the_waiting_prompt_resolves_only_after_the_turn_settles() {
        let engine: Arc<dyn SessionEngine> = Arc::new(
            ScriptedEngine::from_value(json!({ "responses": ["settled reply"] }))
                .unwrap_or_default(),
        );
        let runner = burst_runner(Arc::clone(&engine));
        let (done_tx, mut done_rx) = oneshot::channel();
        let core = std::sync::Arc::clone(&runner.core);
        let turn = tokio::spawn(async move {
            runner
                .run_turn(
                    engine,
                    vec![QueuedItem {
                        preview: None,
                        message: "burst".to_string(),
                        custom_message: None,
                        agent_message: None,
                        queue_key: None,
                        admission_id: None,
                        images: Vec::new(),
                        done: Some(done_tx),
                        queue_visible: true,
                        policy: TurnPolicy::Queued,
                        forced_batch: false,
                    }],
                )
                .await;
        });
        let settled = tokio::time::timeout(std::time::Duration::from_secs(5), &mut done_rx).await;
        let outcome = settled
            .expect("the waiting prompt never resolved")
            .expect("the waiter sender dropped without an outcome");
        assert_eq!(
            outcome,
            TurnSettle::Completed,
            "the settled turn's outcome: {outcome:?}"
        );
        // The idle flip (and the queue projection after it) already
        // happened when the waiter resolved.
        {
            let core = core.lock().unwrap();
            assert!(!core.busy, "the waiter resolved before the idle flip");
        }
        turn.await.expect("the turn task panicked");
    }

    /// A fake supervisor link endpoint: every `worker_roster_delta`
    /// command's summary is recorded in arrival order.
    async fn fake_supervisor(
        socket: std::path::PathBuf,
    ) -> (Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let recorded = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = Arc::clone(&recorded);
        let server = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let sink = Arc::clone(&sink);
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
                    let (reader, mut writer) = stream.into_split();
                    writer
                        .write_all(b"{\"type\":\"daemon_hello\"}\n")
                        .await
                        .unwrap();
                    let mut lines = BufReader::new(reader);
                    loop {
                        let mut line = String::new();
                        if lines.read_line(&mut line).await.unwrap_or(0) == 0 {
                            return;
                        }
                        if line.trim().is_empty() {
                            continue;
                        }
                        let Ok(request) = serde_json::from_str::<Value>(line.trim()) else {
                            continue;
                        };
                        sink.lock()
                            .unwrap()
                            .push(request["command"]["summary"].clone());
                        let response =
                            crate::protocol::response_line(&crate::protocol::response_success(
                                request["id"].as_str(),
                                "worker_roster_delta",
                                None,
                            ));
                        writer
                            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                            .await
                            .unwrap();
                        writer.write_all(b"\n").await.unwrap();
                    }
                });
            }
        });
        (recorded, server)
    }

    /// A turn runner whose roster pushes and activity watcher ship to a
    /// live supervisor link (the burst runner keeps them disabled).
    fn live_feed_runner(engine: Arc<dyn SessionEngine>, socket: std::path::PathBuf) -> TurnRunner {
        let core = Arc::new(Mutex::new(SessionCore::test_core(None, "/tmp".to_string())));
        let user_bash = Arc::new(crate::user_bash::UserBash::new());
        let events = Arc::new(EventPump::new());
        let roster_pushes =
            crate::roster_activity::RosterPushQueue::spawn(crate::worker::RosterPushContext {
                core: Arc::clone(&core),
                engine: std::sync::Arc::clone(&engine),
                user_bash,
                roster_link: Arc::new(crate::supervisor_link::SupervisorLink::new(socket)),
                worker_token: "token".to_string(),
                worker_instance_id: "instance".to_string(),
                roster_delta_sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                roster_push_order: Arc::new(std::sync::Mutex::new(())),
            });
        crate::roster_activity::spawn_roster_activity_watch(
            Arc::clone(&events),
            roster_pushes.clone(),
        );
        TurnRunner {
            recovery: Arc::new(Mutex::new(None)),
            core,
            input_pauses: crate::session_input_pause::InputPauseTable::new(),
            prompt_admissions: crate::prompt_admission::WorkerAdmissions::new(),
            work_notify: Arc::new(Notify::new()),
            idle_notify: Arc::new(Notify::new()),
            events,
            engine,
            active_session_id: "feed-session".to_string(),
            roster_pushes,
        }
    }

    /// The waiting/executing indicator over the wire: a working session's
    /// roster deltas carry live `isRunningTools` transitions while the
    /// tool executes (mid-turn pushes, not a static turn-start snapshot)
    /// and end idle once the turn settles (TS `observeRosterEvent` +
    /// `ROSTER_SESSION_EVENT_TRIGGERS` + `scheduleRosterFlush`).
    #[tokio::test]
    async fn roster_feed_publishes_live_tool_activity() {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("sup.sock");
        let (recorded, server) = fake_supervisor(socket.clone()).await;
        let engine: Arc<dyn SessionEngine> = Arc::new(
            ScriptedEngine::from_value(json!({
                "responses": [{
                    "text": "ran the tool",
                    "toolCalls": [{
                        "toolCallId": "call-1",
                        "toolName": "bash",
                        "args": { "command": "ls" },
                        "result": "listing",
                        "delayMs": 250,
                    }],
                }],
            }))
            .unwrap_or_default(),
        );
        let runner = live_feed_runner(Arc::clone(&engine), socket);
        // The pickup's busy flip (the run loop's arm before `run_turn`).
        runner.core.lock().unwrap().busy = true;
        runner
            .run_turn(
                engine,
                vec![QueuedItem {
                    preview: None,
                    message: "run the tool".to_string(),
                    custom_message: None,
                    agent_message: None,
                    queue_key: None,
                    admission_id: None,
                    images: Vec::new(),
                    done: None,
                    queue_visible: true,
                    policy: TurnPolicy::Queued,
                    forced_batch: false,
                }],
            )
            .await;
        // The settle push is in flight once the turn returns; the last
        // delta composes the idle state.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let settled = recorded
                .lock()
                .unwrap()
                .last()
                .is_some_and(|summary| summary["isStreaming"] == json!(false));
            if settled || std::time::Instant::now() > deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let summaries = recorded.lock().unwrap().clone();
        let statuses = |key: &str| {
            summaries
                .iter()
                .filter(|summary| summary["isStreaming"] == json!(true))
                .any(|summary| summary[key] == json!(true))
        };
        assert!(
            statuses("isRunningTools"),
            "no mid-turn delta carried isRunningTools=true: {summaries:?}"
        );
        assert!(
            !summaries.is_empty(),
            "the worker never pushed a roster delta"
        );
        let last = summaries.last().cloned().unwrap_or(Value::Null);
        assert_eq!(
            last["isStreaming"],
            json!(false),
            "the settled worker's roster row must read idle (isRunningTools={}): {summaries:?}",
            last["isRunningTools"]
        );
        assert_eq!(
            last["isRunningTools"],
            json!(false),
            "an idle session cannot report tools in flight: {summaries:?}"
        );
        assert_eq!(
            last["activity"],
            json!("idle"),
            "the settled worker's activity is idle: {summaries:?}"
        );
        // The working turns' deltas carry the mid-turn flags.
        let working: Vec<&Value> = summaries
            .iter()
            .filter(|summary| summary["isStreaming"] == json!(true))
            .collect();
        assert!(
            working
                .iter()
                .any(|summary| summary["isRunningTools"] == json!(true)),
            "the tool execution never showed in the feed: {summaries:?}"
        );
        // The post-tool intermediate state (streaming, no tools in flight)
        // is not asserted: the coalescer may collapse it into the turn's
        // next flush — the feed's contract is the mid-tool live state and
        // the settled idle row, both asserted above.
        server.abort();
    }

    async fn turn_session_events(engine: Arc<dyn SessionEngine>) -> Vec<Value> {
        let runner = burst_runner(Arc::clone(&engine));
        let mut subscription = runner.events.subscribe();
        runner
            .run_turn(
                engine,
                vec![QueuedItem {
                    preview: None,
                    message: "burst".to_string(),
                    custom_message: None,
                    agent_message: None,
                    queue_key: None,
                    admission_id: None,
                    images: Vec::new(),
                    done: None,
                    queue_visible: true,
                    policy: TurnPolicy::Queued,
                    forced_batch: false,
                }],
            )
            .await;
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

    /// Run one scripted turn and return its session-event frames in wire
    /// order, with the queued item carrying an injected custom row.
    async fn turn_session_events_with_custom_message(
        engine: Arc<dyn SessionEngine>,
        custom_message: Value,
    ) -> Vec<Value> {
        let runner = burst_runner(Arc::clone(&engine));
        let mut subscription = runner.events.subscribe();
        runner
            .run_turn(
                engine,
                vec![QueuedItem {
                    preview: None,
                    message: "[child-exited: no-reply child:lane]".to_string(),
                    custom_message: Some(custom_message),
                    agent_message: None,
                    queue_key: None,
                    admission_id: None,
                    images: Vec::new(),
                    done: None,
                    queue_visible: true,
                    policy: TurnPolicy::Injected,
                    forced_batch: false,
                }],
            )
            .await;
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

    /// An injected custom row replaces the turn's user row: the wire carries
    /// the custom message's `message_start`/`message_end` pair and no
    /// user-message frame, while the model turn still runs on the notice
    /// text (the RLM child terminal-notice path).
    #[tokio::test]
    async fn an_injected_custom_turn_replaces_the_user_row() {
        let engine = Arc::new(
            ScriptedEngine::from_value(json!({
                "responses": ["notice acknowledged"],
            }))
            .unwrap_or_default(),
        );
        let custom = json!({
            "role": "custom",
            "customType": "rlm_child_terminal_notice",
            "content": "[child-exited: no-reply child:lane]",
            "display": true,
            "details": {
                "kind": "completed_without_reply",
                "childId": "sub-1",
                "sessionName": "lane",
            },
        });
        let events = turn_session_events_with_custom_message(engine, custom).await;

        let starts = positions_of(&events, "message_start");
        let ends = positions_of(&events, "message_end");
        // The custom row opens as a message_start pair; the scripted
        // assistant reply opens as a `message_update` (the scripted
        // harness carries no provider `start` stream event), so exactly
        // one start is on the wire and both rows settle.
        assert_eq!(starts.len(), 1, "only the custom row opens a start");
        assert_eq!(
            ends.len(),
            2,
            "the custom row and the assistant reply settle"
        );
        // The first row is the custom notice, not a user message.
        assert_eq!(events[starts[0]]["message"]["role"], "custom");
        assert_eq!(
            events[starts[0]]["message"]["customType"],
            "rlm_child_terminal_notice"
        );
        // No user row was recorded for the turn.
        let user_rows = events.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["role"] == "user"
        });
        assert!(!user_rows, "the injected turn must not emit a user row");
        // The model turn ran on the notice text and settled the reply
        // (the scripted engine carries the reply as a plain string).
        assert_eq!(events[ends[1]]["message"]["role"], "assistant");
        assert_eq!(events[ends[1]]["message"]["content"], "notice acknowledged");
    }

    /// A delivered agent message (the `worker_deliver_message` arm) runs
    /// as its `agent_message` custom row: the accepted-row frames carry
    /// the custom pair the collapsed card decodes from, no plain user row
    /// reaches the wire, and the model turn still runs on the rendered
    /// prompt.
    #[tokio::test]
    async fn a_delivered_agent_message_turn_emits_the_custom_row() {
        let dir = std::env::temp_dir().join(format!("pa-worker-amw-{}", uuid::Uuid::new_v4()));
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
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        // A busy session parks the delivery on the steering lane, so the
        // queued item is exactly what the served runner would pop.
        worker.core.lock().unwrap().busy = true;
        let delivered = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "target-session",
                    "message": "the research is done",
                    "sender": {
                        "activeSessionId": "source-session",
                        "sessionName": "research-lane",
                        "runtimeKind": "subagent",
                        // The child label derives from this parent edge,
                        // never from the runtime kind alone.
                        "parentActiveSessionId": "target-session",
                    },
                }),
            )
            .await;
        assert!(delivered.success, "deliver failed: {delivered:?}");
        let item = worker
            .core
            .lock()
            .unwrap()
            .steering
            .pop_front()
            .expect("the delivery parked on the steering lane");
        let engine: Arc<dyn SessionEngine> = Arc::new(
            ScriptedEngine::from_value(json!({ "responses": ["ack"] })).unwrap_or_default(),
        );
        let runner = burst_runner(Arc::clone(&engine));
        let mut subscription = runner.events.subscribe();
        runner.run_turn(engine, vec![item]).await;
        let mut events = Vec::new();
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type == "session_event" {
                if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                    events.push(outbound["event"].clone());
                }
            }
        }
        // The accepted row is the agent_message custom pair - the
        // collapsed card's wire form - and no user row rides the turn.
        let starts = positions_of(&events, "message_start");
        assert_eq!(
            starts.len(),
            1,
            "only the custom row opens a start: {events:?}"
        );
        assert_eq!(events[starts[0]]["message"]["role"], "custom");
        assert_eq!(events[starts[0]]["message"]["customType"], "agent_message");
        assert_eq!(
            events[starts[0]]["message"]["content"],
            "[agent-message from child:research-lane]\n\nthe research is done"
        );
        let user_rows = events.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("message_start")
                && event["message"]["role"] == "user"
        });
        assert!(!user_rows, "the delivered turn must not emit a user row");
        // The model turn ran on the rendered prompt and settled the reply.
        let ends = positions_of(&events, "message_end");
        assert_eq!(ends.len(), 2, "the custom row and the reply settle");
        assert_eq!(events[ends[1]]["message"]["role"], "assistant");
    }

    /// A settled turn's wire `agent_end` (TS parity): the engine's per-run
    /// frame carries the run's message set — the accepted user row and the
    /// settled assistant row — and the worker's trailing synthesized frame
    /// stays silent (the fallback exists only for runs that ended without
    /// a model turn; TS emits one `agent_end` per agent run).
    #[tokio::test]
    async fn a_settled_turn_broadcasts_the_engine_agent_end_with_its_messages() {
        let engine = Arc::new(
            ScriptedEngine::from_value(json!({ "responses": ["settled reply"] }))
                .unwrap_or_default(),
        );
        let events = turn_session_events(engine).await;
        let agent_ends = positions_of(&events, "agent_end");
        assert_eq!(
            agent_ends.len(),
            1,
            "exactly one agent_end per run: {events:?}"
        );
        let agent_end = &events[agent_ends[0]];
        assert!(
            agent_end.get("messages").is_some(),
            "the frame carries the TS messages payload: {agent_end:?}"
        );
        let messages = agent_end["messages"]
            .as_array()
            .cloned()
            .expect("the messages payload");
        let roles = messages
            .iter()
            .map(|message| message["role"].as_str().unwrap_or_default())
            .collect::<Vec<&str>>();
        assert_eq!(roles, ["user", "assistant"], "the run's message set");
        assert_eq!(
            messages[0]["content"],
            json!("burst"),
            "the accepted user row rides the payload"
        );
        assert_eq!(
            messages[1]["content"],
            json!("settled reply"),
            "the settled assistant row rides the payload"
        );
        // The frame order: the terminal `turn_end` precedes the run's
        // `agent_end`.
        let turn_ends = positions_of(&events, "turn_end");
        assert_eq!(turn_ends.len(), 1, "the scripted turn's turn_end");
        assert!(
            turn_ends[0] < agent_ends[0],
            "turn_end precedes agent_end: {events:?}"
        );
    }

    /// The bare `agent_end` fallback (a Rust-only shape kept for the TUI's
    /// silent-failure backstop): a turn that ended without a model turn —
    /// no `turn_end`, no `agent_end` from the engine — still closes with
    /// the bare pair, like a session-command or pre-model-failure run.
    #[tokio::test]
    async fn a_turn_without_a_model_turn_keeps_the_bare_fallback_frames() {
        let events = turn_session_events(Arc::new(DoneOnlyEngine)).await;
        let turn_ends = positions_of(&events, "turn_end");
        assert_eq!(turn_ends.len(), 1, "the fallback turn_end: {events:?}");
        assert!(
            events[turn_ends[0]]
                .as_object()
                .is_some_and(|object| object.len() == 1),
            "the fallback turn_end carries no payload: {events:?}"
        );
        let agent_ends = positions_of(&events, "agent_end");
        assert_eq!(agent_ends.len(), 1, "the fallback agent_end: {events:?}");
        assert!(
            events[agent_ends[0]]
                .as_object()
                .is_some_and(|object| object.len() == 1),
            "the fallback agent_end carries no payload: {events:?}"
        );
        assert!(
            turn_ends[0] < agent_ends[0],
            "the fallback pair closes the turn in order: {events:?}"
        );
    }

    /// One `agent_end` per agent run on the wire (TS parity on a retried
    /// turn): the failed run's frame carries the accepted rows plus the
    /// failed assistant row, the retry run re-opens with its own
    /// `agent_start` + `turn_start` frames (a boundary already passed), and
    /// its `agent_end` carries only the retry's messages. No bare
    /// synthesized frame trails the runs.
    #[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
    #[tokio::test]
    async fn a_retried_turn_broadcasts_one_agent_end_per_run() {
        fn roles_of(frame: &Value) -> Vec<String> {
            frame["messages"]
                .as_array()
                .map(|messages| {
                    messages
                        .iter()
                        .map(|message| message["role"].as_str().unwrap_or_default().to_string())
                        .collect()
                })
                .unwrap_or_default()
        }
        let _faux = crate::agent_engine::tests::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = std::env::temp_dir().join(format!(
            "pa-worker-agent-end-retry-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        std::fs::write(
            dir.join("agent").join("settings.json"),
            json!({ "retry": { "enabled": true, "maxRetries": 1, "baseDelayMs": 10 } }).to_string(),
        )
        .unwrap();
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "agent-end-retry-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [
                    { "stopReason": "error", "errorMessage": "faux provider overloaded" },
                    { "text": "recovered reply" },
                ],
            })),
        };
        let worker = std::sync::Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "agent-end-retry" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let mut subscription = worker.events.subscribe();
        let prompt = worker
            .dispatch(
                "prompt",
                &json!({
                    "activeSessionId": "agent-end-retry-session",
                    "message": "retried turn for the agent end probe",
                }),
            )
            .await;
        assert!(prompt.success, "prompt failed: {prompt:?}");
        // The turn runs detached (`prompt` answers immediately) and the
        // faux retry settles in milliseconds, so the busy flag is not a
        // reliable admission marker: drain the stream until both runs'
        // `agent_end` frames arrived.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut events = Vec::new();
        loop {
            while let Ok(frame) = subscription.try_recv() {
                if frame.outbound_type != "session_event" {
                    continue;
                }
                let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) else {
                    continue;
                };
                if let Some(event) = outbound.get("event") {
                    events.push(event.clone());
                }
            }
            let agent_ends = events
                .iter()
                .filter(|event| event.get("type").and_then(Value::as_str) == Some("agent_end"))
                .count();
            if agent_ends >= 2 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the retried turn never settled: {events:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        // The turn settled: drain the trailing frames (the settle-side
        // queue snapshot rides after the final `agent_end`).
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        while let Ok(frame) = subscription.try_recv() {
            if frame.outbound_type != "session_event" {
                continue;
            }
            let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) else {
                continue;
            };
            if let Some(event) = outbound.get("event") {
                events.push(event.clone());
            }
        }
        let agent_ends = positions_of(&events, "agent_end");
        assert_eq!(
            agent_ends.len(),
            2,
            "one agent_end per agent run: {events:?}"
        );
        let first = &events[agent_ends[0]];
        assert_eq!(
            roles_of(first),
            ["custom", "user", "assistant"],
            "the failed run's message set (the deferred digest rides first): {events:?}"
        );
        assert_eq!(
            first["messages"][2]["stopReason"],
            json!("error"),
            "the failed run ends on the error row"
        );
        let second = &events[agent_ends[1]];
        assert_eq!(
            roles_of(second),
            ["assistant"],
            "the retried run carries only its own messages: {events:?}"
        );
        assert_eq!(
            second["messages"][0]["content"],
            json!([{ "type": "text", "text": "recovered reply" }]),
            "the retried run's settled row"
        );
        // The retry run restarted with its own opening frames: two
        // `agent_start` and two `turn_start` frames total (the worker's
        // run-opening pair plus the forwarded retry-run pair), the retry
        // run's frames after the retry start.
        let agent_starts = positions_of(&events, "agent_start");
        assert_eq!(agent_starts.len(), 2, "one agent_start per run: {events:?}");
        let turn_starts = positions_of(&events, "turn_start");
        assert_eq!(
            turn_starts.len(),
            2,
            "the run-opening turn_start plus the retry run's: {events:?}"
        );
        let retry_starts = positions_of(&events, "auto_retry_start");
        assert_eq!(retry_starts.len(), 1, "the retry start frame: {events:?}");
        assert!(
            agent_ends[0] < retry_starts[0]
                && retry_starts[0] < agent_starts[1]
                && agent_starts[1] < turn_starts[1]
                && turn_starts[1] < agent_ends[1],
            "the retry run's frames sit between the two agent_ends: {events:?}"
        );
        // No bare synthesized frame trails the runs: every agent_end on
        // the wire carries the messages payload.
        assert!(
            events.iter().all(|event| {
                event.get("type").and_then(Value::as_str) != Some("agent_end")
                    || event.get("messages").is_some()
            }),
            "no bare agent_end frames: {events:?}"
        );
    }

    fn positions_of(events: &[Value], frame_type: &str) -> Vec<usize> {
        events
            .iter()
            .enumerate()
            .filter(|(_, event)| event.get("type").and_then(Value::as_str) == Some(frame_type))
            .map(|(index, _)| index)
            .collect()
    }

    fn texts_at(events: &[Value], positions: &[usize]) -> Vec<String> {
        positions
            .iter()
            .filter_map(|index| {
                events[*index]["message"]["content"][0]["text"]
                    .as_str()
                    .map(str::to_string)
            })
            .collect()
    }

    /// A provider that outruns the flush tick still broadcasts at most one
    /// parked update per tick — never one wire frame per delta (the
    /// pre-fix path flooded the wire with every delta and the client
    /// starved at the tick rate; a 12k-token turn took minutes to render).
    #[tokio::test]
    async fn a_provider_burst_broadcasts_one_coalesced_update_per_tick_not_per_delta() {
        const DELTAS: usize = 120;
        // 1ms spacing: the burst spans ~120ms, so the 50ms flusher tick
        // flushes at most a handful of mid-burst snapshots.
        let engine = Arc::new(BurstStreamEngine {
            deltas: DELTAS,
            spacing_ms: 1,
        });
        let events = turn_session_events(engine).await;

        assert_eq!(
            positions_of(&events, "message_start").len(),
            1,
            "one message_start frame opens the stream"
        );
        let updates = positions_of(&events, "message_update");
        let end = positions_of(&events, "message_end");
        assert_eq!(end.len(), 1, "the turn settles with one message_end");
        assert!(
            !updates.is_empty(),
            "the parked snapshots must reach the wire"
        );
        assert!(
            updates.len() * 10 < DELTAS,
            "{DELTAS} spaced deltas must coalesce to a handful of wire updates, saw {}",
            updates.len()
        );
        // The latest snapshot wins: the flushed update carries the full
        // message so far, and superseded snapshots are dropped.
        assert_eq!(
            texts_at(&events, &updates).last().map(String::len),
            Some((DELTAS + 1) * 4),
            "the last flushed update must carry the full text"
        );
        // Event-sequence order: every update precedes the settle frame.
        assert!(
            updates.iter().all(|index| *index < end[0]),
            "a superseded snapshot must never follow message_end"
        );
    }

    /// An instant burst (the provider outruns the tick entirely) parks one
    /// snapshot at a time; the settle frame flushes the final snapshot
    /// before `message_end`, so the client sees the full message without a
    /// tick waiting period and nothing lands out of order.
    #[tokio::test]
    async fn an_instant_burst_flushes_the_final_snapshot_with_its_settle_frame() {
        const DELTAS: usize = 200;
        let engine = Arc::new(BurstStreamEngine {
            deltas: DELTAS,
            spacing_ms: 0,
        });
        let events = turn_session_events(engine).await;

        let updates = positions_of(&events, "message_update");
        let end = positions_of(&events, "message_end");
        assert_eq!(end.len(), 1, "the turn settles with one message_end");
        assert!(
            updates.len() <= 3,
            "an instant burst broadcasts at most the settle-flushed snapshot (a mid-burst tick race adds one per 50ms stall), saw {}",
            updates.len()
        );
        assert!(
            texts_at(&events, &updates)
                .iter()
                .any(|text| text.len() == (DELTAS + 1) * 4),
            "the flushed snapshot must carry the full message"
        );
        assert!(
            updates.iter().all(|index| *index < end[0]),
            "the flushed snapshot precedes message_end"
        );
    }
}

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
