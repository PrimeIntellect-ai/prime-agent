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

// The test mass (the faux harness and the in-file unit battery) moved to
// the child module at the same tree position (agent_engine::tests); the
// FAUX_TEST_LOCK re-export keeps the facade's FAUX_TEST_LOCK paths stable
// for the sibling test modules (overflow_compaction, compact_autorefine,
// session_navigation, acp/{autorefine,compaction_arms,goal_continuation}).
#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
pub(crate) use tests::FAUX_TEST_LOCK;

mod goalcore;

// The model concern (the startup/restore resolution cluster, the
// live session-model and thinking-level surfaces, the request API-key
// seam, and the persisted max-depth read) moved to the child module;
// the `use` below keeps the facade's bare-path caller in scope.
mod model;

use model::persisted_rlm_max_depth;

// The header config types (the create-command contract, the supervisor
// link, the autonomous admission sink, and the private goal/restore/usage
// handle types) moved to the child module at the same tree position
// (agent_engine::config); the re-exports keep the facade's type paths
// stable (worker.rs, autonomous_continuation.rs, overflow_compaction.rs
// and the tests module's use-super glob all reach them through here).
mod config;

// The artifact-reference free fns (the sha256 artifact-id mint, the
// cwd-relative logical-path resolution, and the epoch-millis clock) moved to
// the child module; the facade re-export keeps the in-file trait-impl
// callers' bare-name resolution (no crate paths outside the facade -
// caller scan: resource_snapshot x3, run_prompt-region x2).
mod artifacts;

pub(crate) use artifacts::{artifact_reference, now_millis};

