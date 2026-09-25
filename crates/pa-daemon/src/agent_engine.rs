//! The real agent-session engine for daemon workers: a pa-core session over
//! the shared provider adapter, driven through the daemon's `SessionEngine`
//! contract. Replaces the scripted faux engine when a model is configured.
//!
//! Streaming note: assistant updates are forwarded to the worker's emit
//! callback as they arrive (one per provider stream event) while the turn
//! runs — never buffered until the turn settles — matching the TS daemon's
//! `void prompt(...)` live-broadcast behavior. The worker coalesces them
//! for broadcast (see `worker::run_turn`).

use std::sync::Arc;

use serde_json::{json, Value};

use crate::agent_messaging::{LinkAgentMessageController, LinkAgentObserveController};
use crate::model_allowlist::DaemonAllowlist;
use crate::overflow_compaction::{OverflowArmRun, OverflowRecovery};
use pa_agent::abort::AbortController;
use pa_agent::types::StopReason;
use pa_core::kernel::shared::HostRequestHandlers;
use pa_core::session_engine::agent_messaging::{
    register_agent_message_host_handlers, register_agent_observe_host_handlers,
};
use pa_core::session_engine::engine::{SessionEngine as CoreSessionEngine, SessionEngineConfig};
use pa_core::session_engine::provider_adapter::{
    json_round_trip, map_thinking_level, switchable_stream_fn, ProviderTarget,
};
use pa_core::session_engine::session_commands::{
    execute_session_command, SessionCommandExecution, SessionCommandParams,
};
use pa_types::ai::Model;

use crate::auto_compaction::AutoCompactionRun;
use crate::engine::{
    BranchSummaryOutcome, BranchSummaryRequest, BranchSummaryRun, CompactionOutcome,
    CompactionRequest, CompactionRun, EngineEvent, EngineModelSelection, PromptRequest,
    SessionEngine, SideQuestionOutcome, SideQuestionRequest,
};
use crate::goal_continuation::GoalBoundary;
use crate::rlm_children::{ParentIdentity, SupervisorChildSessions, DEFAULT_RLM_MAX_DEPTH};

/// Configuration for the real engine.
#[derive(Clone)]
pub struct AgentEngineConfig {
    pub cwd: std::path::PathBuf,
    pub agent_dir: std::path::PathBuf,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    /// Requested thinking level from the process-level fallback. The
    /// session's create command (`--thinking`) overrides it via
    /// [`SessionEngine::configure_model`].
    pub thinking: Option<pa_types::ai::ModelThinkingLevel>,
    /// Session persistence directory (JSONL sessions live under it).
    pub session_dir: Option<std::path::PathBuf>,
    /// Conversation-log path for the system prompt: the daemon worker owns
    /// the session file, so the in-session manager stays in-memory and the
    /// prompt reads the path from here.
    pub session_file: Option<std::path::PathBuf>,
    /// Verification seam: a scripted faux provider (`{"responses": [...]}`).
    /// Never set by the product.
    pub faux_script: Option<String>,
    /// Supervisor socket + own active session id for the worker's supervisor
    /// link. Present only inside a daemon worker; it enables the kernel's
    /// agent_message/agent_observe host requests.
    pub supervisor_link: Option<SupervisorLinkConfig>,
    /// Telemetry opt-out from the create command (Some(true) installs no
    /// telemetry; None/Some(false) resolve the configured sinks).
    pub telemetry_disabled: Option<bool>,
    /// The worker's kernel cron wiring (TS daemon-mode wires its
    /// `AgentCronJobStore.forSessionArtifacts()` into the session runtime):
    /// the shared scheduled-jobs store kernel `rlm_heartbeat.*` host
    /// requests read and write, so agent-created heartbeats reach the same
    /// catalog the `heartbeats_list` command reads and the scheduler fires.
    /// The binding is enriched per build from the worker's live/durable
    /// session identity.
    pub cron_store: Option<pa_core::session_engine::runtime_wiring::KernelCronWiring>,
    /// TS `_steeringStopPending` (the session's stop hooks): `true` while
    /// the worker's steering lane holds a queued item, so the running turn
    /// stops at the next turn boundary and the steer delivers as the next
    /// input (the follow-up lane never stops the run).
    pub queued_steering_probe: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
}

/// Supervisor-link coordinates for a daemon worker.
#[derive(Clone, Debug)]
pub struct SupervisorLinkConfig {
    pub socket_path: std::path::PathBuf,
    /// The worker's own active session id, stamped on outgoing messages so
    /// the supervisor can attribute them to this session.
    pub active_session_id: String,
    /// The worker's authentication token, presented on supervisor requests
    /// that act on this worker's behalf (worker-to-worker peer tickets).
    pub worker_token: String,
}

/// The worker's autonomous admission sink: a held threshold continuation's
/// text, queued into the worker's follow-up lane.
pub(crate) type AutonomousAdmission = std::sync::Arc<dyn Fn(String) + Send + Sync>;

/// The goal driver and session-manager handles mirrored from the core
/// session (see `AgentSessionEngine::goal_runtime`).
#[derive(Clone)]
pub(crate) struct GoalRuntimeHandles {
    pub(crate) driver:
        std::sync::Arc<tokio::sync::Mutex<pa_core::session_engine::goal_driver::GoalDriver>>,
    pub(crate) session:
        std::sync::Arc<tokio::sync::Mutex<pa_core::session::manager::SessionManager>>,
}

/// The session-model restore decision for one session file (TS
/// `createAgentSession`'s restored-from-session step): the model the
/// session's file pins, computed once at the create/replace seam through
/// the bounded catalog-readiness wait, or the on-the-record fallback when
/// the window missed (TS `modelFallbackMessage`). Scoped to
/// `session_file`: the resolution consults it only while the engine owns
/// that file, so a replacement flow recomputes its own instead of
/// silently keeping the previous session's pin.
#[derive(Clone)]
struct RestoredSessionModel {
    session_file: std::path::PathBuf,
    /// `None` when the restore missed after the readiness window.
    model: Option<(String, String)>,
    fallback_message: Option<String>,
}

/// The daemon-side adapter onto the engine's attribution producer: the
/// children registry's observation sites deliver per-origin batches
/// through this sink (pa-core owns the target row and the durable
/// append).
struct ProducerUsageSink(
    std::sync::Arc<pa_core::session_engine::rlm_usage::RlmChildUsageAttributions>,
);

impl pa_core::session_engine::rlm_usage::RlmChildUsageSink for ProducerUsageSink {
    fn record(
        &self,
        report: pa_core::session_engine::rlm_usage::RlmChildUsageReport,
    ) -> std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let producer = std::sync::Arc::clone(&self.0);
        Box::pin(async move {
            producer.record_child_usage(report).await;
        })
    }

    fn forget(
        &self,
        rlm_child_id: &str,
    ) -> std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let producer = std::sync::Arc::clone(&self.0);
        let rlm_child_id = rlm_child_id.to_string();
        Box::pin(async move {
            producer.forget_child(&rlm_child_id).await;
        })
    }
}

/// A [`SessionEngine`] running real agent turns.
pub struct AgentSessionEngine {
    pub(crate) runtime: crate::async_safe_runtime::AsyncSafeRuntime,
    pub(crate) config: AgentEngineConfig,
    /// The session-scoped ACP MCP store (TS `session._mcpManager`): shared
    /// with the core engine's prompt gating, so admitted servers are one
    /// store for admission and execution.
    pub(crate) mcp: std::sync::Arc<std::sync::Mutex<pa_core::mcp::McpManager>>,
    /// The last goal state emitted as a `goal_update` event: the TS session
    /// emits on state change, so unchanged states (e.g. `/goal status`)
    /// stay silent.
    pub(crate) published_goal: std::sync::Mutex<Option<pa_core::goals::GoalState>>,
    /// The session's goal driver and session-manager handles, mirrored from
    /// the core session at build time: the core session's own mutex is held
    /// across a turn's admission, so goal checks inside emit callbacks
    /// (which may run in async context) must not lock it.
    pub(crate) goal_runtime: std::sync::Mutex<Option<GoalRuntimeHandles>>,
    /// Whether this run's usage accounting crossed the goal's token budget
    /// (TS `_accountGoalUsageForAssistantMessage` returning `true` at the
    /// message_end hook): the natural boundary mints the budget-limit
    /// wrap-up steer and ends the run. Shared with the agent-loop
    /// subscription (a plain field cannot cross the 'static handler).
    pub(crate) goal_budget_crossed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The worker's session-input probe (TS `queuedActionCount > 0` plus
    /// the queued-input suspension): the goal continuation mint defers
    /// while it reports queued work.
    pub(crate) goal_input_probe: std::sync::Mutex<Option<crate::engine::SessionInputProbe>>,
    /// The worker's goal admission sink: minted goal follow-ups admit
    /// through the turn runner's queue lanes (steering for the budget
    /// steer, follow-up for the continuation).
    pub(crate) goal_admission_sink: std::sync::Mutex<Option<crate::engine::GoalAdmissionSink>>,
    /// The worker's queued-goal-context purge (TS
    /// `_clearQueuedGoalContexts`): invoked by the pause/clear/start
    /// session commands and the kernel `goal.complete` host request.
    pub(crate) goal_queue_purge: std::sync::Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    /// The worker's bash-completion queue seams (TS
    /// `_promptInjectedMessage`/`_withdrawAsyncBashCompletionNotice`):
    /// the `bash.completed` notice admits through the steering lane
    /// (queue-if-busy, resume-if-idle) and the `bash.consumed` notice
    /// withdraws its undelivered row. Set by the worker at construction;
    /// `None` outside a daemon worker (no queue to admit into).
    pub(crate) bash_completion_sink: std::sync::Mutex<Option<crate::engine::BashCompletionSink>>,
    pub(crate) bash_consumed_sink: std::sync::Mutex<Option<crate::engine::BashConsumedSink>>,
    /// The session's live agent handle (TS `AgentSession.agent`): the eager
    /// turn-abort funnel's target. Mirrored from the core session at build
    /// time for the same reason as the goal runtime handles — a running
    /// turn holds the core session's mutex across its admission, so an
    /// abort request from the worker must reach the agent's run controller
    /// without locking it.
    turn_agent: std::sync::Mutex<Option<std::sync::Arc<pa_agent::agent::Agent>>>,
    /// The session's queue delivery modes (TS `agent.steeringMode` /
    /// `agent.followUpMode`): seeded from the start config, applied to the
    /// built session's agent at build time, and switched live by the
    /// `set_steering_mode`/`set_follow_up_mode` commands (TS
    /// `setSteeringMode`/`setFollowUpMode` write the live agent). `None`
    /// keeps the TS default ("one-at-a-time"); the daemon's create seeds
    /// the settings value, whose steering default is "all".
    queue_modes: std::sync::Mutex<(Option<String>, Option<String>)>,
    /// The in-run autonomous consult's deadlock-free mirror (see
    /// [`crate::autonomous_continuation`]): the shared turn-boundary slot,
    /// agent, and compaction settings the consult reads without ever
    /// taking the session mutex — a compaction run holds that mutex
    /// across its model turn, and the consult runs inside one (an agent
    /// turn the loop drives mid-run).
    pub(crate) autonomous_boundary:
        std::sync::Mutex<Option<crate::autonomous_continuation::AutonomousBoundaryMirror>>,
    /// The worker-owned session file (conversation-log path), set at create.
    session_file: std::sync::Mutex<Option<std::path::PathBuf>>,
    /// The authoritative model selection. Starts from the process fallback
    /// (create config or worker env) and is re-bound when a session's create
    /// command carries explicit wire flags.
    selection: std::sync::RwLock<EngineModelSelection>,
    /// TS `createAgentSession`'s restored-from-session decision, scoped to
    /// the session file it was computed for: a revived session's saved
    /// model (or, after a missed restore window, the on-the-record
    /// fallback message — TS `modelFallbackMessage`). Computed once per
    /// file at the create/replace seam (the bounded readiness wait) and
    /// consulted by every unflagged resolution; a replacement flow that
    /// moves the worker onto another file recomputes its own (TS
    /// re-restores at every session boot), and an explicit create flag
    /// wins end-to-end (the decision is never consulted).
    restored_model: std::sync::Mutex<Option<RestoredSessionModel>>,
    /// The session runtime config the reset returns to at every session
    /// restore — TS `mergeAgentSessionRuntimeConfig(defaultSessionConfig,
    /// command.config)`: the spawn-time fallback (create config or worker
    /// env) folded with the create command's explicit flags. TS hands the
    /// same merged config down through every replacement (`switchSession`
    /// -> `createRuntime` -> `createAgentSession({ ...sessionConfig })`),
    /// so a mid-session `/model` switch belongs to the session it
    /// switched, never to the moved-to one, while the create's own flags
    /// survive every replacement.
    initial_selection: std::sync::RwLock<EngineModelSelection>,
    /// The session's resolved effective thinking level, computed once when
    /// the create command adopts the selection and reused afterwards.
    /// Resolved at create time (before any turn) so summary/state polls
    /// during a live turn stay side-effect-free.
    effective_thinking: std::sync::RwLock<Option<pa_types::ai::ModelThinkingLevel>>,
    service_tier: std::sync::RwLock<Option<pa_types::ai::ServiceTier>>,
    /// Built once on the first prompt, reused across prompts, shared
    /// behind an Arc: a running model turn (the admission in
    /// `run_turn_once`), a compaction summarizer, and a refinement run
    /// clone the Arc and release this mutex before their long awaits, so
    /// every read seam (`system_prompt`, `tool_definition`,
    /// `connection_commands`, `resource_snapshot`, ...) answers while a
    /// turn streams — the TS bar, where the daemon-mode
    /// `get_system_prompt` arm reads `session.systemPrompt` on the same
    /// event loop that streams the turn and the provider awaits yield to
    /// it. Short critical sections only: no model call may hold this
    /// mutex.
    pub(crate) session: tokio::sync::Mutex<Option<Arc<CoreSessionEngine>>>,
    /// The session-build gate: at most one `build_session` in flight. The
    /// eager create-time build (TS parity: the prewarm starts at create)
    /// races the first demand seam; the guard makes them meet at one
    /// build instead of constructing two sessions.
    pub(crate) session_build: tokio::sync::Mutex<()>,
    /// A branch move (tree navigation or fork) that landed before the first
    /// turn built the session: consumed at build so the session starts on
    /// the moved branch (TS rebuilds context from the durable branch).
    pending_branch: std::sync::Mutex<Option<Vec<pa_types::session::FileEntry>>>,
    /// The `goal_update` payload a live branch rebuild's goal reload
    /// stashed (TS `_emitGoalUpdate` at `_reloadGoalStateFromBranch`):
    /// published against the dedupe baseline while the driver lock is
    /// held, taken by the worker that announces it. `None` when the
    /// reload changed nothing.
    reloaded_goal_update: std::sync::Mutex<Option<Value>>,
    /// The provider target the built session's stream reads per call
    /// (api key + model), set when the session builds: `set_model` swaps
    /// the slot so the live session follows the new model without a
    /// rebuild.
    provider_target: std::sync::Arc<
        std::sync::RwLock<Option<pa_core::session_engine::provider_adapter::ProviderTarget>>,
    >,
    /// One shared supervisor-link client for the worker: agent messaging
    /// and supervisor-backed RLM children multiplex the same connection
    /// (the TS worker's single `SupervisorLink` socket). Unconnected until
    /// the first request; standalone workers never use it.
    link: Arc<crate::supervisor_link::SupervisorLink>,
    /// Supervisor-backed RLM children; `None` for standalone workers.
    pub(crate) children: Option<Arc<SupervisorChildSessions>>,
    /// The attribution producer the children registry's sink last got:
    /// the session's live children outlive an engine rebuild, and their
    /// spawn registrations live on the producer of the build that
    /// spawned them — every rebuild adopts them forward before the new
    /// sink starts observing.
    usage_producer: std::sync::Mutex<
        Option<std::sync::Arc<pa_core::session_engine::rlm_usage::RlmChildUsageAttributions>>,
    >,
    /// This worker's own session summary (worker-pushed at create/rename),
    /// read by the kernel messaging controller to render sender identity.
    own_summary: std::sync::Arc<std::sync::Mutex<Option<Value>>>,
    /// The session's autonomous runtime state (limits, usage accounting).
    /// Shared with the agent-loop subscription so per-message accounting can
    /// run on every settled assistant message.
    pub(crate) autonomous:
        std::sync::Arc<tokio::sync::Mutex<pa_core::autonomous::AutonomousRuntimeState>>,
    /// The autonomous continuation policy the turn loop consults after
    /// every settled turn. Product default: the shell-gate driver in the
    /// session cwd; deterministic harnesses replace it through
    /// [`AgentSessionEngine::set_autonomous_driver`].
    pub(crate) autonomous_driver:
        std::sync::RwLock<std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>>,
    /// Whether `autonomous_driver` still holds the product default (no
    /// harness replaced it): a cwd rebind swaps the default shell driver
    /// (it runs in the session cwd) but must keep an injected one.
    autonomous_driver_default: std::sync::atomic::AtomicBool,
    /// The continuation the in-run hook's threshold arm minted ahead of the
    /// boundary's compaction (TS
    /// `_queueAutonomousContinuationForThresholdCompaction`): held for the
    /// queued `followUp` admission the turn loop hands to the worker's
    /// queue lanes once the boundary arms ran.
    pub(crate) held_autonomous_continuation: std::sync::Mutex<Option<String>>,
    /// The worker's autonomous admission sink: the turn loop hands the held
    /// continuation to it at the settled boundary (the worker queues it in
    /// the follow-up lane and wakes the turn runner).
    pub(crate) autonomous_admission: std::sync::Mutex<Option<AutonomousAdmission>>,
    /// Whether the in-run hook deferred the natural continuation behind
    /// unsettled RLM descendant work (TS `_autonomousContinuationAwaitsRlmWork`):
    /// the children registry's settle hook delivers the owed continuation.
    pub(crate) autonomous_awaits_rlm_work: std::sync::atomic::AtomicBool,
    /// The session's closed marker (TS `_disposed`/`_disposing`): set by
    /// the worker's kill/shutdown closes. The goal and autonomous
    /// continuation mint sites and their settle-hook retries bail instead
    /// of continuing a stopped session — no continuation, no mint, no
    /// goal-state churn (the zombie fix: a stopped session stays
    /// stopped). The create path clears it: a fresh (or replaced) session
    /// starts live.
    pub(crate) session_closed: std::sync::atomic::AtomicBool,
    /// The engine's own arc, registered by the worker after construction:
    /// the in-run autonomous continuation hook upgrades the weak so the
    /// agent's loop never pins the engine (the goal seam's pattern, held
    /// by the worker's queue instead).
    pub(crate) self_weak: std::sync::Mutex<Option<std::sync::Weak<AgentSessionEngine>>>,
    /// The worker's queue purge for held autonomous continuations (TS
    /// `_clearQueuedAutonomousContinuations`): `/autonomous off` withdraws
    /// the queued `followUp` item the threshold arm admitted.
    pub(crate) autonomous_queue_purge:
        std::sync::Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    /// The session's live working directory (TS the runtime's `cwd`, rebuilt
    /// per replacement): seeds the core session build (the kernel-resident
    /// tools run there), the settings reads, and the MCP settings
    /// discovery. Shared with the MCP user-servers closure so a
    /// [`SessionEngine::set_cwd`] rebind is visible to it.
    cwd: std::sync::Arc<std::sync::RwLock<std::path::PathBuf>>,
    /// This session's RLM recursion depth (0 for top-level sessions),
    /// stamped by `configure_rlm_identity`. Gates the kernel `refine.*`
    /// host requests (TS `_autoRefineAllowedForSession` depth check).
    rlm_depth: std::sync::atomic::AtomicU32,
    /// The RLM depth bound's TS source stamp (`default` | `env` | `global`
    /// | `inherited` | `chat`), seeded by `configure_rlm_identity` (the
    /// TS `_resolveRlmMaxDepth` precedence) and flipped to `chat` by a
    /// `set_rlm_max_depth` override.
    rlm_max_depth_source: std::sync::Mutex<&'static str>,
    /// A `set_rlm_max_depth` that landed before the first turn built the
    /// session: the durable `rlm_max_depth_state` custom entry parks here
    /// and flushes at build, exactly the `pending_branch` pattern.
    pending_max_depth: std::sync::Mutex<Option<u64>>,
    /// The resolved faux model, registered once per engine so scripted
    /// responses queue across turns instead of replaying per resolution.
    /// Verification harness only; never set by the product.
    faux_model: std::sync::OnceLock<Model>,
    /// One compact-and-retry attempt per context overflow (TS
    /// `_overflowRecovery`): the state machine the overflow arm walks.
    pub(crate) overflow_recovery: std::sync::Mutex<OverflowRecovery>,
    /// The live automatic-compaction abort slot (TS
    /// `_autoCompactionAbortController`): the threshold and requested
    /// turn-boundary runs each register their controller here for the
    /// run's duration, and [`SessionEngine::abort_auto_compaction`]
    /// aborts whatever run holds it.
    pub(crate) auto_compaction_abort: std::sync::Mutex<Option<std::sync::Arc<AbortController>>>,
    /// The daemon model-allowlist refusal telemetry (`model refused`),
    /// shared with the RLM children host so every enforcement seam in
    /// this worker emits through one lazily-built client.
    pub(crate) model_refusal_telemetry:
        std::sync::Arc<crate::model_allowlist::ModelRefusalTelemetry>,
}

