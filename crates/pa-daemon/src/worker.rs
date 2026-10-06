//! Session worker runtime: one process, one session.
//! The worker owns the session - the append-only store, the queue lanes, event sequencing, and turn
//! execution.

mod config;
mod env;
mod session_core;

pub(crate) use config::WorkerConfig;
// KillCloseReason is read only by the commands module (via `use super::*`), so allow the unused
// import.
#[allow(unused_imports)]
use env::KillCloseReason;
mod input;
mod lifecycle;
mod summary;

mod connection;

pub(crate) use connection::{AuthOutcome, ConnectionSink, EventPump, OutboundFrame};

mod digest;

pub(crate) use digest::AgentMessageDigest;
#[cfg(test)]
pub(crate) use digest::AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE;

mod queue;

pub use queue::Lane;
pub use queue::QueuePriority;
pub(crate) use queue::{
    admit_autonomous_follow_up, admit_bash_completion_notice, admit_goal_follow_up,
    checkpoint_queue_recovery, enqueue_priority, gather_delivery_batch, parse_custom_message,
    parse_prompt_images, queue_lanes, restore_queue_snapshot, restored_turn_policy,
    withdraw_bash_completion_notice, QueueCheckpoint, QueueLanes, QueuedItem, TurnPolicy,
    TurnSettle, ABORTED_TURN_SETTLE_ERROR, PROMPT_ABORTED_BEFORE_DELIVERY, QUEUED_INPUT_SUSPENDED,
    QUEUED_PROMPT_DELETED, SIDE_QUESTION_SETTLE_TIMEOUT,
};

mod create;
mod turn;

use create::{active_session_id_of, worker_server_capabilities};
// session_summary serves the in-crate test modules only, so allow the unused import.
#[allow(unused_imports)]
pub(crate) use summary::{
    compact_action_label, emit_worker_event_with, persist_custom_row, push_roster_delta,
    session_snapshot, session_summary, RosterPushContext,
};
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
// PathBuf is read only by this facade's in-file test modules (via `use super::*`).
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
    AssistantSnapshot, EngineEvent, EngineModelSelection, PromptRequest, RlmSessionIdentity,
    ScriptedEngine, SessionEngine,
};
use crate::framing::{write_frame, write_frame_segments, DEFAULT_PRIVATE_FRAME_LIMITS};
use crate::journal::WorkerRecoveryJournal;
use crate::paths;
use crate::peer::{
    peer_command_allowed, worker_peer_command_allowed, ConnectionRole, PeerGrantStore,
    PEER_COMMAND_NOT_ALLOWED,
};
use crate::protocol::{
    create_daemon_event_meta, create_daemon_replay_info, current_protocol_info,
    default_client_capabilities, normalize_client_capabilities, response_failure, response_success,
    DaemonOutbound, DaemonResponse, DaemonResumeCursor, DaemonSessionClosedReason,
    DAEMON_APP_VERSION, DAEMON_SCHEMA_ID, DAEMON_SCHEMA_REVISION,
};
use crate::registration::RegistrationHandle;
use crate::session_store::{session_file_name, SessionFile};

use crate::types::{AgentConnectionState, SessionActionSnapshot};