pub use config::AgentEngineConfig;
pub(crate) use config::AutonomousAdmission;
pub use config::SupervisorLinkConfig;
use config::{GoalRuntimeHandles, ProducerUsageSink, RestoredSessionModel};
// The turn-execution inherent impl (the turn state machine: the model-turn
// runner, the turn boundary, the turn loop, the once-runner with its retry
// and failover policy trio, the queue-mode mapping, and the session-agent
// constructor) moved to the child module as its own inherent impl block;
// the facade queue-mode cluster and the trait impl turn callers keep
// resolving through the type (pub(super) bumps on the 3 shared names).
mod turn;

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
    /// `message_end` hook): the natural boundary mints the budget-limit
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
    /// The background-bash liveness probe (TS `_hasLiveBackgroundBashHandles`
    /// reads the session's kernel provisioner): `true` while the session's
    /// kernel still runs background `bash()` handles, so the goal and
    /// autonomous continuation gates can hold their timer-driven turns
    /// without ever taking the session mutex (the consult can run inside
    /// a compaction turn, which holds it). Adopted onto every built
    /// session (a weak provisioner reference) and cleared with the
    /// runtime's retirement or close; an unwired probe answers `false`.
    pub(crate) background_bash_probe:
        std::sync::Mutex<Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>>,
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
    /// The live compaction summary-delta sink the worker installs (the
    /// `compaction_summary_delta` broadcast seam): adopted onto every
    /// built session at [`Self::adopt_built_session`], so every compaction
    /// surface — the manual `compact` command, the threshold, overflow,
    /// and requested auto arms — streams its summarizer deltas to the
    /// attached clients. `None` for engine constructions without a worker
    /// pump (tests, headless embeds): no streaming, no deltas.
    compaction_summary_sink:
        std::sync::Mutex<Option<pa_core::session_engine::compaction_exec::SummaryDeltaSink>>,
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
    /// Build the engine: the shared async runtime, the model selection
    /// (create config, else the process env pair), the supervisor link, the
    /// children registry, and the MCP store.
    ///
    /// # Errors
    ///
    /// Returns an error when the multi-thread runtime cannot be built.
    ///
    /// # Panics
    ///
    /// The MCP user-server and catalog-source closures built here panic
    /// on a poisoned engine cwd lock (a holder panicked while holding
    /// it).
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
            background_bash_probe: std::sync::Mutex::new(None),
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
            compaction_summary_sink: std::sync::Mutex::new(None),
            model_refusal_telemetry,
        })
    }

    /// Replace the autonomous continuation policy. Deterministic eval
    /// harnesses inject a scripted driver here; the product keeps the
    /// default shell-gate driver in the session cwd. Call before the
    /// first admitted turn.
    ///
    /// # Panics
    ///
    /// Panics when the autonomous-driver lock is poisoned (a holder
    /// panicked while holding it).
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

    /// Install the worker's live compaction summary-delta sink (the
    /// `compaction_summary_delta` broadcast seam): the worker calls this
    /// once after the engine is built, capturing its event pump; every
    /// built session adopts the sink at [`Self::adopt_built_session`], so
    /// each compaction surface (the manual `compact` command, the
    /// threshold, overflow, and requested auto arms) streams its
    /// summarizer deltas to the attached clients while the summary
    /// generates.
    ///
    /// # Panics
    ///
    /// Panics when the sink slot's mutex is poisoned.
    pub fn set_compaction_summary_sink(
        &self,
        sink: pa_core::session_engine::compaction_exec::SummaryDeltaSink,
    ) {
        *self
            .compaction_summary_sink
            .lock()
            .expect("compaction summary sink lock") = Some(sink);
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
        // The live compaction summary-delta sink (the worker's
        // `compaction_summary_delta` broadcast): adopted onto the built
        // session like the goal runtime mirrors, so every rebuild's
        // compactions stream — the worker installs the sink before the
        // first build and every built session takes the current slot.
        if let Some(sink) = self
            .compaction_summary_sink
            .lock()
            .expect("compaction summary sink lock")
            .clone()
        {
            built.session.set_compaction_summary_sink(sink);
        }
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
                compaction: built.session.compaction_settings(),
            });
        // The background-bash liveness probe (TS `_hasLiveBackgroundBashHandles`
        // reads the provisioner's kernel manager): the same deadlock-free
        // read discipline as the mirror, over the build's own provisioner —
        // the kernel's bash-activity tracking (the state behind the
        // bash-done completion follow-ups) is the liveness surface a held
        // continuation waits on.
        let provisioner = built.kernel_provisioner_weak();
        *self
            .background_bash_probe
            .lock()
            .expect("background bash probe lock") = Some(std::sync::Arc::new(move || {
            provisioner
                .upgrade()
                .and_then(|provisioner| provisioner.manager())
                .is_some_and(|manager| manager.has_background_work())
        }));
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
        // The window walk and the retained-context replay allocated
        // transient entry trees several times the retained size; both are
        // consumed here, so release their freed heap to the OS.
        pa_types::memory_release::trim_freed_heap();
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
        *self
            .background_bash_probe
            .lock()
            .expect("background bash probe lock") = None;
        *self.published_goal.lock().expect("published goal lock") = None;
        // The retired session's provider target goes with it: a demand
        // seam before the replacement build (an immediate `/compact`)
        // must resolve the CURRENT model through the pre-build
        // `resolve_model` fallback, not rebuild on the retired session's
        // target while a cwd/settings change waits for the prewarm.
        *self.provider_target.write().expect("provider target lock") = None;
        if let Some(engine) = built {
            // The replacement teardown also drops the compact-trigger
            // state with a version bump (TS teardown -> `requestAbort` ->
            // `_autoRefineReviewAbort.abort()`): a background review round
            // still in flight on this session resolves against the
            // bumped version and never applies its edits or surfaces its
            // rows.
            engine.session.discard_compact_auto_refine();
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
    ///
    /// # Panics
    ///
    /// Panics when an internal mutex is poisoned (the goal runtime or the
    /// autonomous boundary lock, after a holder panicked while holding
    /// it).
    pub fn mark_session_closed(&self) {
        self.session_closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        *self.goal_runtime.lock().expect("goal runtime lock") = None;
        *self
            .autonomous_boundary
            .lock()
            .expect("autonomous boundary lock") = None;
        *self
            .background_bash_probe
            .lock()
            .expect("background bash probe lock") = None;
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
    ///
    /// # Errors
    ///
    /// Returns an error when no session kernel is running ("Kernel is
    /// not running"), or when the kernel's own shell-activity call fails.
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
            let (api_key, headers) = self.resolve_request_key_and_headers(model);
            *target = Some(ProviderTarget {
                service_tier: *self.service_tier.read().expect("service tier lock"),
                api_key,
                model: model.clone(),
                headers,
            });
        }
        if let Some(session_dir) = &self.config.session_dir {
            std::fs::create_dir_all(session_dir)?;
        }
        let cwd = self.cwd();
        let session_file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        // The engine session carries the session's own directory (the
        // refine path's local harness state and the session's identity)
        // while staying non-persisted: the worker owns the durable
        // session file and mirrors the entries into it. The configured
        // session dir leads; the session file's parent (the create
        // command's sessionDir) is the daemon's own fallback — the
        // engine config itself is built without one.
        let session_manager = match self
            .config
            .session_dir
            .as_deref()
            .or_else(|| session_file.as_deref().and_then(std::path::Path::parent))
        {
            Some(session_dir) => {
                pa_core::session::manager::SessionManager::in_memory_in_session_dir(
                    &cwd,
                    session_dir,
                )
            }
            None => pa_core::session::manager::SessionManager::in_memory(&cwd),
        };
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
        // TS `AgentSession` wires `onBackgroundWorkSettled` onto the kernel
        // provisioner (agent-session.ts): the kernel's last live background
        // `bash()` handle settling — or the kernel tearing down while one
        // runs — retries the owed continuations, the same resume pair the
        // RLM child settlement sites fire. An engine without a registered
        // arc (direct-construction harnesses) wires nothing, exactly like
        // the in-run autonomous hook.
        let on_background_work_settled = self
            .self_weak
            .lock()
            .expect("engine self weak lock")
            .clone()
            .map(|weak| {
                std::sync::Arc::new(move || {
                    if let Some(engine) = weak.upgrade() {
                        engine.retry_owed_goal_continuation();
                        engine.retry_owed_autonomous_continuation();
                    }
                }) as pa_core::kernel::shared::BackgroundWorkSettledCallback
            });
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
            on_background_work_settled,
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
            // descendant work or a live background bash handle defers the
            // mint (the continuation is owed, not consumed; the settle
            // sites deliver it).
            if self.has_unsettled_rlm_work().await || self.has_live_background_bash_handles() {
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
    /// body the turn boundaries use (`compact_autorefine.rs`).
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
                headers: None,
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
                        model: result.model,
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