impl AgentSessionEngine {
    pub fn new(config: AgentEngineConfig) -> anyhow::Result<Self> {
        let runtime = crate::async_safe_runtime::AsyncSafeRuntime::new_multi_thread()?;
        let session_file = std::sync::Mutex::new(config.session_file.clone());
        // Process-level fallback: the create config, else the worker env
        // pair. A create command with explicit wire flags overrides both.
        let thinking = config.thinking;
        let selection = if config.provider.is_some() || config.model.is_some() {
            EngineModelSelection {
                provider: config.provider.clone(),
                model: config.model.clone(),
                api_key: config.api_key.clone(),
                thinking,
            }
        } else {
            EngineModelSelection {
                provider: std::env::var("PRIME_AGENT_MODEL_PROVIDER").ok(),
                model: std::env::var("PRIME_AGENT_MODEL").ok(),
                api_key: None,
                thinking,
            }
        };
        // One shared supervisor-link client for the worker: agent messaging
        // and supervisor-backed RLM children multiplex the same connection
        // (the TS worker's single `SupervisorLink` socket).
        let link = Arc::new(crate::supervisor_link::SupervisorLink::new(
            config
                .supervisor_link
                .as_ref()
                .map(|link_config| link_config.socket_path.clone())
                .unwrap_or_default(),
        ));
        let model_refusal_telemetry =
            std::sync::Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
                config.agent_dir.clone(),
                config.telemetry_disabled == Some(true),
            ));
        let children = config.supervisor_link.as_ref().map(|link_config| {
            Arc::new(SupervisorChildSessions::new(
                Arc::clone(&link),
                config.agent_dir.clone(),
                link_config.active_session_id.clone(),
                std::sync::Arc::clone(&model_refusal_telemetry),
            ))
        });
        let autonomous_driver = std::sync::RwLock::new(std::sync::Arc::new(
            pa_core::autonomous::ShellAutonomousDriver::new(config.cwd.clone()),
        )
            as std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>);
        let cwd = std::sync::Arc::new(std::sync::RwLock::new(config.cwd.clone()));
        // The ACP MCP store (auth storage construction is blocking; the
        // engine construction paths are already off the hot async paths).
        let agent_dir = config.agent_dir.clone();
        // Settings-declared user servers feed the store this worker owns
        // (TS `session._mcpManager` resolves user settings; the
        // `mcp.config` host request answers from them). Read per resolve
        // so `mcp.refresh` - which re-resolves integrations - sees
        // settings changes, mirroring the in-process engine's
        // `mcp_gating` extraction (agentDir + project settings.json).
        let mcp_cwd = std::sync::Arc::clone(&cwd);
        let mcp_agent_dir = agent_dir.clone();
        let catalog_cwd = std::sync::Arc::clone(&cwd);
        let catalog_agent_dir = agent_dir.clone();
        let mcp = pa_core::mcp::McpManager::new(pa_core::mcp::McpManagerOptions {
            auth_storage: pa_core::auth::AuthStorage::create_with_oauth(
                &agent_dir,
                std::sync::Arc::new(pa_core::mcp::McpOAuth::new()),
            ),
            get_user_servers: Box::new(move || {
                // The live cwd slot, not the construction-time cwd: the
                // rebind (a switched-to session in another directory) must
                // reach the MCP settings discovery (TS rebuilds the runtime's
                // MCP manager per replacement).
                let mcp_cwd = mcp_cwd.read().expect("engine cwd lock").clone();
                let settings = pa_core::settings::SettingsManager::create(&mcp_cwd, &mcp_agent_dir);
                Some(
                    settings
                        .settings()
                        .mcp_servers
                        .clone()
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|(server, server_config)| {
                            serde_json::from_value(server_config)
                                .ok()
                                .map(|parsed| (server, parsed))
                        })
                        .collect::<std::collections::HashMap<
                            String,
                            pa_core::mcp::McpServerConfig,
                        >>(),
                )
            }),
            begin_login: None,
            agent_dir: Some(agent_dir),
            get_catalog_sources: Some(Box::new(move || {
                // Declared local service-catalog sources (TS
                // `settingsManager.getMcpCatalogSources()`), re-read per
                // resolve so settings changes reach the next refresh.
                let catalog_cwd = catalog_cwd.read().expect("engine cwd lock").clone();
                let settings =
                    pa_core::settings::SettingsManager::create(&catalog_cwd, &catalog_agent_dir);
                settings
                    .settings()
                    .mcp_catalog_sources
                    .clone()
                    .unwrap_or_default()
            })),
            remote_source: None,
            probe_override: None,
        });
        // The kernel's `mcp.begin_login` host request: the worker runs the
        // OAuth login (browser + local callback) and persists the
        // endpoint-bound credential the shared auth store gates on. Wired
        // before any session registers host handlers, so every session the
        // worker builds exposes it.
        let mcp = std::sync::Arc::new(std::sync::Mutex::new(mcp));
        crate::mcp_login::wire_worker_mcp_login(
            &mcp,
            std::sync::Arc::new(crate::mcp_login::WorkerMcpLoginUi::from_env()),
            std::sync::Arc::new(pa_core::mcp::ReqwestOAuthHttp::new()),
        );
        // The queue delivery modes arrive at session create (TS `sdk.ts`
        // builds the agent with the settings modes; the worker's create
        // seeds them through `set_queue_modes`), so the engine starts
        // unseeded (None keeps the TS default "one-at-a-time" until the
        // create writes the settings modes — steering "all" by default).
        let queue_modes = std::sync::Mutex::new((None, None));
        Ok(Self {
            runtime,
            config,
            mcp,
            published_goal: std::sync::Mutex::new(None),
            goal_runtime: std::sync::Mutex::new(None),
            goal_budget_crossed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            goal_input_probe: std::sync::Mutex::new(None),
            goal_admission_sink: std::sync::Mutex::new(None),
            bash_completion_sink: std::sync::Mutex::new(None),
            bash_consumed_sink: std::sync::Mutex::new(None),
            goal_queue_purge: std::sync::Mutex::new(None),
            turn_agent: std::sync::Mutex::new(None),
            queue_modes,
            autonomous_boundary: std::sync::Mutex::new(None),
            session_file,
            selection: std::sync::RwLock::new(selection.clone()),
            restored_model: std::sync::Mutex::new(None),
            initial_selection: std::sync::RwLock::new(selection),
            effective_thinking: std::sync::RwLock::new(None),
            service_tier: std::sync::RwLock::new(None),
            session: tokio::sync::Mutex::new(None),
            session_build: tokio::sync::Mutex::new(()),
            pending_branch: std::sync::Mutex::new(None),
            provider_target: std::sync::Arc::new(std::sync::RwLock::new(None)),
            own_summary: std::sync::Arc::new(std::sync::Mutex::new(None)),
            autonomous: std::sync::Arc::new(tokio::sync::Mutex::new(
                pa_core::autonomous::create_autonomous_runtime_state(None, None),
            )),
            link,
            children,
            usage_producer: std::sync::Mutex::new(None),
            autonomous_driver,
            autonomous_driver_default: std::sync::atomic::AtomicBool::new(true),
            held_autonomous_continuation: std::sync::Mutex::new(None),
            autonomous_admission: std::sync::Mutex::new(None),
            autonomous_awaits_rlm_work: std::sync::atomic::AtomicBool::new(false),
            session_closed: std::sync::atomic::AtomicBool::new(false),
            self_weak: std::sync::Mutex::new(None),
            autonomous_queue_purge: std::sync::Mutex::new(None),
            cwd,
            rlm_depth: std::sync::atomic::AtomicU32::new(0),
            rlm_max_depth_source: std::sync::Mutex::new("default"),
            pending_max_depth: std::sync::Mutex::new(None),
            reloaded_goal_update: std::sync::Mutex::new(None),
            faux_model: std::sync::OnceLock::new(),
            overflow_recovery: std::sync::Mutex::new(OverflowRecovery::default()),
            auto_compaction_abort: std::sync::Mutex::new(None),
            model_refusal_telemetry,
        })
    }

    /// Replace the autonomous continuation policy. Deterministic eval
    /// harnesses inject a scripted driver here; the product keeps the
    /// default shell-gate driver in the session cwd. Call before the
    /// first admitted turn.
    pub fn set_autonomous_driver(
        &self,
        driver: std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>,
    ) {
        self.autonomous_driver_default
            .store(false, std::sync::atomic::Ordering::Relaxed);
        *self
            .autonomous_driver
            .write()
            .expect("autonomous driver lock") = driver;
    }

    /// The session's live working directory (the engine's cwd slot).
    fn cwd(&self) -> std::path::PathBuf {
        self.cwd.read().expect("engine cwd lock").clone()
    }

    /// Expand a `/skill:<name>` submission for the accepted-turn user row
    /// (TS `_normalizeSubmission` persists the expanded text as the user
    /// message): build the core session when needed (it loads the skill
    /// inventory), then expand against it. Non-skill inputs and build
    /// failures pass the text through unchanged — the turn then surfaces
    /// the failure it would have surfaced anyway.
    pub(crate) fn expand_skill_submission(&self, text: &str) -> String {
        let Ok(model) = self.resolve_model() else {
            return text.to_string();
        };
        if let Err(error) = self.ensure_core_session(&model) {
            eprintln!("skill submission expansion skipped: session build failed: {error:#}");
            return text.to_string();
        }
        self.runtime.block_on(async {
            let guard = self.session.lock().await;
            match guard.as_deref() {
                Some(engine) => engine.expand_skill_submission(text),
                None => text.to_string(),
            }
        })
    }

    /// The async build of the core session (the same funnel as
    /// `ensure_core_session`, awaited on the caller's runtime instead of
    /// parked on the engine's own): read seams (`get_system_prompt`)
    /// reaching an unbuilt session build it here. The build gate makes the
    /// eager create-time build and every demand seam meet at one build.
    pub(crate) async fn ensure_core_session_async(&self, model: &Model) -> anyhow::Result<()> {
        let _build = self.session_build.lock().await;
        {
            let guard = self.session.lock().await;
            if guard.is_some() {
                return Ok(());
            }
        }
        let built = self.build_session(model).await?;
        self.adopt_built_session(&built).await?;
        self.session.lock().await.replace(Arc::new(built));
        Ok(())
    }

    /// Post-build adoption, shared by every build path (the async funnel
    /// and the turn-driven `session_agent` build): mirror the goal
    /// runtime, flush a depth override that landed before the build, and
    /// consume a parked replacement branch. A replacement flow retires
    /// the built session (see [`Self::retire_session_runtime`]) and parks
    /// the moved branch in `pending_branch`; whichever build path runs
    /// first must adopt it, or a read-seam build would strand the parked
    /// branch and the session would start off the moved branch's entries.
    async fn adopt_built_session(&self, built: &CoreSessionEngine) -> anyhow::Result<()> {
        self.mirror_goal_runtime(built);
        // The in-run consult's mirror (deadlock-free reads: the session
        // mutex is held across compaction model turns, and the consult
        // runs inside one of them).
        *self
            .autonomous_boundary
            .lock()
            .expect("autonomous boundary lock") =
            Some(crate::autonomous_continuation::AutonomousBoundaryMirror {
                turn_boundary: std::sync::Arc::clone(&built.turn_boundary),
                agent: std::sync::Arc::clone(built.session.agent()),
                compaction: *built.session.compaction_settings(),
            });
        // The in-run autonomous continuation hook (the natural mint rides
        // the agent loop; the goal seam keeps its own boundary mint).
        self.install_autonomous_continuation_hook_on(built.session.agent());
        // The children registry's usage observation feeds the engine's
        // attribution producer (TS `flushPendingChildUsageAttribution`'s
        // Rust seam): one sink per build. The session's live children are
        // separate worker processes that OUTLIVE the rebuild — their
        // spawns were registered on the previous build's producer, so
        // adopt those registrations forward before the new sink starts
        // observing, or the first post-swap report drops against a
        // producer that never saw the spawn.
        if let Some(children) = &self.children {
            let retired = self
                .usage_producer
                .lock()
                .expect("usage producer lock")
                .take();
            if let Some(retired) = retired {
                built.rlm_usage.adopt_registrations(&retired).await;
            }
            children.set_usage_sink(std::sync::Arc::new(ProducerUsageSink(
                std::sync::Arc::clone(&built.rlm_usage),
            )));
            *self.usage_producer.lock().expect("usage producer lock") =
                Some(std::sync::Arc::clone(&built.rlm_usage));
        }
        // The eager-abort target rides the same mirror (see
        // [`Self::turn_agent`]).
        *self.turn_agent.lock().expect("turn agent lock") =
            Some(std::sync::Arc::clone(built.session.agent()));
        // A `set_rlm_max_depth` that landed before the build parks its
        // durable entry; the built session owns the store now.
        {
            let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
            if let Some(handles) = handles {
                let mut manager = handles.session.lock().await;
                self.flush_pending_max_depth(&mut manager);
            }
        }
        // A branch move that landed before the first turn built the
        // session (tree navigation/fork/replacement with no turn yet)
        // re-seeds the session onto the moved branch.
        let pending_branch = self
            .pending_branch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // Rehydrate the goal driver from the durable store (TS
        // constructor: `this._goalState = this._loadPersistedGoalState()`
        // reads the same session rows `_persistGoalState` wrote). A moved
        // branch's own latest entry wins (faithful branch semantics); the
        // worker-owned session file answers otherwise. The seed also sets
        // the published baseline so the rehydrated state never announces
        // itself (TS loads at construction without emitting).
        let seed = if let Some(entries) = &pending_branch {
            crate::goal_state_persist::goal_state_in_branch(entries)
        } else {
            let path = self
                .session_file
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            tokio::task::spawn_blocking(move || {
                crate::goal_state_persist::persisted_goal_state(path.as_deref())
            })
            .await?
        };
        if let Some(state) = seed {
            let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
            if let Some(handles) = handles {
                let mut driver = handles.driver.lock().await;
                driver.restore_from_persisted(state.clone());
            }
            *self.published_goal.lock().expect("published goal lock") = Some(state);
        }
        if let Some(entries) = pending_branch {
            built.session.rebuild_branch_context(entries).await?;
            return Ok(());
        }
        // Restore the retained context and certified metadata without loading
        // discarded message bodies. Unsupported files use the ordinary reader.
        let session_file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(path) = session_file {
            let (window, branch) = tokio::task::spawn_blocking(move || {
                match pa_core::session::window::WindowedSessionStore::open(&path) {
                    Ok(Some(window)) => (Some(window), None),
                    Ok(None) | Err(_) => (
                        None,
                        crate::session_store::SessionFile::open(&path)
                            .ok()
                            .map(|store| store.branch_file_entries()),
                    ),
                }
            })
            .await?;
            if let Some(window) = window {
                built.session.restore_windowed_context(window).await;
                // This worker holds the session's runtime lease for the
                // engine's lifetime: its durable appends may certify the
                // window cache incrementally (exactly one writer per
                // lease), and the lease's release flushes the certified
                // snapshot to the sidecar for the next warm open.
                built
                    .session
                    .shared_persistence()
                    .lock()
                    .await
                    .set_append_ownership(
                        pa_core::session::window::AppendOwnership::SessionLeaseHeld,
                    );
            } else if let Some(entries) = branch.filter(|entries| !entries.is_empty()) {
                built.session.rebuild_branch_context(entries).await?;
            }
        }
        Ok(())
    }

    /// The TS replacement teardown (`teardownForReplacement` ->
    /// `teardownCurrent` -> `session.disposeAsync()`): retire the live
    /// runtime so the next demand seam rebuilds a fresh session against
    /// the moved session file. The built session's kernel disposes first -
    /// one final namespace snapshot flush, drained host requests, then the
    /// process exits; a kernel that survived here would carry the old
    /// session's namespace into what TS treats as a new session - and the
    /// built session drops together with its mirrored goal handles and the
    /// last published goal state (a read before the next build reports
    /// the fresh runtime's empty state, not the retired session's). The
    /// build gate is held across the teardown so no racing demand seam
    /// rebuilds mid-dispose; the kernel dispose happens after the session
    /// is taken, so the fresh build it enables starts from nothing.
    pub(crate) async fn retire_session_runtime(&self) {
        let _build = self.session_build.lock().await;
        let built = self.session.lock().await.take();
        *self.goal_runtime.lock().expect("goal runtime lock") = None;
        *self.turn_agent.lock().expect("turn agent lock") = None;
        *self
            .autonomous_boundary
            .lock()
            .expect("autonomous boundary lock") = None;
        *self.published_goal.lock().expect("published goal lock") = None;
        // The retired session's provider target goes with it: a demand
        // seam before the replacement build (an immediate `/compact`)
        // must resolve the CURRENT model through the pre-build
        // `resolve_model` fallback, not rebuild on the retired session's
        // target while a cwd/settings change waits for the prewarm.
        *self.provider_target.write().expect("provider target lock") = None;
        if let Some(engine) = built {
            // The session's telemetry ends with it (the TS dispose
            // callback the replacement teardown runs); best-effort like
            // every end path, a failed flush never fails the teardown.
            if let Some(telemetry) = &engine.telemetry {
                let _ = telemetry.end().await;
            }
            engine.dispose_kernel().await;
        }
    }

    /// Tear the built session's kernel down (TS `closeSession` ->
    /// `AgentSessionRuntime.dispose` -> `AgentSession.disposeAsync` ->
    /// `IpythonKernelProvisioner.dispose`: one final namespace snapshot,
    /// drained host requests, then the `python -m rlm.repl` process exits).
    ///
    /// The engine object survives the call: the worker process outlives its
    /// session, so the engine-drop teardown (the strong owner of the
    /// provisioner going away) cannot run yet. This is the explicit seam the
    /// worker invokes at every session end — kill, shutdown, the orphan
    /// exit — so the kernel process never outlives the session that owns it.
    pub async fn dispose_kernel(&self) {
        let guard = self.session.lock().await;
        if let Some(engine) = guard.as_deref() {
            engine.dispose_kernel().await;
        }
    }

    /// Mark the session closed (TS `runtime.dispose`'s `_disposing`/`_disposed`
    /// gates) and retire the closed runtime's continuation mirrors: the
    /// worker's kill, shutdown, and replacement closes set it first, so
    /// every continuation mint site and settle-hook retry bails — a stopped
    /// session never continues (no mint, no goal-state churn, no queued
    /// follow-up a later wake could run). The mirrors go with the marker:
    /// the engine object outlives the close (the worker process may be
    /// reused for a fresh create), and a stale settle callback must find
    /// no goal runtime to mint through — the owed slot itself survives
    /// the close in the durable state for a later resumed session.
    pub fn mark_session_closed(&self) {
        self.session_closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        *self.goal_runtime.lock().expect("goal runtime lock") = None;
        *self
            .autonomous_boundary
            .lock()
            .expect("autonomous boundary lock") = None;
    }

    /// The create path's live reset: a fresh (or replaced) session starts
    /// live (TS's fresh runtime starts un-disposed).
    pub fn clear_session_closed(&self) {
        self.session_closed
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether the session is closed (TS `this._disposed || this._disposing`
    /// in the continuation resume sites).
    pub fn session_is_closed(&self) -> bool {
        self.session_closed
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Session-scoped kernel shell activity; never builds a new session/kernel.
    pub async fn bash_activity(
        &self,
        action: &str,
        activity_id: Option<&str>,
        lines: usize,
    ) -> anyhow::Result<Value> {
        let engine = self
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Kernel is not running"))?;
        engine.bash_activity(action, activity_id, lines).await
    }

    /// Build the core session once (same once-only rule as `session_agent`),
    /// through the same guarded funnel.
    pub(crate) fn ensure_core_session(&self, model: &Model) -> anyhow::Result<()> {
        self.runtime
            .block_on(async { self.ensure_core_session_async(model).await })
    }

    /// Execute one session slash command against the built session: resolve
    /// the model, build the core session on first use, then run the pa-core
    /// executor (durable rows, compaction, goal continuation).
    pub(crate) fn execute_session_command(
        &self,
        command: &pa_core::session_engine::slash_commands::SessionSlashCommand,
    ) -> anyhow::Result<SessionCommandExecution> {
        // The session's live model (`/compact` runs a summarizer call):
        // the provider target the turn stream reads, not a fresh
        // startup-chain resolution (R8).
        let model = self.session_model()?;
        self.ensure_core_session(&model)?;
        let api_key = self.resolve_request_api_key(&model);
        let mut autonomous = self.autonomous.blocking_lock();
        let mut params = SessionCommandParams {
            model: &model,
            api_key,
            global_harness_dir: self.config.agent_dir.clone(),
            autonomous: &mut autonomous,
        };
        // The lock covers the clone only (see `run_turn_once`): a
        // session command can run a summarizer model call (`/compact`),
        // so holding the mutex across the execution serialized every
        // client read seam behind it.
        let core = self
            .session
            .blocking_lock()
            .clone()
            .expect("session built by ensure_core_session");
        Ok(self
            .runtime
            .block_on(async { execute_session_command(&core, &mut params, command).await }))
    }

    /// The current explicit selection (create-config flags merged over the
    /// process fallback).
    fn current_selection(&self) -> EngineModelSelection {
        self.selection.read().expect("model selection lock").clone()
    }

    /// The TS `createAgentSession` startup chain (the no-flagged-model
    /// arm of [`Self::resolve_registry_model`]): the saved settings
    /// default, then the featured default, then the first available
    /// model — resolved against `registry`'s current view.
    fn startup_chain_model(&self, registry: &pa_core::models::ModelRegistry) -> Option<Model> {
        let available: Vec<Model> = registry.get_available().into_iter().cloned().collect();
        let all: Vec<Model> = registry.get_all().to_vec();
        let settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        pa_core::models::find_initial_model(&pa_core::models::InitialModelOptions {
            cli_provider: None,
            cli_model: None,
            scoped_models: &[],
            is_continuing: false,
            default_provider: settings.get_default_provider(),
            default_model_id: settings.get_default_model(),
            all_models: &all,
            available_models: &available,
        })
        .or_else(|| all.first().cloned())
    }

    /// The runtime-config reset at every session restore (TS
    /// `switchSession` -> `createRuntime` -> `createAgentSession`): the
    /// session's model selection returns to the session runtime config
    /// (the spawn-time fallback folded with the create command's explicit
    /// flags, TS's merged `sessionConfig`), so a mid-session `/model`
    /// switch belongs to the session it switched and never to the
    /// moved-to one — whose own file pins what it should run on.
    ///
    /// The cached thinking level is always dropped: it was computed
    /// against the dropped selection (or the previous session's restored
    /// model). TS `createAgentSession` resolves the model first and
    /// clamps the thinking level against it, so the clamp must follow the
    /// resolution the moved-to session actually runs on — the restore
    /// re-resolves the level once it has recorded its decision, and the
    /// first read after a flagged reset (an explicit selection the
    /// restore returns early for) resolves lazily against that selection.
    fn reset_selection_to_spawn_fallback(&self) {
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = None;
        {
            let initial = self
                .initial_selection
                .read()
                .expect("initial selection lock")
                .clone();
            let mut current = self.selection.write().expect("model selection lock");
            if current.provider == initial.provider
                && current.model == initial.model
                && current.api_key == initial.api_key
                && current.thinking == initial.thinking
            {
                return;
            }
            *current = initial;
        }
    }

    /// The create-time session-model restore (see
    /// [`SessionEngine::restore_session_model`]): reset the selection to
    /// the spawn-time fallback (the TS runtime-config reset), read the
    /// session file's saved model context, give the in-flight
    /// catalog/auth refreshes the bounded readiness window, and record
    /// the decision for this file. Explicit spawn flags win (TS
    /// `options.model`); a session with no saved model keeps the startup
    /// chain; a restore that still misses after the window records the
    /// fallback (`model_fallback_message`, never silent).
    async fn restore_session_model_at(&self, session_path: &std::path::Path) {
        // An unpersisted session (an in-memory fork or a no-session
        // worker's replacement) has no file to read: TS restores its
        // branch context, whose `model_change` row is the live branch's
        // own — the model the session already runs on — so the
        // runtime-config reset must not run with nothing to restore.
        if session_path.as_os_str().is_empty() {
            return;
        }
        self.reset_selection_to_spawn_fallback();
        // TS `buildSessionContext()`: the session file pins the model it
        // last ran on and the thinking level it last set. The scan is
        // plain file work on a potentially large session file — park it
        // on a blocking thread.
        let path = session_path.to_path_buf();
        let Ok(saved) = tokio::task::spawn_blocking(move || saved_session_context(&path)).await
        else {
            return;
        };
        let Some(saved) = saved else {
            return;
        };
        // TS `createAgentSession` re-reads the session's saved thinking
        // level at every boot (`hasThinkingEntry ?
        // existingSession.thinkingLevel` — sdk.ts) when the runtime config
        // carries no explicit flag: the moved-to session's pinned level
        // wins over the settings/medium default. The level re-clamps
        // against the model below (the reset dropped the cache).
        if self.current_selection().thinking.is_none() {
            if let Some(level) = saved.thinking {
                self.configure_model(EngineModelSelection {
                    thinking: Some(level),
                    ..Default::default()
                });
            }
        }
        // An explicit create flag wins for the MODEL (TS `options.model`)
        // — the saved thinking above still applies, then the restore skips
        // the model's readiness window entirely.
        if self.current_selection().model.is_some() {
            return;
        }
        let Some((provider, model_id)) = saved.model else {
            return;
        };
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        registry.load_private_authorization_from_cache();
        let restored = pa_core::models::find_session_model_with_readiness_wait(
            &mut registry,
            &provider,
            &model_id,
            pa_core::models::SESSION_MODEL_RESTORE_READINESS_TIMEOUT_MS,
        )
        .await;
        let (model, fallback_message) = if let Some(restored) = restored {
            (Some((restored.provider, restored.id)), None)
        } else {
            // The TS `modelFallbackMessage`: the restore miss is on the
            // record — the startup chain owns the session, and the
            // summary publishes what happened (never silent).
            let fallback = self.startup_chain_model(&registry);
            let message = match &fallback {
                Some(fallback) => format!(
                    "Could not restore model {provider}/{model_id}. Using {}/{}",
                    fallback.provider, fallback.id
                ),
                None => format!("Could not restore model {provider}/{model_id}"),
            };
            eprintln!("{message}");
            (None, Some(message))
        };
        *self
            .restored_model
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(RestoredSessionModel {
            session_file: session_path.to_path_buf(),
            model,
            fallback_message,
        });
        // The decision is on the record now, so the level must resolve
        // against the model this session actually runs on (the restored
        // pin, or the startup chain after a missed window) — TS
        // `createAgentSession` resolves the model first and clamps the
        // thinking level against it. A concurrent summary/roster read may
        // have populated the cache against the startup chain while the
        // restore was still awaiting: drop the cache once more so the
        // post-decision resolution wins for every later reader (the reset
        // dropped it too, but the window in between is concurrent).
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = None;
        let _ = self.effective_thinking();
    }

    /// The restored-from-session resolution for the engine's current
    /// session file (TS `createAgentSession`'s restored-from-session
    /// step): a decision computed for this file resolves its pinned model
    /// through the same exact-match path a flagged selection takes — a
    /// catalog flap rebuilds the private route template on the same id
    /// (`build_fallback_model`), never silently drifting to the featured
    /// default. A decision for another file (a replacement flow that has
    /// not recomputed yet) is ignored.
    fn restored_model_resolution(
        &self,
        registry: &pa_core::models::ModelRegistry,
    ) -> Option<Model> {
        let decision = self
            .restored_model
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        let (provider, model_id) = decision.model?;
        let current = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        if decision.session_file != current {
            return None;
        }
        pa_core::models::resolve_cli_model(Some(&provider), &model_id, registry.get_all()).model
    }

    /// Emit the daemon model-allowlist refusal's adoption event (schema
    /// v1 `model refused`) from any of this worker's enforcement seams.
    /// The telemetry binds to the engine's live cwd, so a session that
    /// moved directories reports through the current project scope.
    pub(crate) fn note_model_refused(&self, surface: &str, selector: &str) {
        self.model_refusal_telemetry
            .note_refused(surface, selector, &self.cwd());
    }

    /// Resolve the model through the composed registry, then enforce the
    /// settings `allowedModels` allowlist: a resolution outside the
    /// allowlist fails loudly here (the silent-fallback guarantee — the
    /// startup chain never lands a session on a model the daemon may not
    /// resolve to), and the refusal emits `model refused`.
    fn resolve_registry_model(&self) -> anyhow::Result<Model> {
        let model = self.resolve_registry_model_unchecked()?;
        let selector = format!("{}/{}", model.provider, model.id);
        let allowlist = crate::model_allowlist::load(&self.cwd(), &self.config.agent_dir);
        if let Err(refusal) = crate::model_allowlist::assert_allowed(&allowlist, &selector) {
            if let Some(refusal) = refusal.downcast_ref::<pa_core::models::ModelAllowlistRefusal>()
            {
                self.note_model_refused("session_start", &refusal.selector);
            }
            return Err(refusal);
        }
        Ok(model)
    }

    /// The registry resolution before the allowlist gate: the flagged-model
    /// arm (TS `resolveCliModel`) or the TS `createAgentSession` startup
    /// chain.
    fn resolve_registry_model_unchecked(&self) -> anyhow::Result<Model> {
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        // A fresh registry gates private Prime Inference models out until the
        // async authorization refresh runs; adopt the on-disk authorization
        // cache so create-time resolution can pick the session's private
        // model (e.g. internal/glm-5.3-fast).
        registry.load_private_authorization_from_cache();
        let selection = self.current_selection();
        let Some(model_name) = selection.model.as_deref() else {
            // No flagged model: the restored-from-session decision comes
            // first (TS `createAgentSession`), then the startup chain —
            // the saved settings default, then the featured default, then
            // the first available model.
            if let Some(model) = self.restored_model_resolution(&registry) {
                return Ok(model);
            }
            let Some(model) = self.startup_chain_model(&registry) else {
                anyhow::bail!(
                    "No models available. Check your installation or add models to models.json."
                );
            };
            return Ok(model);
        };
        // TS `resolveCliModel` resolves against `modelRegistry.getAll()`
        // — the full catalog, not the auth-configured list ("use *all*
        // models here, not just models with pre-configured auth. This
        // allows --api-key to be used for first-time setup"): a saved or
        // switched model keeps resolving when no provider credential is
        // visible to the worker, and the turn's run-start auth validation
        // reports the missing credential with the TS message instead.
        let all: Vec<Model> = registry.get_all().to_vec();
        let resolved =
            pa_core::models::resolve_cli_model(selection.provider.as_deref(), model_name, &all);
        if let Some(error) = resolved.error {
            anyhow::bail!("{error}");
        }
        resolved
            .model
            .ok_or_else(|| anyhow::anyhow!("No matching model found."))
    }

    /// Test seam: a scripted faux provider (same script contract as pa-cli's
    /// print runtime) drives the engine without the network. The provider
    /// registers once per engine: its queued responses then span the whole
    /// session (multi-turn scripts), instead of replaying from the top on
    /// every model resolution.
    pub(crate) fn resolve_model(&self) -> anyhow::Result<Model> {
        if let Some(script) = &self.config.faux_script {
            if let Some(model) = self.faux_model.get() {
                return Ok(model.clone());
            }
            let model = faux_model_from_script(script)?;
            let _ = self.faux_model.set(model.clone());
            return Ok(model);
        }
        self.resolve_registry_model()
    }

    /// The session's live model for summarization-side model calls
    /// (compaction summarizers, branch summaries, side questions, and the
    /// compaction-triggered refinement): the provider target the built
    /// session's stream reads per call — the model the session is actually
    /// running on. TS `_runAutoCompaction` runs its summarizer on
    /// `this.model`, the session's live model, never a fresh resolution.
    ///
    /// [`Self::resolve_model`] consults a registry built from scratch each
    /// call (startup chain over the live catalog, settings, and auth), so
    /// two consecutive calls can resolve differently and a summarizer arm
    /// can land on a provider the session never used — the R8 report: a
    /// live prime-inference session whose threshold auto-compaction
    /// resolved to `amazon-bedrock` and failed with "No AWS credentials
    /// available for Bedrock" while the session's turns kept streaming
    /// through the target's provider. The turn loop already follows the
    /// target (the stream reads it per call); the summarizer arms follow
    /// the same chain.
    ///
    /// Falls back to [`Self::resolve_model`] before the session's first
    /// build (the target is set at build): the same resolution the build
    /// itself would make, for the surfaces that can run before any turn
    /// (the `/compact` wire command on a fresh session).
    pub(crate) fn session_model(&self) -> anyhow::Result<Model> {
        if let Some(target) = self
            .provider_target
            .read()
            .expect("provider target lock")
            .clone()
        {
            return Ok(target.model);
        }
        self.resolve_model()
    }

    /// The effective session thinking level (the sdk.ts `createAgentSession`
    /// order): the create-config flag, then the settings default, then
    /// "medium" — always clamped to what the model supports, where the
    /// model is the one the session actually runs on (the restored pin
    /// after a session-model restore, the explicit selection after a
    /// flagged create); a model that cannot be resolved degrades to
    /// "off". Resolved once at the create/restore seam and cached so
    /// summary/state calls stay side-effect-free while turns run.
    fn effective_thinking(&self) -> pa_types::ai::ModelThinkingLevel {
        if let Some(level) = *self
            .effective_thinking
            .read()
            .expect("effective thinking lock")
        {
            return level;
        }
        let requested = self
            .current_selection()
            .thinking
            .or_else(|| {
                let settings =
                    pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
                settings
                    .get_default_thinking_level()
                    .map(pa_core::settings::ThinkingLevelSetting::model_level)
            })
            // TS `DEFAULT_THINKING_LEVEL`.
            .unwrap_or(pa_types::ai::ModelThinkingLevel::Medium);
        let resolved = match self.resolve_model() {
            Ok(model) => pa_ai::models::clamp_thinking_level(&model, requested),
            Err(_) => pa_types::ai::ModelThinkingLevel::Off,
        };
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = Some(resolved);
        resolved
    }

    /// Resolve the request API key for `model`: the create-config key (the
    /// TS `setRuntimeApiKey` path), else the registry's auth resolution
    /// (auth storage, then the models.json provider `apiKey` — the same
    /// sources `getApiKeyAndHeaders` merges in the TS product).
    pub(crate) fn resolve_request_api_key(&self, model: &Model) -> Option<String> {
        if let Some(api_key) = &self.current_selection().api_key {
            return Some(api_key.clone());
        }
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        registry
            .get_api_key_and_headers(model, model.headers.as_ref())
            .api_key
    }

    /// Kernel host-request handlers for agent messaging and observation,
    /// routed through the worker's supervisor link. `None` outside a daemon
    /// worker: without a supervisor there is nobody to reach.
    fn extra_host_handlers(&self) -> Option<HostRequestHandlers> {
        let config = self.config.supervisor_link.as_ref()?;
        let sender = Arc::new(LinkAgentMessageController::new(
            Arc::clone(&self.link),
            config.active_session_id.clone(),
            config.worker_token.clone(),
            Arc::clone(&self.own_summary),
            self.children.clone(),
        ));
        let observer = Arc::new(LinkAgentObserveController::new(
            Arc::clone(&self.link),
            config.active_session_id.clone(),
            Arc::clone(&self.own_summary),
            self.children.clone(),
        ));
        let mut handlers = HostRequestHandlers::default();
        register_agent_message_host_handlers(sender, &mut handlers);
        register_agent_observe_host_handlers(observer, &mut handlers);
        self.register_bash_notice_host_handlers(&mut handlers);
        Some(handlers)
    }

    /// The configured kernel cron wiring (the worker's shared store).
    fn cron_wiring(&self) -> Option<pa_core::session_engine::runtime_wiring::KernelCronWiring> {
        self.config.cron_store.clone()
    }

    /// The kernel cron binding for the current session build: the live
    /// active session id (the supervisor link carries it) plus the
    /// durable session id + file from the worker-owned session file's
    /// header. `None` outside a daemon worker or before the session file
    /// exists (the engine falls back to its in-memory identity).
    fn kernel_cron_binding(
        &self,
    ) -> Option<pa_core::session_engine::runtime_wiring::KernelCronBinding> {
        let active_session_id = self
            .config
            .supervisor_link
            .as_ref()?
            .active_session_id
            .clone();
        let file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        let header = pa_core::session::manager::read_session_header(&file)?;
        Some(pa_core::session_engine::runtime_wiring::KernelCronBinding {
            active_session_id,
            session_id: header.id,
            session_file: file.display().to_string(),
            cwd: self.cwd().display().to_string(),
        })
    }

    async fn build_session(&self, model: &Model) -> anyhow::Result<CoreSessionEngine> {
        let agent_model =
            json_round_trip(model).ok_or_else(|| anyhow::anyhow!("model conversion failed"))?;
        // The live queue-delivery modes (seeded from the start config or
        // switched by `set_steering_mode`/`set_follow_up_mode`): read
        // under a scoped lock — a std guard must never ride the build's
        // awaits below.
        let (steering_mode, follow_up_mode) = {
            let modes = self.queue_modes.lock().expect("queue modes");
            (
                modes.0.as_deref().and_then(Self::queue_mode),
                modes.1.as_deref().and_then(Self::queue_mode),
            )
        };

        // The session's stream reads its target from the engine's live slot:
        // `set_model` swaps the slot so the built session follows without a
        // rebuild.
        let stream_fn = switchable_stream_fn(std::sync::Arc::clone(&self.provider_target));
        {
            let mut target = self.provider_target.write().expect("provider target lock");
            *target = Some(ProviderTarget {
                service_tier: *self.service_tier.read().expect("service tier lock"),
                api_key: self.resolve_request_api_key(model),
                model: model.clone(),
            });
        }
        if let Some(session_dir) = &self.config.session_dir {
            std::fs::create_dir_all(session_dir)?;
        }
        let cwd = self.cwd();
        let session_manager = pa_core::session::manager::SessionManager::in_memory(&cwd);
        let session_file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        // Children inherit the parent model selector; the engine resolves
        // the model here, after the create command set the rest of the
        // parent identity.
        if let Some(children) = &self.children {
            children.set_model(format!("{}/{}", model.provider, model.id));
        }
        // Session telemetry: the composition root is this worker process;
        // the create command's opt-out rides the engine config (TS main.ts
        // `telemetryDisabled` on the runtime config). Sinks resolve from
        // settings + env inside `build_client`.
        let telemetry = (self.config.telemetry_disabled != Some(true)).then(|| {
            let settings =
                pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
            pa_core::session_engine::telemetry::TelemetryWiring {
                client: pa_core::session_engine::telemetry::build_client(
                    &settings,
                    &self.config.agent_dir,
                ),
                execution_mode: Some("daemon".to_string()),
                now: None,
            }
        });
        // Bound before the awaited build: the purge-clone binding must not
        // hold the lock guard across the await.
        let queued_goal_context_purge = self
            .goal_queue_purge
            .lock()
            .expect("goal queue purge lock")
            .clone();
        pa_core::session_engine::engine::create_session(SessionEngineConfig {
            telemetry,
            cwd,
            agent_dir: self.config.agent_dir.clone(),
            mcp_manager: Some(std::sync::Arc::clone(&self.mcp)),
            model: Some(agent_model),
            thinking_level: Some(map_thinking_level(self.effective_thinking())),
            stream_fn: Some(stream_fn),
            // Model tools: `ipython` only (kernel-resident bash/edit parity);
            // the engine adds the kernel-backed `ipython` tool itself.
            tools: vec![],
            custom_system_prompt: None,
            prompt_guidelines: vec![],
            generic_mcp_servers: vec![],
            allow_recursion: None,
            session_manager: Some(session_manager),
            extra_host_handlers: self.extra_host_handlers(),
            conversation_log_path: session_file,
            additional_skill_paths: vec![],
            additional_prompt_paths: vec![],
            extra_builtin_skill_overrides: vec![],
            rlm_subagent_host: self.children.clone().map(|children| {
                children as Arc<dyn pa_core::session_engine::rlm_host::RlmSubagentHost>
            }),
            rlm_depth: Some(self.rlm_depth.load(std::sync::atomic::Ordering::Relaxed)),
            model_info: Some(model.clone()),
            // The daemon worker has no CLI extension sources: sessions
            // load configured/discovered extensions only (the attached
            // TUI/ACP surfaces do not carry `-e` flags today).
            cli_extension_sources: vec![],
            extension_tool_allow_list: None,
            // TS main.ts `createDefaultRuntimeFactory` passes
            // `prewarmIpythonKernel: true` for every session it hosts; the
            // engine's depth gate keeps subagent workers (rlmDepth > 0) on
            // the lazy first-call start, exactly like the TS session's
            // `rlmDepth === 0` check.
            prewarm_ipython_kernel: Some(true),
            // TS `_clearQueuedGoalContexts` (the session-command sites and
            // the kernel's `goal.complete`): the worker-installed queue
            // purge, so the session engine's surfaces withdraw queued
            // minted continuations.
            queued_goal_context_purge,
            // TS `_steeringStopPending`: the worker's steering lane owns
            // the stop hooks (a queued steer cuts the run at the next
            // turn boundary; the runner delivers it as the next turn).
            queued_steering_probe: self.config.queued_steering_probe.clone(),
            // TS `sdk.ts` seeds the Agent's queue modes from the settings
            // manager; the worker create reads the same settings (the
            // engine-level queues drain per the mode at the loop
            // boundary, mirroring the worker lane's delivery modes). The
            // live switch (`set_steering_mode`/`set_follow_up_mode`)
            // updates the same slot ahead of any later build. The lock
            // is scoped to the read (a guard must never ride the build's
            // awaits).
            steering_mode,
            follow_up_mode,
            // The worker's shared scheduled-jobs store with the session
            // identity the kernel binding needs: the live active session
            // id the supervisor routes commands by, and the durable session
            // id + file the store partitions and rebinds by. Both come from
            // the worker-owned session (the engine's in-memory manager
            // carries neither), so the enrichment runs per build.
            cron_store: self.cron_wiring().map(|mut wiring| {
                wiring.binding = self.kernel_cron_binding().or(wiring.binding);
                wiring
            }),
        })
        .await
        .inspect(|engine| {
            // A queue-mode switch that landed while this build was in
            // flight wrote only the live slot (the build snapshot above
            // predates it, and the agent handle did not exist yet): re-
            // apply the current modes to the freshly built agent so the
            // first build can never serve a stale mode (TS's agent is
            // built once per session, so the race does not exist there;
            // this port's lazy build needs the catch-up).
            let (steering_mode, follow_up_mode) = {
                let modes = self.queue_modes.lock().expect("queue modes");
                (
                    modes.0.as_deref().and_then(Self::queue_mode),
                    modes.1.as_deref().and_then(Self::queue_mode),
                )
            };
            if let Some(mode) = steering_mode {
                engine.session.agent().set_steering_mode(mode);
            }
            if let Some(mode) = follow_up_mode {
                engine.session.agent().set_follow_up_mode(mode);
            }
        })
    }
}

/// The last persisted `rlm_max_depth_state` custom entry in a session
/// file (TS `_loadPersistedRlmMaxDepthState`): the chat override a
/// resumed session re-seeds its depth bound from. `None` when the file
/// carries no override (or cannot be read - an unreadable file keeps the
/// create-carried bound, exactly the TS fallthrough).
pub(crate) fn persisted_rlm_max_depth(path: Option<&str>) -> Option<u64> {
    let path = std::path::Path::new(path?);
    let content = std::fs::read_to_string(path).ok()?;
    crate::session_store::parse_session_entries(&content)
        .iter()
        .rev()
        .find_map(|entry| {
            (entry.get("type").and_then(Value::as_str) == Some("custom")
                && entry.get("customType").and_then(Value::as_str) == Some("rlm_max_depth_state"))
            .then(|| {
                entry
                    .get("data")
                    .and_then(|data| data.get("maxDepth"))
                    .and_then(Value::as_u64)
            })
            .flatten()
        })
}

/// The saved model context of a session file (TS
/// `buildSessionContext().model`): the model the session last ran on —
/// the last `model_change` row, else the last assistant message's
/// provider/model. `None` when the file carries no model context (a
/// fresh session) or cannot be read (the create flow owns that failure).
/// The session file's saved model context (TS `buildSessionContext`): the
/// pinned `(provider, model)` and the saved thinking level — present only
/// when the file carries a `thinking_level_change` row (TS
/// `hasThinkingEntry`).
pub(crate) struct SavedSessionContext {
    pub(crate) model: Option<(String, String)>,
    pub(crate) thinking: Option<pa_types::ai::ModelThinkingLevel>,
}

pub(crate) fn saved_session_context(path: &std::path::Path) -> Option<SavedSessionContext> {
    let store = crate::session_store::SessionFile::open(path).ok()?;
    let entries = store.branch_file_entries();
    let leaf = store.leaf_id().map(str::to_string);
    let context = pa_core::session::build_session_context(&entries, leaf.as_deref());
    let thinking = store
        .has_thinking_level()
        .then(|| pa_ai::models::thinking_level_from_str(&context.thinking_level))
        .flatten();
    Some(SavedSessionContext {
        model: context.model,
        thinking,
    })
}

/// One artifact reference (TS `createArtifactReference` in
/// modes/agent-connection/snapshot.ts): the sha256-derived id, the owning
/// session, the artifact type, and the logical path (cwd-relative when the
/// file lives under the cwd, else the basename).
fn artifact_reference(
    session_id: &str,
    cwd: &str,
    artifact_type: &str,
    file_path: &str,
) -> Option<Value> {
    use sha2::{Digest, Sha256};
    if file_path.is_empty() {
        return None;
    }
    let digest = Sha256::new()
        .chain_update(format!("{session_id}\0{artifact_type}\0{file_path}"))
        .finalize();
    let id = format!("artifact_{}", hex_prefix(&digest, 16));
    let mut reference = json!({
        "id": id,
        "sessionId": session_id,
        "type": artifact_type,
        "logicalPath": logical_artifact_path(cwd, file_path),
    });
    let logical = reference["logicalPath"].as_str().unwrap_or_default();
    let resolved_cwd = std::path::Path::new(cwd);
    let resolved_path = std::path::Path::new(file_path);
    if let (Ok(relative), true) = (
        resolved_path.strip_prefix(resolved_cwd),
        logical.chars().next().is_some_and(|c| c != '.' && c != '/'),
    ) {
        reference["relativePath"] = json!(relative.to_string_lossy().replace('\\', "/"));
    }
    Some(reference)
}

/// The first `len` hex characters of a digest.
fn hex_prefix(digest: &[u8], len: usize) -> String {
    digest
        .iter()
        .flat_map(|byte| [format!("{:02x}", byte >> 4), format!("{:02x}", byte & 0x0f)])
        .collect::<String>()
        .chars()
        .take(len)
        .collect()
}

/// TS `createArtifactPathInfo`: synthetic paths (`<...>`) stay as-is; a
/// path under the cwd keeps its cwd-relative form; anything else degrades
/// to the basename.
fn logical_artifact_path(cwd: &str, file_path: &str) -> String {
    if file_path.starts_with('<') && file_path.ends_with('>') {
        return file_path.to_string();
    }
    let resolved_cwd = std::path::Path::new(cwd);
    let resolved_path = std::path::Path::new(file_path);
    if let Ok(relative) = resolved_path.strip_prefix(resolved_cwd) {
        let relative = relative.to_string_lossy().replace('\\', "/");
        if !relative.is_empty() && !relative.starts_with("..") && !relative.starts_with('/') {
            return relative;
        }
    }
    std::path::Path::new(file_path).file_name().map_or_else(
        || "artifact".to_string(),
        |name| name.to_string_lossy().to_string(),
    )
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

impl AgentSessionEngine {
    /// Write the durable `rlm_max_depth_state` custom entry (TS
    /// `RLM_MAX_DEPTH_STATE_CUSTOM_TYPE`): straight into the built
    /// session's persistence handle, or parked for the build when the
    /// first turn has not built the session yet.
    fn persist_max_depth_state(&self, max_depth: u64) {
        let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
        match handles {
            Some(handles) => {
                let mut manager = self
                    .runtime
                    .block_on(async { handles.session.lock().await });
                if let Err(error) = manager.append_custom_entry(
                    "rlm_max_depth_state",
                    Some(json!({ "maxDepth": max_depth })),
                ) {
                    eprintln!("pa-daemon: failed to persist rlm_max_depth_state: {error:#}");
                }
            }
            None => {
                *self
                    .pending_max_depth
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(max_depth);
            }
        }
    }

    /// The global settings write behind `set_rlm_max_depth { global: true }`
    /// (TS `settingsManager.setRlmMaxDepth` + flush + `drainErrors`):
    /// `Some(message)` when the write failed, mirroring the TS
    /// `globalError` field.
    fn write_global_rlm_max_depth(&self, max_depth: u64) -> Option<String> {
        let mut settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        match settings.set_rlm_max_depth(max_depth) {
            Ok(()) => None,
            Err(error) => Some(error.to_string()),
        }
    }

    /// Flush a parked `rlm_max_depth_state` entry once the session built
    /// (the `pending_branch` pattern's build-site twin).
    fn flush_pending_max_depth(&self, manager: &mut pa_core::session::manager::SessionManager) {
        let pending = self
            .pending_max_depth
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(max_depth) = pending {
            if let Err(error) = manager.append_custom_entry(
                "rlm_max_depth_state",
                Some(json!({ "maxDepth": max_depth })),
            ) {
                eprintln!("pa-daemon: failed to flush pending rlm_max_depth_state: {error:#}");
            }
        }
    }

    /// Mirror the built session's goal handles: the core session's own
    /// mutex stays held across a turn's admission, so goal checks in emit
    /// callbacks read the mirror instead of the session.
    fn mirror_goal_runtime(&self, core: &CoreSessionEngine) {
        *self.goal_runtime.lock().expect("goal runtime lock") = Some(GoalRuntimeHandles {
            driver: core.goal_driver.clone(),
            session: core.session.shared_persistence(),
        });
    }

    /// The current goal state for a wire emission, when the driver is free
    /// to read (an in-flight host request holds it only for its own
    /// critical section; the next emitted event re-checks).
    fn current_goal_state(&self) -> Option<pa_core::goals::GoalState> {
        let handles = self
            .goal_runtime
            .lock()
            .expect("goal runtime lock")
            .clone()?;
        let driver = handles.driver.try_lock().ok()?;
        Some(driver.state().clone())
    }

    /// Emit the `goal_update` engine event when the session's goal state
    /// changed since the last emission (per-session dedupe: the TS session
    /// listener fires on state change). Returns the emit callback's verdict.
    /// A session without a goal seeds the baseline silently instead of
    /// emitting an idle-state event TS never sends.
    pub(crate) fn goal_update_if_changed(&self, emit: &mut dyn FnMut(EngineEvent) -> bool) -> bool {
        let Some(goal) = self.current_goal_state() else {
            // No session yet, or the driver is mid-mutation: a later event
            // re-checks before the turn settles.
            return true;
        };
        {
            let mut published = self.published_goal.lock().expect("published goal lock");
            if published.as_ref() == Some(&goal) {
                return true;
            }
            let baseline_only =
                published.is_none() && goal.status == pa_core::goals::GoalStatus::Idle;
            *published = Some(goal.clone());
            if baseline_only {
                return true;
            }
        }
        emit(EngineEvent::GoalUpdate {
            goal: serde_json::to_value(&goal).unwrap_or(Value::Null),
        })
    }

    /// Wrap one prompt's emit callback so every forwarded event is followed
    /// by a goal-change check: kernel `goal.complete`/`goal.create` host
    /// requests and session-command mutations surface as `goal_update` at
    /// the moment they happen (TS emits from `_setGoalState`), so the
    /// announcement row lands between the surrounding rows — after the
    /// echo/tool card, before the result/reply — not after the turn.
    pub(crate) fn goal_tracking_emit<'a>(
        &'a self,
        emit: &'a mut dyn FnMut(EngineEvent) -> bool,
    ) -> impl FnMut(EngineEvent) -> bool + 'a {
        move |event: EngineEvent| {
            if !emit(event) {
                return false;
            }
            self.goal_update_if_changed(emit)
        }
    }
}

impl SessionEngine for AgentSessionEngine {
    /// TS `_clearQueuedGoalContexts`: the worker-installed purge withdraws
    /// the queued minted goal-context turns (pause/clear/start must not
    /// leave a stale continuation to run after the state change).
    fn purge_queued_goal_contexts(&self) {
        let purge = self
            .goal_queue_purge
            .lock()
            .expect("goal queue purge lock")
            .clone();
        if let Some(purge) = purge {
            purge();
        }
    }

    fn goal_state_value(&self) -> Value {
        if let Some(goal) = self.current_goal_state() {
            return serde_json::to_value(&goal).unwrap_or(Value::Null);
        }
        // The driver is mid-mutation or the session is not built yet (goal
        // rehydration surfaces with the first prompt/command): fall back to
        // the last published state, then the empty state.
        let published = self.published_goal.lock().expect("published goal lock");
        published
            .as_ref()
            .and_then(|goal| serde_json::to_value(goal).ok())
            .or_else(|| serde_json::to_value(pa_core::goals::empty_goal_state()).ok())
            .unwrap_or(Value::Null)
    }

    fn mint_post_compaction_goal_continuation(&self) -> Option<crate::engine::GoalContinuation> {
        // The mirrored goal runtime holds the driver and the session's
        // persistence handle (the core session's own lock stays held
        // across a turn's admission); the driver and session locks are
        // async, so the mint runs on the engine runtime like every other
        // engine call that touches the session.
        let handles = self
            .goal_runtime
            .lock()
            .expect("goal runtime lock")
            .clone()?;
        let continuation = self.runtime.block_on(async {
            let mut driver = handles.driver.lock().await;
            // TS `resumeQueuedWork()`'s quiescence arm: unsettled RLM
            // descendant work defers the mint (the continuation is owed,
            // not consumed; the settle sites deliver it).
            if self.has_unsettled_rlm_work().await {
                driver.mark_continuation_owed();
                return None;
            }
            let mut session = handles.session.lock().await;
            // The mint persists the `thread_goal_state` entry (TS
            // `_setGoalState`) and consumes one continuation slot; an
            // inactive or objective-less goal mints nothing. A failed
            // persist ends the boundary without a continuation (TS
            // `_maybeResumeGoalContinuationAfterRlmWork`'s catch: the
            // hook must not reject; the unchanged count retries).
            let message = match driver.next_continuation_message(&mut session) {
                Ok(message) => message,
                Err(error) => {
                    eprintln!("pa-daemon: goal continuation mint persist failed: {error:#}");
                    None
                }
            }?;
            let goal_update = self.publish_goal_state(driver.state());
            Some((
                crate::engine::PromptRequest {
                    batch: Vec::new(),
                    message: message.content.text(),
                    images: Vec::new(),
                    source: "user".to_string(),
                    agent_message_id: None,
                    custom_message: Some(crate::session_commands::custom_message_value(&message)),
                },
                goal_update,
            ))
        })?;
        let (request, goal_update) = continuation;
        Some(crate::engine::GoalContinuation {
            request,
            goal_update,
        })
    }

    fn autonomous_status(
        &self,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Option<pa_core::autonomous::AgentAutonomousStatus>>
                + Send
                + '_,
        >,
    > {
        // The turn loop's accounting holds the state lock across awaits
        // (gate evaluation), so the snapshot takes the async lock; the
        // caller waits for the session to settle first
        // (wait_for_headless_completion waits for idle).
        let autonomous = std::sync::Arc::clone(&self.autonomous);
        Box::pin(async move {
            let state = autonomous.lock().await;
            Some(pa_core::autonomous::autonomous_status(&state))
        })
    }

    /// Finalize telemetry on the live core session: `agent session ended`
    /// plus one flush (TS dispose callback). Best-effort by contract: a
    /// failed end never blocks or fails shutdown.
    fn end_telemetry(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let session = self.session.lock().await;
            let Some(engine) = session.as_deref() else {
                return;
            };
            let Some(telemetry) = &engine.telemetry else {
                return;
            };
            let _ = telemetry.end().await;
        })
    }

    /// The TS replacement teardown (see
    /// [`Self::retire_session_runtime`]): the replacement flows retire the
    /// live runtime - kernel dispose plus the built session's drop - so
    /// the moved-to session rebuilds cold against its new file.
    fn teardown_for_replacement(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            self.retire_session_runtime().await;
        })
    }

    /// The daemon `kill` path: report `session archived` (lifetime in ms),
    /// then finalize with `agent session ended` + flush. Best-effort like
    /// all telemetry; `SessionTelemetry::end` is idempotent, so a later
    /// worker shutdown stays a no-op for a killed session.
    fn archive_session_telemetry(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let session = self.session.lock().await;
            let Some(engine) = session.as_deref() else {
                return;
            };
            let Some(telemetry) = &engine.telemetry else {
                return;
            };
            telemetry.note_archived();
            let _ = telemetry.end().await;
        })
    }

    fn acp_mcp_manager(
        &self,
    ) -> Option<std::sync::Arc<std::sync::Mutex<pa_core::mcp::McpManager>>> {
        Some(std::sync::Arc::clone(&self.mcp))
    }

    fn model_context_window(&self) -> Option<u64> {
        self.resolve_model().ok().map(|model| model.context_window)
    }

    fn creation_model(&self) -> Option<(String, String)> {
        let model = self.resolve_registry_model().ok()?;
        Some((model.provider.clone(), model.id))
    }

    fn set_session_file(&self, path: std::path::PathBuf) {
        *self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(path);
    }

    /// TS `createAgentSession`'s restored-from-session step (sdk.ts): a
    /// session that already ran on a model restores it before the startup
    /// chain — the saved model context from the session file, through the
    /// bounded readiness wait (a revived worker races the daemon boot's
    /// catalog fetch; without the wait a private model is missing from
    /// the cold registry and the session silently lands on the featured
    /// default instead of the model it was running on). The worker calls
    /// this at create, before the create-config selection is adopted: a
    /// successful restore pins the model into the selection (the TS
    /// session holds its restored model), an explicit create flag still
    /// wins, and a failed restore is never silent —
    /// [`Self::model_fallback_message`] publishes the fallback.
    fn restore_session_model(
        &self,
        session_path: &std::path::Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let path = session_path.to_path_buf();
        Box::pin(async move {
            self.restore_session_model_at(&path).await;
        })
    }

    /// TS `modelFallbackMessage`: the non-silent record of a revived
    /// session's model falling back to the startup chain after the
    /// readiness window missed. Published on the session summary while
    /// the engine owns the file the decision was computed for.
    fn model_fallback_message(&self) -> Option<String> {
        let decision = self
            .restored_model
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        let current = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        if decision.session_file != current {
            return None;
        }
        decision.fallback_message
    }

    /// The `compact` command path (TS `compact()`'s background
    /// `_scheduleAutoRefine("compact")` on an idle session): the round
    /// runs right after the compaction answered, through the same gated
    /// body the turn boundaries use (compact_autorefine.rs).
    fn consume_compact_auto_refine(
        &self,
    ) -> anyhow::Result<Option<pa_core::refinement::RefinementResult>> {
        self.consume_compact_auto_refine_round()
    }

    /// The worker's live session summary (the TS
    /// `createAgentSessionMessageSender` source): rendered into the
    /// sender identity block of direct worker-to-worker deliveries.
    fn set_session_summary(&self, summary: Value) {
        *self
            .own_summary
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(summary);
    }

    fn configure_service_tier(&self, tier: Option<pa_types::ai::ServiceTier>) {
        *self.service_tier.write().expect("service tier lock") = tier;
        if let Some(target) = self
            .provider_target
            .write()
            .expect("provider target lock")
            .as_mut()
        {
            target.service_tier = tier;
        }
    }

    fn configure_model(&self, selection: EngineModelSelection) {
        // Merge like the TS runtime config: explicit wire flags replace the
        // current selection; absent fields keep it.
        {
            let mut current = self.selection.write().expect("model selection lock");
            if selection.provider.is_some() {
                current.provider = selection.provider;
            }
            if selection.model.is_some() {
                current.model = selection.model;
            }
            if selection.api_key.is_some() {
                current.api_key = selection.api_key;
            }
            if selection.thinking.is_some() {
                current.thinking = selection.thinking;
            }
        }
        // Resolve the effective thinking level now (create time, before any
        // turn): the merge above may have changed the selection, so drop the
        // cached value and recompute. `effective_thinking` caches it, so
        // later summary/state calls stay side-effect-free while turns run.
        *self
            .effective_thinking
            .write()
            .expect("effective thinking lock") = None;
        let _ = self.effective_thinking();
        // The first prompt after create builds the session against this
        // selection, so no invalidation is needed here: configure runs at
        // create time, before any turn.
    }

    fn configure_create_model(&self, selection: EngineModelSelection) {
        // The create command's explicit flags fold into the session
        // runtime config (TS `mergeAgentSessionRuntimeConfig`): TS hands
        // the merged `sessionConfig` down through every replacement, so
        // the flags must survive the runtime-config reset a session
        // restore performs — a later `switch_session`/`fork`/`import`
        // keeps honoring the create's selection (it wins over the
        // moved-to file's pin, exactly like `options.model` in
        // `createAgentSession`).
        {
            let mut initial = self
                .initial_selection
                .write()
                .expect("initial selection lock");
            if selection.provider.is_some() {
                initial.provider.clone_from(&selection.provider);
            }
            if selection.model.is_some() {
                initial.model.clone_from(&selection.model);
            }
            if selection.api_key.is_some() {
                initial.api_key.clone_from(&selection.api_key);
            }
            if selection.thinking.is_some() {
                initial.thinking = selection.thinking;
            }
        }
        self.configure_model(selection);
    }

    fn switch_model(&self, selection: EngineModelSelection) -> bool {
        // The allowlist gate on the switch candidate, before the selection
        // slot mutates: a refused model must not poison the live selection
        // (every later resolution would fail at the same gate). The wire
        // seams (`set_model`, `cycle_model`) check first and own the user
        // message and refusal event; this is the engine's total guard for
        // any other caller.
        if let (Some(provider), Some(model)) =
            (selection.provider.as_deref(), selection.model.as_deref())
        {
            let selector = format!("{provider}/{model}");
            let allowlist = crate::model_allowlist::load(&self.cwd(), &self.config.agent_dir);
            if crate::model_allowlist::assert_allowed(&allowlist, &selector).is_err() {
                return false;
            }
        }
        self.configure_model(selection);
        let Ok(model) = self.resolve_model() else {
            return false;
        };
        // The built session follows the new model without a rebuild: the
        // agent's model (loop context) and the provider stream's target
        // swap in place (TS `agent.state.model = model`).
        {
            let mut target = self.provider_target.write().expect("provider target lock");
            *target = Some(ProviderTarget {
                service_tier: *self.service_tier.read().expect("service tier lock"),
                api_key: self.resolve_request_api_key(&model),
                model: model.clone(),
            });
        }
        let session = self.session.blocking_lock();
        if let Some(core) = session.as_deref() {
            let provider = model.provider.clone();
            let model_id = model.id.clone();
            let _ = self
                .runtime
                .block_on(core.session.set_model(&model, &provider, &model_id));
        }
        // The children registry's inherited parent model follows the
        // switch (the build-time stamp alone would go stale): an inherited
        // `rlm.spawn` resolves the model the session NOW runs, so the
        // allowlist gate never refuses a stale selector the parent left
        // behind.
        if let Some(children) = &self.children {
            children.set_model(format!("{}/{}", model.provider, model.id));
        }
        true
    }

    fn supported_thinking_levels(&self) -> Option<Vec<String>> {
        let model = self.resolve_model().ok()?;
        Some(
            pa_ai::models::get_supported_thinking_levels(&model)
                .into_iter()
                .map(|level| level.wire_name().to_string())
                .collect(),
        )
    }

    fn switch_thinking_level(&self, level: pa_types::ai::ModelThinkingLevel) -> bool {
        self.configure_model(EngineModelSelection {
            thinking: Some(level),
            ..Default::default()
        });
        // The effective level is the request clamped to the model's
        // supported levels (TS `setThinkingLevel`); a built session's
        // agent follows it on the next turn.
        let effective = self.effective_thinking();
        let session = self.session.blocking_lock();
        if let Some(core) = session.as_deref() {
            let _ = self.runtime.block_on(
                core.session
                    .set_thinking_level(map_thinking_level(effective)),
            );
        }
        true
    }

    fn effective_thinking_level(&self) -> Option<String> {
        Some(self.effective_thinking().wire_name().to_string())
    }

    /// The built core session's assembled prompt (the export embeds it).
    /// Best-effort: the caller's `export_tools` read (which builds an
    /// absent session, the TS create-time state) runs first; a still
    /// unbuilt or busy session omits the section.
    fn export_system_prompt(&self) -> Option<String> {
        let session = self.session.try_lock().ok()?;
        session.as_deref().map(|core| core.system_prompt.clone())
    }

    /// The built session's live tool registry mapped to the export's tools
    /// section (TS `state.tools`). An export that precedes the first turn
    /// builds the session now (the TS state exists from create); a
    /// mid-turn engine reports `None` and the export omits the section.
    fn export_tools(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + '_>> {
        Box::pin(async move {
            let model = self.resolve_model().ok()?;
            self.ensure_core_session_async(&model).await.ok()?;
            let session = self.session.try_lock().ok()?;
            let state = session.as_deref()?.session.agent().state().await;
            Some(pa_core::export_html::tools_section(&state.tools))
        })
    }

    /// The export's custom-tool pre-render: walk the entries through the
    /// registry-backed renderer (TS `preRenderCustomTools`), against the
    /// same built-session registry as [`Self::export_tools`].
    fn export_rendered_tools(
        &self,
        entries: &[Value],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + '_>> {
        let entries = entries.to_vec();
        Box::pin(async move {
            let model = self.resolve_model().ok()?;
            self.ensure_core_session_async(&model).await.ok()?;
            let session = self.session.try_lock().ok()?;
            let state = session.as_deref()?.session.agent().state().await;
            let renderer = crate::session_export::ExportToolRenderer {
                tools: &state.tools,
            };
            pa_core::export_html::pre_render_custom_tools(&entries, &renderer)
        })
    }

    fn model_metadata(&self) -> Option<Value> {
        let model = self.resolve_model().ok()?;
        Some(json!({
            "id": model.id,
            "name": model.name,
            "api": model.api,
            "provider": model.provider,
            "reasoning": model.reasoning,
        }))
    }

    /// `compact` over the hosted pa-core session: the session summarizes
    /// its own branch, persists the entry on its in-memory store, and
    /// rebuilds the loop context; the worker persists the durable entry.
    /// The abort races the run: the summarizer call is cancelled by
    /// dropping the future (the entry write happens inside it).
    fn abort_auto_compaction(&self) {
        // TS `abortCompaction` aborts the auto controller in flight and is a
        // silent no-op otherwise; the run itself clears its slot when it
        // settles (only its own controller clears, so a stale abort cannot
        // clear a newer run's slot).
        let controller = self
            .auto_compaction_abort
            .lock()
            .expect("auto compaction abort lock")
            .clone();
        if let Some(controller) = controller {
            controller.abort();
        }
    }

    fn run_compaction(
        &self,
        request: CompactionRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        // The session's live model (the provider target the turn stream
        // reads), never a fresh startup-chain resolution (R8: a
        // re-resolution landed the summarizer on an unconfigured provider).
        let model = match self.session_model() {
            Ok(model) => model,
            Err(error) => {
                return CompactionOutcome::Failed {
                    error: error.to_string(),
                }
            }
        };
        if let Err(error) = self.session_agent(&model) {
            return CompactionOutcome::Failed {
                error: error.to_string(),
            };
        }
        let custom_instructions = request.custom_instructions;
        // The live target's key, the same chain every other summarizer
        // arm reads: the config key is the startup snapshot and goes
        // stale with the session's provider switches (the R8 seam's
        // key arm — a summarizer with the old provider's key, or none).
        let api_key = self.resolve_request_api_key(&model);
        let run = async {
            // The lock covers the clone only (see `run_turn_once`): the
            // compaction below runs a summarizer model call, and holding
            // the mutex across it serialized every client read seam
            // behind the compaction.
            let session = self.session.lock().await.clone();
            let Some(engine) = session else {
                anyhow::bail!("session not built");
            };
            engine
                .session
                .compact(
                    custom_instructions.as_deref(),
                    &model,
                    api_key,
                    // The run's own signal: a summarizer that resolved while
                    // the abort raced still lands the pre-commit check (TS
                    // `_performCompaction`'s `if (signal.aborted) throw`).
                    Some(signal),
                )
                .await
        };
        let result = self
            .runtime
            .block_on(pa_agent::abort::race_with_abort(run, signal));
        let compaction = match result {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(error)) => {
                // Abort-marked errors and a lost abort race both surface as
                // the TS "Compaction cancelled" outcome.
                if pa_agent::abort::is_abort_error(&error) {
                    return CompactionOutcome::Aborted;
                }
                return CompactionOutcome::Failed {
                    error: format!("{error:#}"),
                };
            }
            Err(_) => return CompactionOutcome::Aborted,
        };
        match compaction {
            pa_core::session_engine::compact_session::CompactOutcome::Skipped(message) => {
                CompactionOutcome::Skipped {
                    message: message.to_string(),
                }
            }
            pa_core::session_engine::compact_session::CompactOutcome::Ran(run) => {
                // Adoption telemetry (TS `compaction_end` handling counts
                // every completed compaction into the active run; the
                // manual wire run counts like the `/compact` command).
                {
                    let guard = self.session.blocking_lock();
                    if let Some(telemetry) = guard
                        .as_deref()
                        .and_then(|engine| engine.telemetry.as_ref())
                    {
                        telemetry.note_compaction();
                    }
                }
                // TS `compact()` schedules the compact-trigger auto-refine
                // review after every successful compaction (the manual path
                // included); the `compact` command consumes the round once
                // the run settled.
                self.mark_compact_auto_refine_pending();
                CompactionOutcome::Compacted {
                    run: Box::new(CompactionRun {
                        // The wire result is the TS `CompactionResult` shape
                        // (`_performCompaction`'s return): summary,
                        // firstKeptEntryId, tokensBefore, and the file-op
                        // `details` verbatim from the durable entry. Usage and
                        // the harnessDigest snapshot live on the persisted
                        // entry, handed over verbatim, never on the wire
                        // result.
                        result: crate::compaction::compaction_result_value(&run.result, &run.entry),
                        usage: run
                            .result
                            .usage
                            .and_then(|usage| serde_json::to_value(usage).ok()),
                        entry: serde_json::to_value(&run.entry).unwrap_or(Value::Null),
                        // The post-compaction kernel notice in its wire
                        // message form (`role: "custom"`), when the session's
                        // kernel was running.
                        ipython_state: run
                            .ipython_state
                            .as_ref()
                            .map(crate::session_commands::custom_message_value),
                    }),
                }
            }
        }
    }

    fn run_branch_summary(
        &self,
        request: BranchSummaryRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> BranchSummaryOutcome {
        // The session's live model (the provider target the turn stream
        // reads): the branch summarizer runs on the session model like the
        // compaction summarizer (R8).
        let model = match self.session_model() {
            Ok(model) => model,
            Err(error) => {
                return BranchSummaryOutcome::Failed {
                    error: error.to_string(),
                }
            }
        };
        let api_key = self.resolve_request_api_key(&model);
        let settings =
            pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
        let reserve_tokens = settings
            .settings()
            .branch_summary
            .as_ref()
            .and_then(|branch_summary| branch_summary.reserve_tokens)
            .unwrap_or(
                pa_core::session_engine::branch_summarization::DEFAULT_BRANCH_RESERVE_TOKENS,
            );
        let entries = request.entries;
        let custom_instructions = request.custom_instructions;
        let replace_instructions = request.replace_instructions;
        // TS #2411: the branch summary resolves its model through the
        // `auxiliaryModel` setting (the session model above is the
        // fallback), so its one-off prompt stays off the session's
        // prompt-cache prefix.
        let auxiliary = pa_core::session_engine::auxiliary_model::AuxiliaryModelContext {
            cwd: self.cwd(),
            agent_dir: self.config.agent_dir.clone(),
        };
        let run = async {
            pa_core::session_engine::branch_summarization::generate_branch_summary(
                &entries,
                pa_core::session_engine::branch_summarization::GenerateBranchSummaryOptions {
                    model: &model,
                    api_key,
                    custom_instructions: custom_instructions.as_deref(),
                    replace_instructions,
                    reserve_tokens,
                    auxiliary: Some(&auxiliary),
                },
            )
            .await
        };
        match self
            .runtime
            .block_on(pa_agent::abort::race_with_abort(run, signal))
        {
            Ok(result) => {
                if result.aborted {
                    return BranchSummaryOutcome::Aborted;
                }
                if let Some(error) = result.error {
                    return BranchSummaryOutcome::Failed { error };
                }
                let summary = result
                    .summary
                    .unwrap_or_else(|| "No summary generated".to_string());
                BranchSummaryOutcome::Complete {
                    run: BranchSummaryRun {
                        summary,
                        usage: result
                            .usage
                            .and_then(|usage| serde_json::to_value(usage).ok()),
                        details: Some(json!({
                            "readFiles": result.read_files,
                            "modifiedFiles": result.modified_files,
                        })),
                    },
                }
            }
            Err(_) => BranchSummaryOutcome::Aborted,
        }
    }

    fn rebuild_session_context(
        &self,
        branch_entries: Vec<pa_types::session::FileEntry>,
        goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        // The caller parks this synchronous engine call on a blocking
        // thread (see `branch_navigation`), so `blocking_lock` is legal
        // here; the async session move below then rides the engine
        // runtime, the same pattern as `run_compaction`.
        let built = self.session.blocking_lock().is_some();
        if !built {
            // The session builds lazily on the first turn; park the branch
            // so the build consumes it (see `session_agent`). The goal
            // state seed rides the build (`adopt_built_session`: the TS
            // constructor's `_loadPersistedGoalState`), so the reload
            // rule has nothing to run here.
            *self
                .pending_branch
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(branch_entries);
            return Ok(());
        }
        self.runtime.block_on(async move {
            let guard = self.session.lock().await;
            let Some(engine) = guard.as_deref() else {
                return Ok(());
            };
            // TS `_invalidatePendingAutoRefineForBranchChange`: the moved
            // branch invalidates the conversation an armed compact-trigger
            // review would read, so the trigger drops.
            engine.session.discard_compact_auto_refine();
            engine
                .session
                .rebuild_branch_context(branch_entries)
                .await?;
            // TS `_reloadGoalStateFromBranch({ monotonicTokens })` at the
            // `_navigateTree` tail: the rebuilt context reads the moved
            // branch's own latest persisted goal entry (the session manager
            // adopted the entries above, so the same scan the TS
            // `sessionManager.getBranch()` read applies), with the
            // same-timeline rule clamping the same goal's accounting. The
            // reload's announcement publishes here — while the driver lock
            // is held, so a racing goal mutation can neither interleave
            // nor make the payload read fail — and the caller takes it.
            let mut driver = engine.goal_driver.lock().await;
            let session = engine.session.shared_persistence();
            let manager = session.lock().await;
            driver.reload_from_branch(&manager, goal_reload);
            let announcement = self.publish_goal_state(driver.state());
            *self
                .reloaded_goal_update
                .lock()
                .expect("reloaded goal update lock") = announcement;
            Ok(())
        })
    }

    fn goal_update_after_rebuild(&self) -> Option<Value> {
        // The on-change announcement the TS `_emitGoalUpdate` at the
        // reload emits: the reload already published it through the
        // shared dedupe (an unchanged state stashes nothing, and a later
        // turn-boundary check never re-announces it); the announcing
        // caller takes it exactly once.
        self.reloaded_goal_update
            .lock()
            .expect("reloaded goal update lock")
            .take()
    }

    /// Rebind the engine's session cwd (see [`SessionEngine::set_cwd`]):
    /// the core session rebuild (a replacement flow just retired the old
    /// session) reads the slot, so the rebuilt session's kernel-resident
    /// tools run in the moved-to session's cwd — the TS
    /// `createRuntime({ cwd: sessionManager.getCwd() })` rebind. The
    /// product-default shell-gate driver follows the cwd (it runs shell
    /// gates there); a harness-injected driver stays.
    fn set_cwd(&self, cwd: std::path::PathBuf) {
        {
            let mut slot = self.cwd.write().expect("engine cwd lock");
            if *slot == cwd {
                return;
            }
            (*slot).clone_from(&cwd);
        }
        if self
            .autonomous_driver_default
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            *self
                .autonomous_driver
                .write()
                .expect("autonomous driver lock") =
                std::sync::Arc::new(pa_core::autonomous::ShellAutonomousDriver::new(cwd))
                    as std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>;
        }
    }

    fn configure_rlm_identity(
        &self,
        identity: crate::engine::RlmSessionIdentity,
    ) -> anyhow::Result<()> {
        // This session's own depth gates the kernel `refine.*` host requests
        // (TS `_autoRefineAllowedForSession`: depth-0 sessions only).
        self.rlm_depth
            .store(identity.rlm_depth, std::sync::atomic::Ordering::Relaxed);
        // The inherited default the children registry seeds from (validated;
        // the children create command carries it onward). This session's own
        // effective level resolves through the shared path instead: the
        // worker routes the same create-config `thinking` flag through
        // `configure_model`, so it lands in `effective_thinking` already
        // validated and clamped to the model (the TS `resolveRuntimeSessionOptions`
        // -> sdk.ts `createAgentSession` order).
        if let Some(thinking) = &identity.thinking {
            pa_ai::models::thinking_level_from_str(thinking)
                .ok_or_else(|| anyhow::anyhow!("unknown thinking level \"{thinking}\""))?;
        }
        // The depth bound's TS precedence (agent-session
        // `_resolveRlmMaxDepth`): a persisted chat override wins, then the
        // create-carried bound (inherited), the global setting, the
        // `RLM_MAX_DEPTH` env, and finally the shared default.
        let (max_depth, source) = persisted_rlm_max_depth(identity.session_file.as_deref())
            .map(|depth| (depth, "chat"))
            .or_else(|| {
                identity
                    .rlm_max_depth
                    .map(|depth| (u64::from(depth), "inherited"))
            })
            .or_else(|| {
                let settings =
                    pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
                settings.get_rlm_max_depth().map(|depth| (depth, "global"))
            })
            .or_else(|| {
                std::env::var("RLM_MAX_DEPTH")
                    .ok()
                    .filter(|value| !value.is_empty())
                    .and_then(|value| value.parse::<u64>().ok())
                    .filter(|value| *value >= 1)
                    .map(|depth| (depth, "env"))
            })
            .unwrap_or((u64::from(DEFAULT_RLM_MAX_DEPTH), "default"));
        *self.rlm_max_depth_source.lock().expect("depth source lock") = source;
        if let Some(children) = &self.children {
            let parent = ParentIdentity {
                rlm_depth: identity.rlm_depth,
                rlm_max_depth: max_depth.min(u64::from(u32::MAX)) as u32,
                model: None,
                cwd: identity.cwd.clone(),
                session_id: identity.session_id.clone(),
                session_file: identity.session_file.clone(),
                thinking: identity.thinking.clone(),
                child_script: identity.child_script,
            };
            children.set_identity(parent);
        }
        Ok(())
    }

    /// An agent message from one of this session's children arrived: the
    /// children registry records it so the child's no-reply terminal
    /// notice is withheld (TS `_parentReplyCount` on the child run).
    fn mark_child_reply(&self, child_active_session_id: &str) {
        if let Some(children) = &self.children {
            let children = Arc::clone(children);
            let child = child_active_session_id.to_string();
            // The delivery handler is sync; the registry lock is async, so
            // the mark parks on this engine's own runtime.
            self.runtime.spawn(async move {
                children.mark_replied(&child).await;
            });
        }
    }

    /// The worker's turn completed: release child prompt tasks waiting on
    /// the turn boundary (see `SupervisorChildSessions::wait_turn_done`).
    fn on_turn_done(&self) {
        if let Some(children) = &self.children {
            children.notify_turn_done();
        }
    }

    fn run_side_question(
        &self,
        request: SideQuestionRequest,
        signal: &pa_agent::abort::AbortSignal,
        sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> SideQuestionOutcome {
        // The session's live model (the provider target the turn stream
        // reads): the side question runs on the session model like the
        // compaction summarizer (R8).
        let model = match self.session_model() {
            Ok(model) => model,
            Err(error) => {
                return SideQuestionOutcome::Failed {
                    answer: String::new(),
                    error: error.to_string(),
                }
            }
        };
        let agent = match self.session_agent(&model) {
            Ok(agent) => agent,
            Err(error) => {
                return SideQuestionOutcome::Failed {
                    answer: String::new(),
                    error: error.to_string(),
                }
            }
        };
        let question = request.question.clone();
        let previous_turns = request.previous_turns;
        let retry_policy = pa_core::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY;
        let result =
            self.runtime
                .block_on(pa_core::session_engine::side_question::run_side_question(
                    &agent,
                    &question,
                    &previous_turns,
                    &retry_policy,
                    signal,
                    sink,
                ));
        match result.status {
            pa_core::session_engine::side_question::SideQuestionStatus::Complete => {
                SideQuestionOutcome::Complete {
                    answer: result.answer,
                }
            }
            pa_core::session_engine::side_question::SideQuestionStatus::Cancelled => {
                SideQuestionOutcome::Aborted {
                    answer: result.answer,
                }
            }
            pa_core::session_engine::side_question::SideQuestionStatus::Error => {
                SideQuestionOutcome::Failed {
                    answer: result.answer,
                    error: result
                        .error_message
                        .unwrap_or_else(|| "Side question failed".to_string()),
                }
            }
        }
    }

    fn rlm_child_snapshots(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Value>> + Send + '_>> {
        let children = self.children.clone();
        Box::pin(async move {
            let Some(children) = children else {
                return Vec::new();
            };
            children.child_snapshots().await
        })
    }

    fn connection_commands(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Value>> + Send + '_>> {
        Box::pin(async move {
            // The TS session (and its resource loader) exists from create, so
            // `get_commands` always sees the skill list. This port builds
            // the core session lazily, so a read before any turn builds it
            // now (the async build path, like `system_prompt`; the create
            // prewarm usually already finished it).
            if let Ok(model) = self.resolve_model() {
                if let Err(error) = self.ensure_core_session_async(&model).await {
                    eprintln!("get_commands session build failed: {error:#}");
                    return Vec::new();
                }
            }
            let guard = self.session.lock().await;
            let Some(engine) = guard.as_deref() else {
                return Vec::new();
            };
            // TS `createAgentConnectionCommands` order: extension
            // commands, then prompt templates, then skills. The Rust
            // extension registry does not track per-command source info,
            // so extension entries carry the TS fields minus
            // `sourceInfo`.
            let mut commands = Vec::new();
            if let Some(runner) = &engine.extension_runner {
                let registry = runner.registry().await;
                for command in registry.commands() {
                    let mut entry = json!({
                        "name": command.invocation_name,
                        "registeredName": command.name,
                        "source": "extension",
                    });
                    if let Some(description) = &command.description {
                        entry["description"] = json!(description);
                    }
                    commands.push(entry);
                }
            }
            for template in &engine.prompt_templates {
                let mut entry = json!({
                    "name": template.name,
                    "source": "prompt",
                    "sourceInfo": template.source_info,
                });
                if let Some(hint) = &template.argument_hint {
                    entry["argumentHint"] = json!(hint);
                }
                if !template.description.is_empty() {
                    entry["description"] = json!(template.description);
                }
                commands.push(entry);
            }
            for skill in &engine.skills {
                let mut entry = json!({
                    "name": format!("skill:{}", skill.name),
                    "source": "skill",
                    "sourceInfo": skill.source_info,
                });
                if !skill.description.is_empty() {
                    entry["description"] = json!(skill.description);
                }
                commands.push(entry);
            }
            commands
        })
    }

    fn resource_snapshot(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        Box::pin(async move {
            let session_id = {
                let guard = self.session.lock().await;
                match guard.as_deref() {
                    Some(engine) => engine.session.session_id().await,
                    None => {
                        // The session builds lazily (first prompt); the
                        // resource surface reads the session's own loader
                        // results, so an unbuilt session answers the
                        // empty snapshot.
                        return crate::engine::empty_resource_snapshot();
                    }
                }
            };
            let guard = self.session.lock().await;
            let Some(engine) = guard.as_deref() else {
                return crate::engine::empty_resource_snapshot();
            };
            let cwd = self.cwd().display().to_string();
            let mut skills = Vec::new();
            for skill in &engine.skills {
                let mut entry = json!({
                    "name": skill.name,
                    "filePath": skill.file_path.display().to_string(),
                    "sourceInfo": skill.source_info,
                });
                if !skill.description.is_empty() {
                    entry["description"] = json!(skill.description);
                }
                if let Some(artifact) = artifact_reference(
                    &session_id,
                    &cwd,
                    "skill",
                    &skill.file_path.display().to_string(),
                ) {
                    entry["artifact"] = artifact;
                }
                skills.push(entry);
            }
            let mut prompts = Vec::new();
            for template in &engine.prompt_templates {
                let mut entry = json!({
                    "name": template.name,
                    "filePath": template.file_path,
                    "sourceInfo": template.source_info,
                });
                if !template.description.is_empty() {
                    entry["description"] = json!(template.description);
                }
                if let Some(hint) = &template.argument_hint {
                    entry["argumentHint"] = json!(hint);
                }
                if let Some(artifact) =
                    artifact_reference(&session_id, &cwd, "prompt", &template.file_path)
                {
                    entry["artifact"] = artifact;
                }
                prompts.push(entry);
            }
            let mut context_files = Vec::new();
            for file in &engine.agents_files {
                let mut entry = json!({ "path": file.path.display().to_string() });
                if let Some(artifact) = artifact_reference(
                    &session_id,
                    &cwd,
                    "context_file",
                    &file.path.display().to_string(),
                ) {
                    entry["artifact"] = artifact;
                }
                context_files.push(entry);
            }
            json!({
                "contextFiles": context_files,
                "skills": skills,
                "prompts": prompts,
                "extensions": [],
                "themes": [],
                "diagnostics": {
                    "skills": engine.skill_diagnostics,
                    "prompts": [],
                    "extensions": engine
                        .extension_diagnostics
                        .iter()
                        .map(|error| json!({ "type": "error", "message": error }))
                        .collect::<Vec<_>>(),
                    "themes": [],
                },
            })
        })
    }

    fn system_prompt(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send + '_>>
    {
        Box::pin(async move {
            // The TS session exists from create; this port builds the
            // core session lazily on the first turn, so a prompt read
            // before any turn builds it now (the async build path, never
            // the blocking `ensure_core_session`: this future runs on the
            // caller's runtime).
            let model = self.resolve_model()?;
            self.ensure_core_session_async(&model).await?;
            let guard = self.session.lock().await;
            let engine = guard.as_deref().expect("session built above");
            Ok(engine.system_prompt.clone())
        })
    }

    fn tool_definition(
        &self,
        name: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + '_>> {
        let name = name.to_string();
        Box::pin(async move {
            let guard = self.session.lock().await;
            let engine = guard.as_deref()?;
            let state = engine.session.agent().state().await;
            let tool = state.tools.iter().find(|tool| tool.name() == name)?;
            Some(json!({
                "name": tool.name(),
                "label": tool.label(),
                "description": tool.description(),
                "parameters": tool.parameters(),
            }))
        })
    }

    fn run_refinement(
        &self,
        options: pa_core::session_engine::refine::RefineOptions,
    ) -> anyhow::Result<Value> {
        let model = self.resolve_model()?;
        self.ensure_core_session(&model)?;
        let api_key = self.resolve_request_api_key(&model);
        let global_harness_dir = self.config.agent_dir.clone();
        // The lock covers the clone only (see `run_turn_once`): the
        // refinement below runs a model call, and holding the mutex
        // across it serialized every client read seam behind it.
        let core = self
            .session
            .blocking_lock()
            .clone()
            .expect("session built by ensure_core_session");
        let result = self.runtime.block_on(async {
            core.session
                .refine(
                    &options,
                    pa_core::session_engine::refine::RefinementSource::User,
                    &model,
                    api_key,
                    global_harness_dir,
                )
                .await
        })?;
        serde_json::to_value(&result)
            .map_err(|error| anyhow::anyhow!("refinement result conversion failed: {error}"))
    }

    fn rlm_max_depth_status(&self) -> Value {
        let source = *self.rlm_max_depth_source.lock().expect("depth source lock");
        let max_depth = match &self.children {
            // The live bound the registry enforces (the chat override and
            // the inherited/seeded bound both land there).
            Some(children) => children.rlm_max_depth(),
            None => DEFAULT_RLM_MAX_DEPTH,
        };
        json!({ "maxDepth": max_depth, "source": source })
    }

    fn cancel_rlm_child<'a>(
        &'a self,
        child_id: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            match &self.children {
                Some(children) => children.cancel_child_run(child_id).await,
                None => false,
            }
        })
    }

    fn delete_rlm_subagent<'a>(
        &'a self,
        child_id: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<&'static str>> + Send + 'a>,
    > {
        Box::pin(async move {
            match &self.children {
                Some(children) => children.delete_inactive_subagent(child_id).await,
                None => Ok("not_found"),
            }
        })
    }

    fn set_rlm_max_depth(&self, max_depth: u64, global: bool) -> anyhow::Result<Value> {
        // The live bound every spawn checks (TS updates `_rlmMaxDepth`
        // and rebuilds the system prompt; the bound itself lives in the
        // registry here - see PORTING-NOTES for the prompt-text note).
        if let Some(children) = &self.children {
            children.set_rlm_max_depth(max_depth.min(u64::from(u32::MAX)) as u32);
        }
        *self.rlm_max_depth_source.lock().expect("depth source lock") = "chat";
        // The durable `rlm_max_depth_state` custom entry (TS
        // `appendCustomEntryWithRollback`): a resumed session re-seeds
        // its bound from it. The session that is not built yet parks the
        // entry for its build (the `pending_branch` pattern).
        self.persist_max_depth_state(max_depth);
        // The global settings write (TS `settingsManager.setRlmMaxDepth`
        // + flush + drain): errors join the TS `globalError` field, they
        // do not fail the command.
        let mut result = json!({
            "maxDepth": max_depth,
            "source": "chat",
            "globalSaved": false,
        });
        if global {
            if let Some(error) = self.write_global_rlm_max_depth(max_depth) {
                result["globalError"] = json!(error);
            } else {
                result["globalSaved"] = json!(true);
            }
        }
        Ok(result)
    }

    fn run_prompt(
        &self,
        _prompt_index: usize,
        mut request: PromptRequest,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        // Goal-state changes surface as `goal_update` at the moment they
        // happen (kernel host requests and session-command mutations), so
        // every emit of this prompt runs through the tracking wrapper.
        let mut emit = self.goal_tracking_emit(emit);
        // The accepted-turn row carries the skill-expanded text (TS
        // `_normalizeSubmission` persists the expanded submission as the
        // user message): a `/skill:<name>` command expands against the
        // session's skill inventory before the row persists and
        // broadcasts, so the transcript renders the skill card instead
        // of the raw command. Everything else skips the expansion (and
        // its on-demand session build) entirely.
        if request.message.starts_with("/skill:") {
            request.message = self.expand_skill_submission(&request.message);
        }
        // Session commands (compact/refine/goal/autonomous) never admit a
        // model turn and never record a user-message row: the durable echo
        // row replaces it. Execute before admission so the idle-wait loop
        // below stays reachable only for real turns.
        if let Some(command) =
            crate::session_commands::parse_prompt_session_command(&request.message)
        {
            let Some(execution) =
                crate::session_commands::run_session_command(self, command, &mut emit)
            else {
                return;
            };
            if let Some(error) = &execution.error {
                emit(EngineEvent::Done(Err(error.clone())));
                return;
            }
            // A goal start/resume schedules its continuation context as
            // the turn (an injected custom row): the durable row's
            // message pair precedes the turn it drives (TS's prepared-turn
            // primary record emits at admission), and the loop admission
            // carries the row itself — one representation of the turn.
            // An unchanged `/goal` state stays silent (TS emits
            // goal_update only on state change; the interactive surface
            // dedupes announcements).
            if let Some(message) = execution.continuation_message {
                if !emit(EngineEvent::CustomMessage(
                    crate::session_commands::custom_message_value(&message),
                )) {
                    return;
                }
                self.run_turns(TurnPrompt::Injected(message), aborted, &mut emit);
            } else {
                emit(EngineEvent::Done(Ok(())));
            }
            return;
        }
        // The injected custom row (wire `role: "custom"`) parses to its
        // session shape first: an unparseable row fails the turn instead
        // of double-representing it (the loop would admit a user row with
        // the same text while the row already persists and renders).
        let injected = match &request.custom_message {
            Some(custom) => {
                match serde_json::from_value::<pa_types::session::AgentMessage>(custom.clone()) {
                    Ok(pa_types::session::AgentMessage::Custom(parsed)) => Some(parsed),
                    Ok(_) => {
                        emit(EngineEvent::Done(Err(
                            "injected custom message must carry role \"custom\"".to_string(),
                        )));
                        return;
                    }
                    Err(error) => {
                        emit(EngineEvent::Done(Err(format!(
                            "injected custom message parse failed: {error}"
                        ))));
                        return;
                    }
                }
            }
            None => None,
        };
        // The accepted turn row: an injected custom row replaces the user
        // message — the row persists and renders as itself while the model
        // turn runs on the row itself (TS injected-prompt turns: RLM child
        // terminal notices). The plain turn records the accepted user
        // message; images ride as multimodal content blocks after the text
        // (TS prompt admission: the text part first, then the image parts).
        let accepted = if let Some(custom) = &request.custom_message {
            EngineEvent::CustomMessage(custom.clone())
        } else {
            let mut content = vec![json!({ "type": "text", "text": request.message })];
            for image in &request.images {
                let mut block = match serde_json::to_value(image) {
                    Ok(Value::Object(block)) => Value::Object(block),
                    _ => continue,
                };
                if let Some(object) = block.as_object_mut() {
                    object.insert("type".to_string(), json!("image"));
                }
                content.push(block);
            }
            EngineEvent::UserMessage(json!({
                "role": "user",
                "content": content,
                "timestamp": now_millis(),
            }))
        };
        if !emit(accepted) {
            return;
        }
        // The batched co-delivery rows (TS `_startPreparedTurnActions`: each
        // batched action's primary record emits before the run): one accepted
        // user row per batched message, in delivery order, persisted and
        // rendered like the primary. The batch only ever rides a plain user
        // turn (the injected-custom turns deliver solo — the queue never
        // batches a row that replaces the user row). Each row expands a
        // leading `/skill:` the same way the primary does, so the accepted
        // row persists and renders the expanded submission (TS normalizes
        // every submission at queue time).
        for row in &request.batch {
            let text = if row.text.starts_with("/skill:") {
                self.expand_skill_submission(&row.text)
            } else {
                row.text.clone()
            };
            let mut content = vec![json!({ "type": "text", "text": text })];
            for image in &row.images {
                let mut block = match serde_json::to_value(image) {
                    Ok(Value::Object(block)) => Value::Object(block),
                    _ => continue,
                };
                if let Some(object) = block.as_object_mut() {
                    object.insert("type".to_string(), json!("image"));
                }
                content.push(block);
            }
            if !emit(EngineEvent::UserMessage(json!({
                "role": "user",
                "content": content,
                "timestamp": now_millis(),
            }))) {
                return;
            }
        }
        let turn_prompt = match injected {
            Some(custom) => TurnPrompt::Injected(custom),
            None => TurnPrompt::User {
                text: request.message.clone(),
                images: request.images.clone(),
                batch: request.batch,
            },
        };
        self.run_turns(turn_prompt, aborted, &mut emit);
    }

    fn abort_in_flight_turn(&self) {
        // TS `requestAbort` ends with `this.agent.abort()`: the agent's
        // active-run controller aborts, every loop await rejects, and the
        // in-flight provider fetch cancels. No run in flight (or a
        // not-yet-built session) aborts nothing, like the TS optional
        // chain.
        let agent = self.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            agent.abort();
        }
    }

    /// `set_steering_mode` / `set_follow_up_mode` (TS
    /// `session.setSteeringMode`/`setFollowUpMode`): the queue delivery
    /// mode switches live — the slot feeds any later session build, and
    /// the built session's agent drains by the new mode from the next
    /// boundary (`this.agent.steeringMode = mode`).
    fn set_queue_modes(&self, steering: Option<&str>, follow_up: Option<&str>) {
        {
            let mut modes = self.queue_modes.lock().expect("queue modes");
            if let Some(mode) = steering {
                modes.0 = Some(mode.to_string());
            }
            if let Some(mode) = follow_up {
                modes.1 = Some(mode.to_string());
            }
        }
        let agent = self.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            if let Some(mode) = steering.and_then(Self::queue_mode) {
                agent.set_steering_mode(mode);
            }
            if let Some(mode) = follow_up.and_then(Self::queue_mode) {
                agent.set_follow_up_mode(mode);
            }
        }
    }
}