pub struct Worker {
    pub(crate) config: WorkerConfig,
    /// The bind-time filesystem identity of this worker's own socket file
    /// (TS daemon-mode captures `socketIdentity` in the listen callback,
    /// daemon-mode.ts:718): the exit cleanups pass it as the unlink's
    /// expected identity, so a file REPLACED at the path after this bind -
    /// a successor worker the supervisor relaunches on the same
    /// deterministic path - is never unlinked by this process (the
    /// D-state-survivor late-exit edge). `None` until `serve` binds
    /// (named pipes keep `None`: there is no file to stat).
    pub(crate) bound_socket_identity: std::sync::Mutex<Option<crate::socket::SocketIdentity>>,
    /// Supervisor self-registration handle; `None` for standalone workers.
    registration: Option<RegistrationHandle>,
    /// Live connections authenticated as the supervisor role; a non-zero
    /// count disarms the supervisor-lost exit monitor.
    pub(crate) supervisor_claims: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub(crate) core: Arc<Mutex<SessionCore>>,
    pub(crate) engine: std::sync::Arc<dyn SessionEngine>,
    /// The concrete agent engine behind `engine` for the create command's
    /// eager session build (the kernel prewarm).
    pub(crate) agent_engine: Option<std::sync::Arc<crate::agent_engine::AgentSessionEngine>>,
    /// The monotonic roster-delta counter shared with the roster push
    /// queue: per-request links deliver pushes unordered.
    roster_delta_sequence: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub(crate) work_notify: Arc<Notify>,
    pub(crate) idle_notify: Arc<Notify>,
    /// The per-connection session-attach registry (the fresh bots'
    /// release findings): connection tokens -> the client ids their
    /// `attach` retained. The release is connection-scoped on EVERY
    /// return path (the guard's Drop), and a shared client id leaves the
    /// core only when the LAST live connection holding it goes (the
    /// reconnect shape).
    pub(crate) session_attachments:
        std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,
    /// Tokens whose attach guard already released: a late registration
    /// racing the close is rejected, not recreated as unowned.
    pub(crate) released_attach_tokens: std::sync::Mutex<std::collections::HashSet<String>>,
    pub(crate) events: Arc<EventPump>,
    /// The `/model` catalog background-refresh coalescing gate: at most
    /// one refresh plus one queued re-arm per burst.
    pub(crate) model_catalog_refresh_gate: std::sync::Arc<crate::model_catalog::RefreshGate>,
    recovery: Arc<Mutex<Option<WorkerRecoveryJournal>>>,
    side_questions: crate::side_question::SideQuestionManager,
    /// Single-use peer-transport grants (worker memory only).
    pub(crate) peer_grants: PeerGrantStore,
    pub(crate) compaction: crate::compaction::CompactionManager,
    pub(crate) tree_navigation: crate::branch_navigation::TreeNavigation,
    /// The `get_context_tree` children cache: the artifact-tree walk is a
    /// multi-second disk read, so requests serve the cached snapshot.
    pub(crate) context_tree: std::sync::Arc<crate::context_tree_cache::ContextTreeCache>,
    exports: crate::session_export::ExportCommands,
    /// Session-scoped ACP MCP servers for engines without their own
    /// store; the real engine's manager serves the product path.
    acp_mcp: std::sync::Arc<std::sync::Mutex<pa_core::mcp::McpManager>>,
    /// The user-bash slot (`execute_bash` / `execute_bash_and_wait` /
    /// `abort_bash`): one command runs at a time, killed on abort.
    pub(crate) user_bash: std::sync::Arc<crate::user_bash::UserBash>,
    /// The coalescing roster push queue shared with the turn runner: the
    /// awaited bash handler enqueues the run-settle flush.
    pub(crate) roster_pushes: crate::roster_activity::RosterPushQueue,
    /// Agent-message ingestion state: the pause flag the delivery gate checks.
    pub(crate) agent_messages: crate::agent_message_ingest::AgentMessageIngest,
    /// The digest inbox lane (swarm PRs C/D/E): the durable inbox, the
    /// daemon-side lane controller with its counters, and the notice
    /// routing through this worker's queue lanes.
    pub(crate) agent_digest: Arc<AgentMessageDigest>,
    /// Session input-pause leases: the admission gate the turn runner consults.
    pub(crate) input_pauses: crate::session_input_pause::InputPauseTable,
    /// Session navigation: `new_session` / `switch_session` / `import_jsonl`,
    /// the shared replacement flow.
    pub(crate) navigation: crate::session_navigation::SessionNavigation,
    /// Worker-side prompt admissions: the registry the supervisor's
    /// forwarded `cancel_prompt_admission` reads.
    pub(crate) prompt_admissions: crate::prompt_admission::WorkerAdmissions,
    /// The scheduling surface: the session's cron/heartbeat store plus the
    /// scheduler firing due jobs into the queue (jobs rebind on replacement).
    pub(crate) scheduled: std::sync::Arc<crate::scheduled_jobs::ScheduledJobs>,
    /// The session's Herdr reporter (the built-in connector): starts
    /// disabled and is (re)bound at `create` from the create payload's
    /// client env — the session's own pane identity, never this
    /// process's boot context. Replacing it silences the old task
    /// exactly like the TS session-shutdown arm (no release; a successor
    /// re-reports), because the task ends when its last handle drops.
    pub(crate) herdr: std::sync::Arc<std::sync::Mutex<crate::herdr::HerdrReporter>>,
    /// The reporter epoch (bumped on every (re)bind): a replaced
    /// reporter's task drops its queued boundary events instead of
    /// flushing them over the successor's pane state.
    pub(crate) herdr_generation: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Session creation is one serialized critical section (TS
    /// `openingSessions`: a concurrent open for the same session JOINS
    /// the in-flight one instead of racing it). Commands run on spawned
    /// tasks, so without the gate two concurrent `create` requests could
    /// both pass the `core.created` check while the first still awaits
    /// its session-model restore — duplicating creation-prefix rows and
    /// overwriting the initialized core state.
    create_gate: tokio::sync::Mutex<()>,
    /// Whole-session replacements are one serialized critical section:
    /// the swap must move the worker onto the replacement as one unit.
    pub(crate) replacement_gate: tokio::sync::Mutex<()>,
}

/// The kernel cron wiring the worker hands its session engine: the shared
/// store, durable binding, and mutation hook for `rlm_heartbeat.*`.
fn kernel_cron_wiring(
    scheduled: &std::sync::Arc<crate::scheduled_jobs::ScheduledJobs>,
) -> pa_core::session_engine::runtime_wiring::KernelCronWiring {
    pa_core::session_engine::runtime_wiring::KernelCronWiring {
        store: std::sync::Arc::clone(scheduled.store()),
        binding: None,
        mutation_hook: Some(scheduled.mutation_hook()),
    }
}

fn supervisor_link_config(config: &WorkerConfig) -> SupervisorLinkConfig {
    SupervisorLinkConfig {
        socket_path: config.supervisor_socket_path.clone(),
        active_session_id: config.active_session_id.clone(),
        worker_token: config.token.clone(),
    }
}

/// Whether a delivery's sender is one of THIS session's children, by the
/// sender's recorded durable parent edge; runtime kind alone never decides.
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
/// durable identity: the sender's parent edge must point back at this session.
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
    /// Build the worker: core, engine, and the sink/hook wiring between them.
    ///
    /// # Panics
    ///
    /// The wired closures panic on a poisoned session-core mutex.
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
            last_activity_ms: 0,
            compacting: false,
            auto_compaction_enabled: true,
            // TS seeds `_lastSessionActionSnapshot` with the empty projection:
            // the first empty snapshot is not an update.
            last_action_snapshot: Some(SessionActionSnapshot::default()),
            rlm_depth: 0,
            runtime_kind: "top-level".to_string(),
            rlm_child_id: None,
            parent_active_session_id: None,
            parent_session_id: None,
            child_script: None,
            service_tier: None,
            active_service_tier: None,
            steering_mode: "all".to_string(),
            follow_up_mode: "one-at-a-time".to_string(),
            forced_all_steering: false,
            scoped_models: Vec::new(),
            retry_abort_requested: false,
            queued_input_suspended: false,
            pending_next_turn: Vec::new(),
            agent_message_digest_mode: false,
            agent_message_digest_pin: digest::DigestLanePin::default(),
            active_action: None,
            running_tool_calls: std::collections::HashSet::new(),
            running_admission_ids: std::collections::HashSet::new(),
        };
        let active_session_id = config.active_session_id.clone();
        let script = config.script.clone();
        let core = Arc::new(Mutex::new(core));
        // TS `_steeringStopPending`: a queued steer stops the running turn
        // at its next boundary — the follow-up lane never stops the run.
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
        // snapshots, `serve` opens the file, commands record busy state.
        let recovery = Arc::new(Mutex::new(None));
        let work_notify = Arc::new(Notify::new());
        let idle_notify = Arc::new(Notify::new());
        // The supervisor link and worker token for roster pushes: one
        // construction shared by the turn runner and the command arms
        // (identical dial path).
        let roster_link = std::sync::Arc::new(crate::supervisor_link::SupervisorLink::new(
            std::env::var_os(WORKER_SUPERVISOR_SOCKET_ENV)
                .map(std::path::PathBuf::from)
                .unwrap_or_default(),
        ));
        let worker_token = std::env::var(WORKER_TOKEN_ENV).unwrap_or_default();
        let roster_delta_sequence = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let roster_push_order = std::sync::Arc::new(std::sync::Mutex::new(()));
        let input_pauses = crate::session_input_pause::InputPauseTable::new();
        // The shared pane-reporter slot: the worker binds it at create and
        // the turn runner reads it at every boundary (a slot, not a
        // snapshot, so a create-time rebind reaches the runner too).
        let herdr_slot =
            std::sync::Arc::new(std::sync::Mutex::new(crate::herdr::HerdrReporter::default()));
        // The reporter epoch shared with every reporter the worker
        // starts: a rebind bumps it so the replaced task drops its
        // queued boundary events instead of flushing them.
        let herdr_generation = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        // The worker's prompt-admission registry: shared with the turn
        // runner (the commit happens at turn start).
        let prompt_admissions = crate::prompt_admission::WorkerAdmissions::new();
        // Created before the session engine: `rlm_heartbeat.*` requests
        // write the shared cron store.
        let user_bash = std::sync::Arc::new(crate::user_bash::UserBash::new());
        let scheduled = std::sync::Arc::new(crate::scheduled_jobs::ScheduledJobs::new(
            Arc::clone(&core),
            Arc::clone(&work_notify),
            std::sync::Arc::clone(&user_bash),
            Arc::clone(&events),
            Arc::clone(&recovery),
        ));
        // The digest inbox lane (swarm PRs C/D/E): the receiving worker owns
        // the lane — the durable inbox, the controller with its counters, and
        // the notice admission/withdrawal through the queue lanes.
        let agent_digest = Arc::new(AgentMessageDigest::new(
            Arc::clone(&core),
            Arc::clone(&recovery),
            Arc::clone(&work_notify),
        ));
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
                // engine over the scripted faux provider (verification only).
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
                Some(script) => {
                    std::sync::Arc::new(ScriptedEngine::from_value(script).unwrap_or_default())
                }
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
            // the worker owns the queue and gates, the engine owns the mint.
            if let Some(concrete) = agent_engine.as_ref() {
                // The in-run autonomous continuation seam: the hook holds
                // itself weakly through the registered arc.
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
                        // The withdraw settles the rows: dropping the last
                        // queued row must not leave busy=true promising a
                        // revive (mid-turn stays busy until its own `turn_end`).
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
                // Weak engine reference: the engine holds this sink, so a
                // strong one would pin it forever.
                let sink_engine = std::sync::Arc::downgrade(concrete);
                let sink: crate::engine::GoalAdmissionSink = Arc::new(move |work| {
                    // The item's OWN pending handle, cloned before the
                    // admission: the release touches exactly this mint's
                    // guard, never the mutable mirror a rebuilt core re-swaps.
                    let pending_handle = match &work {
                        crate::engine::GoalTurnEndWork::Continuation(item)
                        | crate::engine::GoalTurnEndWork::BudgetLimitSteer(item) => {
                            item.pending_handle.clone()
                        }
                    };
                    admit_goal_follow_up(
                        &sink_recovery,
                        &sink_core,
                        &sink_events,
                        &sink_notify,
                        work,
                    );
                    if sink_engine.upgrade().is_none() {
                        return;
                    }
                    // The queue admitted the minted continuation: the guard
                    // releases now, so the next boundary may mint again.
                    AgentSessionEngine::release_goal_continuation_handle(pending_handle.as_ref());
                });
                // TS `_clearQueuedGoalContexts`: withdraw queued minted
                // goal-context turns.
                let purge_core = Arc::clone(&core);
                let purge_recovery = Arc::clone(&recovery);
                let queue_purge: std::sync::Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                    {
                        let mut core = purge_core.lock().unwrap();
                        core.steering.retain(|item| !is_goal_context_item(item));
                        core.follow_up.retain(|item| !is_goal_context_item(item));
                    }
                    // Same settle as the autonomous withdraw: a pause/clear
                    // cannot leave busy=true.
                    checkpoint_queue_recovery(
                        &purge_recovery,
                        &purge_core,
                        QueueCheckpoint::Settle {
                            operation: "queue_purged",
                        },
                    );
                });
                concrete.set_goal_admission(probe, sink, queue_purge);
                let late_core = Arc::clone(&core);
                let late_events = Arc::clone(&events);
                concrete.set_late_agent_message_sink(std::sync::Arc::new(
                    move |tool_call_id, message| {
                        let wire = pa_core::sent_agent_message_json(&message);
                        crate::user_bash::emit_session_event_frame(
                            &late_core,
                            &late_events,
                            serde_json::json!({
                                "type": "ipython_sent_agent_message",
                                "toolCallId": tool_call_id,
                                "message": wire,
                            }),
                        );
                    },
                ));
                // The settled-child kernel release's registered-jobs gate
                // (TS #2483's `canPassivateSettledSession`
                // `hasRegisteredCronJob`): the release defers while this
                // session still owns an active or paused scheduled job
                // (a cron or heartbeat run must not lose its kernel).
                let jobs_core = Arc::clone(&core);
                let jobs_store = std::sync::Arc::clone(scheduled.store());
                concrete.set_registered_jobs_probe(std::sync::Arc::new(move || {
                    let active_session_id = {
                        jobs_core
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .active_session_id
                            .clone()
                    };
                    jobs_store.list().into_iter().any(|job| {
                        job.active_session_id == active_session_id
                            && matches!(
                                job.status,
                                pa_core::cron::JobStatus::Active | pa_core::cron::JobStatus::Paused
                            )
                    })
                }));
                // The live compaction summary-delta sink: every summarizer
                // text delta reaches clients as one ephemeral frame (never
                // persisted, never a roster trigger).
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
                // The bash-completion wake seam (TS `_promptInjectedMessage`
                // for `bash.completed`): the handler validates, the sink
                // admits/withdraws through the queue lanes.
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
                        &notice,
                        // Revalidated inside the admission's lock section: the
                        // close paths mark the session BEFORE clearing the lanes.
                        || engine.session_is_closed(),
                    );
                });
                let withdraw_core = Arc::clone(&core);
                let withdraw_recovery = Arc::clone(&recovery);
                let consumed: crate::engine::BashConsumedSink = Arc::new(move |notice| {
                    withdraw_bash_completion_notice(&withdraw_recovery, &withdraw_core, &notice);
                });
                concrete.set_bash_notice_sinks(completion, consumed);
                // The swarm digest-lane seams (PRs C/D/E): the receiving
                // worker owns the inbox (its store), the lane pin, and the
                // digest-aware notice routing; the engine's kernel handlers
                // call through these closures. The watch sink carries the
                // same closed-session gate the completion sink holds.
                let inbox_digest = Arc::clone(&agent_digest);
                let list: crate::agent_inbox_host::InboxListFn =
                    Arc::new(move || inbox_digest.inbox_snapshot());
                let inbox_digest = Arc::clone(&agent_digest);
                let read: crate::agent_inbox_host::InboxReadFn =
                    Arc::new(move |ids| inbox_digest.read_inbox(ids));
                let inbox_digest = Arc::clone(&agent_digest);
                let configure: crate::agent_inbox_host::InboxConfigureFn =
                    Arc::new(move |mode| inbox_digest.configure_pin(mode));
                concrete.set_digest_inbox_seams(crate::agent_inbox_host::DigestInboxSeams {
                    list,
                    read,
                    configure,
                });
                let watch_engine = std::sync::Arc::downgrade(concrete);
                let watch_digest = Arc::clone(&agent_digest);
                let watch_sink: crate::agent_inbox_host::WatchNoticeSink =
                    std::sync::Arc::new(move |watch, content| {
                        // A closed session never admits notices; the
                        // digest-aware routing itself lives worker-side.
                        if watch_engine
                            .upgrade()
                            .is_some_and(|engine| engine.session_is_closed())
                        {
                            return;
                        }
                        watch_digest.emit_watch_notice(watch, content);
                    });
                concrete.set_watch_notice_sink(watch_sink);
            }
            // The live roster activity feed (TS `observeRosterEvent`): busy
            // flips and trigger events coalesce into `worker_roster_delta`
            // pushes.
            let roster_pushes =
                crate::roster_activity::RosterPushQueue::spawn(crate::worker::RosterPushContext {
                    core: Arc::clone(&core),
                    engine: std::sync::Arc::clone(&engine),
                    user_bash: std::sync::Arc::clone(&user_bash),
                    roster_link: Arc::clone(&roster_link),
                    worker_token: worker_token.clone(),
                    worker_instance_id: config.worker_instance_id.clone(),
                    roster_delta_sequence: std::sync::Arc::clone(&roster_delta_sequence),
                    roster_push_order: std::sync::Arc::clone(&roster_push_order),
                });
            crate::roster_activity::spawn_roster_activity_watch(&events, roster_pushes.clone());
            if let Some(children) = agent_engine
                .as_ref()
                .and_then(|engine| engine.children.as_ref())
            {
                crate::roster_activity::spawn_running_children_watch(
                    children,
                    roster_pushes.clone(),
                );
            }
            let runner = TurnRunner {
                recovery: Arc::clone(&recovery),
                core: Arc::clone(&core),
                input_pauses: input_pauses.clone(),
                prompt_admissions: prompt_admissions.clone(),
                work_notify: Arc::clone(&work_notify),
                idle_notify: Arc::clone(&idle_notify),
                events: events.clone(),
                engine: std::sync::Arc::clone(&engine),
                active_session_id,
                roster_pushes: roster_pushes.clone(),
                user_bash: std::sync::Arc::clone(&user_bash),
                agent_digest: Arc::clone(&agent_digest),
                passivation: crate::worker::turn::PassivationContext {
                    agent_dir: config.agent_dir.clone(),
                    link: Arc::clone(&roster_link),
                    worker_token,
                },
                herdr: std::sync::Arc::clone(&herdr_slot),
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
        // blocking, so the builder runs off the async runtime.
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
        let navigation = crate::session_navigation::SessionNavigation::new(
            std::sync::Arc::clone(&engine),
            Arc::clone(&core),
            Arc::clone(&agent_digest),
        );
        Worker {
            config,
            bound_socket_identity: std::sync::Mutex::new(None),
            registration,
            supervisor_claims,
            core,
            engine,
            agent_engine,
            roster_delta_sequence,
            work_notify,
            idle_notify,
            session_attachments: std::sync::Mutex::new(std::collections::HashMap::new()),
            released_attach_tokens: std::sync::Mutex::new(std::collections::HashSet::new()),
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
            agent_digest,
            input_pauses,
            navigation,
            prompt_admissions,
            scheduled,
            herdr: std::sync::Arc::clone(&herdr_slot),
            herdr_generation: std::sync::Arc::clone(&herdr_generation),
            create_gate: tokio::sync::Mutex::new(()),
            replacement_gate: tokio::sync::Mutex::new(()),
        }
    }

    /// The Herdr session reference the reports carry (TS
    /// `agent_session_path` / `agent_session_id`): the session file when
    /// the session has one, otherwise the session id.
    pub(crate) fn herdr_session_ref(core: &SessionCore) -> crate::herdr::HerdrSessionRef {
        let store = core.store.as_ref();
        crate::herdr::HerdrSessionRef::new(
            store
                .filter(|store| !store.path.as_os_str().is_empty())
                .map(|store| store.path.to_string_lossy().to_string()),
            store.map(|store| store.session_id().to_string()),
        )
    }

    /// The durable tail of a successful close: the resume entry, the
    /// worker's own socket cleanup, and the process exit. The routed
    /// `shutdown` arm and the registration-retirement path share it
    /// (`std::process::exit` runs no destructors, so the caller must
    /// have settled the close first).
    fn exit_after_close(&self) -> ! {
        // Shutdown keeps the resume entry and exits the process (TS
        // `closeKeepsResumeEntry("shutdown")`).
        let _ = self.record_recovery(false, "shutdown");
        // A graceful exit owns its socket file: remove it now so a respawn
        // does not wait out the stale-socket path (a killed worker cannot
        // clean up, but its killer relaunches through
        // `prepare_socket_path`). The bind-time identity (captured in
        // `serve`) is the unlink's expected identity, so a REPLACED file
        // at the path - a successor worker's live socket - survives this
        // exit (TS daemon-mode.ts:1078-1080).
        crate::socket::cleanup_socket_path(
            &self.config.socket_path,
            self.bound_socket_identity.lock().unwrap().clone(),
        );
        std::process::exit(0)
    }

    /// The refused-registration self-heal: the supervisor definitively rejected this worker's
    /// identity. Retire with the graceful close, releasing the session lease.
    pub(crate) async fn exit_refused_registration(&self) {
        eprintln!(
            "pa-daemon worker {}: registration refused (the supervisor no longer owns this identity); retiring",
            std::process::id()
        );
        let _ = self.handle_shutdown().await;
        self.exit_after_close();
    }
}

