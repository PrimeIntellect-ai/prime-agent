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
mod turn_types;

use turn_types::{
    aborted_message, drop_trailing_assistant, retry_event_to_engine_event, BoundaryRun,
    TurnAdmission, TurnOnce, TurnPrompt, TurnResult,
};

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

// The `SessionEngine` trait impl moved to the child module whole -
// one impl block per trait+type is a rustc constraint (E0119).
mod session_engine_impl;

/// The live quota park (TS `AgentSession._quotaPark`): the session ended
/// a turn because a provider-reported usage reset exceeded the bounded
/// wait, and a durable one-shot wake (a `quota-resume` cron job whose
/// prompt is the resume marker) resumes it. While parked the session
/// itself makes no model calls; the wake's marker turn probes the quota.
#[derive(Debug, Clone)]
pub(crate) struct QuotaParkState {
    /// Parks consumed in this quota episode; bounded by the park
    /// policy's `max_parks` (a successful model call while parked
    /// clears the state and starts the next episode fresh).
    pub(crate) park_count: u32,
    /// Wall-clock wake time for the current park (epoch ms).
    pub(crate) resume_at_ms: u64,
    /// Id of the durable one-shot wake job.
    pub(crate) job_id: Option<String>,
    /// Wake re-arms consumed without a resume (the wake fired but its
    /// probe could not run or settle); bounded by
    /// [`QUOTA_WAKE_MAX_RETRIES`].
    pub(crate) wake_retries: u32,
}

/// Retry delay for a wake that was consumed without resuming (the wake
/// fired, but its marker turn never settled into a probe) — TS
/// `QUOTA_WAKE_RETRY_DELAY_MS`.
pub(crate) const QUOTA_WAKE_RETRY_DELAY_MS: u64 = 60_000;

