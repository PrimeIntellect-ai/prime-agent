//! The real agent-session engine for daemon workers: a pa-core session
//! over the shared provider adapter, driven through the daemon's
//! `SessionEngine` contract. Assistant updates forward to the emit
//! callback as they arrive — never buffered until the turn settles.

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
use crate::image_route::ImageRoute;
use crate::rlm_children::{ParentIdentity, SupervisorChildSessions, DEFAULT_RLM_MAX_DEPTH};

// The test mass (the faux harness and the in-file unit battery) moved to
// the child module at the same tree position (agent_engine::tests); the
// FAUX_TEST_LOCK re-export keeps the facade's FAUX_TEST_LOCK paths stable
// for the sibling test modules (overflow_compaction, compact_autorefine,
// session_navigation).
#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
pub(crate) use tests::FAUX_TEST_LOCK;

mod goalcore;
mod lifecycle;
mod turn_types;

use turn_types::{
    aborted_message, drop_trailing_assistant, retry_event_to_engine_event, BoundaryRun,
    TurnAdmission, TurnOnce, TurnPrompt, TurnResult,
};

mod model;

use model::persisted_rlm_max_depth;
pub(crate) use model::saved_session_context_from_parts;

mod config;

mod artifacts;

pub(crate) use artifacts::{artifact_reference, now_millis};

pub use config::AgentEngineConfig;
pub(crate) use config::AutonomousAdmission;
pub(crate) use config::CreateSessionResources;
pub use config::SupervisorLinkConfig;
use config::{GoalRuntimeHandles, ProducerUsageSink, RestoredSessionModel, StartupScope};

mod reload;
mod session_engine_impl;

mod turn;

/// The live quota park: parked on a provider-reported usage reset, resumed
/// by a durable one-shot wake; while parked, no model calls run.
#[derive(Debug, Clone)]
pub(crate) struct QuotaParkState {
    /// Parks consumed in this quota episode; bounded by `max_parks`.
    pub(crate) park_count: u32,
    /// Wall-clock wake time for the current park (epoch ms).
    pub(crate) resume_at_ms: u64,
    pub(crate) job_id: Option<String>,
    /// Wake re-arms without a resume; bounded by
    /// [`QUOTA_WAKE_MAX_RETRIES`].
    pub(crate) wake_retries: u32,
}

pub(crate) const QUOTA_WAKE_RETRY_DELAY_MS: u64 = 60_000;

/// A park that can never wake is dropped instead of parked forever.
pub(crate) const QUOTA_WAKE_MAX_RETRIES: u32 = 3;

/// The session's snapshot-flushing kernel stop as a boxed-future factory.
pub(crate) type SettledKernelRelease =
    std::sync::Arc<dyn Fn() -> futures::future::BoxFuture<'static, ()> + Send + Sync>;