impl AgentSessionEngine {
    /// Map a wire/settings queue mode ("all"/"one-at-a-time") onto the
    /// agent's `QueueMode`; an unknown value keeps the TS default
    /// ("one-at-a-time").
    fn queue_mode(mode: &str) -> Option<pa_agent::agent::QueueMode> {
        match mode {
            "all" => Some(pa_agent::agent::QueueMode::All),
            "one-at-a-time" => Some(pa_agent::agent::QueueMode::OneAtATime),
            _ => None,
        }
    }

    /// Drive one admitted prompt through the retry-driver model loop and
    /// emit the turn outcome (provider-failure retries + final-row
    /// surfacing). The user row — or a goal continuation's durable context
    /// row — precedes this, so this starts at the model turn. The trailing
    /// `Done` is owned by the caller (`run_turns`).
    fn run_model_turn(
        &self,
        admission: TurnAdmission,
        prompt: &TurnPrompt,
        boundary_passed: &std::sync::Arc<std::sync::atomic::AtomicBool>,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> TurnResult {
        // Model resolution and session construction are hard failures: they
        // never reach the provider, so the retry loop does not apply (the
        // TS loop only classifies provider stream failures).
        let model = match self.resolve_model() {
            Ok(model) => model,
            Err(error) => {
                return TurnResult::Error {
                    error: error.to_string(),
                    assistant: None,
                }
            }
        };
        // TS `_validateCanStartAgentRun`: a resolved model whose provider
        // has no configured credential fails the run before the provider
        // request, with the login-guidance message. The create-config key
        // covers the TS runtime-key candidate (`setRuntimeApiKey`), and the
        // scripted faux seam has no credentials at all.
        if self.config.faux_script.is_none() && self.current_selection().api_key.is_none() {
            let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
            let mut registry = pa_core::models::ModelRegistry::create(
                auth,
                self.config.agent_dir.join("models.json"),
            );
            registry.load_private_authorization_from_cache();
            if !registry.has_configured_auth(&model) {
                let uses_oauth = registry
                    .auth
                    .get_all()
                    .credential(&model.provider)
                    .is_some_and(|credential| {
                        matches!(credential, pa_core::auth::AuthCredential::Oauth { .. })
                    });
                let message = if uses_oauth {
                    format!(
                        "Authentication failed for \"{}\". Credentials may have expired or network is unavailable.\n\nRun /login to update credentials.",
                        model.provider
                    )
                } else {
                    let docs = pa_core::packages::docs_path();
                    format!(
                        "No API key found for {}.\n\nUse /login to log into a provider via OAuth or API key. See:\n  {}\n  {}",
                        model.provider,
                        docs.join("providers.md").display(),
                        docs.join("models.md").display()
                    )
                };
                return TurnResult::Error {
                    error: message,
                    assistant: None,
                };
            }
        }
        let agent = match self.session_agent(&model) {
            Ok(agent) => agent,
            Err(error) => {
                return TurnResult::Error {
                    error: format!("{error:#}"),
                    assistant: None,
                }
            }
        };
        let policy = self.retry_policy();
        let failover_policy = self.failover_policy();
        let candidates = self.failover_candidates(&model);
        // The pa-core retry driver owns the attempt loop; this engine owns
        // one turn. The driver awaits each attempt to completion before
        // emitting retry events, so the single `emit` reference is handed
        // through a RefCell slot to whichever closure is currently running.
        let emit_cell = std::cell::RefCell::new(emit);
        // The overflow compact-and-retry re-issues the loop without a new
        // user message, so its turn starts as a continuation (TS
        // `agent.continue()`); an ordinary turn starts fresh and only the
        // retry driver's re-issues continue.
        let first_attempt = std::cell::Cell::new(matches!(admission, TurnAdmission::FreshPrompt));
        // Failover switch/restore re-bind the live agent's model and append
        // the model-change row the TS backup-model retry logs. The primary
        // (model + thinking level) is captured at the first switch and
        // restored on every settled outcome.
        let persistence = {
            let guard = self.session.blocking_lock();
            guard
                .as_ref()
                .map(|engine| engine.session.shared_persistence())
        };
        // Retry/failover adoption telemetry (TS `auto_retry_start` counting):
        // retries increment `retry_count`, provider switches `failover_count`.
        let telemetry = {
            let guard = self.session.blocking_lock();
            guard.as_deref().and_then(|engine| engine.telemetry.clone())
        };
        let primary_state: std::cell::RefCell<
            Option<(
                pa_types::ai::Model,
                pa_agent::types::ThinkingLevel,
                Option<String>,
            )>,
        > = std::cell::RefCell::new(None);
        let result = self.runtime.block_on(
            pa_core::session_engine::provider_failover::run_turn_with_provider_failover(
                &policy,
                &failover_policy,
                &candidates,
                model.context_window,
                None,
                || {
                    let mut emit = emit_cell.borrow_mut();
                    let first = first_attempt.get();
                    first_attempt.set(false);
                    let agent = agent.clone();
                    let prompt = prompt.clone();
                    let model = model.clone();
                    async move {
                        // A retry re-issues the failed turn: the failed
                        // assistant message leaves the loop context first
                        // (TS `messages.slice(0, -1)` keeps the retried
                        // request free of the error turn), then `continue`.
                        if !first {
                            drop_trailing_assistant(&agent).await;
                        }
                        match self
                            .run_turn_once(&agent, &prompt, first, boundary_passed, &mut **emit)
                            .await
                        {
                            Ok(TurnOnce::Message { assistant }) => {
                                // The settled messages already reached the
                                // transcript through their message_end
                                // events (the failure included: TS persists
                                // and renders it like any outcome); this
                                // arm only carries the final message to the
                                // retry classifier.
                                Ok(*assistant)
                            }
                            Ok(TurnOnce::None) => Err(anyhow::anyhow!("No response produced.")),
                            Ok(TurnOnce::Aborted) => Ok(aborted_message(&model)),
                            Err(error) => Err(error),
                        }
                    }
                },
                |event| {
                    let mut emit = emit_cell.borrow_mut();
                    let telemetry = telemetry.clone();
                    async move {
                        if let Some(telemetry) = &telemetry {
                            telemetry.note_auto_retry();
                            if matches!(
                                &event,
                                pa_core::session_engine::auto_retry::AutoRetryEvent::Start {
                                    reason:
                                        pa_core::session_engine::auto_retry::RetryStartReason::Backup { .. },
                                    ..
                                }
                            ) {
                                telemetry.note_provider_failover();
                            }
                        }
                        let engine_event = retry_event_to_engine_event(event);
                        if !emit(engine_event) {
                            anyhow::bail!("emit cancelled");
                        }
                        Ok(())
                    }
                },
                |delay| {
                    async move {
                        // Abort-aware wait: the worker's cancel flag stops
                        // the retry sleep early (TS `_retryAbortController`).
                        let deadline = tokio::time::Instant::now() + delay;
                        loop {
                            if aborted() {
                                return false;
                            }
                            if tokio::time::Instant::now() >= deadline {
                                return true;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    }
                },
                |next: &pa_types::ai::Model| {
                    let agent = agent.clone();
                    let persistence = persistence.clone();
                    {
                        let mut primary = primary_state.borrow_mut();
                        // Capture the primary model + thinking level + key
                        // once (TS `_backupModel` state): the level the
                        // session was built with, restored when the turn
                        // settles.
                        if primary.is_none() {
                            *primary = Some((
                                model.clone(),
                                map_thinking_level(self.effective_thinking()),
                                self.resolve_request_api_key(&model),
                            ));
                        }
                    }
                    let next = next.clone();
                    async move {
                        let agent_model = json_round_trip(&next)
                            .ok_or_else(|| anyhow::anyhow!("model conversion failed"))?;
                        // Clamp the requested level to what the switched-to
                        // model supports (TS `clampThinkingLevel` on the
                        // backup switch); the primary's level is restored
                        // with the primary.
                        let clamped =
                            pa_ai::models::clamp_thinking_level(&next, self.effective_thinking());
                        // The stream's provider target follows the switch
                        // (the same slot `set_model` swaps): the retried
                        // request hits the switched-to provider with its
                        // resolved key.
                        {
                            let mut target =
                                self.provider_target.write().expect("provider target lock");
                            *target = Some(ProviderTarget {
                service_tier: *self.service_tier.read().expect("service tier lock"),
                                api_key: self.resolve_request_api_key(&next),
                                model: next.clone(),
                            });
                        }
                        agent.set_model(agent_model).await;
                        agent
                            .set_thinking_level(map_thinking_level(clamped))
                            .await;
                        if let Some(persistence) = persistence {
                            let mut session = persistence.lock().await;
                            session.append_model_change(&next.provider, &next.id)?;
                        }
                        Ok(())
                    }
                },
                || {
                    let agent = agent.clone();
                    let persistence = persistence.clone();
                    let primary = primary_state.borrow().clone();
                    async move {
                        let Some((primary_model, thinking_level, primary_api_key)) = primary
                        else {
                            return Ok(None);
                        };
                        let agent_model = json_round_trip(&primary_model)
                            .ok_or_else(|| anyhow::anyhow!("model conversion failed"))?;
                        // Restore the stream's provider target with the
                        // primary (the slot the build-time target set).
                        {
                            let mut target =
                                self.provider_target.write().expect("provider target lock");
                            *target = Some(ProviderTarget {
                service_tier: *self.service_tier.read().expect("service tier lock"),
                                api_key: primary_api_key,
                                model: primary_model.clone(),
                            });
                        }
                        agent.set_model(agent_model).await;
                        agent.set_thinking_level(thinking_level).await;
                        if let Some(persistence) = persistence {
                            let mut session = persistence.lock().await;
                            session.append_model_change(
                                &primary_model.provider,
                                &primary_model.id,
                            )?;
                        }
                        Ok(Some(format!(
                            "{}/{}",
                            primary_model.provider, primary_model.id
                        )))
                    }
                },
            ),
        );
        match result {
            Ok(message) => match message.stop_reason {
                // The failure already reached the transcript as the final
                // assistant message; the turn error still travels to
                // headless callers through the turn result.
                StopReason::Error => TurnResult::Error {
                    error: message
                        .error_message
                        .clone()
                        .filter(|error| !error.is_empty())
                        .unwrap_or_else(|| "Assistant response failed".to_string()),
                    assistant: Some(Box::new(message)),
                },
                StopReason::Aborted => TurnResult::Aborted,
                _ => TurnResult::Message(Box::new(message)),
            },
            Err(error) => TurnResult::Error {
                error: error.to_string(),
                assistant: None,
            },
        }
    }

    /// Clear the automatic-compaction abort slot when `controller`'s run
    /// settles (TS `_runAutoCompaction`'s `finally`: only the run that
    /// assigned the controller clears it, so a stale run cannot clear a
    /// newer run's slot).
    pub(crate) fn clear_auto_compaction_abort(&self, controller: &std::sync::Arc<AbortController>) {
        let mut slot = self
            .auto_compaction_abort
            .lock()
            .expect("auto compaction abort lock");
        if slot
            .as_ref()
            .is_some_and(|live| std::sync::Arc::ptr_eq(live, controller))
        {
            *slot = None;
        }
    }

    /// Drop pending turn-boundary requests (aborted turns; TS `_checkCompaction`
    /// abort arm clears both the compaction and the refine request).
    fn drop_turn_boundary_requests(&self) {
        let guard = self.session.blocking_lock();
        if let Some(engine) = guard.as_deref() {
            self.runtime.block_on(engine.turn_boundary.clear_pending());
        }
    }

    /// Consume pending `compact.run`/`refine.run` requests at the settled
    /// turn boundary, in TS order (compaction, then refinement). The
    /// compaction outcome reaches the transcript like `/compact` (the
    /// worker persists the entry and broadcasts `compaction_end`); the
    /// model-facing refinement notice reaches it like the `/refine` notice
    /// row. A consumed compaction stops the run (TS: requested compaction
    /// stops the loop on purpose; the model resumes on the next prompt or
    /// queued continuation).
    fn run_turn_boundary(&self, emit: &mut dyn FnMut(EngineEvent) -> bool) -> BoundaryRun {
        // Fast path: nothing scheduled (the common turn).
        let has_pending = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self.runtime.block_on(async {
                    engine.turn_boundary.compaction_scheduled().await
                        || engine.turn_boundary.refine_pending().await
                }),
                None => false,
            }
        };
        if !has_pending {
            return BoundaryRun::Proceed;
        }
        // The session's live model (the provider target the turn stream
        // reads), never a fresh startup-chain resolution (R8: a
        // re-resolution landed the summarizer on an unconfigured provider).
        let model = match self.session_model() {
            Ok(model) => model,
            Err(error) => {
                eprintln!("pa-daemon: boundary request could not resolve a model: {error:#}");
                return BoundaryRun::Proceed;
            }
        };
        let api_key = self.resolve_request_api_key(&model);
        let global_harness_dir = self.config.agent_dir.clone();
        // TS `_runAutoCompaction("requested")` emits the start event before
        // the summarizer runs (the `Agent requested compaction, compacting
        // context...` loader swap), carrying the pending instructions.
        let scheduled = {
            let guard = self.session.blocking_lock();
            match guard.as_deref() {
                Some(engine) => self
                    .runtime
                    .block_on(async { engine.turn_boundary.scheduled_compaction().await }),
                None => None,
            }
        };
        if let Some(pending) = scheduled {
            if !emit(EngineEvent::CompactionStart {
                event: crate::compaction::compaction_start_event(
                    "requested",
                    pending.instructions.as_deref(),
                ),
            }) {
                return BoundaryRun::Cancelled;
            }
        }
        // TS `_runAutoCompaction` assigns `_autoCompactionAbortController`
        // for the requested run's duration: an `abort_compaction` command
        // lands in the slot and cancels the in-flight summarizer.
        let controller = std::sync::Arc::new(AbortController::new());
        let signal = controller.signal();
        {
            *self
                .auto_compaction_abort
                .lock()
                .expect("auto compaction abort lock") = Some(std::sync::Arc::clone(&controller));
        }
        let consumption = {
            let guard = self.session.blocking_lock();
            let Some(engine) = guard.as_deref() else {
                self.clear_auto_compaction_abort(&controller);
                return BoundaryRun::Proceed;
            };
            let consumed = self.runtime.block_on(async {
                engine
                    .consume_turn_boundary_requests(
                        &model,
                        api_key,
                        global_harness_dir,
                        Some(&signal),
                    )
                    .await
            });
            self.clear_auto_compaction_abort(&controller);
            consumed
        };
        let mut stopped_for_compaction = false;
        let mut compacted = false;
        match consumption.compaction {
            Some(Ok(pa_core::session_engine::compact_session::CompactOutcome::Ran(run))) => {
                // The post-compaction kernel notice goes out before the
                // settled end (TS `_syncKernelStateAfterCompaction` runs
                // inside `_performCompaction`): its `message_start` /
                // `message_end` pair precedes `compaction_end`.
                if let Some(message) = &run.ipython_state {
                    if !emit(EngineEvent::CustomMessage(
                        crate::session_commands::custom_message_value(message),
                    )) {
                        return BoundaryRun::Cancelled;
                    }
                }
                // Adoption telemetry (TS `compaction_end` handling counts
                // every completed compaction into the active run).
                {
                    let guard = self.session.blocking_lock();
                    if let Some(telemetry) = guard
                        .as_deref()
                        .and_then(|engine| engine.telemetry.as_ref())
                    {
                        telemetry.note_compaction();
                    }
                }
                // TS `_scheduleAutoRefineAfterCompaction`: the compaction
                // arms the compact-trigger review; the run stops on
                // purpose, so the round services it before the `Done`.
                self.mark_compact_auto_refine_pending();
                let entry = serde_json::to_value(&run.entry).unwrap_or(Value::Null);
                // The wire result is the TS `CompactionResult` shape
                // (`_performCompaction`'s return, details included); the
                // event reason is `requested` (TS `_runAutoCompaction`).
                let result = crate::compaction::compaction_result_value(&run.result, &run.entry);
                let event =
                    crate::compaction::compaction_end_success("requested", &result, false, None);
                if !emit(EngineEvent::Compaction { entry, event }) {
                    return BoundaryRun::Cancelled;
                }
                stopped_for_compaction = true;
                compacted = true;
            }
            // A skip consumed the request (the Rust `/compact` contract):
            // the durable disclosure row goes out with its message pair,
            // then the end event carries the TS warning.
            Some(Ok(pa_core::session_engine::compact_session::CompactOutcome::Skipped(
                message,
            ))) => {
                eprintln!("pa-daemon: requested compaction skipped: {message}");
                if !self.emit_unsuccessful_compaction(
                    pa_core::session_engine::messages::CompactionOutcomeReason::Requested,
                    pa_core::session_engine::messages::CompactionOutcomeKind::Skipped,
                    &format!("Requested compaction skipped: {message}"),
                    None,
                    emit,
                ) {
                    return BoundaryRun::Cancelled;
                }
                stopped_for_compaction = true;
            }
            Some(Err(error)) => {
                // An aborted run is user-initiated, not a failure (TS
                // `_runAutoCompaction`'s `aborted` check before the skip and
                // failure arms): the request is consumed either way, so the
                // run stops like a completed requested compaction.
                let cancelled = pa_agent::abort::is_abort_error(&error);
                let message = if cancelled {
                    "Requested compaction cancelled".to_string()
                } else {
                    eprintln!("pa-daemon: requested compaction failed: {error:#}");
                    format!("Requested compaction failed: {error:#}")
                };
                let outcome = if cancelled {
                    pa_core::session_engine::messages::CompactionOutcomeKind::Cancelled
                } else {
                    pa_core::session_engine::messages::CompactionOutcomeKind::Failed
                };
                if !self.emit_unsuccessful_compaction(
                    pa_core::session_engine::messages::CompactionOutcomeReason::Requested,
                    outcome,
                    &message,
                    None,
                    emit,
                ) {
                    return BoundaryRun::Cancelled;
                }
                stopped_for_compaction = true;
            }
            None => {}
        }
        match consumption.refinement {
            Some(Ok(refinement)) => {
                // The model-facing notice row (durable, like the session
                // persistence of TS `refine()`).
                if refinement.applied_edits.iter().any(|edit| edit.applied) {
                    let notice = pa_core::session_engine::refine::create_refinement_notice_message(
                        &refinement,
                        pa_core::session_engine::refine::RefinementSource::SelfRefine,
                    );
                    if !emit(EngineEvent::CustomMessage(
                        crate::session_commands::custom_message_value(&notice),
                    )) {
                        return BoundaryRun::Cancelled;
                    }
                }
            }
            // TS emits `refine_failed` on the wire; the Rust daemon wire
            // has no refine event yet — the worker log keeps the failure.
            Some(Err(error)) => {
                eprintln!("pa-daemon: requested refinement failed: {error:#}");
            }
            None => {}
        }
        if stopped_for_compaction {
            BoundaryRun::StoppedForCompaction { compacted }
        } else {
            BoundaryRun::Proceed
        }
    }

    /// The turn loop: run one model turn, consume turn-boundary requests,
    /// then ask the autonomous driver what follows. A continuation is
    /// injected as a durable user row and drives the next turn; a stop
    /// surfaces its reason as a durable `autonomous_status` row. The single
    /// trailing `Done` ends the run.
    fn run_turns(
        &self,
        first: TurnPrompt,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        // The first turn admits the prompt (a user prompt with its
        // images, or an injected custom row); every autonomous follow-up
        // turn runs text-only (the TS driver regenerates from the loop
        // state, never re-sending attachments).
        let prompt = first;
        let mut overflow_retry = false;
        // Whether a loop-boundary frame already passed in this runner item
        // (a `turn_end` of an inner turn or an `agent_end` of an earlier
        // run): the worker's run-opening frames are the item's first run's
        // `agent_start`/`turn_start`, so the engine forwards the later
        // runs' opening frames — the retried/continued runs TS restarts
        // with their own frames (one `agent_start` + `agent_end` pair per
        // agent run).
        let boundary_passed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // TS resets `_overflowRecovery` when a message that starts an agent
        // run enters the loop: the admitted prompt here.
        self.reset_overflow_recovery();
        loop {
            // TS `_runPreTurnCompaction` (`beforeModelSelection` for queued
            // prompts): a stale overflow error from the previous run gets
            // its compact-and-retry attempt on the newly admitted prompt
            // (Case 1 runs before the threshold arm), then a threshold
            // crossing that predates this admission compacts before the
            // turn runs; the turn then proceeds either way.
            if !self.run_pre_turn_overflow_compaction(emit) {
                return;
            }
            if self.run_auto_compaction(emit) == AutoCompactionRun::Cancelled {
                return;
            }
            // The overflow compact-and-retry re-issues the loop without a
            // new user message; every other iteration runs a fresh prompt
            // (autonomous continuations are real user rows).
            // `mem::take` clears the retry slot as it reads it (the
            // slot's cleared value is never read back on the loop's
            // exits, so a plain clear would be a dead store).
            let admission = if std::mem::take(&mut overflow_retry) {
                TurnAdmission::Continue
            } else {
                TurnAdmission::FreshPrompt
            };
            let turn = self.run_model_turn(admission, &prompt, &boundary_passed, aborted, emit);
            match turn {
                TurnResult::Message(_assistant) => {
                    // A settled non-error turn resets the overflow
                    // recovery state (TS resets at every non-error
                    // assistant message end) and counts into the
                    // auto-refine review prompt's turn line (TS
                    // `_assistantTurnsSinceAutoRefine`'s message_end
                    // increment).
                    self.reset_overflow_recovery();
                    self.note_settled_turn_since_auto_refine_review();
                }
                // An aborted turn never services boundary requests (TS
                // `_checkCompaction` abort arm): drop any pending ones so
                // a stale request cannot leak into the next turn.
                TurnResult::Aborted => {
                    self.reset_overflow_recovery();
                    self.drop_turn_boundary_requests();
                    emit(EngineEvent::DoneAborted);
                    return;
                }
                TurnResult::Error { error, assistant } => {
                    // TS `_checkCompaction` Case 1 at `agent_end`: a
                    // context-overflow error triggers one compact-and-retry
                    // attempt before the run ends.
                    let arm = assistant.map_or(OverflowArmRun::NotApplicable, |assistant| {
                        self.run_overflow_compaction(&assistant, emit)
                    });
                    match arm {
                        OverflowArmRun::RetryTurn => {
                            overflow_retry = true;
                            continue;
                        }
                        OverflowArmRun::NotApplicable | OverflowArmRun::Finished => {}
                        OverflowArmRun::Cancelled => return,
                    }
                    // TS `_stopGoalContinuationForTerminalMessage`: an
                    // error assistant message fails an active goal (the
                    // state change surfaces with the trailing `Done`
                    // through the tracking wrapper).
                    self.finish_goal_for_terminal_error(&error);
                    emit(EngineEvent::Done(Err(error)));
                    return;
                }
            };
            // Turn-boundary consumption (TS `_checkCompaction` requested
            // arm, then `_consumePendingRequestedRefine`): requests the
            // kernel `compact.run`/`refine.run` host handlers scheduled
            // during this turn run now, between turns.
            match self.run_turn_boundary(emit) {
                BoundaryRun::Cancelled => return,
                BoundaryRun::StoppedForCompaction { compacted } => {
                    // The requested compaction armed the trigger; the run
                    // stops here, so the round services it before the
                    // `Done` reaches attached clients (TS agent_end's
                    // background scheduling, mapped onto the quiescent
                    // boundary).
                    if !self.run_compact_auto_refine(emit) {
                        return;
                    }
                    // TS `compact()`'s `didCompact` + active-goal branch:
                    // a compaction that ran re-consults the goal at the
                    // post-compaction boundary (`_goalContinuationAwaitsRlmWork
                    // ||= !hasQueuedMessages(); resumeQueuedWork()`); a
                    // skip or failure stays stopped like the TS catch arm.
                    if compacted && !aborted() {
                        match self.goal_turn_end_boundary() {
                            GoalBoundary::End => {
                                emit(EngineEvent::Done(Ok(())));
                                return;
                            }
                            GoalBoundary::Proceed => {}
                        }
                    }
                    emit(EngineEvent::Done(Ok(())));
                    return;
                }
                BoundaryRun::Proceed => {}
            }
            // TS agent_end `_checkCompaction` threshold arm (after the
            // requested arm, which never falls through to it): the settled
            // turn's usage crossing the reserve headroom auto-compacts;
            // the autonomous continuation decision below still runs, so a
            // continuation the driver queues continues after the
            // compaction like the TS queued continuation.
            if self.run_auto_compaction(emit) == AutoCompactionRun::Cancelled {
                return;
            }
            // The compact-trigger round at the settled boundary (TS
            // `_scheduleAutoRefineAfterAgentEnd`'s background review after
            // the agent_end arms ran): a compaction armed earlier — the
            // pre-turn arm, an overflow compact-and-retry, or this
            // boundary's arms — services its review here, before the
            // autonomous decision may queue a continuation.
            if !self.run_compact_auto_refine(emit) {
                return;
            }
            // TS `_getContinuationMessages` at the agent loop's natural
            // turn end: the goal continuation takes exclusive priority
            // over autonomous continuation, so the goal arm runs first
            // and an active goal ends the boundary either way (a minted
            // follow-up, or a deferral behind queued input / unsettled
            // RLM descendant work). `signal?.aborted` gates the hook.
            if !aborted() {
                match self.goal_turn_end_boundary() {
                    GoalBoundary::End => {
                        emit(EngineEvent::Done(Ok(())));
                        return;
                    }
                    GoalBoundary::Proceed => {}
                }
            }
            // The natural autonomous continuation already churned inside
            // the agent run (the in-run hook, TS `getContinuationMessages`
            // -> `_getContinuationMessages`'s autonomous arm): what may
            // remain here is the continuation the threshold arm minted and
            // held ahead of the boundary's compaction (TS
            // `_queueAutonomousContinuationForThresholdCompaction` queues
            // it as a `followUp` admission) — hand it to the worker's queue
            // lanes, which run it as its own item after this run ends. A
            // stop surfaces nothing here: the headless status and exit
            // contracts carry it (TS: no row, no stream frame).
            if let Some(text) = self
                .held_autonomous_continuation
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                let admission = self
                    .autonomous_admission
                    .lock()
                    .expect("autonomous admission lock")
                    .clone();
                if let Some(admit) = admission {
                    admit(text);
                }
            }
            emit(EngineEvent::Done(Ok(())));
            return;
        }
    }