/// Cap on those retries: a park that can never wake is dropped instead of
/// parked forever — TS `QUOTA_WAKE_MAX_RETRIES`.
pub(crate) const QUOTA_WAKE_MAX_RETRIES: u32 = 3;

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
    /// The live quota park (TS `AgentSession._quotaPark`): shared with the
    /// park callback the retry chain consults (an owned, `'static` future
    /// over `&self` state), so it lives in an `Arc` the callback clones.
    pub(crate) quota_park: std::sync::Arc<std::sync::Mutex<Option<QuotaParkState>>>,
    /// Whether the settled turn parked (the park callback fired): the
    /// turn-settle arms read it to keep an active goal alive — a parked
    /// turn is the park's pause, not the goal's death.
    pub(crate) quota_parked_this_run: std::sync::Arc<std::sync::atomic::AtomicBool>,
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
            quota_park: std::sync::Arc::new(std::sync::Mutex::new(None)),
            quota_parked_this_run: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
            // A moved branch restores its own park (the early return
            // would otherwise skip the build-tail restore and leave the
            // previous branch's park — or none — armed).
            self.restore_quota_park(built).await;
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
        // Restore the quota park this branch ended on (TS
        // `_restoreQuotaPark`, at construction): the newest
        // `provider_quota_park` entry not followed by a
        // `provider_quota_resume` entry. A wake still ahead re-arms the
        // live state (a missing wake is rebuilt; a user-cancelled one is
        // honored by leaving the session unparked); a wake that already
        // passed is left to the durable job — a later failure re-parks
        // from a fresh count, like the TS.
        self.restore_quota_park(built).await;
        // The window walk and the retained-context replay allocated
        // transient entry trees several times the retained size; both are
        // consumed here, so release their freed heap to the OS.
        pa_types::memory_release::trim_freed_heap();
        Ok(())
    }

    /// Scan the built session's branch entries for the park this branch
    /// ended on and re-arm the live park state (TS `_restoreQuotaPark`).
    /// A rebuild starts from the branch's own records: any park carried
    /// by the previous build (a replaced session or a moved branch) is
    /// cleared first, so the state never survives onto a branch that did
    /// not park.
    async fn restore_quota_park(&self, built: &CoreSessionEngine) {
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        let persistence = built.session.shared_persistence();
        let manager = persistence.lock().await;
        let Some(persisted) = manager.latest_quota_park() else {
            return;
        };
        drop(manager);
        let now_ms = crate::util::now_ms();
        if persisted.resume_at_ms <= now_ms {
            // The wake time passed: the durable wake job owns the resume
            // (a failed probe re-parks from a fresh count, like the TS).
            return;
        }
        // A wake job that still exists keeps its id; a missing one is
        // rebuilt and the replacement is recorded so the next restart
        // reuses it instead of arming another beside it; a user-cancelled
        // one is honored (the user owns the wake) by leaving the session
        // unparked.
        let job_id = match &persisted.job_id {
            Some(job_id) if self.quota_wake_job_active(job_id) => persisted.job_id.clone(),
            Some(job_id)
                if self.cron_wiring().is_some_and(|wiring| {
                    wiring.store.list().iter().any(|job| &job.id == job_id)
                }) =>
            {
                return;
            }
            Some(_) | None => self.create_quota_resume_job(persisted.resume_at_ms).await,
        };
        if job_id != persisted.job_id {
            // Write through the BUILT session: the installed slot is
            // still empty while the build runs. A failed write surfaces
            // as a log: the wake exists (rebuilt above), so the restart's
            // stale-park arms still own the recovery.
            if let Err(write_error) = self
                .append_quota_park_entry(
                    Some(built.session.shared_persistence()),
                    persisted.resume_at_ms,
                    persisted.park_count,
                    job_id.as_deref(),
                    None,
                )
                .await
            {
                eprintln!("pa-daemon: restored quota park entry write failed: {write_error}");
            }
        }
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(QuotaParkState {
            park_count: persisted.park_count,
            resume_at_ms: persisted.resume_at_ms,
            job_id,
            wake_retries: 0,
        });
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
        // The retired session's quota park ends with it (the wake's owner
        // is gone); the replacement build restores whatever the new
        // branch's own entries say.
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
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
            let (api_key, headers) = self.resolve_request_key_and_headers(model);
            let mut target = self.provider_target.write().expect("provider target lock");
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
        #[derive(Clone)]
        struct FailoverPrimary {
            model: pa_types::ai::Model,
            thinking_level: pa_agent::types::ThinkingLevel,
            api_key: Option<String>,
            headers: Option<std::collections::BTreeMap<String, String>>,
        }
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
        // The failover-captured primary target state (TS `_backupModel`):
        // the model, its thinking level, and its resolved request auth,
        // restored when the turn settles back onto the primary.
        let primary_state: std::cell::RefCell<Option<FailoverPrimary>> =
            std::cell::RefCell::new(None);
        // The quota-park seam (TS #2375): the retry chain consults the
        // engine at its give-up; a quota failure whose provider-reported
        // reset exceeds the wait cap parks the session (the weak self
        // keeps the callback `'static` — the engine outlives the turn it
        // runs, and a parked give-up surfaces the parked status).
        let quota_parked_flag = std::sync::Arc::clone(&self.quota_parked_this_run);
        let engine_weak = self
            .self_weak
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let park: Option<pa_core::session_engine::provider_park::ParkDecisionCallback> =
            Some(&mut move |message, abort| {
                let engine_weak = engine_weak.clone();
                let abort = abort.to_string();
                let quota_parked_flag = std::sync::Arc::clone(&quota_parked_flag);
                Box::pin(async move {
                    let engine = engine_weak.as_ref().and_then(std::sync::Weak::upgrade)?;
                    let outcome = engine.park_for_quota_reset(&message, &abort).await;
                    if outcome.is_some() {
                        quota_parked_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    outcome
                })
            });
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
                            let (api_key, headers) =
                                self.resolve_request_key_and_headers(&model);
                            *primary = Some(FailoverPrimary {
                                model: model.clone(),
                                thinking_level: map_thinking_level(self.effective_thinking()),
                                api_key,
                                headers,
                            });
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
                            let (api_key, headers) =
                                self.resolve_request_key_and_headers(&next);
                            let mut target =
                                self.provider_target.write().expect("provider target lock");
                            *target = Some(ProviderTarget {
                                service_tier: *self.service_tier.read().expect("service tier lock"),
                                api_key,
                                model: next.clone(),
                                headers,
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
                        let Some(FailoverPrimary {
                            model: primary_model,
                            thinking_level,
                            api_key: primary_api_key,
                            headers: primary_headers,
                        }) = primary
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
                                headers: primary_headers,
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
                park,
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
                // purpose, and the worker services the armed round off the
                // turn's settle (the review never runs before the `Done`).
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
        // The quota-park flag is per-run: only this run's turns can park
        // it (the settle arms read and clear it).
        self.quota_parked_this_run
            .store(false, std::sync::atomic::Ordering::SeqCst);
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
                    // A parked session that completes a model call has its
                    // quota back: clear the park (cancelling any pending
                    // wake) and resume (TS `_completeQuotaParkResume`).
                    // The wake probe's own success needs no second marker;
                    // an early success queues one so the interrupted task
                    // continues right away.
                    if self.is_quota_parked() {
                        let marker =
                            pa_core::session_engine::provider_park::QUOTA_RESUME_MARKER_TEXT;
                        let wake_probe = match &prompt {
                            TurnPrompt::User { text, .. } => text == marker,
                            TurnPrompt::Injected(row) => row.content.text() == marker,
                        };
                        self.runtime.block_on(self.resume_quota_park(wake_probe));
                    }
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
                    // A live quota park owns the resume: the parked turn
                    // is the park's pause, not the goal's death, so the
                    // goal survives until the wake (or a spent park
                    // budget, which declines the park first) ends it (TS
                    // `_stopGoalContinuationForTerminalMessage`'s
                    // `_quotaPark` guard — a restored park guards too,
                    // not only this run's park decision).
                    let parked_this_run = self
                        .quota_parked_this_run
                        .swap(false, std::sync::atomic::Ordering::SeqCst);
                    let live_park = self
                        .quota_park
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .clone();
                    if parked_this_run {
                        emit(EngineEvent::Done(Err(error)));
                        return;
                    }
                    if let Some(park) = live_park {
                        if park.resume_at_ms > crate::util::now_ms() {
                            // A future wake still owns the resume: the
                            // goal survives this failed turn (TS's
                            // `_quotaPark` guard).
                            emit(EngineEvent::Done(Err(error)));
                            return;
                        }
                        // The wake was consumed and this give-up did not
                        // re-park (a non-quota failure): the episode ends
                        // here (the give-up it replaced stands), so the
                        // stale park must not linger without a wake (TS
                        // abort arm's stale-park clear).
                        if let Some(job_id) = &park.job_id {
                            self.cancel_quota_resume_job(job_id);
                        }
                        self.runtime
                            .block_on(self.append_quota_resume_entry("wake-error"));
                        *self
                            .quota_park
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                    }
                    // TS `_stopGoalContinuationForTerminalMessage`: an
                    // error assistant message fails an active goal (the
                    // state change surfaces with the trailing `Done`
                    // through the tracking wrapper).
                    self.finish_goal_for_terminal_error(&error);
                    emit(EngineEvent::Done(Err(error)));
                    return;
                }
            }
            // Turn-boundary consumption (TS `_checkCompaction` requested
            // arm, then `_consumePendingRequestedRefine`): requests the
            // kernel `compact.run`/`refine.run` host handlers scheduled
            // during this turn run now, between turns.
            match self.run_turn_boundary(emit) {
                BoundaryRun::Cancelled => return,
                BoundaryRun::StoppedForCompaction { compacted } => {
                    // The requested compaction armed the trigger; the
                    // round stays armed past this run: TS
                    // `_scheduleAutoRefineAfterCompaction` schedules the
                    // review in the background (never on the
                    // completion path), and the worker services the
                    // armed trigger off the turn's settle.
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
            // The compact-trigger round is NOT consumed here: TS
            // `_scheduleAutoRefineAfterAgentEnd` schedules the review as a
            // background round (`setTimeout(0)`) that runs while the
            // session is idle, never between the compaction and its
            // settled turn — the worker services the armed trigger off
            // the turn's settle (a review LLM call on this boundary held
            // the queued next prompt behind the whole round; the
            // compaction-completion-stall measurement pinned it).
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

    /// The quota-park policy from settings
    /// (`retry.provider.waitForUsage`; TS #2375).
    fn park_policy(&self) -> pa_core::session_engine::provider_park::ProviderParkPolicy {
        pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir)
            .get_provider_park_policy()
    }

    /// True while the session is parked waiting out a provider-reported
    /// usage reset (TS `session.isQuotaParked`).
    pub fn is_quota_parked(&self) -> bool {
        self.quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }

    /// Create the durable one-shot wake that resumes a parked session: a
    /// `quota-resume` cron job in the session's own artifacts whose
    /// prompt is the resume marker (TS `_createQuotaResumeJob`). The
    /// scheduler fires it into the session's follow-up lane, so the wake
    /// survives worker restarts and passivated sessions. Best effort:
    /// `None` when no wake can be armed (outside a daemon worker there is
    /// no scheduler — the park then declines and the give-up stands).
    async fn create_quota_resume_job(&self, resume_at_ms: u64) -> Option<String> {
        let wiring = self.cron_wiring()?;
        let binding = self.kernel_cron_binding()?;
        let schedule_text = format!(
            "at {}",
            pa_core::session::manager::format_iso(resume_at_ms as i64)
        );
        let job = wiring
            .store
            .create(&pa_core::cron::store::CreateAgentCronJobInput {
                active_session_id: binding.active_session_id.clone(),
                session_id: binding.session_id.clone(),
                session_file: binding.session_file.clone(),
                cwd: binding.cwd.clone(),
                source: Some("quota_resume".to_string()),
                label: Some(
                    pa_core::session_engine::provider_park::QUOTA_RESUME_CRON_LABEL.to_string(),
                ),
                prompt: pa_core::session_engine::provider_park::QUOTA_RESUME_MARKER_TEXT
                    .to_string(),
                schedule_text,
                now: Some(crate::util::now_ms()),
                ..Default::default()
            })
            .ok()?;
        // Re-arm the scheduler so the armed job gets a live timer (the
        // same post-mutation seam the kernel heartbeat controllers use;
        // `drop_queued: false` keeps the queued-fire withdrawal a no-op).
        if let Some(hook) = &wiring.mutation_hook {
            let mutation = pa_core::session_engine::host_requests::RlmHeartbeatMutation {
                job: job.clone(),
                drop_queued: false,
            };
            hook(mutation).await;
        }
        Some(job.id)
    }

    /// Cancel a park's pending wake job (TS `_resolveQuotaResumeJob`'s
    /// cancel arm): a completed (fired) job stays — rewriting it would
    /// hide that the wake landed.
    fn cancel_quota_resume_job(&self, job_id: &str) {
        let Some(wiring) = self.cron_wiring() else {
            return;
        };
        let matches_job = wiring
            .store
            .list()
            .iter()
            .any(|job| job.id == job_id && job.status == pa_core::cron::JobStatus::Active);
        if matches_job {
            let _ = wiring.store.cancel(job_id, crate::util::now_ms());
        }
    }

    /// The park callback the retry chain consults at its give-up (the
    /// quota-park seam, TS #2375): a quota-classified failure with a
    /// provider-reported reset beyond the quick-retry wait cap parks the
    /// session until the reset and auto-resumes there. Returns the
    /// parked status for the chain's `final_error`, or `None` to keep
    /// the give-up (not quota-classified, no reset, park disabled,
    /// park budget spent, or no wake can be armed).
    async fn park_for_quota_reset(
        &self,
        message: &pa_agent::types::AssistantMessage,
        abort: &str,
    ) -> Option<pa_core::session_engine::provider_park::ProviderParkOutcome> {
        use pa_core::session_engine::provider_park::{
            is_quota_block_failure, provider_park_decision, quota_failure_reset_ms,
            quota_parked_final_error, NoParkReason, ProviderParkDecision, ProviderParkOutcome,
        };
        let error = message
            .error_message
            .as_deref()
            .unwrap_or("unknown error")
            .to_string();
        // Only a quota failure can park; a non-quota give-up keeps the
        // immediate abort (TS parks only from the wait path's `usage`
        // arm).
        if !is_quota_block_failure(message) {
            return None;
        }
        let reset_ms = quota_failure_reset_ms(message);
        let policy = self.park_policy();
        let existing = self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let now_ms = crate::util::now_ms();
        if let Some(park) = &existing {
            let wake_armed = park
                .job_id
                .as_deref()
                .is_some_and(|job_id| self.quota_wake_job_active(job_id));
            if park.resume_at_ms > now_ms {
                // A live park whose wake is still armed owns the resume:
                // this turn ends without consuming a park or rescheduling
                // (TS `_parkForQuotaReset`'s already-parked arm). A
                // vanished wake (a user cancel in `/cron`) is rebuilt so
                // the park still wakes.
                let (resume_at_ms, job_id) = if wake_armed {
                    (park.resume_at_ms, park.job_id.clone())
                } else {
                    let rebuilt = self.create_quota_resume_job(park.resume_at_ms).await?;
                    (park.resume_at_ms, Some(rebuilt))
                };
                if park.job_id != job_id {
                    // A vanished wake is rebuilt without consuming a park
                    // (TS `_restoreQuotaWakeJob`'s rebuild arm — the
                    // replacement entry records the new job so the next
                    // restore reuses it).
                    *self
                        .quota_park
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(QuotaParkState {
                            park_count: park.park_count,
                            resume_at_ms,
                            job_id: job_id.clone(),
                            wake_retries: park.wake_retries,
                        });
                    // A failed replacement write surfaces as a log:
                    // the rebuilt wake exists, so the restart's stale-park
                    // arms still own the recovery.
                    if let Err(write_error) = self
                        .append_quota_park_entry(
                            self.installed_persistence().await,
                            resume_at_ms,
                            park.park_count,
                            job_id.as_deref(),
                            Some(message.provider.as_str()),
                        )
                        .await
                    {
                        eprintln!(
                            "pa-daemon: quota park wake-rebuild entry write failed: {write_error}"
                        );
                    }
                }
                let resume_at_iso = pa_core::session::manager::format_iso(resume_at_ms as i64);
                return Some(ProviderParkOutcome {
                    status_message: format!(
                        "Session is parked until {resume_at_iso} waiting for the provider usage reset; this turn ended without a retry: {error}",
                    ),
                });
            }
            // The wake already fired (its probe failed or never settled):
            // the decision below re-parks at the newly reported reset, or
            // — with no reset — re-arms a short bounded probe (TS
            // `_recoverQuotaParkWake`); a spent budget or a disabled park
            // ends the episode's stale park exactly like the TS abort
            // arm (the give-up it replaced stands).
        }
        // The park decision (pure): disabled / budget spent decline, a
        // reset parks until it (plus grace), capped at the policy bound.
        let parks_used = existing.as_ref().map_or(0, |park| park.park_count);
        let resume_after_ms = match provider_park_decision(parks_used, reset_ms, &policy) {
            ProviderParkDecision::Park { resume_after_ms } => resume_after_ms,
            ProviderParkDecision::None {
                reason: NoParkReason::NoReset,
            } => {
                let park = existing.filter(|park| park.resume_at_ms <= now_ms)?;
                // The wake fired but its probe could not re-park (no
                // reported reset): re-arm one short probe, bounded so a
                // park that can never wake ends instead of parking
                // forever (TS `_recoverQuotaParkWake`).
                return self.recover_quota_park_wake(park, &error).await;
            }
            ProviderParkDecision::None {
                reason: NoParkReason::Disabled | NoParkReason::ParkBudget,
            } => {
                let park = existing.filter(|park| park.resume_at_ms <= now_ms)?;
                // A stale park whose episode ended here: its wake
                // already fired, so nothing else would resume it (TS
                // abort arm's stale-park clear).
                if let Some(job_id) = &park.job_id {
                    self.cancel_quota_resume_job(job_id);
                }
                *self
                    .quota_park
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                return None;
            }
        };
        let resume_at_ms = now_ms.saturating_add(resume_after_ms);
        // TS always cancels the existing wake before arming the
        // replacement (`_cancelQuotaParkWake(existing)` runs for a stale
        // park AND for one whose scheduled job has not fired yet), so an
        // expired park's lagging job can never race the replacement into
        // a second marker turn.
        if let Some(job_id) = existing.as_ref().and_then(|park| park.job_id.as_deref()) {
            self.cancel_quota_resume_job(job_id);
        }
        // Arm the durable wake first: without a wake the park would be a
        // silent death, so a failed job creation declines the park.
        let job_id = self.create_quota_resume_job(resume_at_ms).await?;
        let park_count = parks_used + 1;
        // The durable park record gates the park exactly like the wake:
        // TS's appendCustomEntry throws on a failed persist (the append
        // rolls back and the park path never reports success), so a
        // failed session-file write cancels the wake and declines the
        // park — the give-up stands instead of a live park a restart
        // would silently lose.
        if let Err(write_error) = self
            .append_quota_park_entry(
                self.installed_persistence().await,
                resume_at_ms,
                park_count,
                Some(job_id.as_str()),
                Some(message.provider.as_str()),
            )
            .await
        {
            self.cancel_quota_resume_job(&job_id);
            eprintln!(
                "pa-daemon: quota park entry write failed, the park is declined: {write_error}"
            );
            return None;
        }
        let state = QuotaParkState {
            park_count,
            resume_at_ms,
            job_id: Some(job_id.clone()),
            wake_retries: existing.as_ref().map_or(0, |park| park.wake_retries),
        };
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(state);
        Some(ProviderParkOutcome {
            status_message: quota_parked_final_error(abort, resume_at_ms, &error),
        })
    }

    /// Wake re-arm for a park whose wake was consumed without resuming
    /// and whose failure reported no reset (TS `_recoverQuotaParkWake`):
    /// one short retry at `QUOTA_WAKE_RETRY_DELAY_MS`, bounded by
    /// [`QUOTA_WAKE_MAX_RETRIES`]; a park that can never wake is dropped
    /// (its resume entry records the drop) and the give-up stands.
    async fn recover_quota_park_wake(
        &self,
        park: QuotaParkState,
        error: &str,
    ) -> Option<pa_core::session_engine::provider_park::ProviderParkOutcome> {
        let retries = park.wake_retries + 1;
        if retries > QUOTA_WAKE_MAX_RETRIES {
            if let Some(job_id) = &park.job_id {
                self.cancel_quota_resume_job(job_id);
            }
            self.append_quota_resume_entry("wake-error").await;
            *self
                .quota_park
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            return None;
        }
        let resume_at_ms = crate::util::now_ms().saturating_add(QUOTA_WAKE_RETRY_DELAY_MS);
        let job_id = self.create_quota_resume_job(resume_at_ms).await?;
        // The re-armed wake needs a replacement entry (TS
        // `_recoverQuotaParkWake` appends one so a restart reads the
        // replacement wake instead of the spent one; it carries no
        // provider field, like the TS). TS's appendCustomEntry throws on
        // a failed persist, so a failed write cancels the re-armed wake
        // and drops the park — the give-up stands.
        if let Err(write_error) = self
            .append_quota_park_entry(
                self.installed_persistence().await,
                resume_at_ms,
                park.park_count,
                Some(job_id.as_str()),
                None,
            )
            .await
        {
            self.cancel_quota_resume_job(&job_id);
            eprintln!(
                "pa-daemon: quota park entry write failed, the re-armed wake is dropped: {write_error}"
            );
            // The spent park cannot stay live without a wake (nothing
            // would ever resume it): the episode ends here and the
            // give-up stands.
            *self
                .quota_park
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            return None;
        }
        let state = QuotaParkState {
            park_count: park.park_count,
            resume_at_ms,
            job_id: Some(job_id.clone()),
            wake_retries: retries,
        };
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(state);
        let resume_at_iso = pa_core::session::manager::format_iso(resume_at_ms as i64);
        Some(pa_core::session_engine::provider_park::ProviderParkOutcome {
            status_message: format!(
                "Session is parked until {resume_at_iso} waiting for the provider usage reset; this turn ended without a retry: {error}"
            ),
        })
    }

    /// Record a park's resume (or drop) transition (TS
    /// `QUOTA_RESUME_CUSTOM_ENTRY_TYPE`'s outcome field).
    async fn append_quota_resume_entry(&self, outcome: &str) {
        let persistence = self
            .session
            .lock()
            .await
            .as_ref()
            .map(|engine| engine.session.shared_persistence());
        let Some(persistence) = persistence else {
            return;
        };
        let mut session = persistence.lock().await;
        // TS's appendCustomEntry throws on a failed persist; the resume
        // path's live clear still stands (the quota IS back — keeping the
        // park armed after a successful model call would be wrong), so
        // the failure surfaces as a log and the restart's stale-park arms
        // own the recovery (the spent park entry cannot restore a live
        // park without a wake).
        if let Err(write_error) = session.append_custom_entry(
            pa_core::session_engine::provider_park::PROVIDER_QUOTA_RESUME_ENTRY,
            Some(serde_json::json!({ "outcome": outcome })),
        ) {
            eprintln!(
                "pa-daemon: quota resume entry write failed (outcome {outcome}): {write_error}"
            );
        }
    }

    /// Whether the park's wake job is still scheduled (Active) in the
    /// session's artifacts.
    fn quota_wake_job_active(&self, job_id: &str) -> bool {
        let Some(wiring) = self.cron_wiring() else {
            return false;
        };
        wiring
            .store
            .list()
            .iter()
            .any(|job| job.id == job_id && job.status == pa_core::cron::JobStatus::Active)
    }

    /// Record the parked transition in the session log (TS
    /// `QUOTA_PARK_CUSTOM_ENTRY_TYPE`), so a restart restores the park
    /// count and the wake. Async (the park callback runs inside the
    /// retry chain's `block_on`, where a nested `block_on` would panic).
    /// The persistence handle is a parameter: the park callback writes
    /// through the installed session, the build-time restore through the
    /// built one (the installed slot is still empty while it runs).
    async fn append_quota_park_entry(
        &self,
        persistence: Option<
            std::sync::Arc<tokio::sync::Mutex<pa_core::session::manager::SessionManager>>,
        >,
        resume_at_ms: u64,
        park_count: u32,
        job_id: Option<&str>,
        provider: Option<&str>,
    ) -> std::io::Result<()> {
        let data = serde_json::json!({
            "resumeAt": pa_core::session::manager::format_iso(resume_at_ms as i64),
            "parkCount": park_count,
            "jobId": job_id,
            "provider": provider,
        });
        let Some(persistence) = persistence else {
            return Ok(());
        };
        let mut session = persistence.lock().await;
        session
            .append_custom_entry(
                pa_core::session_engine::provider_park::PROVIDER_QUOTA_PARK_ENTRY,
                Some(data),
            )
            .map(|_| ())
    }

    /// The installed session's persistence handle (the park callback's
    /// write path).
    async fn installed_persistence(
        &self,
    ) -> Option<std::sync::Arc<tokio::sync::Mutex<pa_core::session::manager::SessionManager>>> {
        self.session
            .lock()
            .await
            .as_ref()
            .map(|engine| engine.session.shared_persistence())
    }

    /// A parked session completed a model call: the quota is back. Clear
    /// the park (cancelling any pending wake), record the resumed
    /// transition, and — unless this success WAS the wake probe — queue
    /// the resume marker so the interrupted task continues right away
    /// (TS `_completeQuotaParkResume`).
    async fn resume_quota_park(&self, wake_probe: bool) {
        let park = self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let Some(park) = park else {
            return;
        };
        if let Some(job_id) = &park.job_id {
            self.cancel_quota_resume_job(job_id);
        }
        let outcome = if wake_probe { "wake" } else { "early" };
        self.append_quota_resume_entry(outcome).await;
        if wake_probe {
            return;
        }
        // Early resume: the quota returned before the wake, so the
        // interrupted task continues now (TS queues the marker through
        // `_queuePreparedPrompt`; this port admits it through the
        // worker's goal-admission lane, the existing follow-up
        // admission seam).
        if let Some(sink) = self
            .goal_admission_sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            sink(crate::engine::GoalTurnEndWork::Continuation(
                crate::engine::GoalContinuation {
                    request: crate::engine::PromptRequest {
                        message: pa_core::session_engine::provider_park::QUOTA_RESUME_MARKER_TEXT
                            .to_string(),
                        images: Vec::new(),
                        source: "user".to_string(),
                        agent_message_id: None,
                        custom_message: None,
                        batch: Vec::new(),
                    },
                    goal_update: None,
                },
            ));
        }
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
                agent.continue_run().await
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
        let () = subscription.unsubscribe().await;
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
