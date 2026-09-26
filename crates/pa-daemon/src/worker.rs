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
mod input;
mod lifecycle;
mod summary;

mod connection;

pub(crate) use connection::{AuthOutcome, ConnectionSink, EventPump, OutboundFrame};

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
use turn::TurnRunner;
pub(crate) use summary::{
    RosterPushContext, compact_action_label, emit_worker_event_with, push_roster_delta,
    session_snapshot, session_summary,
};


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

#[cfg(test)]
#[path = "worker_resume_settings_tests.rs"]
mod worker_resume_settings_tests;

#[cfg(test)]
mod agent_message_tests;

#[cfg(test)]
mod prompt_image_tests;

#[cfg(test)]
mod update_snapshot_tests;

#[cfg(test)]
mod tests;


#[cfg(test)]
mod turn_stream_tests;

#[cfg(test)]
mod replacement_gate_tests;

#[cfg(test)]
mod recovery_verdict_tests;