    /// The hosted session's agent loop, building the session on first use.
    fn session_agent(
        &self,
        model: &Model,
    ) -> anyhow::Result<std::sync::Arc<pa_agent::agent::Agent>> {
        // Build (once) through the shared gated funnel, so the
        // turn-driven build and the read-seam builds (and the replacement
        // teardown's fresh rebuild) all adopt the same pre-build state -
        // goal mirrors, a parked depth override, and a parked replacement
        // branch.
        {
            let guard = self.session.blocking_lock();
            if guard.is_none() {
                drop(guard);
                self.ensure_core_session(model)?;
            }
        }
        let guard = self.session.blocking_lock();
        let engine = guard.as_deref().expect("session built");
        Ok(std::sync::Arc::clone(engine.session.agent()))
    }

    /// The provider retry policy from settings (TS `providerRetryPolicy`).
    fn retry_policy(&self) -> pa_core::session_engine::provider_retry::ProviderRetryPolicy {
        pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir)
            .get_provider_retry_policy()
    }

    /// The provider-failover policy from settings (`retry.failover`).
    fn failover_policy(
        &self,
    ) -> pa_core::session_engine::provider_failover::ProviderFailoverPolicy {
        pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir)
            .get_provider_failover_policy()
    }

    /// The failover chain for `model`: the other auth-configured providers
    /// serving the same model id, in catalog order after the current one,
    /// filtered by the daemon model allowlist — a failover must never land
    /// a turn on a provider the operator pinned out (the same
    /// `allowedModels` gate as every other resolution). Faux-script
    /// sessions never fail over (their failures are deterministic test
    /// fixtures, and a second provider would only reroute the scripted
    /// queue).
    fn failover_candidates(&self, model: &pa_types::ai::Model) -> Vec<pa_types::ai::Model> {
        if self.config.faux_script.is_some() {
            return Vec::new();
        }
        let auth = pa_core::auth::AuthStorage::create(&self.config.agent_dir);
        let mut registry =
            pa_core::models::ModelRegistry::create(auth, self.config.agent_dir.join("models.json"));
        registry.load_private_authorization_from_cache();
        let available: Vec<pa_types::ai::Model> =
            registry.get_available().into_iter().cloned().collect();
        let candidates = pa_core::models::failover_candidates(model, &available);
        match crate::model_allowlist::load(&self.cwd(), &self.config.agent_dir) {
            DaemonAllowlist::Unrestricted => candidates,
            DaemonAllowlist::Allowed(patterns) => candidates
                .into_iter()
                .filter(|candidate| {
                    pa_core::models::model_allowed(
                        &format!("{}/{}", candidate.provider, candidate.id),
                        &patterns,
                    )
                })
                .collect(),
            // Fail closed on an unreadable policy: no failover candidate
            // may bypass the configured allowlist.
            DaemonAllowlist::Unreadable(_) => Vec::new(),
        }
    }

    /// Run one turn, streaming assistant updates through `emit` as they
    /// arrive. The first attempt prompts the session; retries continue the
    /// parked turn. Returns the turn outcome: the final assistant message
    /// (provider failures included), `None` when no assistant message was
    /// produced, or `Aborted` when the emit callback cancelled the run.
    async fn run_turn_once(
        &self,
        agent: &std::sync::Arc<pa_agent::agent::Agent>,
        prompt: &TurnPrompt,
        first_attempt: bool,
        boundary_passed: &std::sync::Arc<std::sync::atomic::AtomicBool>,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) -> anyhow::Result<TurnOnce> {
        // Stream assistant events while the turn runs.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<EngineEvent>();
        // Goal usage accounting (TS `_accountGoalUsageForAssistantMessage`
        // at the message_end hook) shares the same per-message hook: while a
        // goal is active, each settled non-error assistant message records
        // its token delta; a budget crossing moves the goal to
        // `budget_limited` and the next emitted event publishes the
        // `goal_update`. The handles come from the engine mirror: the core
        // session's own mutex is held across the turn's admission.
        let goal_runtime = self.goal_runtime.lock().expect("goal runtime lock").clone();
        let goal_budget_crossed = std::sync::Arc::clone(&self.goal_budget_crossed);
        // The run-opening boundary frames (TS `agent_start` / `turn_start`)
        // are carried by the worker's own run-opening frames for the
        // item's first run, so this subscription forwards them only once a
        // boundary frame already passed in the item: an inner turn of the
        // same run (after the first `turn_end`) or a later run of the same
        // item (after an `agent_end` — a retry or a compact-and-retry
        // re-issue, exactly the runs TS restarts with their own frames).
        let boundary_passed = std::sync::Arc::clone(boundary_passed);
        let subscription = {
            let tx = tx.clone();
            let boundary_passed = std::sync::Arc::clone(&boundary_passed);
            // Per-message usage accounting runs on every settled assistant
            // message (whatever the stop reason except errors), matching the
            // TS message_end hook. The driver owns the policy; this loop
            // only forwards the message to it.
            let autonomous_state = std::sync::Arc::clone(&self.autonomous);
            let autonomous_driver = std::sync::Arc::clone(
                &*self
                    .autonomous_driver
                    .read()
                    .expect("autonomous driver lock"),
            );
            agent
                .subscribe(move |event, _signal| {
                    let tx = tx.clone();
                    let boundary_passed = std::sync::Arc::clone(&boundary_passed);
                    let autonomous_state = std::sync::Arc::clone(&autonomous_state);
                    let autonomous_driver = std::sync::Arc::clone(&autonomous_driver);
                    let goal_runtime = goal_runtime.clone();
                    let goal_budget_crossed = goal_budget_crossed.clone();
                    Box::pin(async move {
                        use pa_agent::types::AgentEvent;
                        if let AgentEvent::MessageEnd {
                            message:
                                pa_agent::types::AgentMessage::Standard(
                                    pa_agent::types::Message::Assistant(assistant),
                                ),
                        } = &event
                        {
                            if let Some(message) =
                                json_round_trip::<_, pa_types::ai::AssistantMessage>(assistant)
                            {
                                let mut state = autonomous_state.lock().await;
                                autonomous_driver.account_message(&mut state, &message);
                                // Goal accounting mirrors the TS guard: only
                                // turns that were neither errors nor aborted
                                // spend the goal's budget, and only while
                                // the goal is active.
                                if let Some(handles) = goal_runtime.as_ref() {
                                    if !matches!(
                                        message.stop_reason,
                                        pa_types::ai::StopReason::Error
                                            | pa_types::ai::StopReason::Aborted
                                    ) {
                                        let mut driver = handles.driver.lock().await;
                                        let mut session = handles.session.lock().await;
                                        // The loop does not assign message
                                        // ids in-process; the timestamp is
                                        // the double-counting guard identity.
                                        let message_id = format!("a-{}", message.timestamp);
                                        // TS `_accountGoalUsageForAssistantMessage`
                                        // returning true: the budget crossing
                                        // moves the goal to `budget_limited`
                                        // (the tracking wrapper publishes the
                                        // `goal_update` with the next emit),
                                        // and the natural boundary mints the
                                        // budget-limit wrap-up steer.
                                        // TS `_shouldStopAfterTurn`'s catch:
                                        // goal accounting must not interrupt
                                        // the core agent loop; a failed
                                        // persist only warns.
                                        match driver
                                            .record_assistant_usage(&mut session, &message_id, &message.usage)
                                        {
                                            Ok(
                                                pa_core::session_engine::goal_driver::UsageOutcome::BudgetReached,
                                            ) => {
                                                // TS `_shouldStopAfterTurn`'s budget
                                                // arm arms the wrap-up steer: the
                                                // natural boundary reads it.
                                                goal_budget_crossed
                                                    .store(true, std::sync::atomic::Ordering::SeqCst);
                                            }
                                            Ok(_) => {}
                                            Err(error) => {
                                                eprintln!(
                                                    "pa-daemon: goal usage accounting persist failed: {error:#}"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        match &event {
                            AgentEvent::MessageStart {
                                message: agent_message,
                            } => {
                                if matches!(
                                    agent_message,
                                    pa_agent::types::AgentMessage::Standard(
                                        pa_agent::types::Message::Assistant(_)
                                    )
                                ) {
                                    if let Some(value) = session_wire_value(agent_message) {
                                        let _ = tx.send(EngineEvent::AssistantUpdate {
                                            message: value,
                                            stream_event: Some(json!({ "type": "start" })),
                                        });
                                    }
                                }
                            }
                            AgentEvent::MessageUpdate {
                                message: agent_message,
                                assistant_message_event: stream_event,
                            } => {
                                if matches!(
                                    agent_message,
                                    pa_agent::types::AgentMessage::Standard(
                                        pa_agent::types::Message::Assistant(_)
                                    )
                                ) {
                                    if let Some(value) = session_wire_value(agent_message) {
                                        let _ = tx.send(EngineEvent::AssistantUpdate {
                                            message: value,
                                            stream_event: stream_event_value(stream_event),
                                        });
                                    }
                                }
                            }
                            AgentEvent::MessageEnd {
                                message: agent_message,
                            } => {
                                // Settled messages persist as session entries
                                // and reach clients: every assistant message
                                // (the TS `message_end` hook appends each
                                // one, mid-run tool-call turns included) and
                                // every tool-result message (framed as a
                                // message pair).
                                match agent_message {
                                    pa_agent::types::AgentMessage::Standard(
                                        pa_agent::types::Message::Assistant(_)
                                            | pa_agent::types::Message::ToolResult(_),
                                    ) => {
                                        if let Some(value) = session_wire_value(agent_message) {
                                            let event = if matches!(
                                                agent_message,
                                                pa_agent::types::AgentMessage::Standard(
                                                    pa_agent::types::Message::ToolResult(_)
                                                )
                                            ) {
                                                EngineEvent::ToolResultMessage(value)
                                            } else {
                                                EngineEvent::AssistantMessage(value)
                                            };
                                            let _ = tx.send(event);
                                        }
                                    }
                                    // An in-run continuation's user row
                                    // (the autonomous hook's mint): the
                                    // loop drains it between turns, so the
                                    // `boundary_passed` gate separates it
                                    // from the admitted prompt's row — the
                                    // turn loop already emitted that one at
                                    // admission. Forwarded as the accepted
                                    // user-message frame (persist + the
                                    // message pair).
                                    pa_agent::types::AgentMessage::Standard(
                                        pa_agent::types::Message::User(_),
                                    ) if boundary_passed
                                        .load(std::sync::atomic::Ordering::SeqCst) =>
                                    {
                                        if let Some(value) = session_wire_value(agent_message) {
                                            let _ = tx.send(EngineEvent::UserMessage(value));
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            // The loop-boundary frames (TS `turn_start` /
                            // `turn_end` / `agent_start` / `agent_end`): the
                            // run-opening `turn_start` and `agent_start`
                            // stay with the worker's run-opening frames for
                            // the item's first run (the `boundary_passed`
                            // gate above — a later run of the same item
                            // forwards its own), `turn_end` carries the
                            // terminal assistant message plus the turn's
                            // tool-result messages, and `agent_end` the
                            // run's whole message set (the rows themselves
                            // persist and broadcast through their own
                            // events; these frames carry only the
                            // accumulated payloads, in the session wire
                            // shapes).
                            AgentEvent::TurnStart => {
                                if boundary_passed.load(std::sync::atomic::Ordering::SeqCst) {
                                    let _ = tx.send(EngineEvent::TurnStart);
                                }
                            }
                            AgentEvent::AgentStart => {
                                if boundary_passed.load(std::sync::atomic::Ordering::SeqCst) {
                                    let _ = tx.send(EngineEvent::AgentStart);
                                }
                            }
                            AgentEvent::AgentEnd { messages } => {
                                let messages = messages
                                    .iter()
                                    .filter_map(session_wire_value)
                                    .collect::<Vec<Value>>();
                                boundary_passed.store(true, std::sync::atomic::Ordering::SeqCst);
                                let _ = tx.send(EngineEvent::AgentEnd { messages });
                            }
                            AgentEvent::TurnEnd {
                                message,
                                tool_results,
                            } => {
                                if let Some(message) = session_wire_value(message) {
                                    let tool_results = tool_results
                                        .iter()
                                        .filter_map(|result| {
                                            session_wire_value(&pa_agent::types::AgentMessage::from(
                                                result.clone(),
                                            ))
                                        })
                                        .collect::<Vec<Value>>();
                                    boundary_passed
                                        .store(true, std::sync::atomic::Ordering::SeqCst);
                                    let _ = tx.send(EngineEvent::TurnEnd {
                                        message,
                                        tool_results,
                                    });
                                }
                            }
                            AgentEvent::ToolExecutionStart {
                                tool_call_id,
                                tool_name,
                                args,
                            } => {
                                let _ = tx.send(EngineEvent::ToolExecutionStart {
                                    tool_call_id: tool_call_id.clone(),
                                    tool_name: tool_name.clone(),
                                    args: args.clone(),
                                });
                            }
                            AgentEvent::ToolExecutionUpdate {
                                tool_call_id,
                                partial_result,
                                ..
                            } => {
                                let _ = tx.send(EngineEvent::ToolExecutionUpdate {
                                    tool_call_id: tool_call_id.clone(),
                                    partial_result: tool_result_wire_value(partial_result),
                                });
                            }
                            AgentEvent::ToolExecutionEnd {
                                tool_call_id,
                                result,
                                is_error,
                                ..
                            } => {
                                let _ = tx.send(EngineEvent::ToolExecutionEnd {
                                    tool_call_id: tool_call_id.clone(),
                                    result: tool_result_wire_value(result),
                                    is_error: *is_error,
                                });
                            }
                        }
                        Ok(())
                    })
                })
                .await
        };
        // Admit the turn on the engine runtime without blocking the
        // forwarding loop below: the admission future settles only when the
        // whole turn settles (the TS daemon fires `prompt` with `void` and
        // streams events from the session listeners while it runs), while
        // the loop hands each streamed event to `emit` the moment it
        // arrives. Buffering events until the future resolves is what made
        // clients render a turn as one final batch.
        let prompt = prompt.clone();
        let mut admitted = std::pin::pin!(async {
            if first_attempt {
                // The session lock covers the clone only: the turn below
                // runs for the whole provider stream, and holding the
                // mutex across it serialized every client read seam
                // (`get_system_prompt` and its family waited for the turn
                // to settle and hit the client's 10s bound — the
                // 2026-09-22 dogfood failure). The Arc clone keeps the
                // turn on the same built session while the mutex stays
                // free for reads (the TS event loop interleaves both).
                let session = self.session.lock().await.clone();
                let engine = session.expect("session built");
                match &prompt {
                    // A plain turn admits a user prompt (text plus
                    // images); an injected turn admits the custom row
                    // itself (TS `_promptInjectedMessage`: the loop
                    // context holds ONE representation of the turn —
                    // the custom row — and the provider request carries
                    // its user-role view at the loop boundary).
                    TurnPrompt::User {
                        text,
                        images,
                        batch,
                    } => {
                        // The batched co-delivery rows ride the same
                        // admission (TS `_startPreparedTurnActions`'s one
                        // `agent.prompt(preparedMessages)`): one run over
                        // the primary plus every batched user row.
                        let options = pa_core::session_engine::PromptOptions {
                            batch: batch
                                .iter()
                                .map(|row| pa_core::session_engine::PromptBatchRow {
                                    text: row.text.clone(),
                                    images: row.images.clone(),
                                })
                                .collect(),
                            ..Default::default()
                        };
                        engine
                            .session
                            .prompt_with_images(text, images.clone(), options)
                            .await
                            .map(|_| ())
                    }
                    TurnPrompt::Injected(message) => engine
                        .session
                        .prompt_injected_message(message)
                        .await
                        .map(|_| ()),
                }
            } else {
                agent.continue_run().await.map(|_| ())
            }
        });
        let mut aborted = false;
        let mut admission_error: Option<anyhow::Error> = None;
        let mut settled = false;
        loop {
            tokio::select! {
                event = rx.recv() => {
                    match event {
                        Some(event) => {
                            if !emit(event) {
                                aborted = true;
                            }
                        }
                        None => break,
                    }
                }
                outcome = &mut admitted => {
                    settled = true;
                    match outcome {
                        Ok(()) => {}
                        Err(error) => admission_error = Some(error),
                    }
                    // The turn settled: drain the events that raced the
                    // resolution, then stop the loop.
                    while let Ok(event) = rx.try_recv() {
                        if !emit(event) {
                            aborted = true;
                            break;
                        }
                    }
                }
            }
            if aborted || settled {
                break;
            }
        }
        if aborted && !settled {
            // The emit callback cancelled the turn: stop the still-running
            // admission and wait out its abort path before returning, so no
            // run outlives this attempt. A turn whose admission already
            // settled (the abort gate dropped only the settled run's tail
            // events in the drain) must not re-poll the completed future -
            // `std::pin::pin!` futures panic when resumed after
            // completion - so only an in-flight admission is awaited out.
            agent.abort();
            let _ = (&mut admitted).await;
        }
        // The settled run's tail still holds the aborted assistant row: the
        // abort finalize emits the row after the cancel (TS
        // `createAbortedAssistantMessage`), so every queued event drains
        // through the emit gate — the row's frames pass (broadcast +
        // persist), the post-abort stragglers drop.
        while let Ok(event) = rx.try_recv() {
            let _ = emit(event);
        }
        let _ = subscription.unsubscribe().await;
        if aborted {
            return Ok(TurnOnce::Aborted);
        }
        if let Some(error) = admission_error {
            return Err(anyhow::anyhow!("{error:#}"));
        }
        // The final assistant message decides the outcome (provider
        // failures included: the retry driver classifies them).
        let state = agent.state().await;
        for message in state.messages.iter().rev() {
            if let pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::Assistant(
                assistant,
            )) = message
            {
                // The message must carry the session wire shape (the
                // transcript already received it through message_end); a
                // round-trip failure means no usable turn outcome.
                if json_round_trip::<_, pa_types::ai::AssistantMessage>(assistant).is_none() {
                    return Ok(TurnOnce::None);
                }
                return Ok(TurnOnce::Message {
                    assistant: Box::new(assistant.clone()),
                });
            }
        }
        Ok(TurnOnce::None)
    }
}

/// The outcome of one admitted turn.
enum TurnResult {
    /// The turn settled; the final assistant message (typed, boxed to
    /// keep the enum small).
    Message(Box<pa_agent::types::AssistantMessage>),
    /// The turn was aborted before a settled message.
    Aborted,
    /// The turn failed before or during the model call. `assistant` is the
    /// failed turn's settled message when one exists (provider failures:
    /// the overflow arm inspects it); model-resolution and session-build
    /// failures never reached the provider and carry none.
    Error {
        error: String,
        assistant: Option<Box<pa_agent::types::AssistantMessage>>,
    },
}

/// How one turn is admitted to the agent loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnAdmission {
    /// A fresh user prompt: the loop context gains the user message.
    FreshPrompt,
    /// Re-issue the loop without a new user message (TS `agent.continue()`):
    /// the overflow compact-and-retry path after the failed turn's error
    /// message left the loop context.
    Continue,
}

/// The first turn's admitted prompt (TS `preparedMessages`): a plain
/// user prompt, or an injected custom row the turn runs on.
#[derive(Debug, Clone)]
enum TurnPrompt {
    /// A user prompt: text plus its image parts, with the batched
    /// co-delivery rows (same-lane, same-policy queue actions under mode
    /// "all") riding the same run after the primary.
    User {
        text: String,
        images: Vec<pa_agent::types::ImageContent>,
        batch: Vec<crate::engine::PromptBatchRow>,
    },
    /// An injected custom row (TS `_promptInjectedMessage` — goal
    /// continuations, RLM child terminal notices): the loop admission
    /// carries the row itself, so the transcript and the compaction walk
    /// hold one representation of the turn.
    Injected(pa_types::session::CustomMessage),
}

/// What the turn-boundary consumption did to the run.
enum BoundaryRun {
    /// Nothing pending, or requests consumed without stopping the run.
    Proceed,
    /// A consumed compaction stops the loop (TS: requested compaction
    /// stops the run on purpose). `compacted` marks the runs that
    /// actually compacted (TS `didCompact`), the only arm whose
    /// post-compaction goal-continuation consult mints.
    StoppedForCompaction { compacted: bool },
    /// The emitter asked to stop.
    Cancelled,
}

/// The outcome of one turn attempt.
enum TurnOnce {
    /// The emit callback cancelled the run.
    Aborted,
    /// The turn produced no assistant message.
    None,
    /// The turn's final assistant message (retry classification).
    Message {
        assistant: Box<pa_agent::types::AssistantMessage>,
    },
}

/// Remove the trailing assistant message from the loop context (TS retry:
/// `messages.slice(0, -1)`), so a retried request does not re-send the
/// failed turn's error message.
async fn drop_trailing_assistant(agent: &std::sync::Arc<pa_agent::agent::Agent>) {
    let state = agent.state().await;
    let mut messages = state.messages;
    if matches!(
        messages.last(),
        Some(pa_agent::types::AgentMessage::Standard(
            pa_agent::types::Message::Assistant(_)
        ))
    ) {
        messages.pop();
        agent.set_messages(messages).await;
    }
}

/// The synthesized aborted assistant message (an abort racing the turn ends
/// the loop without a provider failure).
fn aborted_message(model: &Model) -> pa_agent::types::AssistantMessage {
    pa_agent::types::AssistantMessage {
        content: vec![pa_agent::types::AssistantContent::Text(
            pa_agent::types::TextContent {
                text: String::new(),
                text_signature: None,
            },
        )],
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_agent::types::Usage::zero(),
        stop_reason: StopReason::Aborted,
        stop_reason_raw: None,
        error_message: None,
        timestamp: pa_agent::now_ms(),
    }
}

/// Translate one retry-loop event to the engine event vocabulary.
fn retry_event_to_engine_event(
    event: pa_core::session_engine::auto_retry::AutoRetryEvent,
) -> EngineEvent {
    use pa_core::session_engine::auto_retry::AutoRetryEvent;
    match event {
        AutoRetryEvent::Start {
            attempt,
            max_attempts,
            delay_ms,
            error_message,
            reason,
        } => EngineEvent::AutoRetryStart {
            attempt,
            max_attempts,
            delay_ms,
            error_message,
            reason,
        },
        AutoRetryEvent::End {
            success,
            attempt,
            final_error,
            restored_model,
        } => EngineEvent::AutoRetryEnd {
            success,
            attempt,
            final_error,
            restored_model,
        },
    }
}

/// The faux provider registry is process-global; faux-driven tests must
/// not register concurrently (each registration replaces the queue).
#[cfg(test)]
pub(crate) static FAUX_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) use super::FAUX_TEST_LOCK;

    /// The faux model's per-request output budget (maxTokens 16_384 under the
    /// 32_000 request cap): threshold fixtures subtract it from the window
    /// alongside the headroom (the combined input+output ceiling).
    const FAUX_REQUEST_BUDGET: u64 = 16_384;

    /// A models.json custom provider (name has no env-key mapping), with an
    /// apiKey the registry must resolve for request auth (the env-key map
    /// alone cannot find it).
    fn write_custom_provider_models_json(agent_dir: &std::path::Path, base_url: &str) {
        std::fs::create_dir_all(agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            serde_json::json!({
                "providers": {
                    "battery": {
                        "api": "openai-completions",
                        "baseUrl": base_url,
                        "apiKey": "sk-battery",
                        "models": [
                            {
                                "id": "mock-1",
                                "name": "Mock 1",
                                "api": "openai-completions",
                                "contextWindow": 128_000,
                                "maxTokens": 4096,
                            }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    /// A models.json custom-provider pair for the thinking clamp: a
    /// reasoning model (supports the full level ladder up to `high`) and a
    /// non-reasoning one (supports only `off`) — the restore must clamp
    /// the requested level against whichever one the session file pins.
    fn write_thinking_pair_models_json(agent_dir: &std::path::Path, base_url: &str) {
        std::fs::create_dir_all(agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            serde_json::json!({
                "providers": {
                    "battery": {
                        "api": "openai-completions",
                        "baseUrl": base_url,
                        "apiKey": "sk-battery",
                        "models": [
                            {
                                "id": "mock-reason",
                                "name": "Mock Reasoning",
                                "api": "openai-completions",
                                "contextWindow": 128_000,
                                "maxTokens": 4096,
                                "reasoning": true,
                            },
                            {
                                "id": "mock-plain",
                                "name": "Mock Plain",
                                "api": "openai-completions",
                                "contextWindow": 128_000,
                                "maxTokens": 4096,
                            }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn create_config_flags_reach_the_engine_model_resolution() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");

        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            // No process-level fallback: the wire flags must be the source.
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        // The explicit selection from the session's create config is
        // authoritative over any process-wide fallback model.
        engine.configure_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
        });
        let model = engine.resolve_registry_model().expect("resolved model");
        assert_eq!(model.provider, "battery");
        assert_eq!(model.id, "mock-1");
        // The registry resolves the models.json apiKey (the provider name has
        // no env-key mapping), so the engine can authenticate without env.
        assert_eq!(
            engine.resolve_request_api_key(&model).as_deref(),
            Some("sk-battery")
        );
    }

    fn bare_engine(dir: &std::path::Path) -> AgentSessionEngine {
        let agent_dir = dir.join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap()
    }

    /// A settings.json with an explicit compaction reserve (the f14 battery
    /// shape: `reserveTokens` set so a seeded usage crosses the headroom).
    fn write_compaction_settings(dir: &std::path::Path, reserve_tokens: u64) {
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        std::fs::write(
            dir.join("agent").join("settings.json"),
            serde_json::json!({ "compaction": { "enabled": true, "reserveTokens": reserve_tokens, "keepRecentTokens": 10 } })
                .to_string(),
        )
        .unwrap();
    }

    /// One faux-driven engine over its own tempdir (settings written before
    /// the first prompt so the session build resolves them).
    pub(crate) fn faux_engine_with_settings(
        script: serde_json::Value,
        reserve_tokens: u64,
    ) -> (AgentSessionEngine, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        write_compaction_settings(dir.path(), reserve_tokens);
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(script.to_string()),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        (engine, dir)
    }

    /// The goal-admission collector: installs the turn-end seam (a probe
    /// reporting no queued input plus a sink capturing minted work) on an
    /// engine built without a worker.
    pub(crate) fn goal_admission_collector(
        engine: &std::sync::Arc<AgentSessionEngine>,
    ) -> std::sync::Arc<std::sync::Mutex<Vec<crate::engine::GoalTurnEndWork>>> {
        let collected: std::sync::Arc<std::sync::Mutex<Vec<crate::engine::GoalTurnEndWork>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&collected);
        engine.set_goal_admission(
            std::sync::Arc::new(|| false),
            std::sync::Arc::new(move |work| sink.lock().unwrap().push(work)),
            std::sync::Arc::new(|| {}),
        );
        collected
    }

    /// Admit one prompt through the engine, collecting its events.
    pub(crate) fn admit(
        engine: &AgentSessionEngine,
        message: String,
        events: &mut Vec<EngineEvent>,
    ) {
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message,
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
    }

    /// The post-compaction goal-continue mint (TS `compact()`'s
    /// `didCompact` + active-goal branch -> `resumeQueuedWork()` ->
    /// `_maybeResumeGoalContinuationAfterRlmWork`): an active goal's
    /// mint consumes one continuation slot, persists the state change
    /// (the wire state read reflects it), and returns the queued
    /// follow-up turn — the continuation prompt text carrying the durable
    /// goal-context row — plus the `goal_update` payload of the state
    /// change. A goal that is not active mints nothing.
    /// A recovery rebuild rehydrates the goal driver from the worker-owned
    /// session file (TS constructor `_loadPersistedGoalState`): the fresh
    /// engine continues the persisted objective and counts, the rehydrated
    /// state never announces itself (the published baseline is seeded),
    /// and later state changes (usage accounting) announce from the
    /// rehydrated base, not from zero.
    #[test]
    fn recovery_rebuild_rehydrates_the_goal_from_the_session_file() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        // The durable store a killed worker leaves behind: an active goal
        // mid-pursuit with usage and continuation counts on the books.
        let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
        let session_path = dir.path().join("session.jsonl");
        store.set_path(session_path.clone());
        store.append_entry(
            "custom",
            json!({
                "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
                "data": {
                    "active": true,
                    "status": "active",
                    "goalId": "goal-1",
                    "objective": "ship the port",
                    "tokensUsed": 340,
                    "timeUsedSeconds": 9,
                    "continuationsUsed": 2,
                },
            }),
        );
        store.rewrite().expect("write session file");
        let engine = std::sync::Arc::new(
            AgentSessionEngine::new(AgentEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir,
                provider: None,
                model: None,
                api_key: None,
                thinking: None,
                session_dir: None,
                session_file: Some(session_path),
                faux_script: Some(r#"{"responses": [{"text": "recovery reply"}]}"#.to_string()),
                supervisor_link: None,
                telemetry_disabled: None,
                cron_store: None,
                queued_steering_probe: None,
            })
            .unwrap(),
        );
        // The turn-end seam: the engine has no worker, so a collector
        // stands in for the queue-lane admission sink.
        let goal_work = goal_admission_collector(&engine);
        // The first turn builds the session; the adoption rehydrates the
        // driver from the session file.
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "keep working".to_string(), &mut events);
        let goal = engine.goal_state_value();
        assert_eq!(goal["status"], "active");
        assert_eq!(goal["objective"], "ship the port");
        assert_eq!(goal["goalId"], "goal-1");
        // The rehydrated count continues the pursuit: the turn's natural
        // end minted the next continuation (the TS goal loop).
        assert_eq!(goal["continuationsUsed"], 3);
        assert!(goal["tokensUsed"].as_u64().unwrap() >= 340);
        // Usage accounting announced from the rehydrated base (TS
        // `_accountGoalUsageForAssistantMessage` -> `_emitGoalUpdate`): one
        // `goal_update` through the run's emit, carrying the continued
        // objective and the rehydrated count (the turn-end mint's update
        // surfaces through the admission sink, not the run's emit).
        let goal_updates: Vec<&EngineEvent> = events
            .iter()
            .filter(|event| matches!(event, EngineEvent::GoalUpdate { .. }))
            .collect();
        assert_eq!(goal_updates.len(), 1, "events: {events:?}");
        let EngineEvent::GoalUpdate { goal } = goal_updates[0] else {
            unreachable!();
        };
        assert_eq!(goal["objective"], "ship the port");
        assert_eq!(goal["continuationsUsed"], 2);
        // The turn-end continuation minted at the natural boundary: one
        // admitted follow-up whose `goal_update` continues the count.
        let work = goal_work.lock().unwrap();
        let [crate::engine::GoalTurnEndWork::Continuation(minted)] = work.as_slice() else {
            panic!("unexpected goal work: {work:?}");
        };
        assert!(minted.request.message.contains("[goal: continuation]"));
        assert_eq!(
            minted
                .goal_update
                .as_ref()
                .expect("the mint moved the state")["continuationsUsed"],
            3
        );
        drop(work);
        // A post-compaction mint continues the pursuit's count further.
        let minted = engine
            .mint_post_compaction_goal_continuation()
            .expect("the rehydrated goal mints");
        assert_eq!(
            minted.goal_update.expect("mint moved the state")["continuationsUsed"],
            4
        );
    }

    /// A durable message row in the worker's persisted wire shape.
    fn wire_user_message(text: String) -> Value {
        serde_json::to_value(pa_types::session::AgentMessage::User(
            pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text(text),
                timestamp: 1,
                rest: Default::default(),
            },
        ))
        .expect("user message serializes")
    }

    /// A durable assistant row in the worker's persisted wire shape.
    fn wire_assistant_message(text: String) -> Value {
        serde_json::to_value(pa_types::session::AgentMessage::Assistant(
            pa_types::ai::AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text,
                        text_signature: None,
                        rest: Default::default(),
                    },
                )],
                api: "faux".to_string(),
                provider: "faux".to_string(),
                model: "faux-1".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage::default(),
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 2,
                rest: Default::default(),
            },
        ))
        .expect("assistant message serializes")
    }

    /// The recovered engine's compaction walk sees the durable history (TS
    /// one-store recovery: the owned-session worker respawns with
    /// `--resume <sessionFile>`, so the rebuilt session's branch carries
    /// the pre-crash history and a post-recovery compact runs over it —
    /// never a skip on the fresh engine's empty branch). The daemon worker
    /// owns the file writes while the engine keeps an in-memory manager,
    /// so the recovery build adopts the durable branch and the walk
    /// (prepareCompaction over the branch) reads the same history TS's
    /// single store holds.
    #[test]
    fn recovered_engine_compaction_walk_sees_the_durable_history() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        write_compaction_settings(dir.path(), 1);
        // The durable store a killed worker leaves behind: a long
        // conversation the fresh engine never saw in memory.
        let long = "x".repeat(48_000);
        let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
        let session_path = dir.path().join("session.jsonl");
        store.set_path(session_path.clone());
        store.append_message(wire_user_message(format!("work turn one {long}")));
        store.append_message(wire_assistant_message(format!("reply one {long}")));
        store.rewrite().expect("write session file");
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: Some(session_path),
            faux_script: Some(
                serde_json::json!({
                    "responses": [{"text": "recovery reply"}, {"text": "the summary"}]
                })
                .to_string(),
            ),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        // The recovery turn builds the session; the build adopts the
        // durable branch (TS `--resume`: one store).
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("keep working after the crash {}", "y".repeat(2_000)),
            &mut events,
        );
        let entries = engine_session_entries(&engine);
        assert!(
            entries.iter().any(|entry| match entry {
                pa_types::session::FileEntry::Message {
                    message: pa_types::session::AgentMessage::User(user),
                    ..
                } => user.content.text().contains("work turn one"),
                _ => false,
            }),
            "the recovery build adopted the durable history: {entries:?}"
        );
        // The compact runs over the durable history instead of skipping
        // "too short" on the fresh branch.
        let controller = std::sync::Arc::new(pa_agent::abort::AbortController::new());
        let signal = controller.signal();
        let outcome = engine.run_compaction(
            crate::engine::CompactionRequest {
                custom_instructions: None,
            },
            &signal,
        );
        match outcome {
            crate::engine::CompactionOutcome::Compacted { run } => {
                assert_eq!(run.result["summary"], "the summary", "the compact ran");
                assert!(
                    run.result["firstKeptEntryId"].is_string(),
                    "the cut resolved a kept entry: {run:?}"
                );
            }
            other => panic!("the recovered compact did not run: {other:?}"),
        }
        // The post-compaction branch summary stands in for the durable
        // prefix: the compaction entry landed in the engine branch.
        assert!(compaction_entry_in_entries(&engine));
    }

    #[test]
    fn post_compaction_goal_continuation_mint() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _engine_dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "goal turn reply"}] }),
            1,
        );
        let engine = std::sync::Arc::new(engine);
        // The turn-end seam: the engine has no worker, so a collector
        // stands in for the queue-lane admission sink.
        let goal_work = goal_admission_collector(&engine);
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            "/goal ship the post-compact continue".to_string(),
            &mut events,
        );
        // The goal-start continuation turn ran (TS `/goal` start does not
        // consume a continuation slot), the goal active; the turn's
        // natural end then minted the goal loop's next continuation (the
        // TS `_getGoalContinuationMessages` hook).
        assert_eq!(engine.goal_state_value()["status"], "active");
        assert_eq!(engine.goal_state_value()["continuationsUsed"], 1);
        let work = goal_work.lock().unwrap();
        let [crate::engine::GoalTurnEndWork::Continuation(turn_end)] = work.as_slice() else {
            panic!("unexpected goal work: {work:?}");
        };
        assert!(turn_end.request.message.contains("[goal: continuation]"));
        assert_eq!(
            turn_end.goal_update.as_ref().expect("mint moved the state")["continuationsUsed"],
            1
        );
        drop(work);
        let minted = engine
            .mint_post_compaction_goal_continuation()
            .expect("active goal mints the continuation");
        let message = minted.request.message;
        assert!(
            message.contains("[goal: continuation]"),
            "unexpected continuation text: {message}"
        );
        assert!(
            message.contains("ship the post-compact continue"),
            "the continuation context lost the objective: {message}"
        );
        let row = minted
            .request
            .custom_message
            .expect("the goal-context row rides the turn");
        assert_eq!(row["customType"], "goal_context");
        assert_eq!(row["role"], "custom");
        assert_eq!(row["content"], json!(message));
        assert_eq!(row["details"]["kind"], "continuation");
        assert_eq!(row["details"]["continuationsUsed"], 2);
        // The state change persisted (TS `_setGoalState`): the wire state
        // read reflects the mint, and the `goal_update` payload carries
        // the same state.
        assert_eq!(engine.goal_state_value()["continuationsUsed"], 2);
        let goal_update = minted.goal_update.expect("the mint moved the state");
        assert_eq!(goal_update["status"], "active");
        assert_eq!(goal_update["continuationsUsed"], 2);
        // A mint over a paused goal produces nothing (TS checks the
        // active status at the resume site).
        let mut pause_events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "/goal pause".to_string(), &mut pause_events);
        assert_eq!(engine.goal_state_value()["status"], "paused");
        assert!(
            engine.mint_post_compaction_goal_continuation().is_none(),
            "a paused goal minted a continuation"
        );
    }

    /// Admit one full turn request (the minted continuation's injected
    /// goal-context row), collecting its events.
    pub(crate) fn admit_request(
        engine: &AgentSessionEngine,
        request: crate::engine::PromptRequest,
        events: &mut Vec<EngineEvent>,
    ) {
        engine.run_prompt(0, request, &|| false, &mut |event| {
            events.push(event);
            true
        });
    }

    /// TS `_getGoalContinuationMessages` at the natural turn end: an
    /// active goal mints one continuation per settled turn, the minted
    /// follow-up carries the continuation context (objective, count, and
    /// the durable goal-context row), and a completed goal stops the loop
    /// (no mint at the boundary after the completion).
    #[test]
    fn goal_turn_end_mints_the_loop_until_the_goal_completes() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let engine = std::sync::Arc::new(
            AgentSessionEngine::new(AgentEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir: dir.path().join("agent"),
                provider: None,
                model: None,
                api_key: None,
                thinking: None,
                session_dir: None,
                session_file: None,
                faux_script: Some(
                    serde_json::json!({ "responses": [
                        {"text": "first turn"},
                        {"text": "second turn"},
                        {"text": "third turn"},
                        {"text": "final turn"},
                    ]})
                    .to_string(),
                ),
                supervisor_link: None,
                telemetry_disabled: None,
                cron_store: None,
                queued_steering_probe: None,
            })
            .unwrap(),
        );
        let goal_work = goal_admission_collector(&engine);
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "/goal ship the goal loop".to_string(), &mut events);
        // The goal-start turn's natural end minted the first continuation.
        assert_eq!(engine.goal_state_value()["status"], "active");
        assert_eq!(engine.goal_state_value()["continuationsUsed"], 1);
        // The worker queue would drive the minted turn: admit it like the
        // runner does, twice — each settled turn mints the next
        // continuation (the TS loop keeps prompting the model), the minted
        // row carrying the incremented count.
        let mut request = {
            let mut work = goal_work.lock().unwrap();
            let crate::engine::GoalTurnEndWork::Continuation(follow_up) =
                work.pop().expect("the start turn minted one continuation")
            else {
                panic!("expected a continuation");
            };
            assert!(follow_up.request.message.contains("[goal: continuation]"));
            assert!(follow_up.request.message.contains("ship the goal loop"));
            follow_up.request
        };
        for expected_count in [2u64, 3] {
            let mut turn_events: Vec<EngineEvent> = Vec::new();
            admit_request(&engine, request, &mut turn_events);
            request = {
                let mut work = goal_work.lock().unwrap();
                assert_eq!(work.len(), 1, "unexpected goal work: {work:?}");
                let crate::engine::GoalTurnEndWork::Continuation(follow_up) = work
                    .pop()
                    .expect("the settled turn minted the next continuation")
                else {
                    panic!("expected a continuation");
                };
                let row = follow_up
                    .request
                    .custom_message
                    .as_ref()
                    .expect("the row rides");
                assert_eq!(row["customType"], "goal_context");
                assert_eq!(row["details"]["kind"], "continuation");
                assert_eq!(
                    row["details"]["continuationsUsed"],
                    serde_json::json!(expected_count)
                );
                assert_eq!(
                    follow_up.goal_update.expect("mint moved the state")["continuationsUsed"],
                    serde_json::json!(expected_count)
                );
                follow_up.request
            };
            assert_eq!(
                engine.goal_state_value()["continuationsUsed"],
                serde_json::json!(expected_count)
            );
        }
        // The goal completes (the kernel host request's driver path):
        // the queued continuation's boundary mints nothing more.
        let handles = engine
            .goal_runtime
            .lock()
            .unwrap()
            .clone()
            .expect("goal runtime");
        engine.runtime.block_on(async {
            let mut driver = handles.driver.lock().await;
            let mut session = handles.session.lock().await;
            driver.complete(&mut session).unwrap();
        });
        let mut turn_events: Vec<EngineEvent> = Vec::new();
        admit_request(&engine, request, &mut turn_events);
        assert_eq!(engine.goal_state_value()["status"], "complete");
        assert_eq!(
            engine.goal_state_value()["continuationsUsed"],
            3,
            "a completed goal mints no continuation at the boundary"
        );
        assert!(goal_work.lock().unwrap().is_empty());
    }

    /// The TS gate ladder's inactive arms: a paused goal (and a cleared
    /// one) mints nothing at the natural turn end, and no continuation
    /// slot is consumed.
    #[test]
    fn paused_goal_mints_no_turn_end_continuation() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _engine_dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [
                {"text": "start turn reply"},
                {"text": "paused turn reply"},
            ]}),
            1,
        );
        let engine = std::sync::Arc::new(engine);
        let goal_work = goal_admission_collector(&engine);
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "/goal ship while paused".to_string(), &mut events);
        // The start turn's boundary minted one continuation; pause the
        // goal, then drive that minted turn: its boundary mints nothing.
        let request = {
            let mut work = goal_work.lock().unwrap();
            let crate::engine::GoalTurnEndWork::Continuation(follow_up) =
                work.pop().expect("the start turn minted")
            else {
                panic!("expected a continuation");
            };
            follow_up.request
        };
        let count_before = engine.goal_state_value()["continuationsUsed"].clone();
        let mut pause_events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "/goal pause".to_string(), &mut pause_events);
        assert_eq!(engine.goal_state_value()["status"], "paused");
        let mut turn_events: Vec<EngineEvent> = Vec::new();
        admit_request(&engine, request, &mut turn_events);
        // No mint: the paused goal consumed no slot at the boundary.
        assert!(goal_work.lock().unwrap().is_empty());
        assert_eq!(engine.goal_state_value()["continuationsUsed"], count_before);
        assert_eq!(turn_events.last(), Some(&EngineEvent::Done(Ok(()))));
        // A cleared goal behaves the same.
        admit(&engine, "/goal clear".to_string(), &mut Vec::new());
        let mut after_clear: Vec<EngineEvent> = Vec::new();
        admit(&engine, "plain turn".to_string(), &mut after_clear);
        assert!(goal_work.lock().unwrap().is_empty());
        assert_eq!(engine.goal_state_value()["status"], "idle");
    }

    /// The budget-exhausted gate (TS `_accountGoalUsageForAssistantMessage`
    /// returning true -> the `budget_limit` context steer): the crossing
    /// turn ends the run, the wrap-up steer queues on the steering surface,
    /// the goal moves to `budget_limited` with the TS reason, and no
    /// continuation mints at that boundary.
    #[test]
    fn budget_exhausted_stops_with_the_ts_budget_steer() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _engine_dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "crossing turn reply"}] }),
            1,
        );
        let engine = std::sync::Arc::new(engine);
        let goal_work = goal_admission_collector(&engine);
        let mut events: Vec<EngineEvent> = Vec::new();
        // A tiny budget: the goal-start turn's usage crosses it (the faux
        // provider estimates usage from the context).
        admit(
            &engine,
            "/goal --budget 10 budget the runaway turn".to_string(),
            &mut events,
        );
        let goal = engine.goal_state_value();
        assert_eq!(goal["status"], "budget_limited");
        assert_eq!(
            goal["lastReason"],
            serde_json::json!("Reached 10 token goal budget")
        );
        // The crossing turn's boundary minted the budget-limit steer, not
        // a continuation.
        let work = goal_work.lock().unwrap();
        let [crate::engine::GoalTurnEndWork::BudgetLimitSteer(steer)] = work.as_slice() else {
            panic!("expected exactly the budget steer: {work:?}");
        };
        let steer_text = &steer.request.message;
        assert!(
            steer_text.starts_with("[goal: budget-limit]"),
            "text: {steer_text}"
        );
        assert!(steer_text.contains("budget the runaway turn"));
        assert!(steer_text.contains("status: budget_limited"));
        assert!(steer_text.contains("Do not start new substantive work"));
        let row = steer
            .request
            .custom_message
            .as_ref()
            .expect("the row rides");
        assert_eq!(row["customType"], "goal_context");
        assert_eq!(row["details"]["kind"], "budget_limit");
        // The steer carries no goal_update: the budget transition was
        // announced through the run's own `goal_update` event.
        assert!(steer.goal_update.is_none());
        drop(work);
        let goal_updates: Vec<&EngineEvent> = events
            .iter()
            .filter(|event| matches!(event, EngineEvent::GoalUpdate { .. }))
            .collect();
        assert!(
            goal_updates
                .iter()
                .any(|event| matches!(event, EngineEvent::GoalUpdate { goal }
                    if goal["status"] == serde_json::json!("budget_limited"))),
            "the budget transition never announced: {events:?}"
        );
        // The run stopped at the crossing turn (TS: queued steer owns the
        // next turn, `resumeIfIdle`).
        assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    }

    /// The queued-input gate (TS `queuedActionCount > 0`): queued session
    /// input owns the turn boundary, the mint defers without consuming a
    /// slot, and the boundary after the queued work drains re-mints.
    #[test]
    fn queued_input_defers_the_turn_end_mint() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _engine_dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "first"}, {"text": "second"}] }),
            1,
        );
        let engine = std::sync::Arc::new(engine);
        // A probe that reports queued input while the flag is set: the
        // test flips it to simulate the queue draining.
        let queued = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let probe_queued = std::sync::Arc::clone(&queued);
        let goal_work: std::sync::Arc<std::sync::Mutex<Vec<crate::engine::GoalTurnEndWork>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&goal_work);
        engine.set_goal_admission(
            std::sync::Arc::new(move || probe_queued.load(std::sync::atomic::Ordering::SeqCst)),
            std::sync::Arc::new(move |work| sink.lock().unwrap().push(work)),
            std::sync::Arc::new(|| {}),
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            "/goal ship past the queue".to_string(),
            &mut events,
        );
        // Queued input owns the boundary: no mint, no slot consumed.
        assert!(goal_work.lock().unwrap().is_empty());
        assert_eq!(engine.goal_state_value()["continuationsUsed"], 0);
        assert_eq!(engine.goal_state_value()["status"], "active");
        // The queue drains: the next boundary mints the continuation.
        queued.store(false, std::sync::atomic::Ordering::SeqCst);
        let mut after_drain: Vec<EngineEvent> = Vec::new();
        admit(&engine, "the queued work ran".to_string(), &mut after_drain);
        let work = goal_work.lock().unwrap();
        let [crate::engine::GoalTurnEndWork::Continuation(follow_up)] = work.as_slice() else {
            panic!("expected exactly one continuation: {work:?}");
        };
        assert_eq!(
            follow_up.request.custom_message.as_ref().unwrap()["details"]["continuationsUsed"],
            serde_json::json!(1)
        );
        assert_eq!(engine.goal_state_value()["continuationsUsed"], 1);
    }

    /// The quiescence gate (TS `_getGoalContinuationMessages`'s
    /// `_hasUnsettledRlmQuiescenceWork` arm and
    /// `_maybeResumeGoalContinuationAfterRlmWork`): the natural turn end
    /// defers the continuation behind a running child (owed, not
    /// consumed), and the child's settle delivers it once through the
    /// admission sink.
    #[test]
    fn running_children_owe_the_continuation_and_settle_delivers_it() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let engine = std::sync::Arc::new(
            AgentSessionEngine::new(AgentEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir: dir.path().join("agent"),
                provider: None,
                model: None,
                api_key: None,
                thinking: None,
                session_dir: None,
                session_file: None,
                faux_script: Some(
                    serde_json::json!({ "responses": [{"text": "parent turn reply"}] }).to_string(),
                ),
                supervisor_link: Some(crate::agent_engine::SupervisorLinkConfig {
                    socket_path: dir.path().join("dead.sock"),
                    active_session_id: "parent-session".to_string(),
                    worker_token: "token".to_string(),
                }),
                telemetry_disabled: None,
                cron_store: None,
                queued_steering_probe: None,
            })
            .unwrap(),
        );
        let goal_work = goal_admission_collector(&engine);
        let children = engine.children.clone().expect("children registry");
        // A running child (the test seam): the quiescence gate holds.
        engine.runtime.block_on(async {
            children
                .push_test_child(crate::rlm_children::RlmChildIdentity {
                    rlm_child_id: "child-1".to_string(),
                    active_session_id: "child-session".to_string(),
                    session_id: None,
                    session_name: "worker-1".to_string(),
                })
                .await;
        });
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            "/goal ship behind the children".to_string(),
            &mut events,
        );
        // No mint while the child runs; the deferral is owed, not consumed,
        // and the run still settles normally (the TS goal holds the
        // continuation instead of re-prompting a waiting parent).
        assert!(goal_work.lock().unwrap().is_empty(), "events: {events:?}");
        assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
        assert_eq!(engine.goal_state_value()["status"], "active");
        assert_eq!(engine.goal_state_value()["continuationsUsed"], 0);
        let handles = engine
            .goal_runtime
            .lock()
            .unwrap()
            .clone()
            .expect("goal runtime");
        assert!(engine
            .runtime
            .block_on(async { handles.driver.lock().await.owes_continuation() }));
        // The child settles (the cancel walk): the settle hook delivers the
        // owed continuation exactly once through the admission sink.
        engine
            .runtime
            .block_on(async { children.cancel_child_run("child-1").await });
        for _ in 0..200 {
            if !goal_work.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let work = goal_work.lock().unwrap();
        let [crate::engine::GoalTurnEndWork::Continuation(follow_up)] = work.as_slice() else {
            panic!("expected exactly the owed continuation: {work:?}");
        };
        assert!(follow_up.request.message.contains("[goal: continuation]"));
        assert!(follow_up
            .request
            .message
            .contains("ship behind the children"));
        assert_eq!(
            follow_up.request.custom_message.as_ref().unwrap()["details"]["continuationsUsed"],
            serde_json::json!(1)
        );
        drop(work);
        // The deferral cleared and the slot was consumed exactly once.
        assert!(!engine
            .runtime
            .block_on(async { handles.driver.lock().await.owes_continuation() }));
        assert_eq!(engine.goal_state_value()["continuationsUsed"], 1);
    }

    /// The engine session's entries as their persisted wire shapes (the
    /// hydrating snapshot: a windowed manager holds only the suffix).
    fn engine_session_entries(engine: &AgentSessionEngine) -> Vec<pa_types::session::FileEntry> {
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        let persistence = core.session.shared_persistence();
        engine.runtime.block_on(async {
            let snapshot = persistence.lock().await.history_snapshot();
            snapshot.await.expect("history snapshot")
        })
    }

    /// An injected custom turn (wire `customMessage`, the RLM child
    /// terminal-notice path) holds ONE representation in the engine
    /// branch: the accepted custom row persists and renders as itself
    /// (the wire pair, exactly once), the engine session's transcript
    /// gains the custom row and NO user row with the same text, and the
    /// model turn still runs on the notice text (TS
    /// `_promptInjectedMessage` -> `agent.prompt([customMessage])`).
    #[test]
    fn injected_custom_turn_holds_one_representation() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "notice acknowledged"}] }),
            1,
        );
        let notice_text = "[child-exited: no-reply child:lane]";
        let notice = serde_json::json!({
            "role": "custom",
            "customType": "rlm_child_terminal_notice",
            "content": notice_text,
            "display": true,
            "details": {
                "kind": "completed_without_reply",
                "childId": "sub-1",
                "sessionName": "lane",
            },
            "timestamp": crate::util::now_ms(),
        });
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: notice_text.to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: Some(notice),
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
        // The wire: the accepted custom row's pair, no user row, the
        // model turn settled on the notice text.
        let custom_rows: Vec<&Value> = events
            .iter()
            .filter_map(|event| match event {
                EngineEvent::CustomMessage(row)
                    if row["customType"] == "rlm_child_terminal_notice" =>
                {
                    Some(row)
                }
                _ => None,
            })
            .collect();
        assert_eq!(custom_rows.len(), 1, "events: {events:?}");
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, EngineEvent::UserMessage(_))),
            "the injected turn must not emit a user row: {events:?}"
        );
        assert_eq!(
            assistant_texts(&events),
            vec!["notice acknowledged".to_string()],
            "the model turn ran on the notice text: {events:?}"
        );
        // The engine session's transcript: one custom row, no duplicate
        // user row with the notice text, the assistant settled.
        let entries = engine_session_entries(&engine);
        let notice_rows = entries
            .iter()
            .filter(|entry| {
                matches!(entry, pa_types::session::FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type == "rlm_child_terminal_notice")
            })
            .count();
        assert_eq!(notice_rows, 1, "entries: {entries:?}");
        let user_rows = entries
            .iter()
            .filter(|entry| match entry {
                pa_types::session::FileEntry::Message {
                    message: pa_types::session::AgentMessage::User(user),
                    ..
                } => user.content.text().contains(notice_text),
                _ => false,
            })
            .count();
        assert_eq!(
            user_rows, 0,
            "the injected turn must not persist a user row: {entries:?}"
        );
        let assistant_rows = entries
            .iter()
            .filter(|entry| {
                matches!(
                    entry,
                    pa_types::session::FileEntry::Message {
                        message: pa_types::session::AgentMessage::Assistant(_),
                        ..
                    }
                )
            })
            .count();
        assert_eq!(assistant_rows, 1, "entries: {entries:?}");
    }

    /// A `/goal` start schedules its continuation as an injected custom
    /// row (TS `_runOrQueueGoalContext` -> the prepared-turn primary
    /// record): the engine session's transcript holds the goal-context
    /// row once and NO user row carrying the goal-context prompt — the
    /// pre-fix double representation that shifted the compaction walk.
    #[test]
    fn goal_start_continuation_holds_one_representation() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, _dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "goal turn reply"}] }),
            1,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            "/goal land the post-compact continue".to_string(),
            &mut events,
        );
        assert_eq!(engine.goal_state_value()["status"], "active");
        let entries = engine_session_entries(&engine);
        let goal_rows: Vec<String> = entries
            .iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, .. } => {
                    (payload.custom_type == "goal_context").then(|| payload.content.text())
                }
                _ => None,
            })
            .collect();
        assert_eq!(goal_rows.len(), 1, "entries: {entries:?}");
        let goal_prompt = goal_rows[0].clone();
        let user_rows = entries
            .iter()
            .filter(|entry| match entry {
                pa_types::session::FileEntry::Message {
                    message: pa_types::session::AgentMessage::User(user),
                    ..
                } => user.content.text().contains(&goal_prompt),
                _ => false,
            })
            .count();
        assert_eq!(
            user_rows, 0,
            "the goal continuation must not persist a duplicate user row: {entries:?}"
        );
        // The wire: the goal-context row's message pair goes out with
        // the command rows, before the turn's assistant.
        let goal_pair_index = events
            .iter()
            .position(|event| {
                matches!(event, EngineEvent::CustomMessage(row) if row["customType"] == "goal_context")
            })
            .expect("the goal-context row rides the wire");
        let assistant_index = events
            .iter()
            .position(|event| {
                matches!(event, EngineEvent::AssistantMessage(message) if message["content"][0]["text"] == "goal turn reply")
            })
            .expect("the continuation turn settled");
        assert!(
            goal_pair_index < assistant_index,
            "the row precedes the turn it drives: {events:?}"
        );
    }

    /// The automatic threshold compaction at the turn boundary (TS
    /// `_checkCompaction` threshold arm): a settled turn whose usage
    /// crosses the reserve headroom emits the `compaction_start` /
    /// `compaction_end` pair with the `threshold` reason, runs the
    /// summarizer, and rewrites the loop context.
    ///
    /// The faux provider estimates usage from the serialized context (the
    /// f14 battery's mock-provider shape is not part of the faux script),
    /// so the probe engine first measures one baseline turn's usage and the
    /// threshold engine places the headroom halfway between that baseline
    /// and the baseline plus the big prompt (~12k tokens of `x`s) —
    /// environment-independent margins on both sides.
    #[test]
    fn threshold_crossing_auto_compacts_with_the_event_pair() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Probe: the baseline turn's total usage (system prompt included).
        let (probe, _probe_dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "seed reply"}] }),
            1,
        );
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(&probe, "seed turn".to_string(), &mut probe_events);
        let baseline = probe_events
            .iter()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
                _ => None,
            })
            .expect("probe turn produced usage");
        assert!(
            baseline < 100_000,
            "the probe baseline is implausibly large: {baseline}"
        );
        drop(probe);

        // ~12k tokens of deterministic extra context on the crossing turn.
        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        // The headroom sits between the two turns' usage (the f14 battery
        // shape: reserveTokens so exactly the seeded crossing fires).
        let headroom = baseline + big_tokens / 2;
        let (engine, _engine_dir) = faux_engine_with_settings(
            serde_json::json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "crossing reply"},
                    {"text": "the summary"},
                ],
            }),
            128_000u64
                .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
                .max(1),
        );

        let mut events: Vec<EngineEvent> = Vec::new();
        // The seed turn stays below the headroom: no compaction events.
        admit(&engine, "seed turn".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events),
            vec!["seed reply".to_string()],
            "the seed turn answered"
        );
        assert!(
            !events.iter().any(|event| matches!(
                event,
                EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
            )),
            "no compaction below the headroom"
        );
        // The threshold-crossing turn: the settled usage fires the
        // `compaction_start`/`compaction_end` pair with the `threshold`
        // reason, after the assistant message (TS agent_end order).
        admit(&engine, big_prompt, &mut events);
        let assistant_index = events
            .iter()
            .rposition(|event| matches!(event, EngineEvent::AssistantMessage(_)))
            .expect("assistant message emitted");
        let start_index = events
            .iter()
            .position(|event| {
                matches!(event, EngineEvent::CompactionStart { event } if event["reason"] == "threshold")
            })
            .expect("threshold compaction_start emitted");
        assert!(
            start_index > assistant_index,
            "the check fires at the settled turn boundary"
        );
        let EngineEvent::CompactionStart { event } = &events[start_index] else {
            unreachable!();
        };
        assert_eq!(
            event,
            &serde_json::json!({ "type": "compaction_start", "reason": "threshold" })
        );
        // The durable end event carries the entry and the client-facing
        // result with the summarizer's text (the summarizer consumed the
        // third scripted response).
        let compaction_index = events
            .iter()
            .position(|event| matches!(event, EngineEvent::Compaction { .. }))
            .expect("compaction_end emitted");
        let EngineEvent::Compaction { entry, event } = &events[compaction_index] else {
            unreachable!();
        };
        assert!(compaction_index > start_index);
        assert_eq!(event["reason"], "threshold");
        assert_eq!(event["result"]["summary"], "the summary");
        // The threshold event's result carries the TS dataKeys too: the
        // file-op `details` verbatim from the durable entry.
        assert_eq!(
            event["result"]["details"],
            serde_json::json!({ "readFiles": [], "modifiedFiles": [] })
        );
        assert!(entry["firstKeptEntryId"].is_string());
        // Exactly one pair for the admission: the pre-turn check on the
        // first iteration sees no built session (nothing to compact), and
        // the post-turn check fires once — no double compaction.
        let start_count = events
            .iter()
            .filter(|event| matches!(event, EngineEvent::CompactionStart { .. }))
            .count();
        let end_count = events
            .iter()
            .filter(|event| matches!(event, EngineEvent::Compaction { .. }))
            .count();
        assert_eq!((start_count, end_count), (1, 1));
    }

    /// The compaction summarizer stays on the session's provider when a
    /// fresh startup-chain resolution drifts mid-session (R8): the live
    /// report was a prime-inference session whose threshold
    /// auto-compaction re-resolved to `amazon-bedrock` and failed with
    /// "No AWS credentials available for Bedrock" while the session's
    /// turns kept streaming through the target's provider. The session
    /// builds on the models.json faux model; the settings default then
    /// changes under it (the drift a live catalog or settings edit
    /// produces), so [`AgentSessionEngine::resolve_model`] now lands on
    /// a dead provider — but the threshold arm follows the session's
    /// provider target ([`AgentSessionEngine::session_model`]): the
    /// summarizer request still hits the faux provider and the
    /// compaction succeeds instead of failing on the drift model.
    #[test]
    fn threshold_compaction_stays_on_the_session_provider_after_a_resolution_drift() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        // The session's provider: the process-global faux provider
        // (api "faux"), serving the turn replies and the summarizer.
        let script = json!({
            "responses": [
                {"text": "seed reply"},
                {"text": "crossing reply"},
                {"text": "the drifted summary"},
            ],
        });
        let parsed = pa_ai::faux::script::parse_faux_script(&script).expect("faux script parses");
        let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
        // The registry catalog: the faux model the session builds on,
        // and the drift model — an openai-completions endpoint nothing
        // serves (the live R8 shape: Bedrock with no credentials), so a
        // request against it fails.
        std::fs::write(
            agent_dir.join("models.json"),
            json!({
                "providers": {
                    "faux": {
                        "api": "faux",
                        "baseUrl": "http://localhost:0",
                        "apiKey": "sk-faux",
                        "models": [{
                            "id": "faux-1",
                            "name": "Faux Model",
                            "contextWindow": 128_000,
                            "maxTokens": 16384,
                        }],
                    },
                    "drift": {
                        "api": "openai-completions",
                        "baseUrl": "http://127.0.0.1:9",
                        "apiKey": "sk-drift",
                        "models": [{
                            "id": "drift-1",
                            "name": "Drift Model",
                            "contextWindow": 128_000,
                            "maxTokens": 16384,
                        }],
                    },
                }
            })
            .to_string(),
        )
        .unwrap();
        let write_settings = |default_provider: &str, default_model: &str, reserve_tokens: u64| {
            std::fs::write(
                agent_dir.join("settings.json"),
                json!({
                    "defaultProvider": default_provider,
                    "defaultModel": default_model,
                    "compaction": {
                        "enabled": true,
                        "reserveTokens": reserve_tokens,
                        "keepRecentTokens": 10,
                    },
                })
                .to_string(),
            )
            .unwrap();
        };
        let new_engine = || {
            AgentSessionEngine::new(AgentEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir: agent_dir.clone(),
                provider: None,
                model: None,
                api_key: None,
                thinking: None,
                session_dir: None,
                session_file: None,
                faux_script: None,
                supervisor_link: None,
                telemetry_disabled: None,
                cron_store: None,
                queued_steering_probe: None,
            })
            .unwrap()
        };
        // Probe: the baseline turn's total usage (the faux provider
        // estimates usage from the serialized context, system prompt
        // included) with the threshold far away.
        write_settings("faux", "faux-1", 1);
        let probe = new_engine();
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(&probe, "seed turn".to_string(), &mut probe_events);
        let baseline = probe_events
            .iter()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
                _ => None,
            })
            .expect("probe turn produced usage");
        assert!(baseline < 100_000, "implausible baseline: {baseline}");
        drop(probe);

        // The threshold engine: the combined input+output ceiling sits
        // between the seed turn's usage and the crossing turn's (the
        // same probe margins the sibling threshold tests use; the
        // 16_384 per-request output budget is part of the ceiling).
        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let headroom = baseline + big_tokens / 2;
        let reserve = 128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
            .max(1);
        write_settings("faux", "faux-1", reserve);
        registration.set_responses(parsed.responses);
        let engine = new_engine();
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        assert_eq!(assistant_texts(&events), vec!["seed reply".to_string()]);
        assert!(
            !events.iter().any(|event| matches!(
                event,
                EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
            )),
            "no compaction below the threshold"
        );

        // The mid-session resolution drift (the live R8 shape): the
        // settings default changes under the built session, so a fresh
        // startup-chain resolution lands on the dead provider while the
        // session's live model stays the provider target.
        write_settings("drift", "drift-1", reserve);
        let drifted = engine.resolve_model().expect("the drift model resolves");
        assert_eq!(
            (drifted.provider.as_str(), drifted.id.as_str()),
            ("drift", "drift-1")
        );
        let session = engine.session_model().expect("the session model resolves");
        assert_eq!(
            (session.provider.as_str(), session.id.as_str()),
            ("faux", "faux-1")
        );

        // The threshold arm compacts on the session's provider: the
        // crossing turn's boundary runs the summarizer through the faux
        // provider (its queued reply is the compaction result), never
        // the dead drift model.
        let calls_before_crossing = registration.call_count();
        let mut crossing_events: Vec<EngineEvent> = Vec::new();
        admit(&engine, big_prompt, &mut crossing_events);
        let starts = crossing_events
            .iter()
            .filter(
                |event| matches!(event, EngineEvent::CompactionStart { event } if event["reason"] == "threshold"),
            )
            .count();
        let ends = crossing_events
            .iter()
            .filter(|event| matches!(event, EngineEvent::Compaction { .. }))
            .count();
        assert_eq!((starts, ends), (1, 1));
        let summary = crossing_events
            .iter()
            .find_map(|event| match event {
                EngineEvent::Compaction { event, .. } => {
                    event["result"]["summary"].as_str().map(str::to_string)
                }
                _ => None,
            })
            .expect("the compaction end carries the summarizer's text");
        assert_eq!(summary, "the drifted summary");
        // The crossing turn and the summarizer both served through the
        // session's provider — the drift model was never called.
        assert_eq!(
            registration.call_count(),
            calls_before_crossing + 2,
            "the crossing turn and the summarizer ran on the session provider"
        );
        assert_eq!(
            assistant_texts(&crossing_events),
            vec!["crossing reply".to_string()]
        );
        // The summarizer followed the live target's key too (the R8
        // seam's key arm): every request against the registration carried
        // the models.json faux key — the engine's config key is `None`,
        // so a summarizer reading the stale config key would surface as
        // a `None` entry here.
        let keys = registration.received_api_keys();
        assert_eq!(keys.len() as u64, registration.call_count());
        assert!(
            keys.iter().all(|key| key.as_deref() == Some("sk-faux")),
            "every call followed the live target's key: {keys:?}"
        );
        assert!(matches!(
            crossing_events.last(),
            Some(EngineEvent::Done(Ok(())))
        ));
    }

    /// Retirement clears the provider target with the session (the TS
    /// replacement teardown): a demand seam before the replacement build
    /// (an immediate `/compact` after the teardown) resolves the CURRENT
    /// model through the pre-build `resolve_model` fallback, never the
    /// retired session's target — a cwd/settings model change lands with
    /// the replacement, not the stale target.
    #[test]
    fn retire_clears_the_provider_target_for_the_replacement_build() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let script = json!({ "responses": [{"text": "seed reply"}] });
        let parsed = pa_ai::faux::script::parse_faux_script(&script).expect("faux script parses");
        let _registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
        std::fs::write(
            agent_dir.join("models.json"),
            json!({
                "providers": {
                    "faux": {
                        "api": "faux", "baseUrl": "http://localhost:0", "apiKey": "sk-faux",
                        "models": [{
                            "id": "faux-1", "name": "Faux Model",
                            "contextWindow": 128_000, "maxTokens": 16384,
                        }],
                    },
                    "drift": {
                        "api": "faux", "baseUrl": "http://localhost:0", "apiKey": "sk-drift",
                        "models": [{
                            "id": "drift-1", "name": "Drift Model",
                            "contextWindow": 128_000, "maxTokens": 16384,
                        }],
                    },
                }
            })
            .to_string(),
        )
        .unwrap();
        let write_settings = |default_provider: &str, default_model: &str| {
            std::fs::write(
                agent_dir.join("settings.json"),
                json!({
                    "defaultProvider": default_provider,
                    "defaultModel": default_model,
                })
                .to_string(),
            )
            .unwrap();
        };
        let new_engine = || {
            AgentSessionEngine::new(AgentEngineConfig {
                cwd: dir.path().to_path_buf(),
                agent_dir: agent_dir.clone(),
                provider: None,
                model: None,
                api_key: None,
                thinking: None,
                session_dir: None,
                session_file: None,
                faux_script: None,
                supervisor_link: None,
                telemetry_disabled: None,
                cron_store: None,
                queued_steering_probe: None,
            })
            .unwrap()
        };
        write_settings("faux", "faux-1");
        let engine = new_engine();
        // The turn builds the session and pins the provider target.
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        let model = engine.session_model().expect("the session model resolves");
        assert_eq!(
            (model.provider.as_str(), model.id.as_str()),
            ("faux", "faux-1")
        );

        // The replacement teardown retires the session while the settings
        // default moves under it (the cwd/settings change the
        // replacement carries).
        write_settings("drift", "drift-1");
        engine
            .runtime
            .block_on(async { engine.retire_session_runtime().await });
        assert!(engine
            .runtime
            .block_on(async { engine.session.lock().await.is_none() }));

        // A demand seam before the replacement build (the prewarm has not
        // rebuilt yet) resolves the CURRENT model, never the retired
        // session's target.
        let model = engine
            .session_model()
            .expect("the replacement model resolves");
        assert_eq!(
            (model.provider.as_str(), model.id.as_str()),
            ("drift", "drift-1"),
            "the retired session's provider target must not outlive it"
        );
    }

    /// End the session telemetry (flushing every queued event through the
    /// local mirror sink) and read one named event's properties: the
    /// transparency mirror is the product's own observable surface for the
    /// run counters.
    fn mirror_telemetry_properties(
        engine: &AgentSessionEngine,
        dir: &std::path::Path,
        name: &str,
    ) -> Vec<Value> {
        {
            let guard = engine.session.blocking_lock();
            let telemetry = guard
                .as_ref()
                .and_then(|core| core.telemetry.as_ref())
                .expect("the faux engine has telemetry installed");
            engine
                .runtime
                .block_on(async { telemetry.end().await })
                .expect("telemetry end flushes");
        }
        let mirror = std::fs::read_to_string(dir.join("agent").join("telemetry.jsonl"))
            .expect("the telemetry mirror exists");
        mirror
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|event| event["name"] == name)
            .map(|event| event["properties"].clone())
            .collect()
    }

    /// The threshold arm feeds the compaction telemetry seam: the crossing
    /// turn's compaction counts into the open run's `compaction_count` and
    /// the session total (TS `compaction_end` handling).
    #[test]
    fn threshold_compaction_counts_into_the_run_telemetry() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Probe: the baseline turn's total usage (system prompt included).
        let (probe, _probe_dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "seed reply"}] }),
            1,
        );
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(&probe, "seed turn".to_string(), &mut probe_events);
        let baseline = probe_events
            .iter()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
                _ => None,
            })
            .expect("probe turn produced usage");
        drop(probe);

        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let headroom = baseline + big_tokens / 2;
        let (engine, dir) = faux_engine_with_settings(
            serde_json::json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "crossing reply"},
                    {"text": "the summary"},
                ],
            }),
            128_000u64
                .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
                .max(1),
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut events);
        admit(&engine, big_prompt, &mut events);
        assert!(
            events
                .iter()
                .any(|event| matches!(event, EngineEvent::Compaction { .. })),
            "the crossing turn compacted"
        );
        let runs = mirror_telemetry_properties(&engine, dir.path(), "agent run completed");
        assert_eq!(runs.len(), 2, "one run per admitted prompt");
        assert_eq!(runs[0]["compaction_count"], serde_json::json!(0));
        assert_eq!(
            runs[1]["compaction_count"],
            serde_json::json!(1),
            "the threshold compaction counted into the open run"
        );
        let ended = mirror_telemetry_properties(&engine, dir.path(), "agent session ended");
        assert_eq!(ended.len(), 1);
        assert_eq!(ended[0]["compaction_count"], serde_json::json!(1));
    }

    /// The requested arm feeds the same seam: the boundary compaction the
    /// kernel's `compact.run` scheduled counts into the open run.
    #[test]
    fn requested_compaction_counts_into_the_run_telemetry() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // A tiny reserve keeps the threshold arm silent (TS reserve 1 means
        // the context must nearly fill the window).
        let (engine, dir) = faux_engine_with_settings(
            serde_json::json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                ]
            }),
            1,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("turn one {}", "x".repeat(48_000)),
            &mut events,
        );
        {
            let guard = engine.session.blocking_lock();
            let core = guard.as_deref().expect("session built");
            engine
                .runtime
                .block_on(async { core.turn_boundary.schedule_compaction(None).await });
        }
        // The second turn carries enough tokens that the keep-recent cut
        // leaves the first turn summarizable (a tiny prompt cuts past it
        // and the compaction skips as too short).
        admit(
            &engine,
            format!("turn two {}", "x".repeat(2_000)),
            &mut events,
        );
        assert!(
            events.iter().any(|event| matches!(
                event,
                EngineEvent::Compaction { event, .. } if event["reason"] == "requested"
            )),
            "the requested compaction ran"
        );
        let runs = mirror_telemetry_properties(&engine, dir.path(), "agent run completed");
        assert_eq!(runs.len(), 2, "one run per admitted prompt");
        assert_eq!(runs[0]["compaction_count"], serde_json::json!(0));
        assert_eq!(
            runs[1]["compaction_count"],
            serde_json::json!(1),
            "the requested compaction counted into the open run"
        );
        let ended = mirror_telemetry_properties(&engine, dir.path(), "agent session ended");
        assert_eq!(ended[0]["compaction_count"], serde_json::json!(1));
    }

    /// The manual wire `compact` command (TS daemon-mode `compact`) feeds
    /// the same seam: the compaction the CompactionManager runs counts
    /// into the still-open run it interrupts.
    #[test]
    fn manual_wire_compaction_counts_into_the_run_telemetry() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (engine, dir) = faux_engine_with_settings(
            serde_json::json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    {"text": "the summary"},
                ]
            }),
            1,
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(
            &engine,
            format!("turn one {}", "x".repeat(48_000)),
            &mut events,
        );
        // A second, small-but-not-tiny turn: the keep-recent cut keeps it
        // (with turn one's tiny tail it would cut past everything and the
        // compaction would skip as too short).
        admit(
            &engine,
            format!("turn two {}", "x".repeat(2_000)),
            &mut events,
        );
        // The wire `compact` command: the CompactionManager's engine call
        // (the run happens between turns, so it counts into the deferred
        // run exactly like TS `compact()` between agent runs).
        let controller = std::sync::Arc::new(pa_agent::abort::AbortController::new());
        let signal = controller.signal();
        let outcome = engine.run_compaction(
            crate::engine::CompactionRequest {
                custom_instructions: None,
            },
            &signal,
        );
        assert!(
            matches!(outcome, crate::engine::CompactionOutcome::Compacted { .. }),
            "the manual compaction ran"
        );
        let runs = mirror_telemetry_properties(&engine, dir.path(), "agent run completed");
        assert_eq!(runs.len(), 2, "one run per admitted prompt");
        assert_eq!(runs[0]["compaction_count"], serde_json::json!(0));
        assert_eq!(
            runs[1]["compaction_count"],
            serde_json::json!(1),
            "the manual wire compaction counted into the open run"
        );
        let ended = mirror_telemetry_properties(&engine, dir.path(), "agent session ended");
        assert_eq!(ended[0]["compaction_count"], serde_json::json!(1));
    }

    /// The `compaction_outcome` rows an unsuccessful auto-compaction
    /// records, with the indices of the disclosure pair and the end event
    /// within the event list (the disclosure goes out first, the end event
    /// second — TS `_endCompactionUnsuccessfully`).
    fn outcome_row_and_end_event(
        events: &[EngineEvent],
        expected_reason: &str,
        expected_outcome: &str,
        expected_message: &str,
        expected_severity: &str,
    ) -> (usize, Value) {
        let row_index = events
            .iter()
            .position(|event| {
                matches!(event, EngineEvent::CustomMessage(row) if row["customType"] == "compaction_outcome")
            })
            .expect("the outcome row was broadcast as a custom message");
        let row = match &events[row_index] {
            EngineEvent::CustomMessage(row) => row.clone(),
            _ => unreachable!("matched above"),
        };
        assert_eq!(row["role"], "custom", "the row is a custom message");
        assert_eq!(row["customType"], "compaction_outcome");
        assert_eq!(row["content"], serde_json::json!(expected_message));
        assert_eq!(row["display"], serde_json::json!(true));
        assert_eq!(
            row["details"],
            serde_json::json!({
                "reason": expected_reason,
                "outcome": expected_outcome,
            })
        );
        let end_index = events[row_index + 1..]
            .iter()
            .position(|event| {
                matches!(event, EngineEvent::Compaction { event, .. } if event["type"] == "compaction_end")
            })
            .map(|offset| offset + row_index + 1)
            .expect("the settled compaction_end follows the row");
        let event = match &events[end_index] {
            EngineEvent::Compaction { event, .. } => event.clone(),
            _ => unreachable!("matched above"),
        };
        assert_eq!(event["reason"], serde_json::json!(expected_reason));
        assert_eq!(event["errorMessage"], serde_json::json!(expected_message));
        assert_eq!(event["errorSeverity"], serde_json::json!(expected_severity));
        assert_eq!(event["aborted"], serde_json::json!(false));
        assert_eq!(event["willRetry"], serde_json::json!(false));
        assert!(
            event.get("result").is_none(),
            "no result on an unsuccessful compaction"
        );
        (row_index, event)
    }

    /// The engine session's durable entry chain carries the outcome row.
    pub(crate) fn outcome_row_in_entries(engine: &AgentSessionEngine) -> bool {
        let guard = engine.session.blocking_lock();
        let Some(core) = guard.as_deref() else {
            return false;
        };
        let persistence = core.session.shared_persistence();
        let entries = engine
            .runtime
            .block_on(async { persistence.lock().await.get_entries() });
        entries.iter().any(|entry| {
            matches!(entry, pa_types::session::FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == "compaction_outcome")
        })
    }

    /// The live loop context carries the outcome row (TS
    /// `agent.state.messages.push`); the loop's converter keeps it out of
    /// the provider request.
    pub(crate) fn outcome_row_in_live_context(engine: &AgentSessionEngine) -> bool {
        let guard = engine.session.blocking_lock();
        let Some(core) = guard.as_deref() else {
            return false;
        };
        engine.runtime.block_on(async {
            let state = core.session.agent().state().await;
            state
                .messages
                .last()
                .is_some_and(|message| message.role() == "custom")
        })
    }

    /// The threshold call site (TS `_runAutoCompaction` -> the
    /// `CompactionSkippedError` arm): a threshold compaction that skips
    /// records the durable `compaction_outcome` row, broadcasts its
    /// message pair before the settled `compaction_end` warning, keeps it
    /// in the live context, and never persists a compaction entry.
    #[test]
    fn threshold_skip_records_the_durable_outcome_row() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Probe: the baseline turn's total usage (system prompt included).
        let (probe, _probe_dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "seed reply"}] }),
            1,
        );
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(&probe, "seed turn".to_string(), &mut probe_events);
        let baseline = probe_events
            .iter()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
                _ => None,
            })
            .expect("probe turn produced usage");
        drop(probe);

        // One big crossing turn whose only summarizable history is itself:
        // the threshold fires, and the compaction skips (too short).
        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let headroom = baseline + big_tokens / 2;
        let (engine, _engine_dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "crossing reply"}] }),
            128_000u64
                .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
                .max(1),
        );
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, big_prompt, &mut events);
        assert_eq!(
            assistant_texts(&events),
            vec!["crossing reply".to_string()],
            "the crossing turn answered"
        );
        let skip_message =
            "Auto-compaction skipped: Session is too short to compact — try again once it grows";
        let (row_index, _) =
            outcome_row_and_end_event(&events, "threshold", "skipped", skip_message, "warning");
        let start_index = events
            .iter()
            .position(|event| {
                matches!(event, EngineEvent::CompactionStart { event } if event["reason"] == "threshold")
            })
            .expect("threshold compaction_start emitted");
        assert!(
            row_index > start_index,
            "the disclosure pair goes out after the start event"
        );
        // The engine's durable entry chain and the live context both carry
        // the row; no compaction entry was written for the skip.
        assert!(outcome_row_in_entries(&engine));
        assert!(outcome_row_in_live_context(&engine));
        let guard = engine.session.blocking_lock();
        let core = guard.as_deref().expect("session built");
        let persistence = core.session.shared_persistence();
        let has_compaction_entry = engine.runtime.block_on(async {
            persistence
                .lock()
                .await
                .get_entries()
                .iter()
                .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. }))
        });
        assert!(
            !has_compaction_entry,
            "a skipped compaction persists no compaction entry"
        );
    }

    /// The requested call site (the turn-boundary consumption): a scheduled
    /// `compact.run` request that skips at consumption records the same
    /// durable disclosure with the `requested` reason.
    #[test]
    fn requested_compaction_skip_records_the_durable_outcome_row() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(
                serde_json::json!({ "responses": [{"text": "seed reply"}, {"text": "second reply"}] })
                    .to_string(),
            ),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let mut events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "turn one".to_string(), &mut events);
        // Schedule a requested compaction (the `compact.run` write path):
        // the boundary consumes it after the next turn settles.
        {
            let guard = engine.session.blocking_lock();
            let core = guard.as_deref().expect("session built");
            engine
                .runtime
                .block_on(async { core.turn_boundary.schedule_compaction(None).await });
        }
        admit(&engine, "turn two".to_string(), &mut events);
        assert_eq!(
            assistant_texts(&events),
            vec!["seed reply".to_string(), "second reply".to_string()],
            "both turns answered"
        );
        outcome_row_and_end_event(
            &events,
            "requested",
            "skipped",
            "Requested compaction skipped: Session is too short to compact — try again once it grows",
            "warning",
        );
        assert!(outcome_row_in_entries(&engine));
        assert!(outcome_row_in_live_context(&engine));
    }

    /// The engine session's durable entry chain carries a compaction
    /// entry (an aborted run must never commit one).
    pub(crate) fn compaction_entry_in_entries(engine: &AgentSessionEngine) -> bool {
        let guard = engine.session.blocking_lock();
        let Some(core) = guard.as_deref() else {
            return false;
        };
        let persistence = core.session.shared_persistence();
        let entries = engine.runtime.block_on(async {
            let snapshot = persistence.lock().await.history_snapshot();
            snapshot.await.expect("history snapshot")
        });
        entries
            .iter()
            .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. }))
    }

    /// Admit one prompt on a parked thread, sharing its events; `started`
    /// flips on the first compaction start event so the caller can abort
    /// the run mid-flight. Returns the join handle.
    pub(crate) fn admit_parked(
        engine: &std::sync::Arc<AgentSessionEngine>,
        message: String,
        events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>>,
        started: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> std::thread::JoinHandle<()> {
        let engine = std::sync::Arc::clone(engine);
        std::thread::spawn(move || {
            engine.run_prompt(
                0,
                PromptRequest {
                    batch: Vec::new(),
                    images: Vec::new(),
                    message,
                    source: "user".to_string(),
                    agent_message_id: None,
                    custom_message: None,
                },
                &|| false,
                &mut |event| {
                    if matches!(event, EngineEvent::CompactionStart { .. }) {
                        started.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    events
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(event);
                    true
                },
            );
        })
    }

    /// Wait until the parked admission's compaction started (a deadline
    /// instead of a hang when the run never reaches the summarizer).
    pub(crate) fn wait_for_compaction_start(started: &std::sync::atomic::AtomicBool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !started.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "the auto compaction never started"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    /// The aborted `compaction_end` event for a cancelled auto compaction:
    /// `aborted` with no `errorMessage`, no `errorSeverity`, and no
    /// `result` (TS `_endCompactionUnsuccessfully`'s `{ aborted: true }`).
    pub(crate) fn assert_cancelled_end_event(
        events: &[EngineEvent],
        expected_reason: &str,
        expected_row_message: &str,
    ) {
        let row_index = events
            .iter()
            .position(|event| {
                matches!(event, EngineEvent::CustomMessage(row) if row["customType"] == "compaction_outcome")
            })
            .expect("the cancelled outcome row was broadcast");
        let EngineEvent::CustomMessage(row) = &events[row_index] else {
            unreachable!("matched above");
        };
        assert_eq!(row["customType"], "compaction_outcome");
        assert_eq!(row["content"], serde_json::json!(expected_row_message));
        assert_eq!(
            row["details"],
            serde_json::json!({
                "reason": expected_reason,
                "outcome": "cancelled",
            })
        );
        assert_eq!(row["display"], serde_json::json!(true));
        let EngineEvent::Compaction { event, .. } = events
            .iter()
            .rev()
            .find(|event| {
                matches!(event, EngineEvent::Compaction { event, .. }
                    if event["type"] == "compaction_end" && event["reason"] == expected_reason)
            })
            .expect("the aborted compaction_end follows the row")
        else {
            unreachable!("matched above");
        };
        assert_eq!(event["aborted"], serde_json::json!(true));
        assert_eq!(event["willRetry"], serde_json::json!(false));
        assert!(
            event.get("errorMessage").is_none(),
            "aborts carry no error message: {event}"
        );
        assert!(
            event.get("errorSeverity").is_none(),
            "aborts carry no error severity: {event}"
        );
        assert!(
            event.get("result").is_none(),
            "an aborted run has no result: {event}"
        );
    }

    /// TS `_runAutoCompaction`'s aborted arm at the threshold call site: a
    /// threshold compaction aborted while the summarizer is in flight
    /// records the durable cancelled outcome row (`Compaction cancelled`,
    /// `{threshold, cancelled}`), broadcasts the aborted `compaction_end`
    /// (no error message — the row owns the disclosure), and never commits
    /// a compaction entry; the turn still settles.
    #[test]
    fn threshold_compaction_aborted_mid_run_records_the_cancelled_outcome() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Probe: the baseline turn's total usage (the same shape as the
        // threshold crossing test; the headroom sits between the two
        // turns' usage).
        let (probe, _probe_dir) = faux_engine_with_settings(
            serde_json::json!({ "responses": [{"text": "seed reply"}] }),
            1,
        );
        let mut probe_events: Vec<EngineEvent> = Vec::new();
        admit(&probe, "seed turn".to_string(), &mut probe_events);
        let baseline = probe_events
            .iter()
            .find_map(|event| match event {
                EngineEvent::AssistantMessage(message) => message["usage"]["totalTokens"].as_u64(),
                _ => None,
            })
            .expect("probe turn produced usage");
        drop(probe);

        let big_prompt = format!("seed turn {} crossing", "x".repeat(48_000));
        let big_tokens = (48_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let headroom = baseline + big_tokens / 2;
        let (engine, _engine_dir) = faux_engine_with_settings(
            serde_json::json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "crossing reply"},
                    // The summarizer held in flight: the abort lands while
                    // the request is open.
                    {"text": "the summary", "delayMs": 30_000},
                ],
            }),
            128_000u64
                .saturating_sub(FAUX_REQUEST_BUDGET + headroom)
                .max(1),
        );
        let engine = std::sync::Arc::new(engine);
        let mut seed_events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "seed turn".to_string(), &mut seed_events);
        assert!(
            !seed_events
                .iter()
                .any(|event| matches!(event, EngineEvent::CompactionStart { .. })),
            "the seed turn stays below the headroom"
        );

        let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Default::default();
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let admission = admit_parked(
            &engine,
            big_prompt,
            std::sync::Arc::clone(&events),
            std::sync::Arc::clone(&started),
        );
        wait_for_compaction_start(&started);
        engine.abort_auto_compaction();
        admission.join().expect("the aborted admission settles");

        let events = events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_cancelled_end_event(&events, "threshold", "Compaction cancelled");
        assert!(outcome_row_in_entries(&engine));
        assert!(outcome_row_in_live_context(&engine));
        assert!(
            !compaction_entry_in_entries(&engine),
            "the aborted threshold compaction never commits"
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, EngineEvent::Done(Ok(())))),
            "the turn settles after the cancelled compaction"
        );
    }

    /// The aborted arm at the requested call site (the turn-boundary
    /// consumption): a `compact.run` request aborted mid-summarizer
    /// records the `Requested compaction cancelled` row with the
    /// `requested` reason, broadcasts the aborted `compaction_end`
    /// (`compaction_start` carries the run's reason), consumes the
    /// pending request, and never commits.
    #[test]
    fn requested_compaction_aborted_mid_run_records_the_cancelled_outcome() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // A tiny reserve keeps the threshold check silent (the headroom is
        // the whole window) while the 10-token keep-recent budget leaves
        // the turns summarizable for the requested run.
        let (engine, _engine_dir) = faux_engine_with_settings(
            serde_json::json!({
                "responses": [
                    {"text": "seed reply"},
                    {"text": "second reply"},
                    // The summarizer held in flight for the abort.
                    {"text": "the summary", "delayMs": 30_000},
                ],
            }),
            1_000,
        );
        let engine = std::sync::Arc::new(engine);
        let mut seed_events: Vec<EngineEvent> = Vec::new();
        admit(&engine, "turn one".to_string(), &mut seed_events);
        // Schedule a requested compaction (the `compact.run` write path):
        // the boundary consumes it after the next turn settles.
        {
            let guard = engine.session.blocking_lock();
            let core = guard.as_deref().expect("session built");
            engine
                .runtime
                .block_on(async { core.turn_boundary.schedule_compaction(None).await });
        }

        let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Default::default();
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // A padded second turn keeps the cut's kept tail over the 10-token
        // keep-recent budget, leaving the first turn as summarizable
        // history for the requested run.
        let padded_turn_two = format!("turn two {}", "y".repeat(400));
        let admission = admit_parked(
            &engine,
            padded_turn_two,
            std::sync::Arc::clone(&events),
            std::sync::Arc::clone(&started),
        );
        wait_for_compaction_start(&started);
        let start_reason = events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find_map(|event| match event {
                EngineEvent::CompactionStart { event } => Some(event["reason"].clone()),
                _ => None,
            })
            .expect("the requested compaction_start event");
        assert_eq!(start_reason, serde_json::json!("requested"));
        engine.abort_auto_compaction();
        admission.join().expect("the aborted admission settles");

        let events = events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_cancelled_end_event(&events, "requested", "Requested compaction cancelled");
        assert!(outcome_row_in_entries(&engine));
        assert!(outcome_row_in_live_context(&engine));
        assert!(
            !compaction_entry_in_entries(&engine),
            "the aborted requested compaction never commits"
        );
        // The pending request was consumed: no stale compaction runs at
        // the next boundary (TS `_runAutoCompaction` takes it before the
        // run).
        {
            let guard = engine.session.blocking_lock();
            let core = guard.as_deref().expect("session built");
            assert!(!engine
                .runtime
                .block_on(async { core.turn_boundary.compaction_scheduled().await }));
        }
        assert!(
            events
                .iter()
                .any(|event| matches!(event, EngineEvent::Done(Ok(())))),
            "the turn settles after the cancelled compaction"
        );
    }

    /// Below the headroom nothing fires: the threshold check stays silent
    /// for turns whose usage fits the default 16k reserve (a 111k headroom
    /// on the 128k window).
    #[test]
    fn threshold_below_the_headroom_stays_silent() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(
                serde_json::json!({ "responses": [{"text": "plain reply"}] }).to_string(),
            ),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: "a small turn".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
        assert_eq!(assistant_texts(&events), vec!["plain reply".to_string()]);
        assert!(
            !events.iter().any(|event| matches!(
                event,
                EngineEvent::CompactionStart { .. } | EngineEvent::Compaction { .. }
            )),
            "no compaction events below the headroom"
        );
    }

    /// A prompt with images records the attachments as multimodal content
    /// blocks after the text (TS prompt admission), even when the model
    /// turn itself cannot run.
    #[test]
    fn prompt_images_ride_the_user_message_content() {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = bare_engine(dir.path());
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: vec![pa_agent::types::ImageContent {
                    data: "QUJD".to_string(),
                    mime_type: "image/png".to_string(),
                }],
                message: "look at this".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
        let user = events.iter().find_map(|event| match event {
            EngineEvent::UserMessage(message) => Some(message.clone()),
            _ => None,
        });
        let user = user.expect("user message emitted");
        assert_eq!(
            user["content"][0],
            json!({ "type": "text", "text": "look at this" })
        );
        assert_eq!(
            user["content"][1],
            json!({ "type": "image", "data": "QUJD", "mimeType": "image/png" })
        );
    }

    #[test]
    fn settings_default_drives_unflagged_resolution() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
        let mut settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
        settings
            .set_default_model_and_provider("battery".into(), "mock-1".into())
            .unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let model = engine.resolve_registry_model().expect("resolved model");
        assert_eq!(model.provider, "battery");
        assert_eq!(model.id, "mock-1");
    }

    /// A scripted loopback HTTP server (the pa-core tests/common pattern,
    /// in-crate): answers from a queue of raw responses and records every
    /// request head. Nothing leaves loopback.
    struct MockCatalogServer {
        port: u16,
        requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl MockCatalogServer {
        async fn start(responses: Vec<Vec<u8>>) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind mock catalog server");
            let port = listener.local_addr().unwrap().port();
            let requests: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let queue = std::sync::Arc::new(std::sync::Mutex::new(
                std::collections::VecDeque::from(responses),
            ));
            let request_log = std::sync::Arc::clone(&requests);
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    let requests = std::sync::Arc::clone(&request_log);
                    let queue = std::sync::Arc::clone(&queue);
                    tokio::spawn(async move {
                        let mut buffer = [0u8; 8_192];
                        let mut read = 0usize;
                        loop {
                            let Ok(n) = socket.read(&mut buffer[read..]).await else {
                                return;
                            };
                            if n == 0 {
                                return;
                            }
                            read += n;
                            if buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                            if read == buffer.len() {
                                break;
                            }
                        }
                        let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                        requests.lock().unwrap().push(head);
                        let response = queue.lock().unwrap().pop_front().unwrap_or_else(|| {
                            b"HTTP/1.1 500 Drained\r\ncontent-length: 0\r\n\r\n".to_vec()
                        });
                        let _ = socket.write_all(&response).await;
                        let _ = socket.flush().await;
                    });
                }
            });
            Self { port, requests }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{}", self.port, path)
        }

        fn request_count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }

    fn catalog_ok_json(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    /// One auth.json with a Prime Inference key + team: the file auth the
    /// engine's registry reads (the private-model lane's scope).
    fn write_prime_auth(agent_dir: &std::path::Path) {
        std::fs::create_dir_all(agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("auth.json"),
            serde_json::json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": "test-key",
                    "primeTeam": { "teamId": "team-1", "name": "Test Team" }
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    /// The Prime Inference `/models` payload: every compiled offline
    /// entry (the coverage gate keeps thin fetches out) plus the private
    /// `internal/glm-5.3-fast` the compiled fallback lacks.
    fn pi_payload() -> String {
        let mut data: Vec<Value> = pa_models::transports::prime_inference_offline_entries()
            .iter()
            .map(|model| {
                serde_json::json!({
                    "id": model.id,
                    "display_name": model.name,
                    "pricing": {
                        "input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0
                    },
                    "specs": {
                        "context_window": model.context_window,
                        "max_output_tokens": model.max_tokens,
                        "supports_reasoning": model.reasoning,
                        "modalities": { "input": ["text"], "output": ["text"] },
                    },
                })
            })
            .collect();
        data.push(serde_json::json!({
            "id": "internal/glm-5.3-fast",
            "display_name": "GLM 5.3 Fast (internal)",
            "pricing": { "input_usd_per_mtok": 0.42, "output_usd_per_mtok": 2.1 },
            "specs": {
                "context_window": 400_000, "max_output_tokens": 131_072,
                "supports_reasoning": true,
                "modalities": { "input": ["text"], "output": ["text"] },
            },
        }));
        serde_json::json!({ "data": data }).to_string()
    }

    /// Install a loopback catalog for `agent_dir` (both fetch layers point
    /// at `server`; no bundled snapshot, so the compiled fallback is the
    /// base and only the fetches add the private team model).
    fn install_loopback_catalog(agent_dir: &std::path::Path, server: &MockCatalogServer) {
        let catalog = pa_models::ModelCatalog::with_urls(
            Some(agent_dir.join("models")),
            None,
            &server.url("/catalog"),
            &server.url("/api/v1"),
        );
        pa_core::models::install_catalog(
            &agent_dir.join("models.json"),
            std::sync::Arc::new(catalog),
        );
    }

    /// A session file whose last `model_change` row pins the private team
    /// model — what a revived worker reads at create.
    fn session_file_pinning_private_model(dir: &std::path::Path) -> std::path::PathBuf {
        session_file_pinning_model(dir, "prime-inference", "internal/glm-5.3-fast")
    }

    /// A session file whose last `model_change` row pins the given model —
    /// what a revived worker reads at create (and what a replacement
    /// flow re-restores at its session boot).
    fn session_file_pinning_model(
        dir: &std::path::Path,
        provider: &str,
        model: &str,
    ) -> std::path::PathBuf {
        let mut session =
            crate::session_store::SessionFile::create(dir.to_str().unwrap_or("/tmp"), None, 0);
        let path = dir.join(crate::session_store::session_file_name(
            session.session_id(),
        ));
        session.set_path(path.clone());
        session.append_model_change(provider, model);
        session.rewrite().unwrap();
        path
    }

    fn restore_test_engine(
        dir: &std::path::Path,
        provider: Option<&str>,
        model: Option<&str>,
    ) -> AgentSessionEngine {
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.to_path_buf(),
            agent_dir: dir.join("agent"),
            provider: provider.map(str::to_string),
            model: model.map(str::to_string),
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: Some(true),
            cron_store: None,
            queued_steering_probe: None,
        })
        .expect("engine")
    }

    /// The daemon model allowlist enforcement at the startup chain
    /// (`resolve_registry_model`): a resolution outside settings
    /// `allowedModels` fails loudly with the typed refusal — the chain
    /// never lands a session on an off-list model (no silent fallback to
    /// the featured default) — and an allowing allowlist keeps the
    /// resolution.
    #[test]
    fn the_startup_chain_refuses_models_outside_the_allowlist() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({ "allowedModels": ["anthropic/*"] }).to_string(),
        )
        .unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: Some(true),
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let error = engine
            .resolve_registry_model()
            .expect_err("off-allowlist model refused");
        let refusal = error
            .downcast_ref::<pa_core::models::ModelAllowlistRefusal>()
            .expect("typed refusal");
        assert_eq!(refusal.selector, "battery/mock-1");
        assert!(
            error
                .to_string()
                .contains("blocked by the daemon model allowlist"),
            "{error}"
        );

        // An allowing allowlist opens the gate: the same engine resolves.
        std::fs::write(
            engine.config.agent_dir.join("settings.json"),
            serde_json::json!({ "allowedModels": ["battery/*"] }).to_string(),
        )
        .unwrap();
        let model = engine.resolve_registry_model().expect("resolved model");
        assert_eq!(model.provider, "battery");
        assert_eq!(model.id, "mock-1");
    }

    /// The revival race this lane fixes (the 2026-09-23 05:57 fleet kill):
    /// a revived session (scheduled wake / update restore / worker
    /// relaunch — a create without model flags) resolves against the cold
    /// registry and lands on the featured default while the daemon boot's
    /// catalog fetch is still in flight. The create-time restore pins the
    /// session's saved model after the readiness window instead.
    #[tokio::test]
    async fn revived_session_restores_its_pinned_model_not_the_startup_default() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_prime_auth(&agent_dir);
        let pi = pi_payload();
        let layer_a = serde_json::json!({ "schemaVersion": 1, "models": [] }).to_string();
        let server = MockCatalogServer::start(vec![
            catalog_ok_json(&layer_a),
            catalog_ok_json(&pi),
            catalog_ok_json(&pi),
        ])
        .await;
        install_loopback_catalog(&agent_dir, &server);
        let path = session_file_pinning_private_model(dir.path());
        let engine = restore_test_engine(dir.path(), None, None);
        engine.set_session_file(path.clone());

        // The premise — the silent fallback the race produced: the cold
        // registry holds only the compiled entries, so the unflagged
        // startup chain picks the featured default (z-ai/glm-5.3), not the
        // model the session file pins. No fetch has run.
        let cold = engine.resolve_registry_model().expect("cold resolution");
        assert_eq!(cold.provider, "prime-inference");
        assert_eq!(cold.id, "z-ai/glm-5.3");
        assert_eq!(
            server.request_count(),
            0,
            "the cold resolution never fetches"
        );

        // The create-time restore: the readiness window covers the fetch,
        // the pinned model restores and every later unflagged resolution
        // runs on it.
        engine.restore_session_model(&path).await;
        let restored = engine
            .resolve_registry_model()
            .expect("restored resolution");
        assert_eq!(restored.provider, "prime-inference");
        assert_eq!(restored.id, "internal/glm-5.3-fast");
        assert!(
            engine.model_fallback_message().is_none(),
            "a successful restore leaves no fallback message"
        );
    }

    /// A restore that misses even after the readiness window falls back to
    /// the startup chain — on the record (TS `modelFallbackMessage`), never
    /// silent.
    #[tokio::test]
    async fn revived_session_fallback_is_on_the_record() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_prime_auth(&agent_dir);
        // Every fetch fails instantly (the drained queue answers 500): the
        // restore misses fast, the startup chain owns the session.
        let server = MockCatalogServer::start(Vec::new()).await;
        install_loopback_catalog(&agent_dir, &server);
        let path = session_file_pinning_private_model(dir.path());
        let engine = restore_test_engine(dir.path(), None, None);
        engine.set_session_file(path.clone());

        engine.restore_session_model(&path).await;
        assert_eq!(
            engine.model_fallback_message().as_deref(),
            Some("Could not restore model prime-inference/internal/glm-5.3-fast. Using prime-inference/z-ai/glm-5.3"),
            "the fallback is published, never silent"
        );
        let resolved = engine.resolve_registry_model().expect("startup chain");
        assert_eq!(resolved.provider, "prime-inference");
        assert_eq!(resolved.id, "z-ai/glm-5.3");
    }

    /// Explicit create flags are authoritative (TS `options.model`): the
    /// saved session model never overrides a flagged selection, and a
    /// skipped restore records no fallback.
    #[tokio::test]
    async fn create_flags_beat_the_saved_session_model() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
        let path = session_file_pinning_private_model(dir.path());
        let engine = restore_test_engine(dir.path(), Some("battery"), Some("mock-1"));
        engine.set_session_file(path.clone());

        engine.restore_session_model(&path).await;
        let resolved = engine.resolve_registry_model().expect("flagged resolution");
        assert_eq!(resolved.provider, "battery");
        assert_eq!(resolved.id, "mock-1");
        assert!(engine.model_fallback_message().is_none());
    }

    /// A session with no saved model context (a fresh file) keeps the
    /// startup chain — the restore is a no-op, nothing is recorded.
    #[tokio::test]
    async fn fresh_session_without_a_saved_model_keeps_the_startup_chain() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_prime_auth(&agent_dir);
        let server = MockCatalogServer::start(Vec::new()).await;
        install_loopback_catalog(&agent_dir, &server);
        // A session file with no model rows at all.
        let mut session = crate::session_store::SessionFile::create(
            dir.path().to_str().unwrap_or("/tmp"),
            None,
            0,
        );
        let path = dir.path().join(crate::session_store::session_file_name(
            session.session_id(),
        ));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        let engine = restore_test_engine(dir.path(), None, None);
        engine.set_session_file(path.clone());

        engine.restore_session_model(&path).await;
        assert!(engine.model_fallback_message().is_none());
        let resolved = engine.resolve_registry_model().expect("startup chain");
        assert_eq!(resolved.id, "z-ai/glm-5.3");
    }

    /// The restore decision is scoped to the file it was computed for: a
    /// replacement flow that moves the worker onto another file without
    /// recomputing keeps the startup chain — the previous session's pin
    /// never silently overrides the moved-to session (TS re-restores at
    /// every session boot).
    #[tokio::test]
    async fn a_restore_decision_is_scoped_to_its_session_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_prime_auth(&agent_dir);
        let pi = pi_payload();
        let layer_a = serde_json::json!({ "schemaVersion": 1, "models": [] }).to_string();
        let server = MockCatalogServer::start(vec![
            catalog_ok_json(&layer_a),
            catalog_ok_json(&pi),
            catalog_ok_json(&pi),
        ])
        .await;
        install_loopback_catalog(&agent_dir, &server);
        let pinned = session_file_pinning_private_model(dir.path());
        let engine = restore_test_engine(dir.path(), None, None);
        engine.set_session_file(pinned.clone());
        engine.restore_session_model(&pinned).await;
        let restored = engine
            .resolve_registry_model()
            .expect("restored resolution");
        assert_eq!(restored.id, "internal/glm-5.3-fast");

        // The worker moves onto another file (a replacement flow that has
        // not recomputed yet): the decision for the old file no longer
        // applies — the startup chain owns the resolution again.
        let mut other = crate::session_store::SessionFile::create(
            dir.path().to_str().unwrap_or("/tmp"),
            None,
            0,
        );
        let other_path = dir
            .path()
            .join(crate::session_store::session_file_name(other.session_id()));
        other.set_path(other_path.clone());
        other.rewrite().unwrap();
        engine.set_session_file(other_path);
        let moved = engine.resolve_registry_model().expect("moved resolution");
        assert_eq!(moved.id, "z-ai/glm-5.3");
        assert!(
            engine.model_fallback_message().is_none(),
            "the old file's decision does not leak into the moved-to session"
        );
    }

    /// A mid-session `/model` switch belongs to the session it switched
    /// (TS `switchSession` -> `createRuntime` rebuilds the runtime config
    /// from the daemon default): a replacement onto another file drops
    /// the switch and restores the moved-to file's own pin.
    #[tokio::test]
    async fn a_model_switch_never_leaks_into_the_replacement_session() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_prime_auth(&agent_dir);
        write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
        let pi = pi_payload();
        let layer_a = serde_json::json!({ "schemaVersion": 1, "models": [] }).to_string();
        let server = MockCatalogServer::start(vec![
            catalog_ok_json(&layer_a),
            catalog_ok_json(&pi),
            catalog_ok_json(&pi),
        ])
        .await;
        install_loopback_catalog(&agent_dir, &server);

        // Session A pins the private model; the worker restores it.
        let file_a = session_file_pinning_private_model(dir.path());
        let engine = std::sync::Arc::new(restore_test_engine(dir.path(), None, None));
        engine.set_session_file(file_a.clone());
        engine.restore_session_model(&file_a).await;
        let restored = engine.resolve_registry_model().expect("restored");
        assert_eq!(restored.id, "internal/glm-5.3-fast");

        // A mid-session /model switch on session A (the worker runs the
        // engine's synchronous switch on the blocking pool, like the turn
        // path — a tokio context must not block on its locks).
        let switched_engine = std::sync::Arc::clone(&engine);
        let switched = tokio::task::spawn_blocking(move || {
            switched_engine.switch_model(EngineModelSelection {
                provider: Some("battery".to_string()),
                model: Some("mock-1".to_string()),
                api_key: None,
                thinking: None,
            })
        })
        .await
        .expect("blocking switch");
        assert!(switched);
        let switched = engine.resolve_registry_model().expect("switched");
        assert_eq!(switched.id, "mock-1");

        // The replacement (switch_session/fork/import) onto another file
        // that pins its own model: the switch does not leak — the
        // moved-to session restores its own pin.
        let file_b = session_file_pinning_private_model(dir.path());
        engine.set_session_file(file_b.clone());
        engine.restore_session_model(&file_b).await;
        let moved = engine.resolve_registry_model().expect("moved resolution");
        assert_eq!(
            moved.id, "internal/glm-5.3-fast",
            "the moved-to session's own file pin wins over the previous session's switch"
        );
        assert!(engine.model_fallback_message().is_none());
    }

    /// An unpersisted session (an in-memory fork, a no-session worker's
    /// replacement) has no file to restore from: the runtime-config reset
    /// must not run with nothing to restore — the live selection keeps
    /// the model the session runs on (TS restores the in-memory branch's
    /// own context).
    #[tokio::test]
    async fn an_unpersisted_session_keeps_its_live_selection() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
        let engine = std::sync::Arc::new(restore_test_engine(dir.path(), None, None));
        engine.configure_create_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-plain".to_string()),
            api_key: None,
            thinking: None,
        });
        // A mid-session /model switch on the live session (the worker
        // runs the engine's synchronous switch on the blocking pool).
        let switched_engine = std::sync::Arc::clone(&engine);
        let switched = tokio::task::spawn_blocking(move || {
            switched_engine.switch_model(EngineModelSelection {
                provider: Some("battery".to_string()),
                model: Some("mock-reason".to_string()),
                api_key: None,
                thinking: None,
            })
        })
        .await
        .expect("blocking switch");
        assert!(switched);

        // The in-memory fork's replacement restore: an empty path is a
        // no-op — the switch survives (never reset to the runtime config).
        engine.restore_session_model(std::path::Path::new("")).await;
        let resolved = engine.resolve_registry_model().expect("live selection");
        assert_eq!(
            (resolved.provider.as_str(), resolved.id.as_str()),
            ("battery", "mock-reason"),
            "the live selection survives an unpersisted replacement"
        );
    }

    /// A replacement re-reads the moved-to session's saved thinking level
    /// (TS `createAgentSession`: `hasThinkingEntry ?
    /// existingSession.thinkingLevel` when the runtime config carries no
    /// explicit flag): the pinned level replaces the settings/medium
    /// default and clamps against the restored model.
    #[tokio::test]
    async fn a_replacement_restores_the_moved_to_sessions_saved_thinking_level() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
        let engine = restore_test_engine(dir.path(), None, None);

        // Session A pins the reasoning model at thinking `low`.
        let mut file_a = crate::session_store::SessionFile::create(
            dir.path().to_str().unwrap_or("/tmp"),
            None,
            0,
        );
        let path_a = dir
            .path()
            .join(crate::session_store::session_file_name(file_a.session_id()));
        file_a.set_path(path_a.clone());
        file_a.append_model_change("battery", "mock-reason");
        file_a.append_thinking_level_change("low");
        file_a.rewrite().unwrap();
        engine.set_session_file(path_a.clone());
        engine.restore_session_model(&path_a).await;
        assert_eq!(
            engine.effective_thinking_level().as_deref(),
            Some("low"),
            "the moved-to session's saved thinking level restores, not the medium default"
        );

        // Session B pins the non-reasoning model at thinking `high`: the
        // saved level restores and clamps against the restored model.
        let mut file_b = crate::session_store::SessionFile::create(
            dir.path().to_str().unwrap_or("/tmp"),
            None,
            0,
        );
        let path_b = dir
            .path()
            .join(crate::session_store::session_file_name(file_b.session_id()));
        file_b.set_path(path_b.clone());
        file_b.append_model_change("battery", "mock-plain");
        file_b.append_thinking_level_change("high");
        file_b.rewrite().unwrap();
        engine.set_session_file(path_b.clone());
        engine.restore_session_model(&path_b).await;
        assert_eq!(
            engine.effective_thinking_level().as_deref(),
            Some("off"),
            "the saved level re-clamps against the restored non-reasoning model"
        );
    }

    /// A compacted session restores the model its post-compaction
    /// assistant message ran on (TS `buildSessionContext().model`: the
    /// last `model_change` row before the compaction summary is
    /// superseded; the surviving assistant message's provider/model is
    /// the session's model context).
    #[tokio::test]
    async fn a_compacted_session_restores_its_post_compaction_model() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
        let mut session = crate::session_store::SessionFile::create(
            dir.path().to_str().unwrap_or("/tmp"),
            None,
            0,
        );
        let path = dir.path().join(crate::session_store::session_file_name(
            session.session_id(),
        ));
        session.set_path(path.clone());
        session.append_model_change("battery", "mock-reason");
        let kept = session.append_message(serde_json::json!({
            "role": "assistant",
            "provider": "battery",
            "model": "mock-plain",
            "api": "openai-responses",
            "content": [],
            "stopReason": "stop",
            "timestamp": 0u64,
            "usage": {
                "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0 }
            }
        }));
        session.append_entry(
            "compaction",
            serde_json::json!({
                "summary": "summary",
                "firstKeptEntryId": kept,
                "tokensBefore": 100
            }),
        );
        session.rewrite().unwrap();

        let engine = restore_test_engine(dir.path(), None, None);
        engine.set_session_file(path.clone());
        engine.restore_session_model(&path).await;
        let restored = engine
            .resolve_registry_model()
            .expect("restored resolution");
        assert_eq!(
            (restored.provider.as_str(), restored.id.as_str()),
            ("battery", "mock-plain"),
            "the post-compaction assistant message pins the restored model, not the superseded model_change"
        );
        assert!(engine.model_fallback_message().is_none());
    }

    /// The create command's explicit flags survive every session
    /// replacement (TS hands the merged `sessionConfig` down through
    /// `switchSession`/`fork`/`import`): a later replacement honors the
    /// create-time selection — never the previous session's `/model`
    /// switch, and never the moved-to file's pin (a flagged selection
    /// skips the restore entirely, so no fallback is recorded either).
    #[tokio::test]
    async fn create_flags_survive_a_session_replacement() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
        // The worker started without an environment model; its create
        // command carries the explicit flag.
        let engine = std::sync::Arc::new(restore_test_engine(dir.path(), None, None));
        engine.configure_create_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-plain".to_string()),
            api_key: None,
            thinking: None,
        });

        // A mid-session /model switch on the first session (the worker
        // runs the engine's synchronous switch on the blocking pool — a
        // tokio context must not block on its locks).
        let switched_engine = std::sync::Arc::clone(&engine);
        let switched = tokio::task::spawn_blocking(move || {
            switched_engine.switch_model(EngineModelSelection {
                provider: Some("battery".to_string()),
                model: Some("mock-reason".to_string()),
                api_key: None,
                thinking: None,
            })
        })
        .await
        .expect("blocking switch");
        assert!(switched);
        let switched = engine.resolve_registry_model().expect("switched");
        assert_eq!(switched.id, "mock-reason");

        // The replacement onto a file pinning its own model: the
        // runtime-config reset returns to the create's folded selection —
        // the switch died with the session it switched, and the file's
        // pin never even runs.
        let moved = session_file_pinning_model(dir.path(), "battery", "mock-reason");
        engine.set_session_file(moved.clone());
        engine.restore_session_model(&moved).await;
        let resolved = engine.resolve_registry_model().expect("flagged resolution");
        assert_eq!(
            (resolved.provider.as_str(), resolved.id.as_str()),
            ("battery", "mock-plain"),
            "the create command's flags survive the replacement"
        );
        assert!(
            engine.model_fallback_message().is_none(),
            "a flagged restore never records a fallback"
        );
    }

    /// The restore clamps the thinking level against the model the
    /// session actually runs on (TS `createAgentSession` resolves the
    /// model first, then `clampThinkingLevel`): a create-time `high`
    /// request restores a non-reasoning pin and the session runs `off`,
    /// and a later replacement onto a reasoning pin re-clamps back to
    /// `high` — the previous session's clamp never leaks into the
    /// moved-to one.
    #[tokio::test]
    async fn a_replacement_re_clamps_the_thinking_level_against_the_restored_model() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_thinking_pair_models_json(&agent_dir, "http://127.0.0.1:9");
        let engine = restore_test_engine(dir.path(), None, None);
        // The create command requested `high`.
        engine.configure_create_model(EngineModelSelection {
            provider: None,
            model: None,
            api_key: None,
            thinking: Some(pa_types::ai::ModelThinkingLevel::High),
        });

        // The worker's first session pins the non-reasoning model: the
        // restore records the pin and the level clamps against it.
        let plain = session_file_pinning_model(dir.path(), "battery", "mock-plain");
        engine.set_session_file(plain.clone());
        engine.restore_session_model(&plain).await;
        assert_eq!(
            engine.effective_thinking_level().as_deref(),
            Some("off"),
            "the clamp follows the restored non-reasoning model, not the reset selection"
        );

        // The replacement onto a file pinning the reasoning model: the
        // moved-to session re-clamps against its own restored pin.
        let reason = session_file_pinning_model(dir.path(), "battery", "mock-reason");
        engine.set_session_file(reason.clone());
        engine.restore_session_model(&reason).await;
        assert_eq!(
            engine.effective_thinking_level().as_deref(),
            Some("high"),
            "the replacement re-clamps the requested level against its restored model"
        );
    }

    /// The engine's switch guard: `switch_model` refuses an off-allowlist
    /// candidate BEFORE the selection mutates, so a refused cycle or switch
    /// never poisons the live selection (every later resolution would fail
    /// at the same gate) — the session keeps resolving its current model.
    #[test]
    fn switch_model_never_poisons_the_selection_with_a_refused_candidate() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({ "allowedModels": ["battery/mock-1"] }).to_string(),
        )
        .unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: Some(true),
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let model = engine.resolve_registry_model().expect("resolved model");
        assert_eq!(model.id, "mock-1");
        // The switched-to model does not match the allowlist: the switch is
        // refused and the selection keeps the resolvable model.
        let switched = engine.switch_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-2".to_string()),
            api_key: None,
            thinking: None,
        });
        assert!(!switched, "off-allowlist switch refused");
        let model = engine.resolve_registry_model().expect("still resolvable");
        assert_eq!(model.id, "mock-1");
        // The allowed model still switches through.
        let switched = engine.switch_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
        });
        assert!(switched, "allowed switch proceeds");
        let model = engine.resolve_registry_model().expect("resolved model");
        assert_eq!(model.id, "mock-1");
    }

    /// A live model switch propagates to the children registry's parent
    /// identity: an inherited `rlm.spawn` resolves the model the session
    /// NOW runs. The build-time stamp alone would go stale after a
    /// switch, so the allowlist gate would refuse a stale selector the
    /// parent no longer runs once the allowlist drops it.
    #[test]
    fn switch_model_propagates_the_new_model_to_the_child_identity() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: Some(SupervisorLinkConfig {
                socket_path: dir.path().join("absent-supervisor.sock"),
                active_session_id: "parent-live".to_string(),
                worker_token: "test-token".to_string(),
            }),
            telemetry_disabled: Some(true),
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let children = engine
            .children
            .as_ref()
            .expect("the supervisor link wires the children registry")
            .clone();
        // The pre-switch identity (the build-time stamp's shape): an
        // older selector.
        children.set_model("battery/mock-2".to_string());
        let switched = engine.switch_model(EngineModelSelection {
            provider: Some("battery".to_string()),
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
        });
        assert!(switched, "the switch proceeds without an allowlist");
        assert_eq!(
            children.parent_model().as_deref(),
            Some("battery/mock-1"),
            "an inherited spawn must resolve the switched-to model, not the stale build-time selector"
        );
    }

    #[test]
    fn configure_model_merges_only_present_fields() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        write_custom_provider_models_json(&agent_dir, "http://127.0.0.1:9");
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: Some("battery".to_string()),
            model: Some("mock-1".to_string()),
            api_key: Some("flag-key".to_string()),
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        // A create config with only a model keeps the provider and key.
        engine.configure_model(EngineModelSelection {
            provider: None,
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
        });
        let model = engine.resolve_registry_model().expect("resolved model");
        assert_eq!(model.provider, "battery");
        assert_eq!(
            engine.resolve_request_api_key(&model).as_deref(),
            Some("flag-key")
        );
    }

    #[test]
    fn agent_engine_reports_model_resolution_failures() {
        let dir = tempfile::TempDir::new().unwrap();
        // One auth-configured model keeps the available list non-empty in
        // every environment (a clean env with no credentials resolves to
        // "No models available" before the flagged-provider error, while a
        // machine with ambient env credentials reaches this test's branch).
        std::fs::create_dir_all(dir.path().join("agent")).unwrap();
        std::fs::write(
            dir.path().join("agent").join("models.json"),
            serde_json::json!({
                "providers": {
                    "battery": {
                        "api": "openai-completions",
                        "baseUrl": "http://127.0.0.1:9",
                        "apiKey": "sk-battery",
                        "models": [
                            { "id": "mock-1", "contextWindow": 128_000, "maxTokens": 4096 }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: Some("no-such-provider".to_string()),
            model: Some("some-model".to_string()),
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let mut events: Vec<EngineEvent> = Vec::new();
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: "hi".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
        // The engine degrades to a Done error with the resolver message.
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], EngineEvent::UserMessage(_)));
        let EngineEvent::Done(Err(error)) = &events[1] else {
            panic!("expected error done");
        };
        assert!(error.contains("Unknown provider"));
    }

    /// A reasoning models.json model (no thinkingLevelMap): supported
    /// levels are off..high, so a requested max clamps to high.
    #[test]
    fn configure_model_thinking_clamps_to_the_models_supported_levels() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("models.json"),
            serde_json::json!({
                "providers": {
                    "battery": {
                        "api": "openai-completions",
                        "baseUrl": "http://127.0.0.1:9",
                        "apiKey": "sk-battery",
                        "models": [
                            {
                                "id": "mock-1",
                                "reasoning": true,
                                "contextWindow": 128_000,
                                "maxTokens": 4096
                            }
                        ]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: Some("battery".to_string()),
            model: Some("mock-1".to_string()),
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: None,
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        // Without an explicit flag the TS default applies (medium, clamped).
        assert_eq!(engine.effective_thinking_level().as_deref(), Some("medium"));
        // The create-config flag is authoritative, clamped to model support.
        engine.configure_model(EngineModelSelection {
            provider: None,
            model: None,
            api_key: None,
            thinking: Some(pa_types::ai::ModelThinkingLevel::Max),
        });
        assert_eq!(engine.effective_thinking_level().as_deref(), Some("high"));
        engine.configure_model(EngineModelSelection {
            provider: None,
            model: None,
            api_key: None,
            thinking: Some(pa_types::ai::ModelThinkingLevel::Low),
        });
        assert_eq!(engine.effective_thinking_level().as_deref(), Some("low"));
    }
}

/// Register the faux provider from a script and return its model. Scripts
/// carry plain-text responses (strings or `{"text"}` objects) or content-block
/// arrays (thinking, text, tool calls) so harnesses can script full turns.
/// Verification harness only; never set by the product.
fn faux_model_from_script(script: &str) -> anyhow::Result<Model> {
    let script: serde_json::Value = serde_json::from_str(script)?;
    let parsed = pa_ai::faux::script::parse_faux_script(&script).map_err(anyhow::Error::msg)?;
    let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
    Ok(registration.get_model())
}

/// The eager turn abort (TS `requestAbort`'s closing `this.agent.abort()`):
/// an abort that lands while the provider response is pending — the
/// compaction flow's interrupt-and-settle wait, the `abort` command, kill,
/// shutdown — cancels the in-flight fetch immediately instead of at the
/// next streamed event. The turn settles on its aborted message with
/// EMPTY_USAGE (TS `createAbortedAssistantMessage` with no partial), so the
/// aborted turn's usage never reaches the goal accounting.
#[test]
fn abort_in_flight_turn_cancels_a_mid_provider_wait() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(
            json!({
                "engine": "faux",
                "responses": [{ "text": "held reply", "delayMs": 60000 }],
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Default::default();
    let turn_engine = std::sync::Arc::clone(&engine);
    let turn_events = std::sync::Arc::clone(&events);
    let turn = std::thread::spawn(move || {
        turn_engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: "hello".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                turn_events.lock().unwrap().push(event);
                true
            },
        );
    });
    // Wait until the turn is live (the agent run started) so the abort
    // lands mid-provider-wait, the window TS's requestAbort owns.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let agent = engine.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            let state = engine.runtime.block_on(agent.state());
            if state.is_streaming {
                break;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the turn never started streaming"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let started = std::time::Instant::now();
    engine.abort_in_flight_turn();
    // The fetch cancels now (TS aborts the fetch, not the next event): the
    // turn settles far inside the 60s hold.
    let (settled_tx, settled_rx) = std::sync::mpsc::channel::<()>();
    let waiter = std::thread::spawn(move || {
        turn.join().unwrap();
        let _ = settled_tx.send(());
    });
    settled_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the aborted turn settles immediately, not after the 60s hold");
    waiter.join().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    // The aborted turn settles on the aborted message with EMPTY usage —
    // the accounting input the goal accounting's aborted guard sees, so
    // the aborted turn's usage is not counted (TS parity).
    let events = events.lock().unwrap();
    let assistant = events
        .iter()
        .rev()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message) => Some(message.clone()),
            _ => None,
        })
        .expect("an assistant message settled");
    assert_eq!(assistant["stopReason"], json!("aborted"));
    assert_eq!(assistant["errorMessage"], json!("Request was aborted"));
    assert_eq!(assistant["usage"]["totalTokens"], json!(0));
    assert_eq!(assistant["usage"]["input"], json!(0));
    assert_eq!(assistant["usage"]["output"], json!(0));
    // The terminal `turn_end` frame follows the aborted row's message
    // pair (TS `turn_end` on an aborted turn): the aborted assistant
    // message is the payload, the tool-result list is empty, and the
    // frame precedes the trailing `DoneAborted` settle.
    let turn_end_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::TurnEnd { message, .. }
                if message["stopReason"] == json!("aborted"))
        })
        .expect("the aborted turn's turn_end event");
    let EngineEvent::TurnEnd {
        message,
        tool_results,
    } = &events[turn_end_index]
    else {
        unreachable!();
    };
    assert_eq!(message, &assistant, "the aborted row is the payload");
    assert!(tool_results.is_empty(), "the aborted turn ran no tools");
    // The run's terminal settle is the structural aborted one
    // (`DoneAborted`, the #2617 typed-settles rework): TS classifies the
    // aborted settle structurally — an abort is not a failure, so the
    // retry backoff never applies and the wire keeps its own
    // `turn_end`/`agent_end` frames — not the generic `Done` variant this
    // pin predates.
    let done_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::DoneAborted))
        .expect("the run's trailing DoneAborted settle");
    assert!(turn_end_index < done_index, "turn_end precedes the settle");
    // The aborted run still ends with its `agent_end` (TS emits it on the
    // abort paths): the payload carries the run's whole message set with
    // the aborted row as the terminal message.
    let agent_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AgentEnd { .. }))
        .expect("the aborted run's agent_end event");
    assert!(
        turn_end_index < agent_end_index && agent_end_index < done_index,
        "agent_end sits between the turn_end and the DoneAborted settle: {events:?}"
    );
    let EngineEvent::AgentEnd { messages } = &events[agent_end_index] else {
        unreachable!();
    };
    assert!(
        messages
            .iter()
            .any(|message| message["stopReason"] == json!("aborted")),
        "the aborted row rides the agent_end payload: {messages:?}"
    );
}