/// The turn runner: drains the queue one turn at a time, running the session
/// engine and emitting the agent-loop event lifecycle.
/// Sequence and broadcast one `session_event` frame at the worker
/// level: sequence + meta under the core lock, then one broadcast (the
/// free-standing form of `Worker::emit_worker_event`, shared with the
/// goal admission sink).
pub(crate) fn refine_complete_event(
    result: &pa_core::refinement::RefinementResult,
) -> serde_json::Value {
    json!({
        "type": "refine_complete",
        "result": serde_json::to_value(result).unwrap_or(Value::Null),
    })
}

/// Send a background refinement result only if the session that started
/// the review is still current. Hold the core lock through the broadcast so
/// navigation cannot move the event onto a different session.
fn emit_refinement_event_for_session(
    core: &Arc<Mutex<SessionCore>>,
    events: &Arc<EventPump>,
    review_session_id: &str,
    event: Value,
) -> bool {
    let mut core = core.lock().unwrap();
    if core.store.as_ref().map(SessionFile::session_id) != Some(review_session_id) {
        return false;
    }
    let sequence = core.last_event_sequence + 1;
    core.last_event_sequence = sequence;
    let meta = crate::protocol::create_daemon_event_meta(
        &core.active_session_id,
        sequence,
        None,
        Some(&core.generation),
    );
    let outbound = crate::protocol::DaemonOutbound::SessionEvent {
        active_session_id: core.active_session_id.clone(),
        event,
        meta: Some(meta),
        rest: Map::default(),
    };
    let payload = serde_json::to_vec(&outbound).unwrap_or_default();
    events.send(OutboundFrame::session_event(payload));
    true
}

