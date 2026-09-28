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
mod lifecycle;
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

// The turn-execution inherent impl (the turn state machine: the model-turn
// runner, the turn boundary, the turn loop, the once-runner with its retry,
// failover and quota-park policy machinery, the queue-mode mapping, and the
// session-agent constructor) moved to the child module as its own inherent
// impl block; the facade queue-mode cluster, the quota-struct impl, the
// session_engine_impl trait callers and the tests keep resolving through
// the type (pub(super) bumps on the 10 shared names).
mod turn;

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

/// The settled-child kernel release handle (TS #2483's inline arm): the
/// session's snapshot-flushing kernel stop as a boxed-future factory,
/// adopted onto every built session as a weak provisioner reference.
pub(crate) type SettledKernelRelease =
    std::sync::Arc<dyn Fn() -> futures::future::BoxFuture<'static, ()> + Send + Sync>;

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
    /// The goal driver's pending-continuation guard, mirrored lock-free at
    /// build time: the admission surfaces (the worker's queue sink, the
    /// post-compaction queue path, the abort-cancel withdraw) release it
    /// from contexts that cannot take the async driver lock (a spawned
    /// settle task, a nested `block_on`), so the guard reads through this
    /// atomic handle instead.
    pub(crate) pending_goal_continuation:
        std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
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
    /// The settled-child kernel release (TS #2483's inline arm): the
    /// current session's stop-with-snapshot handle, adopted onto every
    /// built session as a weak provisioner reference (the same
    /// deadlock-free read discipline as the bash probe — the runner's
    /// park arm never takes the session mutex). `None` when no session
    /// is built or the runtime retired; the release then no-ops and the
    /// child stays resident.
    pub(crate) kernel_release_probe: std::sync::Mutex<Option<SettledKernelRelease>>,
    /// The registered scheduled-jobs gate (TS #2483's
    /// `canPassivateSettledSession` `hasRegisteredCronJob`): the worker
    /// wires it over the shared cron store — `true` while this
    /// session still owns an active or paused scheduled job (a cron or
    /// heartbeat run must not lose its kernel). `None` keeps the
    /// release open (a store-less embedding).
    pub(crate) registered_jobs_probe:
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