/// The settled turn's terminal frame (TS `turn_end`): the loop's boundary
/// event carries the final assistant message as its payload with the
/// turn's (empty) tool-result list, positioned between the final
/// `AssistantMessage` and the trailing `Done` — the worker frames it as
/// the wire `turn_end` with the TS shape.
#[test]
fn settled_turn_emits_the_terminal_turn_end_payload() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = tests::faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "settled reply"}] }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    tests::admit(&engine, "plain turn".to_string(), &mut events);
    let assistant_index = events
        .iter()
        .position(|event| {
            matches!(event, EngineEvent::AssistantMessage(message) if message["content"] == json!([{ "type": "text", "text": "settled reply" }]))
        })
        .expect("the settled assistant message");
    let turn_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnEnd { .. }))
        .expect("the settled turn's turn_end event");
    let done_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::Done(_)))
        .expect("the trailing Done");
    assert!(
        assistant_index < turn_end_index && turn_end_index < done_index,
        "turn_end sits between the final message and the Done: {events:?}"
    );
    let EngineEvent::TurnEnd {
        message,
        tool_results,
    } = &events[turn_end_index]
    else {
        unreachable!();
    };
    let EngineEvent::AssistantMessage(assistant) = &events[assistant_index] else {
        unreachable!();
    };
    assert_eq!(message, assistant, "the terminal message is the payload");
    assert!(tool_results.is_empty(), "the text-only turn ran no tools");
}