/// Record one durable custom row of the background compact-trigger
/// review and broadcast its `message_start`/`message_end` pair.
/// `review_session_id` fences the row against session moves made while
/// the review's model call was in flight.
fn emit_refinement_row(
    core: &Arc<Mutex<SessionCore>>,
    events: &Arc<EventPump>,
    review_session_id: &str,
    message: &Value,
) -> bool {
    {
        let mut core = core.lock().unwrap();
        let Some(store) = core.store.as_mut() else {
            return false;
        };
        if store.session_id() != review_session_id {
            pa_core::session_engine::compaction_trace::trace(
                "autorefine.rows_dropped_session_moved",
                &serde_json::Value::Null,
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
/// Errors when the worker role env is missing, the worker env pair cannot be
/// read, or the serve loop fails.
pub async fn run_worker() -> Result<()> {
    if std::env::var(WORKER_ROLE_ENV).unwrap_or_default() != "1" {
        return Err(anyhow!("worker mode requires {WORKER_ROLE_ENV}=1"));
    }
    let config = WorkerConfig::from_env()?;
    // Self-registration: the supervisor's roster survives its own restarts
    // because workers re-present their identity (liveness watch + backoff).
    let registration = crate::registration::start(&config);
    let worker = Arc::new(Worker::new(config, registration));
    // The refused-registration self-heal: retire instead of remaining an
    // invisible lease-holder.
    if let Some(handle) = worker.registration.clone() {
        let worker = Arc::clone(&worker);
        tokio::spawn(async move {
            handle.retired().await;
            worker.exit_refused_registration().await;
        });
    }
    worker.serve().await
}

/// Whether one parked queue item is an RLM child status notice: the
/// injected custom row's kind proves it (clients reject claimed kinds).
fn is_rlm_child_status_item(item: &QueuedItem) -> bool {
    let Some(row) = item.custom_message.as_ref() else {
        return false;
    };
    // One reserved-kind predicate, owned by the intake module: every
    // reader shares the same exact match.
    crate::child_status_notices::is_reserved_child_status_custom_type(row)
}

/// One parked item's engine-minted internal-prompt provenance: the turn
/// policy marks the admission class and `queue_visible` the invisible shape.
fn is_injected_prompt_item(item: &QueuedItem) -> bool {
    item.policy == TurnPolicy::Injected && !item.queue_visible && !is_rlm_child_status_item(item)
}

#[cfg(test)]
#[path = "worker_resume_settings_tests.rs"]
mod worker_resume_settings_tests;

#[cfg(test)]
mod agent_message_tests;

#[cfg(test)]
mod digest_tests;

#[cfg(test)]
mod prompt_image_tests;

#[cfg(test)]
mod compaction_admission_tests;
#[cfg(test)]
mod recovery_verdict_tests;
#[cfg(test)]
mod replacement_gate_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod turn_stream_tests;
#[cfg(test)]
mod update_snapshot_tests;