/// A [`SessionEngine`] running real agent turns.
pub struct AgentSessionEngine {
    pub(crate) runtime: crate::async_safe_runtime::AsyncSafeRuntime,
    pub(crate) config: AgentEngineConfig,
    /// The session-scoped ACP MCP store, shared with the core engine's prompt gating.
    pub(crate) mcp: std::sync::Arc<std::sync::Mutex<pa_core::mcp::McpManager>>,
    /// The last emitted `goal_update`; unchanged states stay silent.
    pub(crate) published_goal: std::sync::Mutex<Option<pa_core::goals::GoalState>>,
    pub(crate) late_agent_message_sink:
        std::sync::Mutex<Option<pa_core::LateSentAgentMessageHandler>>,
    /// The session's goal driver and session-manager handles, mirrored from
    /// the core session at build time: the core session's own mutex is held
    /// across a turn's admission, so goal checks inside emit callbacks
    /// (which may run in async context) must not lock it.
    pub(crate) goal_runtime: std::sync::Mutex<Option<GoalRuntimeHandles>>,
    /// The pending-continuation guard, mirrored lock-free at build: contexts
    /// that cannot take the async driver lock release it through this atomic
    /// handle.
    pub(crate) pending_goal_continuation:
        std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    /// Whether this run's usage crossed the goal's token budget: the boundary
    /// mints the budget-limit wrap-up steer. Shared with the agent-loop
    /// subscription (a plain field cannot cross the 'static handler).
    pub(crate) goal_budget_crossed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The session-input probe: the goal continuation mint defers while it reports queued work.
    pub(crate) goal_input_probe: std::sync::Mutex<Option<crate::engine::SessionInputProbe>>,
    /// Minted goal follow-ups admit through the turn runner's queue lanes
    /// (steering for the budget steer, follow-up for the continuation).
    pub(crate) goal_admission_sink: std::sync::Mutex<Option<crate::engine::GoalAdmissionSink>>,
    /// The queued-goal-context purge (TS `_clearQueuedGoalContexts`):
    /// invoked by pause/clear/start and `goal.complete`.
    pub(crate) goal_queue_purge: std::sync::Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    /// The armed backoff wake's cron job id: `Some` while a one-shot
    /// `goal-backoff-wake` is pending (cancelled by a successful mint).
    pub(crate) goal_backoff_wake_job_id: std::sync::Mutex<Option<String>>,
    /// The stale-row guard's DURABLE terminal row, deferred until after the
    /// context adoption; `Some` between the seed and the flush.
    pub(crate) stale_goal_terminal_pending: std::sync::Mutex<Option<pa_core::goals::GoalState>>,
    /// The bash-completion queue seams: `bash.completed` admits through the
    /// steering lane, `bash.consumed` withdraws its row. `None` outside a
    /// daemon worker.
    pub(crate) bash_completion_sink: std::sync::Mutex<Option<crate::engine::BashCompletionSink>>,
    pub(crate) bash_consumed_sink: std::sync::Mutex<Option<crate::engine::BashConsumedSink>>,
    /// The live agent handle: the eager turn-abort funnel's target, mirrored
    /// because a running turn holds the core session's mutex.
    pub(crate) turn_agent: std::sync::Mutex<Option<std::sync::Arc<pa_agent::agent::Agent>>>,
    pub(crate) quota_park: std::sync::Arc<std::sync::Mutex<Option<QuotaParkState>>>,
    /// Whether the settled turn parked: the park's pause, not the goal's death.
    pub(crate) quota_parked_this_run: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The queue delivery modes: seeded from the start config, switched live;
    /// `None` keeps the default ("one-at-a-time").
    queue_modes: std::sync::Mutex<(Option<String>, Option<String>)>,
    /// The in-run autonomous consult's deadlock-free mirror (see
    /// [`crate::autonomous_continuation`]): read without the session mutex
    /// (a compaction run holds it).
    pub(crate) autonomous_boundary:
        std::sync::Mutex<Option<crate::autonomous_continuation::AutonomousBoundaryMirror>>,
    /// `true` while the kernel still runs background `bash()` handles, so the
    /// continuation gates hold their turns without the session mutex. `None`
    /// (unwired) answers `false`.
    pub(crate) background_bash_probe:
        std::sync::Mutex<Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>>,
    /// The current session's stop-with-snapshot handle, adopted as a weak
    /// provisioner reference (the park arm never takes the session mutex).
    /// `None` when no session is built.
    pub(crate) kernel_release_probe: std::sync::Mutex<Option<SettledKernelRelease>>,
    /// `true` while this session still owns an active or paused scheduled job
    /// (must not lose its kernel). `None` keeps the release open.
    pub(crate) registered_jobs_probe:
        std::sync::Mutex<Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>>,
    /// The worker-owned session file (conversation-log path), set at create.
    session_file: std::sync::Mutex<Option<std::path::PathBuf>>,
    /// The authoritative model selection: the process fallback, re-bound when
    /// a create carries explicit wire flags.
    selection: std::sync::RwLock<EngineModelSelection>,
    /// The restored-from-session decision, scoped to the file it was computed
    /// for: a revived session's saved model (or the fallback message); an
    /// explicit flag wins.
    restored_model: std::sync::Mutex<Option<RestoredSessionModel>>,
    /// The create-time `--models` scope (see [`config::StartupScope`]);
    /// `None` keeps the unscoped chain.
    startup_scope: std::sync::Mutex<Option<StartupScope>>,
    /// The session runtime config the reset returns to at every restore: the
    /// create's flags survive every replacement; a mid-session `/model` switch
    /// belongs to the session it switched.
    initial_selection: std::sync::RwLock<EngineModelSelection>,
    /// The resolved effective thinking level, computed once at create so
    /// summary/state polls during a live turn stay side-effect-free.
    effective_thinking: std::sync::RwLock<Option<pa_types::ai::ModelThinkingLevel>>,
    pub(crate) service_tier: std::sync::RwLock<Option<pa_types::ai::ServiceTier>>,
    /// Built once on the first prompt, reused across prompts: long-running
    /// arms clone the Arc and release this mutex before their awaits, so
    /// every read seam answers while a turn streams.
    pub(crate) session: tokio::sync::Mutex<Option<Arc<CoreSessionEngine>>>,
    /// The build gate: at most one `build_session` in flight; the eager build
    /// and the first demand seam meet at one build.
    pub(crate) session_build: tokio::sync::Mutex<()>,
    /// A branch move that landed before the first turn: consumed at build so
    /// the session starts on the moved branch.
    pending_branch: std::sync::Mutex<Option<Vec<pa_types::session::FileEntry>>>,
    /// The `goal_update` payload a branch rebuild's goal reload stashed,
    /// taken by the worker that announces it. `None` when it changed nothing.
    reloaded_goal_update: std::sync::Mutex<Option<Value>>,
    /// The provider target the stream reads per call; `set_model` swaps the
    /// slot so the live session follows without a rebuild.
    pub(crate) provider_target: std::sync::Arc<
        std::sync::RwLock<Option<pa_core::session_engine::provider_adapter::ProviderTarget>>,
    >,
    /// One shared supervisor-link client: agent messaging and RLM children
    /// multiplex the same connection.
    link: Arc<crate::supervisor_link::SupervisorLink>,
    /// Supervisor-backed RLM children; `None` for standalone workers.
    pub(crate) children: Option<Arc<SupervisorChildSessions>>,
    /// The worker-installed summary-delta sink, adopted onto every built
    /// session. `None` without a worker pump.
    compaction_summary_sink:
        std::sync::Mutex<Option<pa_core::session_engine::compaction_exec::SummaryDeltaSink>>,
    /// The attribution producer the children registry's sink last got:
    /// children outlive a rebuild, so their spawn registrations are adopted
    /// forward.
    usage_producer: std::sync::Mutex<
        Option<std::sync::Arc<pa_core::session_engine::rlm_usage::RlmChildUsageAttributions>>,
    >,
    own_summary: std::sync::Arc<std::sync::Mutex<Option<Value>>>,
    pub(crate) create_resources: std::sync::RwLock<CreateSessionResources>,
    pub(crate) autonomous:
        std::sync::Arc<tokio::sync::Mutex<pa_core::autonomous::AutonomousRuntimeState>>,
    /// The continuation policy the turn loop consults after every settled
    /// turn. Product default: the shell-gate driver in the session cwd;
    /// harnesses replace it via
    /// [`AgentSessionEngine::set_autonomous_driver`].
    pub(crate) autonomous_driver:
        std::sync::RwLock<std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>>,
    /// Whether `autonomous_driver` still holds the product default: a cwd
    /// rebind swaps the default but must keep an injected one.
    autonomous_driver_default: std::sync::atomic::AtomicBool,
    /// The continuation the threshold arm minted ahead of the boundary's
    /// compaction, held for the queued `followUp` admission.
    pub(crate) held_autonomous_continuation: std::sync::Mutex<Option<String>>,
    pub(crate) autonomous_admission: std::sync::Mutex<Option<AutonomousAdmission>>,
    /// Whether the in-run hook deferred the continuation behind unsettled
    /// RLM descendant work: the settle hook delivers it.
    pub(crate) autonomous_awaits_rlm_work: std::sync::atomic::AtomicBool,
    /// Set by the worker's kill/shutdown closes: the continuation mint sites
    /// and settle-hook retries bail — a stopped session stays stopped. The
    /// create path clears it.
    pub(crate) session_closed: std::sync::atomic::AtomicBool,
    /// The engine's own arc: the in-run continuation hook upgrades the weak so the agent's loop
    /// never pins the engine.
    pub(crate) self_weak: std::sync::Mutex<Option<std::sync::Weak<AgentSessionEngine>>>,
    pub(crate) autonomous_queue_purge:
        std::sync::Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    /// The session's live working directory, shared with the MCP user-servers
    /// closure so a [`SessionEngine::set_cwd`] rebind is visible to it.
    cwd: std::sync::Arc<std::sync::RwLock<std::path::PathBuf>>,
    /// This session's RLM recursion depth (0 for top-level): gates the kernel `refine.*` host
    /// requests.
    rlm_depth: std::sync::atomic::AtomicU32,
    /// The depth bound's source stamp (`default` | `env` | `global` |
    /// `inherited` | `chat`).
    rlm_max_depth_source: std::sync::Mutex<&'static str>,
    /// A `set_rlm_max_depth` that landed before the first turn: the durable
    /// entry parks here and flushes at build.
    pending_max_depth: std::sync::Mutex<Option<u64>>,
    /// The resolved faux model, registered once per engine so scripts span
    /// turns. Verification harness only; never set by the product.
    faux_model: std::sync::OnceLock<Model>,
    /// One compact-and-retry attempt per context overflow.
    pub(crate) overflow_recovery: std::sync::Mutex<OverflowRecovery>,
    /// The image-model route armed for the dispatched episode, re-applied at
    /// every model-turn attempt so retries keep serving it; cleared when the
    /// episode settles.
    pub(crate) image_route: std::sync::Mutex<Option<ImageRoute>>,
    /// Serializes `/reload`'s whole live-input refresh: overlapping reloads
    /// resolve the store at their own read times, so an earlier reload's
    /// already-resolved key/header pair must never land over a later
    /// reload's fresher pair (the last reload to run leaves the target
    /// serving the newest store).
    pub(crate) reload_lock: std::sync::Mutex<()>,

    /// Turn-boundary runs register their controller here;
    /// [`SessionEngine::abort_auto_compaction`] aborts whatever holds it.
    pub(crate) auto_compaction_abort: std::sync::Mutex<Option<std::sync::Arc<AbortController>>>,
    /// The model-allowlist refusal telemetry, shared with the RLM children
    /// host (one lazily-built client per worker).
    pub(crate) model_refusal_telemetry:
        std::sync::Arc<crate::model_allowlist::ModelRefusalTelemetry>,
    /// This session's semantic-edge identity (TS
    /// `semanticEdgeLedgerPath`/`semanticParentSessionId`/
    /// `semanticSpawnedByRequestId`): stamped by `configure_rlm_identity`
    /// from the create's semantic spawn origin and read once per session
    /// build, so every build's recorder reopens the same ledger and
    /// re-registration stays idempotent.
    pub(crate) semantic_identity:
        std::sync::Mutex<Option<pa_core::session_engine::semantic_edges::SemanticEdgeIdentity>>,
}