/// The run's terminal frame (TS `agent_end`): the loop's run-end event
/// carries the run's whole message set — the accepted user row and the
/// settled assistant row, in the session wire shapes — positioned after
/// the terminal `turn_end` and before the trailing `Done`. The worker
/// frames it as the wire `agent_end` with the TS `messages` payload; the
/// run-opening `agent_start` stays with the worker's own opening frames,
/// so the engine forwards none for the item's first run.
#[test]
fn settled_turn_emits_the_run_agent_end_payload() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (engine, _engine_dir) = tests::faux_engine_with_settings(
        serde_json::json!({ "responses": [{"text": "settled reply"}] }),
        1,
    );
    let mut events: Vec<EngineEvent> = Vec::new();
    tests::admit(&engine, "plain turn".to_string(), &mut events);
    let turn_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnEnd { .. }))
        .expect("the settled turn's turn_end event");
    let agent_end_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AgentEnd { .. }))
        .expect("the run's agent_end event");
    let done_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::Done(_)))
        .expect("the trailing Done");
    assert!(
        turn_end_index < agent_end_index && agent_end_index < done_index,
        "agent_end sits between the turn_end and the Done: {events:?}"
    );
    let EngineEvent::AgentEnd { messages } = &events[agent_end_index] else {
        unreachable!();
    };
    let roles = messages
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(
        roles,
        ["custom", "user", "assistant"],
        "the run's message set (the deferred harness digest rides first)"
    );
    assert_eq!(
        messages[0]["customType"],
        json!("harness_digest"),
        "the deferred digest row is the run's first message"
    );
    assert_eq!(
        messages[1]["content"],
        json!([{ "type": "text", "text": "plain turn" }]),
        "the accepted user row rides the payload"
    );
    assert_eq!(
        messages[2]["content"],
        json!([{ "type": "text", "text": "settled reply" }]),
        "the settled assistant row rides the payload"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, EngineEvent::AgentStart)),
        "the first run's agent_start stays with the worker's opening frames: {events:?}"
    );
}

/// One `agent_end` per agent run (TS emits per run, so a retried run
/// restarts with its own frames): a retryable provider failure ends the
/// first run with its whole message set — the user row and the failed
/// assistant row — then the retry re-issues as a new run whose `agent_end`
/// carries only the retry's messages (the failed row left the loop
/// context first, TS `messages.slice(0, -1)`). The retry run's opening
/// `agent_start` and `turn_start` forward — a boundary frame (the first
/// run's `agent_end`) already passed in the item.
#[test]
fn retried_run_restarts_with_its_own_agent_frames() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    std::fs::create_dir_all(dir.path().join("agent")).unwrap();
    std::fs::write(
        dir.path().join("agent").join("settings.json"),
        serde_json::json!({
            "compaction": { "enabled": true, "reserveTokens": 1, "keepRecentTokens": 10 },
            "retry": { "enabled": true, "maxRetries": 1, "baseDelayMs": 10 }
        })
        .to_string(),
    )
    .unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(
            serde_json::json!({
                "responses": [
                    { "stopReason": "error", "errorMessage": "faux provider overloaded" },
                    { "text": "recovered reply" },
                ]
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    tests::admit(&engine, "retried turn".to_string(), &mut events);
    let agent_end_indexes = events
        .iter()
        .enumerate()
        .filter(|(_, event)| matches!(event, EngineEvent::AgentEnd { .. }))
        .map(|(index, _)| index)
        .collect::<Vec<usize>>();
    assert_eq!(
        agent_end_indexes.len(),
        2,
        "one agent_end per run: {events:?}"
    );
    let EngineEvent::AgentEnd { messages: first } = &events[agent_end_indexes[0]] else {
        unreachable!();
    };
    let roles = first
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(
        roles,
        ["custom", "user", "assistant"],
        "the failed run's message set (the digest row rides first)"
    );
    assert_eq!(
        first[2]["stopReason"],
        json!("error"),
        "the failed run ends on the error row"
    );
    let EngineEvent::AgentEnd { messages: second } = &events[agent_end_indexes[1]] else {
        unreachable!();
    };
    let roles = second
        .iter()
        .map(|message| message["role"].as_str().unwrap_or_default())
        .collect::<Vec<&str>>();
    assert_eq!(
        roles,
        ["assistant"],
        "the retried run carries only its own messages: {events:?}"
    );
    assert_eq!(
        second[0]["content"],
        json!([{ "type": "text", "text": "recovered reply" }]),
        "the retried run's settled row"
    );
    // The retry run restarted with its own opening frames: the forwarded
    // `agent_start` and `turn_start` both follow the first run's
    // `agent_end`.
    let agent_start_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AgentStart))
        .expect("the retry run's agent_start forwarded");
    assert!(
        agent_start_index > agent_end_indexes[0],
        "the retry run's agent_start follows the failed run's agent_end: {events:?}"
    );
    let retry_turn_start_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::TurnStart))
        .expect("the retry run's turn_start forwarded");
    assert!(
        agent_start_index < retry_turn_start_index && retry_turn_start_index < agent_end_indexes[1],
        "the retry run's turn_start sits between its agent_start and agent_end: {events:?}"
    );
    // The retry itself surfaced on the events between the two runs.
    let auto_retry_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AutoRetryStart { .. }))
        .expect("the retry start event");
    assert!(
        agent_end_indexes[0] < auto_retry_index && auto_retry_index < agent_start_index,
        "the retry start sits between the two runs: {events:?}"
    );
}

/// The aborted turn's goal accounting (TS
/// `_accountGoalUsageForAssistantMessage`'s aborted guard): an active
/// goal's turn aborted mid-provider-wait settles on its aborted row —
/// broadcast through the engine's stream as the message_start/
/// message_end pair (the row's own start frame plus the settled row,
/// `createAbortedAssistantMessage`'s shape: empty content, the abort
/// error, EMPTY usage) — and the row persists, yet the goal accounting
/// skips it: the goal state the goal-start turn left is the state the
/// abort returns (same status, same tokens, same continuation count).
#[test]
fn active_goal_aborted_turn_row_broadcasts_and_goal_accounting_skips_it() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(
            json!({
                "engine": "faux",
                "responses": [
                    { "text": "goal start reply" },
                    { "text": "held reply", "delayMs": 60000 },
                ],
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    // No worker owns the queue here: minted continuation work collects
    // instead of running, so the held turn below is the only live one.
    let _goal_work = tests::goal_admission_collector(&engine);
    let mut events: Vec<EngineEvent> = Vec::new();
    tests::admit(
        &engine,
        "/goal land the aborted row accounting".to_string(),
        &mut events,
    );
    // The goal-start continuation turn ran inside the command's prompt and
    // its usage was accounted (faux usage is nonzero).
    let before = engine.goal_state_value();
    assert_eq!(before["status"], json!("active"), "state: {before:?}");
    assert!(
        before["tokensUsed"].as_u64().unwrap_or(0) > 0,
        "the goal-start turn's usage accounted: {before:?}"
    );
    // The second turn holds mid-provider-wait; the abort cancels the fetch
    // (the eager funnel) and the turn settles on the aborted row.
    let turn_engine = std::sync::Arc::clone(&engine);
    let turn_events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> = Default::default();
    let row_events = std::sync::Arc::clone(&turn_events);
    let turn = std::thread::spawn(move || {
        turn_engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: "held turn".to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                row_events.lock().unwrap().push(event);
                true
            },
        );
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let agent = engine.turn_agent.lock().expect("turn agent lock").clone();
        if let Some(agent) = agent {
            let state = engine.runtime.block_on(agent.state());
            if state.is_streaming {
                break;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the held turn never started streaming"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    engine.abort_in_flight_turn();
    turn.join().expect("the aborted turn settles");
    // The aborted row broadcast as a pair: the row's own start frame (the
    // no-partial abort begins a new message) plus the settled end row.
    let events = turn_events.lock().unwrap();
    let aborted_start = events
        .iter()
        .find_map(|event| match event {
            EngineEvent::AssistantUpdate {
                message,
                stream_event,
            } => (message.get("stopReason").and_then(Value::as_str) == Some("aborted")
                && stream_event
                    .as_ref()
                    .and_then(|event| event.get("type"))
                    .and_then(Value::as_str)
                    == Some("start"))
            .then_some(message.clone()),
            _ => None,
        })
        .expect("the aborted row's start frame broadcast");
    assert_eq!(aborted_start["role"], json!("assistant"));
    assert_eq!(aborted_start["errorMessage"], json!("Request was aborted"));
    let aborted_end = events
        .iter()
        .rev()
        .find_map(|event| match event {
            EngineEvent::AssistantMessage(message)
                if message.get("stopReason").and_then(Value::as_str) == Some("aborted") =>
            {
                Some(message.clone())
            }
            _ => None,
        })
        .expect("the aborted row's settled frame broadcast");
    assert_eq!(aborted_end["role"], json!("assistant"));
    assert_eq!(aborted_end["stopReason"], json!("aborted"));
    assert_eq!(aborted_end["errorMessage"], json!("Request was aborted"));
    assert_eq!(
        aborted_end["content"],
        json!([{ "type": "text", "text": "" }]),
        "the no-partial abort carries empty content"
    );
    assert_eq!(aborted_end["usage"]["totalTokens"], json!(0));
    assert_eq!(aborted_end["usage"]["input"], json!(0));
    assert_eq!(aborted_end["usage"]["output"], json!(0));
    // The goal accounting skipped the aborted row: the goal state the
    // goal-start turn left is unchanged (the wall-clock fields are
    // time-based, so the accounting fields compare).
    let after = engine.goal_state_value();
    assert_eq!(after["status"], json!("active"), "state: {after:?}");
    assert_eq!(after["objective"], before["objective"]);
    assert_eq!(after["tokensUsed"], before["tokensUsed"]);
    assert_eq!(after["continuationsUsed"], before["continuationsUsed"]);
}

/// Scoped process-env overrides for the live-kernel tests: applied on
/// construction, restored on drop. The live-kernel tests are serialized by
/// the faux lock, so nothing races.
#[cfg(test)]
struct KernelEnvOverride {
    saved: Vec<(String, Option<String>)>,
}

#[cfg(test)]
impl KernelEnvOverride {
    fn apply(pairs: Vec<(&str, Option<String>)>) -> Self {
        let saved = pairs
            .iter()
            .map(|(key, _)| ((*key).to_string(), std::env::var(key).ok()))
            .collect();
        for (key, value) in &pairs {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        KernelEnvOverride { saved }
    }
}

#[cfg(test)]
impl Drop for KernelEnvOverride {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

/// The kernel python for the live-kernel abort test (skipped without a live
/// install).
#[cfg(test)]
fn live_kernel_python() -> Option<std::path::PathBuf> {
    let candidate = std::path::PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live kernel test");
    None
}

#[cfg(test)]
fn live_release_dir() -> Option<std::path::PathBuf> {
    let releases = std::path::PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.local/share/prime-agent/releases".to_string(),
        |home| format!("{home}/.local/share/prime-agent/releases"),
    ));
    let Ok(entries) = std::fs::read_dir(&releases) else {
        eprintln!("no releases dir at {releases:?}; skipping live kernel test");
        return None;
    };
    let mut candidates: Vec<std::path::PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join("prime-agent-runtime").is_dir())
        .collect();
    candidates.sort();
    candidates.pop()
}

/// The abort wedge repro (dogfood P0): a turn executing a long kernel cell
/// must unwind at `abort_in_flight_turn` (the kernel interrupt +
/// force-abort path settles the tool race) - not keep the turn alive while
/// the cell runs out. Red: the run thread wedged past the cell's sleep
/// (the daemon worker's `run_turn_once` awaits the admission forever).
#[test]
fn abort_in_flight_turn_cancels_a_running_kernel_cell() {
    let Some(kernel_python) = live_kernel_python() else {
        return;
    };
    let Some(release) = live_release_dir() else {
        return;
    };
    let _env = KernelEnvOverride::apply(vec![
        (
            "PRIME_AGENT_KERNEL_PYTHON",
            Some(kernel_python.display().to_string()),
        ),
        ("PI_PACKAGE_DIR", Some(release.display().to_string())),
        ("PRIME_AGENT_CODING_AGENT_DIR", None),
        ("PRIME_API_KEY", None),
    ]);
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(
            json!({
                "engine": "faux",
                "modelId": "faux-1",
                "modelName": "Faux",
                "reasoning": false,
                "contextWindow": 128_000,
                "tokensPerSecond": 30,
                "responses": [
                    {"content": [
                        {"type": "text", "text": "Running the wedge cell."},
                        {"type": "toolCall", "name": "ipython", "id": "toolu_wedge01",
                         "arguments": {"code":
                            "import time\nopen('wedge-started', 'w').write('1')\ntime.sleep(300)\nopen('wedge-finished', 'w').write('1')\nprint('cell completed')"}}
                    ]},
                    {"content": [{"type": "text", "text": "The cell completed."}]}
                ]
            })
            .to_string(),
        ),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    engine.register_arc();
    let marker = dir.path().join("wedge-started");
    let finished = dir.path().join("wedge-finished");
    let events: std::sync::Arc<std::sync::Mutex<Vec<EngineEvent>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let runner = {
        let engine = std::sync::Arc::clone(&engine);
        let events = std::sync::Arc::clone(&events);
        std::thread::spawn(move || {
            let events = events;
            engine.run_prompt(
                0,
                PromptRequest {
                    batch: Vec::new(),
                    images: Vec::new(),
                    message: "run the wedge cell".to_string(),
                    source: "user".to_string(),
                    agent_message_id: None,
                    custom_message: None,
                },
                &|| false,
                &mut move |event: EngineEvent| {
                    events.lock().unwrap().push(event);
                    true
                },
            );
        })
    };
    // The cell started (bounded by the kernel boot).
    let deadline = std::time::Instant::now() + std::time::Duration::from_mins(3);
    while !marker.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !marker.exists() {
        let events = events.lock().unwrap();
        let wire: Vec<String> = events.iter().map(|event| format!("{event:?}")).collect();
        panic!("the wedge cell never started; events: {wire:?}");
    }
    // Abort strictly mid-cell; the run must settle within the budget.
    engine.abort_in_flight_turn();
    let settled = runner.join();
    match settled {
        Ok(()) => {}
        Err(payload) => std::panic::resume_unwind(payload),
    }
    // The cell died: the finish marker never appears.
    std::thread::sleep(std::time::Duration::from_secs(3));
    assert!(
        !finished.exists(),
        "the interrupted cell must not run to completion"
    );
}

/// A driver loop test harness: faux script + collected events. Holds the
/// faux lock while the engine runs.
#[cfg(test)]
fn run_prompts(
    script: serde_json::Value,
    prompts: &[&str],
) -> (std::sync::Arc<AgentSessionEngine>, Vec<EngineEvent>) {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let engine = std::sync::Arc::new(engine);
    // The in-run continuation hook upgrades the engine's registered arc.
    engine.register_arc();
    let mut events: Vec<EngineEvent> = Vec::new();
    for prompt in prompts {
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: prompt.to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
    }
    (engine, events)
}

/// `get_commands` enumerates the session's skills as `skill:<name>`
/// commands (TS `createAgentConnectionCommands`) — including before the
/// first prompt: the read seam demand-builds the core session (the TS
/// session exists from create), so the client's slash menu sees the
/// skill inventory right after attach. The faux provider registers under
/// `FAUX_TEST_LOCK` on a blocking thread (the lock is std, so it never
/// rides an await); the first model resolution there is the registration,
/// and the demand-build's resolution reads the cached model.
#[tokio::test]
async fn get_commands_enumerates_skills_before_the_first_prompt() {
    use crate::engine::SessionEngine as _;
    let (engine, _dir) = tokio::task::spawn_blocking(|| {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        let skill_dir = agent_dir.join("skills").join("demo-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo-skill\ndescription: Demo the slash menu wiring\n---\nRun the demo.",
        )
        .unwrap();
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir,
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(
                json!({ "engine": "faux", "responses": [{ "text": "ok" }] }).to_string(),
            ),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let engine = std::sync::Arc::new(engine);
        engine.register_arc();
        // Register the faux provider under the lock (this resolution is
        // the registration); the async section then resolves the cached
        // model without re-registering.
        let model = engine.resolve_model().expect("faux model");
        drop(model);
        (engine, dir)
    })
    .await
    .expect("engine build join");
    // No prompt ran: the read seam must build the session itself.
    assert!(engine.session.lock().await.is_none());
    let commands = engine.connection_commands().await;
    assert!(
        engine.session.lock().await.is_some(),
        "the read built the session"
    );
    let skill_commands: Vec<&serde_json::Value> = commands
        .iter()
        .filter(|command| command.get("source").and_then(Value::as_str) == Some("skill"))
        .collect();
    // The checkout's own bundled skills (the packaged `skills/` layout)
    // enumerate too, so the assertion is on the test's own skill, not the
    // count.
    let command = skill_commands
        .iter()
        .find(|command| command.get("name").and_then(Value::as_str) == Some("skill:demo-skill"))
        .unwrap_or_else(|| panic!("the demo skill enumerated: {commands:?}"));
    assert_eq!(
        command.get("description").and_then(Value::as_str),
        Some("Demo the slash menu wiring")
    );
    assert_eq!(
        command
            .get("sourceInfo")
            .and_then(|info| info.get("scope"))
            .and_then(Value::as_str),
        Some("user")
    );
    // Every skill command carries the `skill:` name form and its source
    // info (the menu row's source label reads them).
    for command in &skill_commands {
        assert!(command
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.starts_with("skill:")));
        assert!(command.get("sourceInfo").is_some());
    }
}

/// The TS replacement teardown (`teardownForReplacement` -> `teardownCurrent`
/// -> `session.disposeAsync()`): retiring the built session drops it (the
/// session's kernel disposes with it), and the replacement branch parked
/// while the session was unbuilt is adopted by the async build funnel -
/// the read-seam build, not just the turn-driven one, must consume the
/// parked branch, or a read seam that rebuilt first would strand the
/// replacement's context.
#[tokio::test]
async fn replacement_teardown_retires_the_session_and_the_funnel_adopts_the_branch() {
    let engine = {
        let (engine, _events) = tokio::task::spawn_blocking(|| {
            run_prompts(
                json!({ "engine": "faux", "responses": [{ "text": "first" }] }),
                &["hello"],
            )
        })
        .await
        .expect("prompt join");
        engine
    };
    // The prompt built the session.
    assert!(engine.session.lock().await.is_some());

    // Retire: the built session drops with its mirrored goal handles (the
    // kernel dispose runs under the build gate; the harness session has
    // no live kernel).
    engine.retire_session_runtime().await;
    assert!(engine.session.lock().await.is_none());
    assert!(engine
        .goal_runtime
        .lock()
        .expect("goal runtime lock")
        .is_none());

    // The replacement tail parks the moved branch on the unbuilt engine
    // (the worker parks it on a blocking thread; so does the test).
    let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
    store.append_message(json!({
        "role": "user",
        "content": "moved branch marker",
        "timestamp": 1u64,
    }));
    let branch = store.branch_file_entries();
    {
        let engine = std::sync::Arc::clone(&engine);
        tokio::task::spawn_blocking(move || {
            use crate::engine::SessionEngine as _;
            engine.rebuild_session_context(
                branch,
                pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch,
            )
        })
        .await
        .expect("park join")
        .expect("park branch");
    }
    assert!(engine
        .pending_branch
        .lock()
        .expect("pending branch lock")
        .is_some());

    // The async funnel's build adopts the parked branch: the fresh
    // session starts on the moved branch, not the retired session's
    // context.
    let model = engine.resolve_model().expect("model");
    engine
        .ensure_core_session_async(&model)
        .await
        .expect("rebuild");
    assert!(engine
        .pending_branch
        .lock()
        .expect("pending branch lock")
        .is_none());
    let session = engine.session.lock().await;
    let built = session.as_deref().expect("rebuilt session");
    let state = built.session.agent().state().await;
    let texts: Vec<String> = state
        .messages
        .iter()
        .filter_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::User(user)) => {
                match &user.content {
                    pa_agent::types::UserContent::Text(text) => Some(text.clone()),
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    assert!(
        texts
            .iter()
            .any(|text| text.contains("moved branch marker")),
        "the rebuilt session did not adopt the parked branch: {texts:?}"
    );
    drop(texts);
    drop(state);
    drop(session);
    // The engine owns a private runtime; dropping it from an async
    // context panics, so the teardown rides a blocking thread.
    tokio::task::spawn_blocking(move || drop(engine))
        .await
        .expect("engine drop join");
}

/// A live branch rebuild reloads the goal state from the moved branch (TS
/// `_reloadGoalStateFromBranch` at the `_navigateTree` tail): a branch
/// that predates the goal rows leaves the driver on the branch's own
/// (empty) state, moving back onto the branch that owns the rows
/// restores them, and each reload's change publishes as the
/// `goal_update` payload exactly once (the on-change dedupe the turn
/// emissions share).
#[tokio::test]
async fn live_branch_rebuild_reloads_the_goal_state_from_the_moved_branch() {
    let engine = {
        let (engine, _events) = tokio::task::spawn_blocking(|| {
            run_prompts(
                json!({
                    "engine": "faux",
                    "responses": (0..4).map(|index| json!({ "text": format!("reply {index}") })).collect::<Vec<_>>(),
                }),
                &["hello", "/goal ship it", "/goal pause"],
            )
        })
        .await
        .expect("prompt join");
        std::sync::Arc::new(engine)
    };
    // The prompt built the session and the goal commands left the paused
    // goal's `thread_goal_state` rows on the live branch.
    assert!(engine.session.lock().await.is_some());
    let goal_before = engine.goal_state_value();
    assert_eq!(goal_before["status"], "paused", "state: {goal_before:?}");
    assert_eq!(goal_before["objective"], "ship it");
    let goal_id = goal_before["goalId"].as_str().expect("goal id").to_string();

    // The live branch (the entries the driver's rows live on), captured
    // for the move back. The engine owns a private runtime, so every
    // engine call (the block_on the capture needs) rides a blocking
    // thread.
    let goal_branch = {
        let engine = std::sync::Arc::clone(&engine);
        tokio::task::spawn_blocking(move || {
            let handles = engine
                .goal_runtime
                .lock()
                .expect("goal runtime lock")
                .clone()
                .expect("goal handles");
            let entries = engine
                .runtime
                .block_on(async { handles.session.lock().await })
                .get_all_entries()
                .to_vec();
            // The moved branch is the post-header path (the store form the
            // worker hands the engine carries no header row).
            entries
                .iter()
                .filter(|entry| !matches!(entry, pa_types::session::FileEntry::Header { .. }))
                .cloned()
                .collect::<Vec<_>>()
        })
        .await
        .expect("branch capture join")
    };

    // A pre-goal branch: no `thread_goal_state` entry anywhere.
    let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
    store.append_message(json!({
        "role": "user",
        "content": "moved branch marker",
        "timestamp": 1u64,
    }));
    let branch = store.branch_file_entries();
    {
        let engine = std::sync::Arc::clone(&engine);
        tokio::task::spawn_blocking(move || {
            use crate::engine::SessionEngine as _;
            engine.rebuild_session_context(
                branch,
                pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch,
            )
        })
        .await
        .expect("rebuild join")
        .expect("live branch rebuild");
    }
    let reloaded = engine.goal_state_value();
    assert_eq!(reloaded["status"], "idle", "state: {reloaded:?}");
    // The reload publishes its change once, then stays silent (TS
    // `_emitGoalUpdate` at the reload; the dedupe keeps an unchanged
    // state quiet).
    let update = engine
        .goal_update_after_rebuild()
        .expect("the reload announced the change");
    assert_eq!(update["status"], "idle");
    assert!(engine.goal_update_after_rebuild().is_none());

    // Moving back onto the branch that owns the goal rows restores them
    // (the same-goal id and objective, the durable counters).
    {
        let engine = std::sync::Arc::clone(&engine);
        tokio::task::spawn_blocking(move || {
            use crate::engine::SessionEngine as _;
            engine.rebuild_session_context(
                goal_branch,
                pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch,
            )
        })
        .await
        .expect("rebuild join")
        .expect("live branch rebuild");
    }
    let restored = engine.goal_state_value();
    assert_eq!(restored["status"], "paused", "state: {restored:?}");
    assert_eq!(restored["objective"], "ship it");
    assert_eq!(restored["goalId"].as_str(), Some(goal_id.as_str()));

    // The engine owns a private runtime; dropping it from an async
    // context panics, so the teardown rides a blocking thread.
    tokio::task::spawn_blocking(move || drop(engine))
        .await
        .expect("engine drop join");
}

/// The user rows emitted by one run (message texts in order).
#[cfg(test)]
fn user_texts(events: &[EngineEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::UserMessage(value) => Some(
                value["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
fn assistant_texts(events: &[EngineEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::AssistantMessage(value) => Some(
                value["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
fn custom_rows(events: &[EngineEvent]) -> Vec<serde_json::Value> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CustomMessage(value) => Some(value.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn assistant_updates_stream_live_while_the_turn_runs() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    // A paced script: 40 short words at 100 tokens/second streams for
    // roughly 0.4s wall time. If the engine buffered events until the turn
    // settled, every update would share one emit timestamp; live
    // forwarding spreads them across the stream.
    let words = (0..40).map(|i| format!("w{i} ")).collect::<String>();
    let script = serde_json::json!({
        "engine": "faux",
        "tokensPerSecond": 100.0,
        "responses": [
            {"content": [{"type": "text", "text": words}]}
        ],
    });
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let start = std::time::Instant::now();
    let mut updates: Vec<(std::time::Duration, usize)> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "hi".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            if let EngineEvent::AssistantUpdate { message, .. } = &event {
                let text_len = message["content"].as_array().map_or(0, |blocks| {
                    blocks
                        .iter()
                        .map(|block| {
                            block
                                .get("text")
                                .and_then(Value::as_str)
                                .map_or(0, str::len)
                        })
                        .sum()
                });
                updates.push((start.elapsed(), text_len));
            }
            true
        },
    );
    assert!(
        updates.len() >= 10,
        "the paced stream must produce many updates, got {}",
        updates.len()
    );
    let first = updates.first().unwrap().0;
    let last = updates.last().unwrap().0;
    assert!(
        (last - first) >= std::time::Duration::from_millis(200),
        "updates must spread across the stream, got {first:?}..{last:?}"
    );
    // Content grows monotonically: every update carries the full partial
    // message, so lengths never regress.
    let lengths: Vec<usize> = updates.iter().map(|(_, len)| *len).collect();
    let mut monotonic = lengths.clone();
    monotonic.sort_unstable();
    assert_eq!(lengths, monotonic, "partial message lengths regress");
    // The settled final message arrives too (message_end, not just updates).
    let final_len = lengths.last().copied().unwrap_or(0);
    assert!(final_len >= 40 * 3, "final partial is the full text");
}

/// The wire events one `/compact` produced, in order: the compaction
/// event pair around the durable rows.
#[cfg(test)]
fn compaction_events(events: &[EngineEvent]) -> Vec<serde_json::Value> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::CompactionStart { event } | EngineEvent::Compaction { event, .. } => {
                Some(event.clone())
            }
            _ => None,
        })
        .collect()
}

#[test]
fn compact_session_command_emits_the_ts_event_pair_on_a_skip() {
    let (_engine, events) = run_prompts(
        serde_json::json!({ "responses": ["unused"] }),
        &["/compact"],
    );
    // The echo row precedes the events (TS `_executeSelectedSessionCommand`
    // records it before the queue runs the command); a skip records no
    // result row.
    let rows = custom_rows(&events);
    assert_eq!(rows.len(), 1, "echo only, no result row: {rows:?}");
    assert_eq!(rows[0]["customType"], "session_slash_command");
    assert_eq!(rows[0]["content"], "/compact");
    // The event pair: start, then the settled skip warning.
    let compaction = compaction_events(&events);
    assert_eq!(compaction.len(), 2, "start + end: {compaction:?}");
    assert_eq!(
        compaction[0],
        serde_json::json!({ "type": "compaction_start", "reason": "manual" })
    );
    assert_eq!(
        compaction[1],
        serde_json::json!({
            "type": "compaction_end",
            "reason": "manual",
            "aborted": false,
            "willRetry": false,
            "errorMessage": "Session is too short to compact \u{2014} try again once it grows",
            "errorSeverity": "warning",
        })
    );
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

#[test]
fn compact_session_command_emits_the_result_on_success() {
    // Two big turns (each ~12k tokens by the chars/4 estimate) push the
    // history past the keep-recent budget: the cut keeps the last turn,
    // the summarizer (the third queued faux response) covers the first.
    // The second turn's user message carries the crossing: the
    // keep-recent walk (the 20k default budget) must absorb its budget at
    // the USER message of the last turn — a cut inside a turn (an
    // assistant crossing) is a split-turn compaction that makes TWO
    // summarizer wire calls (TS parity), which this single-summary script
    // does not serve.
    let filler = "history ".repeat(6_000); // ~48k chars = ~12k tokens each
    let big_second = format!("second {}", "padded ".repeat(6_000)); // ~10.5k tokens
    let (_engine, events) = run_prompts(
        serde_json::json!({
            "responses": [
                { "text": filler },
                { "text": filler },
                { "text": "## Summary\nthe session story" },
            ]
        }),
        &["first", &big_second, "/compact focus on the goal"],
    );
    let compaction = compaction_events(&events);
    assert_eq!(compaction.len(), 2, "{compaction:?}");
    assert_eq!(
        compaction[0],
        serde_json::json!({
            "type": "compaction_start",
            "reason": "manual",
            "customInstructions": "focus on the goal",
        })
    );
    let end = &compaction[1];
    assert_eq!(end["type"], "compaction_end");
    assert_eq!(end["reason"], "manual");
    assert_eq!(end["aborted"], false);
    assert_eq!(end["customInstructions"], "focus on the goal");
    let result = end["result"].as_object().expect("the result payload");
    assert_eq!(result["summary"], "## Summary\nthe session story");
    assert!(result["tokensBefore"].as_u64().unwrap_or_default() > 0);
    // The TS dataKeys on the wire result (the live golden,
    // `tests/goldens/compaction-live-ts.json`): summary, firstKeptEntryId,
    // tokensBefore, details — the file-op lists verbatim from the durable
    // entry, and the summarizer usage never rides the wire.
    let mut result_keys: Vec<&str> = result.keys().map(String::as_str).collect();
    result_keys.sort_unstable();
    assert_eq!(
        result_keys,
        ["details", "firstKeptEntryId", "summary", "tokensBefore"],
        "CompactionResult key set"
    );
    assert_eq!(
        result["details"],
        serde_json::json!({ "readFiles": [], "modifiedFiles": [] })
    );
    assert!(result.get("usage").is_none());
    // The durable rows stay minimal (TS's queued `/compact` catch arm
    // records no result row): the echo row is the only custom row — except
    // the `ipython_state` notice, which follows the compaction whenever the
    // session's prewarmed kernel finished booting on this machine in time
    // (kernel-dependent, so it is scoped out of this assertion).
    let rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] != "ipython_state")
        .collect();
    assert_eq!(rows.len(), 1, "the /compact echo only: {rows:?}");
    assert_eq!(rows[0]["customType"], "session_slash_command");
}

#[test]
fn autonomous_on_enables_the_driver_loop() {
    let (engine, events) = run_prompts(
        serde_json::json!({ "responses": ["unused"] }),
        &["/autonomous on --max-continuations 1 --max-turns 5"],
    );
    // The enable prompt runs the session command (echo + status rows) and
    // never admits a model turn.
    let status = custom_rows(&events);
    assert!(status
        .iter()
        .any(|row| row["customType"] == "autonomous_status"
            && row["content"]
                .as_str()
                .unwrap_or_default()
                .starts_with("[autonomous-status: on]")));
    assert_eq!(assistant_texts(&events), Vec::<String>::new());
    let state = engine.autonomous.blocking_lock();
    assert!(state.enabled);
    assert_eq!(state.limits.max_continuations, 1);
    assert_eq!(state.limits.max_turns, 5);
}

#[test]
fn autonomous_limit_stops_the_run_without_a_row() {
    let (engine, events) = run_prompts(
        serde_json::json!({ "responses": ["first", "second"] }),
        &["/autonomous on --max-continuations 1 --max-turns 5", "go"],
    );
    // The continuation churns INSIDE the one run (the TS in-run shape,
    // probed against the binary): the settled turn's `turn_end` is
    // followed by the continuation turn's `turn_start` and user row, with
    // no run boundary between them. Turn 1 continues (missing terminal
    // evidence), turn 2 hits the continuation cap: the stop writes no row
    // (the headless status and exit contracts carry it).
    assert_eq!(assistant_texts(&events), vec!["first", "second"]);
    let texts = user_texts(&events);
    assert_eq!(
        texts,
        vec![
            "go".to_string(),
            "[autonomous-continuation]\n\nNo human input is available in autonomous mode. Continue working until the host evaluator, verifier, or configured autonomous limits stop the run. If you were asking the user a question, make a reasonable assumption and verify it. If you believe you are blocked, prove it with host-observable evidence, preserve that evidence, and keep looking for safe progress while budget remains. Do not end the session yourself; the verifier/evaluator decides completion when configured gates pass.".to_string()
        ]
    );
    // The continuation's frames: one `turn_start` frame between the
    // settled turn's `turn_end` and the continuation user row (the loop's
    // inner-turn start, the run-opening one stays with the worker).
    let turn_ends = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::TurnEnd { .. }))
        .count();
    let turn_starts = events
        .iter()
        .filter(|event| matches!(event, EngineEvent::TurnStart))
        .count();
    assert_eq!(turn_ends, 2);
    assert_eq!(turn_starts, 1, "the continuation turn's inner start");
    // The stop surfaces no `autonomous_status` row of its own: the enable
    // announcement is the only one (the limit stop writes no row — the
    // headless status and exit contracts carry it, the TS shape).
    let status_rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] == "autonomous_status")
        .collect();
    assert_eq!(status_rows.len(), 1, "the enable announcement only");
    assert!(status_rows[0]["content"]
        .as_str()
        .unwrap_or_default()
        .starts_with("[autonomous-status: on]"));
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    // Per-turn usage accounting: two settled turns.
    let state = engine.autonomous.blocking_lock();
    assert_eq!(state.turns_used, 2);
    assert_eq!(state.continuations_used, 1);
}

#[test]
fn autonomous_gate_pass_and_failure_drive_the_loop() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // The gate passes only on its second run (a counter file in the cwd).
    let dir = tempfile::TempDir::new().unwrap();
    let gate = format!(
        "n=$(cat {0}/cnt 2>/dev/null || echo 0); echo $((n+1)) > {0}/cnt; [ $n -ge 1 ]",
        dir.path().display()
    );
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(
                serde_json::json!({ "responses": ["first attempt", "fixed it"] }).to_string(),
            ),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    // The in-run continuation hook upgrades the engine's registered arc.
    engine.register_arc();
    let on = format!("/autonomous on --gate {gate:?}");
    let mut events: Vec<EngineEvent> = Vec::new();
    for prompt in [on.as_str(), "go"] {
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: prompt.to_string(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                events.push(event);
                true
            },
        );
    }
    // Turn 1 fails the gate -> gate-failure continuation (in-run, the next
    // turn of the same run); turn 2 passes -> the run stops with no row
    // (the TS shape: the stop surfaces through the status request and the
    // exit contracts, never a durable row).
    assert_eq!(assistant_texts(&events), vec!["first attempt", "fixed it"]);
    let texts = user_texts(&events);
    assert_eq!(texts.len(), 2);
    assert!(texts[1].starts_with("[autonomous-continuation: gate-failed]"));
    assert!(texts[1].contains("exited with code 1"));
    let status_rows: Vec<_> = custom_rows(&events)
        .into_iter()
        .filter(|row| row["customType"] == "autonomous_status")
        .collect();
    assert_eq!(status_rows.len(), 1, "the enable announcement only");
    assert!(status_rows[0]["content"]
        .as_str()
        .unwrap_or_default()
        .starts_with("[autonomous-status: on]"));
    let state = engine.autonomous.blocking_lock();
    assert_eq!(state.gates.commands, vec![gate]);
    assert_eq!(state.last_gate_failure, None);
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

/// A scripted policy driver: the engine must inject exactly what the trait
/// returns, consult it after every turn, and account every settled message.
#[cfg(test)]
struct ScriptedDriver {
    /// Pops from the end, so reverse the desired order when building.
    follow_ups: std::sync::Mutex<Vec<pa_core::autonomous::AutonomousFollowUp>>,
    accounted: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl pa_core::autonomous::AutonomousDriver for ScriptedDriver {
    fn account_message(
        &self,
        _state: &mut pa_core::autonomous::AutonomousRuntimeState,
        message: &pa_types::ai::AssistantMessage,
    ) {
        assert_ne!(message.stop_reason, pa_types::ai::StopReason::Error);
        self.accounted
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn after_turn<'a>(
        &'a self,
        _state: &'a mut pa_core::autonomous::AutonomousRuntimeState,
        _message: &'a pa_types::ai::AssistantMessage,
    ) -> pa_core::autonomous::AutonomousFollowUpFuture<'a> {
        let next = self
            .follow_ups
            .lock()
            .unwrap()
            .pop()
            .unwrap_or(pa_core::autonomous::AutonomousFollowUp::Inactive);
        Box::pin(async move { next })
    }
}

#[test]
fn the_turn_loop_is_driven_by_the_driver_trait() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(
        AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(serde_json::json!({ "responses": ["one", "two"] }).to_string()),
            supervisor_link: None,
            telemetry_disabled: None,
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap(),
    );
    // The in-run continuation hook upgrades the engine's registered arc.
    engine.register_arc();
    let status = pa_core::autonomous::autonomous_status(&engine.autonomous.blocking_lock());
    // The queue pops from the end: the continuation is consulted first,
    // the stop on the second settled turn.
    let driver = std::sync::Arc::new(ScriptedDriver {
        follow_ups: std::sync::Mutex::new(vec![
            pa_core::autonomous::AutonomousFollowUp::Stop {
                reason: pa_core::autonomous::AutonomousStopReason::Limit(
                    pa_core::autonomous::AutonomousLimitReason::MaxTurns,
                ),
                status: Box::new(status),
            },
            pa_core::autonomous::AutonomousFollowUp::Continue {
                text: "scripted continuation".to_string(),
            },
        ]),
        accounted: std::sync::atomic::AtomicUsize::new(0),
    });
    engine
        .set_autonomous_driver(std::sync::Arc::clone(&driver)
            as std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>);
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "go".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    // The engine holds no autonomous logic of its own: the injected text
    // and the turn count come straight from the trait, minted by the
    // in-run hook (the continuation runs inside the one agent run).
    assert_eq!(
        user_texts(&events),
        vec!["go".to_string(), "scripted continuation".to_string()]
    );
    assert_eq!(
        assistant_texts(&events),
        vec!["one".to_string(), "two".to_string()]
    );
    // The stop surfaces no row (the TS shape).
    assert!(custom_rows(&events)
        .into_iter()
        .all(|row| row["customType"] != "autonomous_status"));
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
    // Per-message accounting ran through the trait for both settled turns.
    assert_eq!(
        driver.accounted.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
}

#[test]
fn agent_engine_streams_updates_and_final_message() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    // Scoped env: the faux seam is process-global; keep the test isolated.
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(serde_json::json!({ "responses": ["streamed answer"] }).to_string()),
        supervisor_link: None,
        telemetry_disabled: None,
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let mut events: Vec<EngineEvent> = Vec::new();
    engine.run_prompt(
        0,
        PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: "hi".to_string(),
            source: "user".to_string(),
            agent_message_id: None,
            custom_message: None,
        },
        &|| false,
        &mut |event| {
            events.push(event);
            true
        },
    );
    // User message, streamed updates, final message, done.
    assert!(matches!(&events[0], EngineEvent::UserMessage(_)));
    assert!(events
        .iter()
        .any(|event| matches!(event, EngineEvent::AssistantUpdate { .. })));
    let final_index = events
        .iter()
        .position(|event| matches!(event, EngineEvent::AssistantMessage(_)))
        .expect("final assistant message");
    let EngineEvent::AssistantMessage(message) = &events[final_index] else {
        unreachable!();
    };
    assert_eq!(message["content"][0]["text"], "streamed answer");
    assert_eq!(message["role"], "assistant");
    assert_eq!(message["stopReason"], "stop");
    assert_eq!(events.last(), Some(&EngineEvent::Done(Ok(()))));
}

/// Serialize a pa-agent message through the session wire shape (adds `role`).
/// Wire form of one provider stream event (TS `assistantMessageEvent`):
/// the event `type` plus the `delta` when the event carries one.
fn stream_event_value(event: &pa_agent::stream::AssistantMessageEvent) -> Option<Value> {
    use pa_agent::stream::AssistantMessageEvent;
    let (kind, delta) = match event {
        AssistantMessageEvent::Start { .. } => ("start", None),
        AssistantMessageEvent::TextStart { .. } => ("text_start", None),
        AssistantMessageEvent::TextDelta { delta, .. } => ("text_delta", Some(delta.as_str())),
        AssistantMessageEvent::TextEnd { .. } => ("text_end", None),
        AssistantMessageEvent::ThinkingStart { .. } => ("thinking_start", None),
        AssistantMessageEvent::ThinkingDelta { delta, .. } => {
            ("thinking_delta", Some(delta.as_str()))
        }
        AssistantMessageEvent::ThinkingEnd { .. } => ("thinking_end", None),
        AssistantMessageEvent::ToolCallStart { .. } => ("toolcall_start", None),
        AssistantMessageEvent::ToolCallDelta { delta, .. } => {
            ("toolcall_delta", Some(delta.as_str()))
        }
        AssistantMessageEvent::ToolCallEnd { .. } => ("toolcall_end", None),
        AssistantMessageEvent::Done { .. } | AssistantMessageEvent::Error { .. } => return None,
    };
    match delta {
        Some(delta) => Some(json!({ "type": kind, "delta": delta })),
        None => Some(json!({ "type": kind })),
    }
}

/// Wire form of one tool result (the TS tool-execution event payload).
fn tool_result_wire_value(result: &pa_agent::types::AgentToolResult) -> Value {
    let content: Vec<Value> = result
        .content
        .iter()
        .map(|block| serde_json::to_value(block).unwrap_or(Value::Null))
        .collect();
    json!({ "content": content, "details": result.details })
}

fn session_wire_value(agent_message: &pa_agent::types::AgentMessage) -> Option<Value> {
    use pa_agent::types::Message as LoopMessage;
    let session_message = match agent_message {
        pa_agent::types::AgentMessage::Standard(LoopMessage::User(user)) => {
            pa_types::session::AgentMessage::User(json_round_trip(user)?)
        }
        pa_agent::types::AgentMessage::Standard(LoopMessage::Assistant(assistant)) => {
            pa_types::session::AgentMessage::Assistant(json_round_trip(assistant)?)
        }
        pa_agent::types::AgentMessage::Standard(LoopMessage::ToolResult(tool_result)) => {
            pa_types::session::AgentMessage::ToolResult(json_round_trip(tool_result)?)
        }
        // A custom row (the harness digest, a goal-context row): the
        // payload is the session-shape custom message and the wire form is
        // the tagged session message — the payload plus the row's role
        // (TS `agent_end.messages` carries custom rows in this shape).
        pa_agent::types::AgentMessage::Custom(custom) => {
            let mut value = custom.payload.clone();
            let object = value.as_object_mut()?;
            object
                .entry("role".to_string())
                .or_insert_with(|| Value::String(custom.role.clone()));
            return Some(value);
        }
    };
    serde_json::to_value(&session_message).ok()
}
