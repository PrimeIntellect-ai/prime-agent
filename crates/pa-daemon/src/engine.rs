//! Session engine contract.
//!
//! The worker drives a [`SessionEngine`]: the worker owns the session store,
//! the queue, event sequencing, and wire framing; the engine owns turn
//! behavior. Today that is the scripted faux session (echo/scripted replies)
//! used by the integration harness and headless checks; the agent-loop crate
//! plugs into the same trait without touching any daemon mechanics.

use anyhow::Result;
use pa_agent::abort::AbortSignal;
use pa_core::session_engine::provider_retry::{ProviderRetryPolicy, UNBOUNDED_BACKOFF_MS};
use pa_core::session_engine::side_question::{SideQuestionSink, SideQuestionTurn};
use serde_json::{json, Value};

/// One user prompt accepted by the engine.
#[derive(Debug, Clone)]
pub struct PromptRequest {
    pub message: String,
    /// Images attached to the prompt (base64 payload plus mime type),
    /// admitted as multimodal content after the text block.
    pub images: Vec<pa_agent::types::ImageContent>,
    pub source: String,
    pub agent_message_id: Option<String>,
    /// An injected custom row (wire `role: "custom"`) that replaces the
    /// accepted user message for this turn: the turn persists and renders
    /// the custom row, then runs the model on `message` (TS injected-prompt
    /// turns: RLM child terminal notices).
    pub custom_message: Option<Value>,
    /// Co-delivered user rows of a batched turn (TS
    /// `_startPreparedTurnActions`): the queue's batched actions ride the
    /// same run as the primary message. Each row is accepted (persisted
    /// and rendered) in order ahead of the model turn, and the loop
    /// context carries every row as one `agent.prompt` message list.
    pub batch: Vec<PromptBatchRow>,
}

/// One co-delivered user row of a batched prompt request.
#[derive(Debug, Clone)]
pub struct PromptBatchRow {
    pub text: String,
    pub images: Vec<pa_agent::types::ImageContent>,
}

/// Explicit model selection from a session's create config (the wire
/// `provider`/`model`/`apiKey`/`thinking` fields). `None` fields keep the
/// engine's current selection, mirroring the TS runtime-config merge
/// semantics.
#[derive(Debug, Clone, Default)]
pub struct EngineModelSelection {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    /// The requested thinking level (`--thinking` on the wire). The engine
    /// resolves the effective level against the model's supported levels.
    pub thinking: Option<pa_types::ai::ModelThinkingLevel>,
}

/// Events an engine emits for one prompt, in order. The worker translates these
/// into protocol events and session-store writes. Returning `false` from the
/// emit callback cancels the prompt.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    /// The user message that was accepted (recorded into the session store).
    UserMessage(Value),
    /// An assistant message update (streaming); the payload is the full
    /// message, plus the provider stream event that produced it (the TS wire
    /// carries `assistantMessageEvent` so clients can track activity).
    AssistantUpdate {
        message: Value,
        stream_event: Option<Value>,
    },
    /// The final assistant message (recorded into the session store).
    AssistantMessage(Value),
    /// A tool call started executing.
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    /// A tool produced a partial result while still executing.
    ToolExecutionUpdate {
        tool_call_id: String,
        partial_result: Value,
    },
    /// A tool call finished; `is_error` mirrors the tool result.
    ToolExecutionEnd {
        tool_call_id: String,
        result: Value,
        is_error: bool,
    },
    /// A tool-result message (wire `role: "toolResult"`): recorded into the
    /// session store and framed to clients as a `message_start` +
    /// `message_end` pair, matching the TS session's loop-event forwarding.
    ToolResultMessage(Value),
    /// A turn of the model loop started (TS wire `turn_start`; the loop
    /// emits it for every turn after the first, so the worker's own
    /// run-opening `turn_start` stays the first turn's frame).
    TurnStart,
    /// A turn of the model loop ended (TS wire `turn_end`): the terminal
    /// assistant message plus the turn's tool-result messages, in the
    /// session wire shapes. Emitted for every settled turn — aborts and
    /// provider errors included (the aborted/error assistant row with
    /// empty tool results), like the TS session's loop-event forwarding.
    /// The rows themselves persist and broadcast through their own events;
    /// this frame carries only the terminal payload.
    TurnEnd {
        message: Value,
        tool_results: Vec<Value>,
    },
    /// An agent run started (TS wire `agent_start`). The loop emits one per
    /// agent run — retried and continued runs included — but the worker's
    /// own run-opening `agent_start` frame is the first run's, so the
    /// engine forwards only the later runs' frames (a boundary frame
    /// already passed in the item).
    AgentStart,
    /// An agent run ended (TS wire `agent_end`): the run's whole message
    /// set in the session wire shapes — the prompt rows (the harness digest
    /// and the user row), every assistant row, the tool results, and every
    /// steering/follow-up/continuation row drained within the run. Emitted
    /// per agent run, aborts and provider errors included (the messages
    /// carry the aborted/error row), like the TS session's loop-event
    /// forwarding. The rows themselves persist and broadcast through
    /// their own events; this frame carries only the accumulated payload.
    AgentEnd { messages: Vec<Value> },
    /// A durable custom message (wire `role: "custom"`): recorded into the
    /// session store and shown to attached clients. Emitted as a
    /// `message_start` + `message_end` pair, matching the TS session's
    /// `_emit` for custom rows.
    CustomMessage(Value),
    /// A compaction run started (TS `compaction_start` wire event); the
    /// payload is the complete event. Emitted before the summarizer runs so
    /// attached clients can swap their loader to the compaction label.
    CompactionStart { event: Value },
    /// A compaction settled (TS `compaction_end` wire event): `entry` is the
    /// `compaction` record to persist (null when the run skipped or
    /// failed), `event` the complete client-facing event (result on
    /// success, errorMessage with its severity otherwise).
    Compaction { entry: Value, event: Value },
    /// The prompt completed (successfully or not).
    Done(std::result::Result<(), String>),
    /// The prompt settled as aborted: the run was aborted before an
    /// assistant message was produced (a user abort or suspension).
    /// Every consumer treats it like `Done(Err(..))` — the wire frames
    /// carry the abort error — except the settle classification, which
    /// must not read the (spoofable) error text: an aborted run is not
    /// a provider failure (the scheduled-fire hook backs off on the
    /// one, not the other).
    DoneAborted,
    /// `goal_update`: the session goal state changed (TS wire event; the
    /// ACP adapter surfaces it as the namespaced `_meta.goal` update).
    /// The payload is the TS `GoalState` wire object.
    GoalUpdate { goal: Value },
    /// `auto_retry_start`: a provider failure is being retried (TS wire
    /// event; the interactive transcript shows the retry countdown). A
    /// `Backup` reason is a provider-failover switch: the failed turn
    /// re-routes to another configured provider serving the same model and
    /// re-issues immediately.
    AutoRetryStart {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        error_message: String,
        reason: pa_core::session_engine::auto_retry::RetryStartReason,
    },
    /// `auto_retry_end`: the retry loop settled. `restored_model` is the
    /// `"provider/model-id"` primary restored after a failover switch
    /// succeeded.
    AutoRetryEnd {
        success: bool,
        attempt: u32,
        final_error: Option<String>,
        restored_model: Option<String>,
    },
}

/// The post-compaction goal continuation (TS `compact()`'s `didCompact` +
/// active-goal branch: `resumeQueuedWork()` ->
/// `_maybeResumeGoalContinuationAfterRlmWork` mints the owed
/// continuation, and `_schedulePostCompactionContinue()` drives it): the
/// follow-up turn to admit — the continuation prompt text with the
/// durable goal-context row as the injected custom message — plus the
/// `goal_update` payload for the mint's state change when it moved the
/// engine's published baseline (TS `_setGoalState` -> `_emitGoalUpdate`).
#[derive(Debug, Clone)]
pub struct GoalContinuation {
    /// The continuation turn request (TS `_createPreparedTurnAction`
    /// "followUp": the normalized continuation text, the goal-context
    /// custom message, `resumeIfIdle: true`).
    pub request: PromptRequest,
    /// The `goal_update` event's `goal` payload, `None` when an
    /// unchanged state stays silent.
    pub goal_update: Option<Value>,
}

/// The goal-driven work a settled run boundary owes: TS
/// `_shouldStopAfterTurn`'s budget arm and `_getGoalContinuationMessages`
/// at the agent loop's natural turn end. Each variant carries the minted
/// turn as a [`GoalContinuation`] (the request plus the `goal_update`
/// payload for the mint's state change).
#[derive(Debug, Clone)]
pub enum GoalTurnEndWork {
    /// The token budget was crossed this run: the budget-limit wrap-up
    /// steer (TS queues it on the steering schedule with
    /// `resumeIfIdle: true`, so the run ends and the steer drives the
    /// wrap-up turn).
    BudgetLimitSteer(GoalContinuation),
    /// The continuation context turn for an active goal (TS's queued
    /// `followUp` admission, the follow-up lane).
    Continuation(GoalContinuation),
}

/// The worker's session-input probe (TS `queuedActionCount > 0` plus the
/// queued-input suspension): `true` while queued user work or a held
/// suspension owns the next turn boundary, so the goal mint defers.
pub type SessionInputProbe = std::sync::Arc<dyn Fn() -> bool + Send + Sync>;

/// One detached kernel bash completion (the `bash.completed` host
/// request): the finished command's identity and exit code. The worker
/// queue admission turns it into the woken turn (TS
/// `createAsyncBashCompletionHostHandler` ->
/// `_promptInjectedMessage(..., { resumeIfIdle: true })`).
#[derive(Debug, Clone)]
pub struct BashCompletionNotice {
    pub pid: u32,
    pub command: String,
    pub exit_code: i64,
}

/// The queue-admission seam for one completion notice (the worker's
/// steering lane + runner wake + recovery busy-evidence).
pub type BashCompletionSink = std::sync::Arc<dyn Fn(BashCompletionNotice) + Send + Sync>;

/// The kernel read a finished command's result before its notice
/// delivered (the `bash.consumed` host request): the queued notice is
/// stale and must withdraw (TS
/// `_withdrawAsyncBashCompletionNotice`).
#[derive(Debug, Clone)]
pub struct BashConsumedNotice {
    pub pid: u32,
    pub command: String,
}

/// The queue-withdrawal seam for a consumed notice.
pub type BashConsumedSink = std::sync::Arc<dyn Fn(BashConsumedNotice) + Send + Sync>;

/// The worker's goal admission sink: the turn runner's queue lanes admit
/// a minted goal follow-up (the steering lane for the budget steer, the
/// follow-up lane for the continuation), the `goal_update` surfaces at
/// the moment the state changed, and the runner wakes.
pub type GoalAdmissionSink = std::sync::Arc<dyn Fn(GoalTurnEndWork) + Send + Sync>;

/// RLM recursion identity carried by a session's create command: the
/// session's depth in the recursion tree, its bound, its working directory
/// and persistence ids, and the default thinking level children inherit.
/// Engines hosting RLM children seed their child registry from it; engines
/// without children (the scripted harness) accept and ignore it.
#[derive(Debug, Clone, Default)]
pub struct RlmSessionIdentity {
    pub rlm_depth: u32,
    pub rlm_max_depth: Option<u32>,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub thinking: Option<String>,
    /// Verification seam: children of this session spawn with a scripted
    /// engine file (the TS child runtime inherits the parent's
    /// `sessionConfig`; the harness analog carries the create's
    /// `childScript` down the recursion). Product sessions carry `None`.
    pub child_script: Option<String>,
}

/// The turn behavior a worker session runs.
pub trait SessionEngine: Send + Sync {
    /// The session's shared MCP manager, when the engine owns one (the
    /// real agent engine does; scripted harness engines do not). The
    /// `replace_acp_mcp_servers` command writes through it so
    /// ACP-admitted servers reach the prompt's MCP gating — the same
    /// store the core engine gates with.
    fn acp_mcp_manager(
        &self,
    ) -> Option<std::sync::Arc<std::sync::Mutex<pa_core::mcp::McpManager>>> {
        None
    }

    /// The session's current goal state as the wire `GoalState` value (the
    /// attach snapshot's `state.goal`, TS `snapshot.ts: session.goalState`).
    /// Engines without thread goals report the empty state.
    fn goal_state_value(&self) -> Value {
        serde_json::to_value(pa_core::goals::empty_goal_state()).unwrap_or(Value::Null)
    }

    /// Purge the queued goal-context turns (TS `_clearQueuedGoalContexts`
    /// at the `_pauseGoal`/`_clearGoal`/`_startGoal` command sites): the
    /// embedding that owns the queue lanes withdraws minted continuations
    /// waiting to run; engines without a queue do nothing.
    fn purge_queued_goal_contexts(&self) {}

    /// Mint the owed post-compaction goal continuation (TS `compact()`'s
    /// `didCompact` + active-goal branch: `resumeQueuedWork()`'s
    /// `_maybeResumeGoalContinuationAfterRlmWork` — `continuationsUsed`
    /// increments, the state change persists, and the continuation
    /// context message becomes a queued follow-up the scheduled continue
    /// drives). `None` when the engine mints nothing: no session, no
    /// active goal, or an engine without goal continuations. The worker
    /// owns the queue and the #234 suspension gate, so this only produces
    /// the turn; the resume site admits it.
    fn mint_post_compaction_goal_continuation(&self) -> Option<GoalContinuation> {
        None
    }

    /// Run one prompt. `prompt_index` counts accepted prompts for this
    /// session. `aborted` is the worker's cancel probe (checked between
    /// retry waits, where no events flow to observe the flag through
    /// `emit`); `emit` returning `false` cancels the prompt.
    fn run_prompt(
        &self,
        prompt_index: usize,
        request: PromptRequest,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    );

    /// Abort the in-flight turn eagerly (TS `requestAbort`'s closing
    /// `this.agent.abort()`): the live run's provider fetch cancels
    /// immediately, not at the next streamed event, and the aborted turn
    /// settles on its aborted message (empty usage mid-wait). The worker's
    /// abort surfaces call this after parking their cancel flag, so the
    /// aborted turn's events stay gated. Engines without a real agent
    /// loop have nothing in flight and keep the default no-op.
    fn abort_in_flight_turn(&self) {}

    /// Switch the queue delivery modes live (TS `setSteeringMode` /
    /// `setFollowUpMode` write the session's agent): the worker's
    /// `set_steering_mode`/`set_follow_up_mode` commands apply the
    /// persisted mode to the engine's agent-level queues too, so the
    /// in-process steer/follow-up admissions drain per the new mode at
    /// the loop boundary. Engines without agent-level queues keep the
    /// default no-op.
    fn set_queue_modes(&self, steering: Option<&str>, follow_up: Option<&str>) {
        let _ = (steering, follow_up);
    }

    /// Run one side question: a second LLM turn over a clone of the
    /// conversation with the serialized previous turns replayed, excluded
    /// from the session history. `signal` aborts the run; `sink` receives
    /// partial answers while the run streams (the worker translates them
    /// into `side_question_event` outbounds).
    fn run_side_question(
        &self,
        request: SideQuestionRequest,
        signal: &AbortSignal,
        sink: &SideQuestionSink,
    ) -> SideQuestionOutcome;

    /// Run one compaction (`compact` command): summarize the pre-cut history.
    /// The engine owns the model call; the worker owns persistence, events,
    /// and the response. `signal` aborts the run.
    fn run_compaction(&self, request: CompactionRequest, signal: &AbortSignal)
        -> CompactionOutcome;

    /// Abort the in-flight automatic compaction (threshold or requested
    /// turn-boundary run), if one is running — TS `abortCompaction` also
    /// aborts the `_autoCompactionAbortController`, not just the manual
    /// run. Engines without automatic compaction runs (the scripted
    /// harness engines) do nothing; aborting with no run in flight is a
    /// silent no-op like the TS controller being `undefined`.
    fn abort_auto_compaction(&self) {}

    /// Consume a pending compact-trigger auto-refine review (TS
    /// `_maybeAutoRefine("compact")` after a successful compaction): the
    /// engine resolves the model and runs the gated round (busy gates
    /// keep the trigger armed); the caller owns the outcome surface.
    /// `Ok(None)` is every silent outcome — no trigger armed, a gate
    /// dropping it, the cooldown holding it, or a declined review.
    /// Engines without the compact-trigger machine never arm one.
    fn consume_compact_auto_refine(
        &self,
    ) -> anyhow::Result<Option<pa_core::refinement::RefinementResult>> {
        Ok(None)
    }

    /// Run one branch summary (`navigate_tree` with `summarize`): summarize
    /// the abandoned branch's entries. The engine owns the model call; the
    /// worker owns the leaf move, the `branch_summary` entry, and the
    /// response. `signal` aborts the run.
    fn run_branch_summary(
        &self,
        request: BranchSummaryRequest,
        signal: &AbortSignal,
    ) -> BranchSummaryOutcome;

    /// Rebuild the engine's live context from a durable branch (the
    /// post-navigation/fork state): the worker moves its store first, then
    /// hands the new branch's entries over so the next turn runs against
    /// the moved branch — and the goal state reloads from the moved
    /// branch under `goal_reload` (TS `_reloadGoalStateFromBranch` at the
    /// `_navigateTree` tail: a summary context rebuild continues the same
    /// timeline, a plain branch move keeps faithful branch semantics).
    /// Engines without a persistent model context accept and ignore the
    /// branch.
    fn rebuild_session_context(
        &self,
        branch_entries: Vec<pa_types::session::FileEntry>,
        goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> Result<()>;

    /// The `goal_update` payload for a goal state change the engine
    /// published outside a turn (TS `_emitGoalUpdate` at
    /// `_reloadGoalStateFromBranch`): `Some(goal)` when the state changed
    /// since the last announcement, `None` when it did not (the
    /// on-change dedupe the turn-boundary emissions share). Engines
    /// without thread goals never publish.
    fn goal_update_after_rebuild(&self) -> Option<Value> {
        None
    }

    /// The TS replacement flows' teardown pass
    /// (`AgentSessionRuntime.teardownForReplacement` ->
    /// `teardownCurrent` -> `session.disposeAsync()`): retire the live
    /// session runtime before the replacement rebuilds onto the new file.
    /// The session's kernel disposes first - one final namespace snapshot
    /// flush, drained host requests, then the `python -m rlm.repl`
    /// process exits - and the built session drops, so the next engine use
    /// rebuilds a fresh session against the replacement file. A
    /// replacement flow must never keep the old kernel: TS treats the
    /// moved-to session as a new runtime, so the old kernel's namespace
    /// and process would leak across what TS starts cold.
    ///
    /// Only the whole-runtime replacements run this (`new_session`,
    /// `switch_session`, `import_jsonl`, `fork`); the tree moves
    /// (`navigate_tree`) never do - TS rebuilds the branch context in
    /// place on the same session and the kernel stays warm. Engines
    /// without a live session (the scripted harness) have nothing to
    /// retire and keep the no-op default.
    fn teardown_for_replacement(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }

    /// Context window (tokens) of the engine's resolved model, when known.
    /// Drives the `contextUsage` estimate in `get_session_stats`; engines
    /// without model metadata report `None` and the field is omitted.
    fn model_context_window(&self) -> Option<u64> {
        None
    }
    /// The worker's turn loop completed (its `EngineEvent::Done` was seen):
    /// engines hosting RLM children use the boundary to release prompt tasks
    /// spawned mid-turn, so the parent's own continuation request always
    /// reaches the provider before a child's first turn (TS event-loop
    /// ordering: the continuation fetch is already in flight when the
    /// detached child task runs). Engines without children ignore it.
    fn on_turn_done(&self) {}

    /// Finalize session telemetry at session close: emit
    /// `agent session ended` and flush once (TS dispose callback).
    /// Best-effort: implementations bound the wait (sink timeouts) and never
    /// fail or block shutdown. Engines without telemetry do nothing.
    fn end_telemetry(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(std::future::ready(()))
    }

    /// The daemon `kill` path: emit `session archived` then finalize
    /// (`agent session ended` + flush), after the turn settles (TS runs the
    /// dispose-callback telemetry after the awaited `session.abort()`).
    /// Best-effort like `end_telemetry`: never blocks a close on a live
    /// turn — the kill handler aborts the in-flight run first.
    fn archive_session_telemetry(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(std::future::ready(()))
    }

    /// The `(provider, model id)` pair the session will run on, when the
    /// engine can resolve one; fresh daemon sessions record it in their
    /// creation prefix (`model_change`). Engines without a model return
    /// `None` and the prefix entry is skipped, like the TS
    /// `if (model) appendModelChange(...)`.
    fn creation_model(&self) -> Option<(String, String)> {
        None
    }

    /// Tell the engine which session file the worker owns (the conversation-log
    /// path for the system prompt and the session-local harness dir). The
    /// worker owns persistence; scripted engines ignore it.
    fn set_session_file(&self, path: std::path::PathBuf) {
        let _ = path;
    }

    /// TS `createAgentSession`'s restored-from-session step: a session
    /// being revived (scheduled wake, update restore, worker relaunch)
    /// restores the model its file pins before the startup chain, giving
    /// the daemon boot's in-flight catalog fetch a bounded readiness
    /// window — without it a revived session silently lands on the
    /// startup-chain default instead of the model it was running on. The
    /// worker calls this at create, before the create-config selection;
    /// explicit flags win, a miss records the fallback (never silent).
    /// Engines without a persisted model context do nothing.
    fn restore_session_model(
        &self,
        _session_path: &std::path::Path,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(std::future::ready(()))
    }

    /// TS `modelFallbackMessage`: the on-the-record reason a revived
    /// session's model fell back (the summary publishes it — a model
    /// fallback must never be silent). `None` while no restore missed.
    fn model_fallback_message(&self) -> Option<String> {
        None
    }

    /// Merge an explicit selection over the engine's live selection (the
    /// TS runtime-config merge semantics): explicit wire flags replace,
    /// absent fields keep. The worker's create-time restored-settings
    /// adoption (the session file's saved thinking level) runs through
    /// this seam — a live merge that must NOT fold into the reset target
    /// (the create-config seam is [`Self::configure_create_model`]).
    /// Engines without a model (the scripted harness) ignore it.
    fn configure_model(&self, _selection: EngineModelSelection) {}

    /// Adopt the explicit model selection carried by the session's create
    /// command (TS `mergeAgentSessionRuntimeConfig(defaultSessionConfig,
    /// command.config)`): the flags are authoritative end-to-end AND
    /// survive every session replacement (TS hands the merged
    /// `sessionConfig` down through `switchSession`/`fork`/`import`), so
    /// they must outlive the live selection a `/model` switch mutates.
    /// Engines without a model (the scripted harness) ignore it.
    fn configure_create_model(&self, _selection: EngineModelSelection) {}

    /// Set the session's resolved service-tier preference before the next request.
    fn configure_service_tier(&self, _tier: Option<pa_types::ai::ServiceTier>) {}

    /// The effective thinking level for the session, as a wire name
    /// (`"off"`, `"minimal"`, ...): the create-config flag (else the
    /// settings default, else `"medium"`), clamped to the model's
    /// supported levels. Fresh daemon sessions record it in the creation
    /// prefix (`thinking_level_change`) and the session engine runs every
    /// provider request with it. Engines without model resolution return
    /// `None` and the prefix records `"off"` instead.
    fn effective_thinking_level(&self) -> Option<String> {
        None
    }

    /// The session's assembled system prompt, when the engine can produce
    /// it synchronously (the HTML export embeds it like the TS
    /// `state.systemPrompt`). Engines whose session is busy or not yet
    /// built report `None` and the export omits the section.
    fn export_system_prompt(&self) -> Option<String> {
        None
    }

    /// The session's registered tools for the export's tools section (TS
    /// `state.tools` mapped to name/description/parameters). An engine
    /// whose session is not yet built builds it now — the TS state
    /// exists from create, so an export before the first turn still
    /// carries the section; a mid-turn engine reports `None` and the
    /// export omits it (async like `tool_definition`: the build and the
    /// registry read await).
    fn export_tools(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + '_>> {
        Box::pin(async { None })
    }

    /// Pre-rendered HTML for custom-tool calls/results, keyed by
    /// tool-call id (TS `preRenderCustomTools`): the engine builds its
    /// registry-backed renderer over the session's tools and the
    /// exporter walks the entries. `None` when nothing rendered or the
    /// engine is busy; the export omits the section.
    fn export_rendered_tools(
        &self,
        _entries: &[Value],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + '_>> {
        Box::pin(async { None })
    }

    /// The engine's resolved model as connection-state wire data
    /// (`{ id, provider, reasoning }`), when known. Drives the interactive
    /// splash and tray labels.
    fn model_metadata(&self) -> Option<Value> {
        None
    }

    /// Apply a live model switch (the daemon `set_model` command, TS
    /// `session.setModel`): the selection merges over the current one and
    /// a built session's agent and provider stream follow the new model on
    /// the next turn. Returns `false` when the engine cannot switch (the
    /// scripted harness), so the caller refuses instead of half-applying.
    fn switch_model(&self, _selection: EngineModelSelection) -> bool {
        false
    }

    /// Apply a live thinking-level switch (the daemon `set_thinking_level`
    /// command, TS `session.setThinkingLevel`): the requested level merges
    /// over the selection, clamped to the resolved model's supported
    /// levels, and a built session's agent follows it on the next turn.
    /// Returns `false` when the engine cannot switch.
    fn switch_thinking_level(&self, _level: pa_types::ai::ModelThinkingLevel) -> bool {
        false
    }

    /// The resolved model's supported thinking levels as wire names (TS
    /// `getSupportedThinkingLevels` on the connection state). Engines
    /// without model resolution report `None` (the caller records
    /// `["off"]`, like the TS non-reasoning shape).
    fn supported_thinking_levels(&self) -> Option<Vec<String>> {
        None
    }

    /// The session's autonomous-run status snapshot (`wait_for_headless_completion`;
    /// TS `DaemonAutonomousStatus`), when the engine tracks one. The
    /// accounting lock is async-held (the turn loop's gate evaluation spans
    /// awaits), so the engine answers through a boxed future the worker
    /// awaits from its async command handler — a blocking lock would park
    /// the runtime thread the handler runs on. The scripted harness reports
    /// `None` and the worker answers the wire shape's disabled default.
    fn autonomous_status(
        &self,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Option<pa_core::autonomous::AgentAutonomousStatus>>
                + Send
                + '_,
        >,
    > {
        Box::pin(async { None })
    }

    /// The worker's live session summary (the `create` response data). The
    /// agent engine renders it into the sender identity block of
    /// worker-to-worker agent messages; scripted engines ignore it.
    fn set_session_summary(&self, _summary: Value) {}

    /// Adopt the RLM identity from the session's create command. Fails when a
    /// carried value is invalid (an unknown thinking level), so the create
    /// fails instead of a later turn.
    fn configure_rlm_identity(&self, _identity: RlmSessionIdentity) -> Result<()> {
        Ok(())
    }

    /// Rebind the engine's session cwd (TS rebuilds the replacement runtime
    /// with `createRuntime({ cwd: sessionManager.getCwd() })`): a
    /// `switch_session` / `import_jsonl` onto a session file with another
    /// recorded cwd moves the rebuilt session's cwd — its kernel-resident
    /// tools, settings reads, and MCP settings discovery follow. Engines
    /// without a session cwd (the scripted harness) keep the no-op default.
    fn set_cwd(&self, _cwd: std::path::PathBuf) {}

    /// An agent message from `child_active_session_id` (one of this
    /// session's RLM children) reached this session. The engine's child
    /// registry records it so a child's terminal notice can be withheld:
    /// a child that replied needs no no-reply notice (TS
    /// `_parentReplyCount`). Engines without children ignore it.
    fn mark_child_reply(&self, _child_active_session_id: &str) {}

    /// The session's RLM children as wire snapshots (TS
    /// `RlmChildAgentSnapshot`), the `get_rlm_children` response and the
    /// context-tree children. The child registry lock is async (the spawn
    /// path holds it across awaits), so the engine answers through a
    /// boxed future, like `autonomous_status`. Engines without a child
    /// registry report none.
    fn rlm_child_snapshots(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Value>> + Send + '_>> {
        Box::pin(async { Vec::new() })
    }

    /// The connection-surface command catalog (TS
    /// `createAgentConnectionCommands`): extension commands, prompt
    /// templates, then skills. The core session and the extension
    /// registry lock are async, so the engine answers through a boxed
    /// future. Engines without a resource surface report none.
    fn connection_commands(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Value>> + Send + '_>> {
        Box::pin(async { Vec::new() })
    }

    /// The connection resource snapshot (TS
    /// `createAgentConnectionResourceSnapshot`): context files, skills,
    /// prompts, extensions, and their diagnostics. The core session and
    /// the extension registry lock are async, so the engine answers
    /// through a boxed future. Engines without a resource surface report
    /// the empty snapshot.
    fn resource_snapshot(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        Box::pin(async { empty_resource_snapshot() })
    }

    /// The session's system prompt (TS `session.systemPrompt`). The core
    /// session lock is async, so the engine answers through a boxed
    /// future. Engines without a prompt report the empty string.
    fn system_prompt(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + '_>> {
        Box::pin(async { Ok(String::new()) })
    }

    /// One tool definition by name (TS `session.getToolDefinition`), when
    /// the engine exposes one. The core session lock is async, so the
    /// engine answers through a boxed future.
    fn tool_definition(
        &self,
        _name: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + '_>> {
        Box::pin(async { None })
    }

    /// Run one refinement (TS `session.refine`, the daemon `refine`
    /// command): plan, apply, and persist the harness state. The returned
    /// value is the TS `RefinementResult` wire object; engines without
    /// refinement support answer an error and the caller surfaces it as
    /// the command failure.
    fn run_refinement(
        &self,
        options: pa_core::session_engine::refine::RefineOptions,
    ) -> Result<Value> {
        let _ = options;
        anyhow::bail!("This session does not support refinement")
    }

    /// The session's RLM max-depth status (TS `getRlmMaxDepthStatus`):
    /// `{ maxDepth, source }` with the TS source vocabulary
    /// (`default` | `env` | `global` | `inherited` | `chat`). Engines
    /// without a depth-bound surface report the shared default.
    fn rlm_max_depth_status(&self) -> Value {
        json!({
            "maxDepth": crate::rlm_children::DEFAULT_RLM_MAX_DEPTH,
            "source": "default",
        })
    }

    /// Cancel one live RLM child run by id (TS `cancelRlmChildRun`, the
    /// daemon `cancel_rlm_child` command): `true` when a live run was
    /// cancelled. The children registry lock is async, so the engine
    /// answers through a boxed future; engines without children never
    /// cancel anything.
    fn cancel_rlm_child<'a>(
        &'a self,
        child_id: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
        let _ = child_id;
        Box::pin(async { false })
    }

    /// Delete one inactive RLM child by id (TS `deleteInactiveRlmSubagent`,
    /// the daemon `delete_rlm_subagent` command). The outcome vocabulary is
    /// TS-verbatim (`"deleted"` | `"not_found"` | `"running"`); a teardown
    /// failure surfaces as the command failure.
    fn delete_rlm_subagent<'a>(
        &'a self,
        child_id: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<&'static str>> + Send + 'a>,
    > {
        let _ = child_id;
        Box::pin(async { Ok("not_found") })
    }

    /// Set the session's RLM depth bound (TS `setRlmMaxDepth`, the daemon
    /// `set_rlm_max_depth` command). Returns the TS `SetRlmMaxDepthResult`
    /// wire object: `{ maxDepth, source, globalSaved }` plus `globalError`
    /// when the requested global settings write failed.
    fn set_rlm_max_depth(&self, max_depth: u64, global: bool) -> Result<Value> {
        let _ = global;
        Ok(json!({ "maxDepth": max_depth, "source": "chat", "globalSaved": false }))
    }
}

/// The resource snapshot for a session without a resource surface (the TS
/// loader shape over empty lists): every category present, every list
/// empty.
pub fn empty_resource_snapshot() -> Value {
    json!({
        "contextFiles": [],
        "skills": [],
        "prompts": [],
        "extensions": [],
        "themes": [],
        "diagnostics": {
            "skills": [],
            "prompts": [],
            "extensions": [],
            "themes": [],
        },
    })
}

/// One compaction request (the `compact` command fields).
#[derive(Debug, Clone)]
pub struct CompactionRequest {
    /// `/compact <instructions>` guidance for the summary.
    pub custom_instructions: Option<String>,
}

/// The completed compaction: the wire `CompactionResult` plus the
/// summarizer usage (persisted on the compaction entry, never on the wire
/// response, mirroring the TS `CompactionResult`/entry split).
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionRun {
    /// TS `CompactionResult`: summary, firstKeptEntryId, tokensBefore,
    /// details.
    pub result: Value,
    /// Usage billed by the summarizer call(s), for the persisted entry.
    pub usage: Option<Value>,
    /// The full durable `compaction` record (TS `CompactionEntry`:
    /// details, fromHook, customInstructions, usage, and the harness
    /// digest snapshot), serialized from the engine's compaction entry.
    /// Null for scripted engines (a test seam with no real entry).
    pub entry: Value,
    /// The post-compaction `ipython_state` notice in its wire message form
    /// (`role: "custom"`) when the engine's kernel was running (TS
    /// `_syncKernelStateAfterCompaction`): already durable in the engine
    /// session and the live context; the worker persists it to the session
    /// store and broadcasts its `message_start`/`message_end` pair.
    pub ipython_state: Option<Value>,
}

/// How one compaction run ended (TS `compact` outcomes: result, skip,
/// "Compaction cancelled", or failure).
#[derive(Debug, Clone, PartialEq)]
pub enum CompactionOutcome {
    /// Compacted; the run carries the result and entry usage. Boxed: the
    /// run's insertion-ordered JSON maps (preserve_order, wire parity)
    /// would make this variant dwarf the skip/abort/fail variants
    /// (`large_enum_variant`).
    Compacted { run: Box<CompactionRun> },
    /// Nothing to compact (TS `CompactionSkippedError`); the string is the
    /// user-facing skip message.
    Skipped { message: String },
    /// Aborted mid-run (`abort_compaction`).
    Aborted,
    /// Failed; the string is the engine error message.
    Failed { error: String },
}

/// One branch-summary request (`navigate_tree` with `summarize`): the
/// abandoned branch's durable entries (wire `FileEntry` form) and the
/// summarizer guidance from the client.
#[derive(Debug, Clone)]
pub struct BranchSummaryRequest {
    pub entries: Vec<pa_types::session::FileEntry>,
    pub custom_instructions: Option<String>,
    /// Replace the default prompt instead of appending the custom focus.
    pub replace_instructions: bool,
}

/// One completed branch summary: the final summary text, the summarizer
/// usage, and the file-operation details block persisted on the entry.
#[derive(Debug, Clone, PartialEq)]
pub struct BranchSummaryRun {
    pub summary: String,
    pub usage: Option<Value>,
    pub details: Option<Value>,
}

/// How one branch-summary run ended (TS `BranchSummaryResult` outcomes).
#[derive(Debug, Clone, PartialEq)]
pub enum BranchSummaryOutcome {
    /// Summary generated; the run carries text, usage, and details.
    Complete { run: BranchSummaryRun },
    /// Aborted mid-run (`abort_branch_summary`).
    Aborted,
    /// Failed; the string is the user-facing error.
    Failed { error: String },
}

/// One side-question request (the `start_side_question` command fields).
#[derive(Debug, Clone)]
pub struct SideQuestionRequest {
    /// Caller-generated id; echoed on every event of the run.
    pub side_question_id: String,
    pub question: String,
    /// Earlier `{question, answer}` exchanges replayed before the question.
    pub previous_turns: Vec<SideQuestionTurn>,
}

/// How one side-question run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SideQuestionOutcome {
    /// Answered; the string is the final answer text.
    Complete { answer: String },
    /// Aborted mid-run; the string is the partial answer streamed so far.
    Aborted { answer: String },
    /// Failed; the string is the provider/engine error message.
    Failed { answer: String, error: String },
}

/// Wire form of one side-question status (TS `SideQuestionStatus`).
pub const SIDE_QUESTION_STATUS_RUNNING: &str = "running";
pub const SIDE_QUESTION_STATUS_COMPLETE: &str = "complete";
pub const SIDE_QUESTION_STATUS_CANCELLED: &str = "cancelled";
pub const SIDE_QUESTION_STATUS_ERROR: &str = "error";

/// Wire form of one side-question event (TS `SideQuestionEvent`).
pub fn side_question_event_value(
    request: &SideQuestionRequest,
    answer: &str,
    status: &str,
    error_message: Option<&str>,
) -> Value {
    let mut event = json!({
        "id": request.side_question_id,
        "question": request.question,
        "answer": answer,
        "status": status,
    });
    if let Some(error_message) = error_message {
        event["errorMessage"] = json!(error_message);
    }
    event
}

impl SideQuestionOutcome {
    /// The TS wire status of this outcome.
    pub fn status_str(&self) -> &'static str {
        match self {
            SideQuestionOutcome::Complete { .. } => SIDE_QUESTION_STATUS_COMPLETE,
            SideQuestionOutcome::Aborted { .. } => SIDE_QUESTION_STATUS_CANCELLED,
            SideQuestionOutcome::Failed { .. } => SIDE_QUESTION_STATUS_ERROR,
        }
    }

    /// The answer text carried by the final event (partial on abort/failure).
    pub fn answer(&self) -> &str {
        match self {
            SideQuestionOutcome::Complete { answer }
            | SideQuestionOutcome::Aborted { answer }
            | SideQuestionOutcome::Failed { answer, .. } => answer,
        }
    }

    /// The error message carried by the final event, when the run failed.
    pub fn error_message(&self) -> Option<&str> {
        match self {
            SideQuestionOutcome::Failed { error, .. } => Some(error.as_str()),
            _ => None,
        }
    }
}

/// A scripted faux session: replays a deterministic sequence of assistant
/// messages for the first N prompts, then echoes. Script format (JSON):
/// `{"responses": ["text one", {"text": "two", "delayMs": 250}],
/// "sideQuestion": {"responses": [...], "retry": {...}}}`.
///
/// A scripted tool call (the roster-activity fixture):
/// `{"toolCallId": "call-1", "toolName": "bash", "args": {...},
/// "result": "listing", "isError": false, "delayMs": 250}` emits the real
/// loop's tool-call lifecycle around the response's final assistant
/// message — `tool_execution_start`, the scripted hold,
/// `tool_execution_end`, the `toolResult` message — so worker tests drive
/// the in-flight tool-call tracking (the hold lets the roster feed
/// publish the mid-tool state before the tool settles).
///
/// The `compaction` seam scripts compaction results, one scripted result
/// per run (replayed from the top each run):
/// `{"summary": "...", "firstKeptEntryId": "...", "tokensBefore": 123,
/// "details": {"readFiles": [], "modifiedFiles": []}, "usage": {...},
/// "delayMs": 250}` compacts; `{"error": "...", "skipped": true}` reports
/// nothing-to-compact; `{"error": "..."}` fails the run; `delayMs` holds the
/// run in flight so aborts and mid-run state reads are observable.
///
/// The `sideQuestion` seam scripts the side-question provider calls, one
/// scripted result per attempt: `{"text": "...", "delayMs": 250}` answers,
/// `{"error": "...", "kind": "server_error", "status": 500,
/// "retryAfterMs": 100}` fails that attempt (retried per `retry`, which is
/// the shared provider policy with test-friendly delays). Verification
/// harness only; never set by the product.
#[derive(Debug, Default)]
pub struct ScriptedEngine {
    responses: Vec<Value>,
    side_question: SideQuestionScript,
    compaction: CompactionScript,
    branch_summary: CompactionScript,
    goal: Option<ScriptedGoal>,
}

/// A scripted thread goal (the post-compaction goal-continue fixture):
/// `{"goal": {"status": "active", "objective": "...", "message": "..."}}`.
/// The scripted state answers `goal_state_value`; the mint returns the
/// follow-up turn (`message` is the continuation prompt text, defaulting
/// to the objective) with the goal-context custom row as the injected
/// message.
#[derive(Debug)]
struct ScriptedGoal {
    state: Value,
    message: String,
    /// Verification fixture only: emit the scripted state as a
    /// `goal_update` engine event during a turn (the real engine's
    /// announcement path), so worker tests drive the durable
    /// `thread_goal_state` mirror.
    emit_update_on_prompt: bool,
}

/// Scripted compaction results, consumed one per run in order; when the
/// script runs out, runs replay from the top (like side questions).
#[derive(Debug, Default)]
struct CompactionScript {
    responses: Vec<Value>,
    next: std::sync::atomic::AtomicUsize,
}

/// Scripted side-question provider results, consumed one per attempt.
#[derive(Debug, Clone, Default)]
struct SideQuestionScript {
    responses: Vec<Value>,
    /// Retry policy for scripted provider failures; `None` uses the shared
    /// default policy.
    retry: Option<ProviderRetryPolicy>,
}

impl ScriptedEngine {
    pub fn from_value(script: Value) -> Result<Self> {
        let responses = script
            .get("responses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let side_question = script
            .get("sideQuestion")
            .map(|side_question| SideQuestionScript {
                responses: side_question
                    .get("responses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                retry: side_question.get("retry").map(|retry| ProviderRetryPolicy {
                    enabled: retry
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    max_retries: retry.get("maxRetries").and_then(Value::as_u64).unwrap_or(0)
                        as u32,
                    base_delay_ms: retry
                        .get("baseDelayMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    max_retry_delay_ms: retry
                        .get("maxRetryDelayMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    max_delay_ms: UNBOUNDED_BACKOFF_MS,
                }),
            })
            .unwrap_or_default();
        let compaction = script
            .get("compaction")
            .map(|compaction| CompactionScript {
                responses: compaction
                    .get("responses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                next: std::sync::atomic::AtomicUsize::new(0),
            })
            .unwrap_or_default();
        let branch_summary = script
            .get("branchSummary")
            .map(|branch_summary| CompactionScript {
                responses: branch_summary
                    .get("responses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                next: std::sync::atomic::AtomicUsize::new(0),
            })
            .unwrap_or_default();
        let goal = script
            .get("goal")
            .filter(|goal| !goal.is_null())
            .map(|goal| ScriptedGoal {
                state: goal.get("state").cloned().unwrap_or_else(|| {
                    json!({
                        "active": goal.get("status").and_then(Value::as_str) == Some("active"),
                        "status": goal.get("status").cloned().unwrap_or(json!("idle")),
                        "objective": goal.get("objective").cloned().unwrap_or(Value::Null),
                        "continuationsUsed": 0,
                    })
                }),
                message: goal
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        format!(
                            "[goal: continuation]\n\n{}",
                            goal.get("objective").and_then(Value::as_str).unwrap_or("")
                        )
                    }),
                emit_update_on_prompt: goal
                    .get("emitUpdateOnPrompt")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        Ok(ScriptedEngine {
            responses,
            side_question,
            compaction,
            branch_summary,
            goal,
        })
    }

    pub fn from_file(path: &std::path::Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        Self::from_value(serde_json::from_str(&content)?)
    }

    fn response_text(response: &Value) -> String {
        match response {
            Value::String(text) => text.clone(),
            Value::Object(_) => response
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            _ => String::new(),
        }
    }

    fn response_delay_ms(response: &Value) -> u64 {
        response
            .get("delayMs")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(60_000)
    }
}

/// Plausible usage block so scripted messages match the real engine's wire
/// shape (and exercise summary aggregation).
fn scripted_usage() -> Value {
    json!({
        "input": 120, "output": 8, "cacheRead": 0, "cacheWrite": 0,
        "totalTokens": 128,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
    })
}

impl SessionEngine for ScriptedEngine {
    /// No model metadata: the TS scripted harness reports no resolved
    /// model on the session summary (`summaryForActiveSession` reads the
    /// agent's model, unset in the harness), so the roster summary and the
    /// CLI `list` table stay empty for scripted sessions — the `faux-1`
    /// id rides on the message rows only.
    fn model_metadata(&self) -> Option<Value> {
        None
    }

    /// The scripted thread goal's state, or the empty state (no goal
    /// section scripted).
    fn goal_state_value(&self) -> Value {
        self.goal
            .as_ref()
            .map(|goal| goal.state.clone())
            .unwrap_or_else(|| {
                serde_json::to_value(pa_core::goals::empty_goal_state()).unwrap_or(Value::Null)
            })
    }

    /// The scripted post-compaction mint: one continuation turn built from
    /// the goal section (the goal-context row as the injected message).
    fn mint_post_compaction_goal_continuation(&self) -> Option<crate::engine::GoalContinuation> {
        let goal = self.goal.as_ref()?;
        Some(crate::engine::GoalContinuation {
            request: crate::engine::PromptRequest {
                batch: Vec::new(),
                message: goal.message.clone(),
                images: Vec::new(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: Some(json!({
                    "role": "custom",
                    "customType": "goal_context",
                    "content": goal.message,
                    "display": true,
                    "details": {
                        "kind": "continuation",
                        "objective": goal.state.get("objective").cloned().unwrap_or(Value::Null),
                    },
                    "timestamp": crate::util::now_ms(),
                })),
            },
            goal_update: Some(goal.state.clone()),
        })
    }

    fn run_prompt(
        &self,
        prompt_index: usize,
        request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        let cancelled = || EngineEvent::Done(Err("prompt cancelled".to_string()));
        let scripted = self.responses.get(prompt_index).cloned();
        let text = match &scripted {
            Some(response) => {
                let delay = Self::response_delay_ms(response);
                if delay > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                }
                Self::response_text(response)
            }
            None => format!("echo: {}", request.message),
        };
        // An injected custom row replaces the accepted user message: the
        // turn persists and renders the row, then runs on `message` (the
        // real engine's injected-prompt contract, mirrored here so the
        // scripted harness exercises the same worker path).
        let accepted_row = match &request.custom_message {
            Some(custom) => custom.clone(),
            None => json!({
                "role": "user",
                "content": request.message.clone(),
                "timestamp": crate::util::now_ms(),
            }),
        };
        let accepted = match &request.custom_message {
            Some(_) => EngineEvent::CustomMessage(accepted_row.clone()),
            None => EngineEvent::UserMessage(accepted_row.clone()),
        };
        if !emit(accepted) {
            emit(cancelled());
            return;
        }
        // The batched co-delivery rows (the real engine's one-run batch):
        // one accepted user row per batched message, in delivery order —
        // images ride as multimodal content blocks after the text, like
        // the primary — ahead of the single scripted reply.
        let mut batch_rows = Vec::new();
        for row in &request.batch {
            let mut content = vec![json!({ "type": "text", "text": row.text })];
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
            let accepted_row = json!({
                "role": "user",
                "content": content,
                "timestamp": crate::util::now_ms(),
            });
            batch_rows.push(accepted_row.clone());
            if !emit(EngineEvent::UserMessage(accepted_row)) {
                emit(cancelled());
                return;
            }
        }
        // The fixture's mid-turn goal announcement (the real engine's
        // `goal_update` emission path, TS `_setGoalState` ->
        // `_emitGoalUpdate`).
        if let Some(goal) = self.goal.as_ref().filter(|goal| goal.emit_update_on_prompt) {
            if !emit(EngineEvent::GoalUpdate {
                goal: goal.state.clone(),
            }) {
                emit(cancelled());
                return;
            }
        }
        let usage = scripted_usage();
        if !emit(EngineEvent::AssistantUpdate {
            message: json!({"role": "assistant", "content": "", "provider": "scripted", "model": "faux-1", "usage": usage.clone(), "timestamp": crate::util::now_ms()}),
            stream_event: None,
        }) {
            emit(cancelled());
            return;
        }
        let scripted_tools = scripted
            .as_ref()
            .and_then(|response| response.get("toolCalls"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // The real engine's assistant message carries its tool calls as
        // `toolCall` content blocks (session stats count calls from them
        // and results from the `toolResult` rows); a plain response keeps
        // the text content unchanged.
        let final_message = if scripted_tools.is_empty() {
            json!({"role": "assistant", "content": text, "provider": "scripted", "model": "faux-1", "usage": usage, "timestamp": crate::util::now_ms()})
        } else {
            let mut content = vec![json!({ "type": "text", "text": text })];
            for call in &scripted_tools {
                if call.get("toolCallId").and_then(Value::as_str).is_some() {
                    content.push(json!({
                        "type": "toolCall",
                        "id": call.get("toolCallId").cloned().unwrap_or(Value::Null),
                        "name": call.get("toolName").cloned().unwrap_or(json!("scripted_tool")),
                        "arguments": call.get("args").cloned().unwrap_or(Value::Null),
                    }));
                }
            }
            json!({"role": "assistant", "content": content, "provider": "scripted", "model": "faux-1", "usage": usage, "timestamp": crate::util::now_ms()})
        };
        if !emit(EngineEvent::AssistantMessage(final_message.clone())) {
            emit(cancelled());
            return;
        }
        // The scripted tool calls (the real loop's tool-call lifecycle, in
        // event order): each entry emits `tool_execution_start`, then
        // `tool_execution_end` with its settled result, then the
        // `toolResult` message the session file records (the roster
        // activity feed keys its `isRunningTools` flag on these frames).
        let mut tool_results = Vec::with_capacity(scripted_tools.len());
        for call in scripted_tools {
            let Some(tool_call_id) = call.get("toolCallId").and_then(Value::as_str) else {
                continue;
            };
            let tool_call_id = tool_call_id.to_string();
            let tool_name = call
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("scripted_tool")
                .to_string();
            let is_error = call
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let result_text = call.get("result").cloned().unwrap_or(Value::Null);
            if !emit(EngineEvent::ToolExecutionStart {
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                args: call.get("args").cloned().unwrap_or(Value::Null),
            }) {
                emit(cancelled());
                return;
            }
            // A running tool holds the turn for its scripted duration (the
            // real loop waits on the tool): the roster activity feed
            // composes and ships a delta while the tool executes, so the
            // gap must outlast the feed's round trip.
            if let Some(delay) = call.get("delayMs").and_then(Value::as_u64) {
                if delay > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                }
            }
            if !emit(EngineEvent::ToolExecutionEnd {
                tool_call_id: tool_call_id.clone(),
                result: json!({
                    "content": [{ "type": "text", "text": result_text.clone() }],
                    "details": Value::Null,
                    "isError": is_error,
                }),
                is_error,
            }) {
                emit(cancelled());
                return;
            }
            let result_message = json!({
                "role": "toolResult",
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "content": [{ "type": "text", "text": result_text }],
                "isError": is_error,
                "timestamp": crate::util::now_ms(),
            });
            if !emit(EngineEvent::ToolResultMessage(result_message.clone())) {
                emit(cancelled());
                return;
            }
            tool_results.push(result_message);
        }
        // The loop's terminal frame (TS `turn_end`): the final assistant
        // message as the payload, the scripted tool results riding it.
        if !emit(EngineEvent::TurnEnd {
            message: final_message.clone(),
            tool_results: tool_results.clone(),
        }) {
            emit(cancelled());
            return;
        }
        // The loop's run-end frame (TS `agent_end`): the run's
        // accumulated message set — the accepted rows (the primary plus
        // every batched row), the final assistant message, and every tool
        // result in the scripted shape.
        let mut run_messages = vec![accepted_row];
        run_messages.extend(batch_rows);
        run_messages.push(final_message);
        run_messages.extend(tool_results);
        if !emit(EngineEvent::AgentEnd {
            messages: run_messages,
        }) {
            emit(cancelled());
            return;
        }
        emit(EngineEvent::Done(Ok(())));
    }

    fn run_side_question(
        &self,
        request: SideQuestionRequest,
        signal: &AbortSignal,
        sink: &SideQuestionSink,
    ) -> SideQuestionOutcome {
        use pa_core::session_engine::provider_retry::{
            complete_with_provider_retry, DEFAULT_PROVIDER_RETRY_POLICY,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc as StdArc;

        // Unscripted side questions echo, like the prompt fallback.
        if self.side_question.responses.is_empty() {
            let answer = format!("echo: {}", request.question);
            if signal.is_aborted() || !sink(&answer) {
                return SideQuestionOutcome::Aborted { answer };
            }
            return SideQuestionOutcome::Complete { answer };
        }

        let policy = self
            .side_question
            .retry
            .clone()
            .unwrap_or(DEFAULT_PROVIDER_RETRY_POLICY);
        // Every scripted side-question run replays its results from the top,
        // like a fresh side conversation per run.
        let responses = StdArc::new(self.side_question.responses.clone());
        let attempt_index = StdArc::new(AtomicUsize::new(0));
        let sink = StdArc::clone(sink);
        let signal = signal.clone();
        let wait_signal = signal.clone();
        let attempt_signal = signal.clone();
        let result = futures::executor::block_on(complete_with_provider_retry(
            &policy,
            Some(&signal),
            move |delay| {
                let wait_signal = wait_signal.clone();
                async move { abortable_sleep(delay, &wait_signal) }
            },
            move || {
                let responses = StdArc::clone(&responses);
                let attempt_index = StdArc::clone(&attempt_index);
                let sink = StdArc::clone(&sink);
                let signal = attempt_signal.clone();
                async move {
                    let index = attempt_index.fetch_add(1, Ordering::SeqCst);
                    let Some(entry) = responses.get(index) else {
                        anyhow::bail!("No more scripted side-question responses");
                    };
                    Ok(scripted_side_question_turn(entry, &sink, &signal))
                }
            },
        ));
        let failed = |answer: String, error: String| SideQuestionOutcome::Failed { answer, error };
        match result {
            Ok(message) => {
                let text = match &message.content[0] {
                    pa_agent::types::AssistantContent::Text(text) => text.text.clone(),
                    _ => String::new(),
                };
                match message.stop_reason {
                    pa_agent::types::StopReason::Stop => {
                        SideQuestionOutcome::Complete { answer: text }
                    }
                    pa_agent::types::StopReason::Aborted => {
                        SideQuestionOutcome::Aborted { answer: text }
                    }
                    _ => failed(
                        text,
                        message
                            .error_message
                            .unwrap_or_else(|| "Side question failed".to_string()),
                    ),
                }
            }
            Err(error) => failed(String::new(), error.to_string()),
        }
    }
    fn run_compaction(
        &self,
        _request: CompactionRequest,
        signal: &AbortSignal,
    ) -> CompactionOutcome {
        // Unscripted compactions produce a deterministic result, like the
        // prompt echo fallback. Scripted runs consume entries in order and
        // replay from the top once exhausted.
        let Some(entry) = (|| {
            let index = self
                .compaction
                .next
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |current| {
                        Some(if current + 1 >= self.compaction.responses.len() {
                            0
                        } else {
                            current + 1
                        })
                    },
                )
                .ok()?;
            self.compaction.responses.get(index)
        })() else {
            return CompactionOutcome::Compacted {
                run: Box::new(CompactionRun {
                    result: json!({
                        "summary": "scripted compaction summary",
                        "firstKeptEntryId": "",
                        "tokensBefore": 0,
                        "details": { "readFiles": [], "modifiedFiles": [] },
                    }),
                    usage: None,
                    entry: Value::Null,
                    ipython_state: None,
                }),
            };
        };
        if let Some(error) = entry.get("error").and_then(Value::as_str) {
            return if entry.get("skipped").and_then(Value::as_bool) == Some(true) {
                CompactionOutcome::Skipped {
                    message: error.to_string(),
                }
            } else {
                CompactionOutcome::Failed {
                    error: error.to_string(),
                }
            };
        }
        let delay_ms = Self::response_delay_ms(entry);
        if delay_ms > 0 && !abortable_sleep(std::time::Duration::from_millis(delay_ms), signal) {
            return CompactionOutcome::Aborted;
        }
        if signal.is_aborted() {
            return CompactionOutcome::Aborted;
        }
        let result = json!({
            "summary": entry.get("summary").and_then(Value::as_str).unwrap_or_default(),
            "firstKeptEntryId": entry.get("firstKeptEntryId").and_then(Value::as_str).unwrap_or_default(),
            "tokensBefore": entry.get("tokensBefore").and_then(Value::as_u64).unwrap_or_default(),
            "details": entry.get("details").cloned().unwrap_or_else(|| json!({
                "readFiles": [], "modifiedFiles": [],
            })),
        });
        CompactionOutcome::Compacted {
            run: Box::new(CompactionRun {
                result,
                usage: entry.get("usage").cloned().filter(|usage| !usage.is_null()),
                entry: Value::Null,
                ipython_state: None,
            }),
        }
    }

    fn run_branch_summary(
        &self,
        _request: BranchSummaryRequest,
        signal: &AbortSignal,
    ) -> BranchSummaryOutcome {
        // Unscripted branch summaries produce a deterministic result, like
        // the compaction fallback. Scripted runs consume entries in order
        // and replay from the top once exhausted.
        let Some(entry) = (|| {
            let index = self
                .branch_summary
                .next
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |current| {
                        Some(if current + 1 >= self.branch_summary.responses.len() {
                            0
                        } else {
                            current + 1
                        })
                    },
                )
                .ok()?;
            self.branch_summary.responses.get(index)
        })() else {
            return BranchSummaryOutcome::Complete {
                run: BranchSummaryRun {
                    summary: "scripted branch summary".to_string(),
                    usage: None,
                    details: Some(json!({ "readFiles": [], "modifiedFiles": [] })),
                },
            };
        };
        if let Some(error) = entry.get("error").and_then(Value::as_str) {
            return BranchSummaryOutcome::Failed {
                error: error.to_string(),
            };
        }
        let delay_ms = Self::response_delay_ms(entry);
        if delay_ms > 0 && !abortable_sleep(std::time::Duration::from_millis(delay_ms), signal) {
            return BranchSummaryOutcome::Aborted;
        }
        if signal.is_aborted() {
            return BranchSummaryOutcome::Aborted;
        }
        BranchSummaryOutcome::Complete {
            run: BranchSummaryRun {
                summary: entry
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                usage: entry.get("usage").cloned().filter(|usage| !usage.is_null()),
                details: entry.get("details").cloned().filter(|d| !d.is_null()),
            },
        }
    }

    fn rebuild_session_context(
        &self,
        _branch_entries: Vec<pa_types::session::FileEntry>,
        _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> Result<()> {
        // The scripted harness engine carries no durable model context.
        Ok(())
    }
}

/// Scripted side-question turn statuses ride the assistant message's stop
/// reason; text blocks carry the (partial) answer.
fn scripted_side_question_turn(
    entry: &Value,
    sink: &SideQuestionSink,
    signal: &AbortSignal,
) -> pa_agent::types::AssistantMessage {
    use pa_agent::types::{
        AssistantContent, AssistantMessage, AssistantMessageDiagnostic, StopReason, TextContent,
    };
    let base = || AssistantMessage {
        content: vec![AssistantContent::Text(TextContent {
            text: String::new(),
            text_signature: None,
        })],
        api: String::new(),
        provider: "scripted".to_string(),
        model: "faux-1".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_agent::types::Usage::zero(),
        stop_reason: StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
    };
    let mut message = base();
    let set_text = |message: &mut AssistantMessage, text: &str| {
        let AssistantContent::Text(block) = &mut message.content[0] else {
            return;
        };
        block.text = text.to_string();
    };
    let text = ScriptedEngine::response_text(entry);
    if let Some(error) = entry.get("error").and_then(Value::as_str) {
        // Scripted provider failure with structured classification, so the
        // shared retry policy sees the same details a real provider records.
        let kind = entry.get("kind").and_then(Value::as_str);
        let status = entry.get("status").and_then(Value::as_u64);
        let retry_after_ms = entry.get("retryAfterMs").and_then(Value::as_u64);
        message.stop_reason = StopReason::Error;
        message.error_message = Some(error.to_string());
        message.diagnostics = Some(vec![AssistantMessageDiagnostic {
            kind: "provider_stream_failure".to_string(),
            timestamp: 0,
            error: None,
            details: Some(json!({
                "kind": kind,
                "status": status,
                "retryAfterMs": retry_after_ms,
            })),
        }]);
        return message;
    }
    // Stream the partial answer, then wait the scripted delay abortably.
    if signal.is_aborted() || !sink(&text) {
        set_text(&mut message, &text);
        message.stop_reason = StopReason::Aborted;
        return message;
    }
    let delay_ms = ScriptedEngine::response_delay_ms(entry);
    if delay_ms > 0 && !abortable_sleep(std::time::Duration::from_millis(delay_ms), signal) {
        set_text(&mut message, &text);
        message.stop_reason = StopReason::Aborted;
        return message;
    }
    if signal.is_aborted() {
        set_text(&mut message, &text);
        message.stop_reason = StopReason::Aborted;
        return message;
    }
    set_text(&mut message, &text);
    message
}

/// Sleep `delay` in slices, stopping early when `signal` aborts.
/// Returns `false` when the wait ended aborted.
fn abortable_sleep(delay: std::time::Duration, signal: &AbortSignal) -> bool {
    let mut remaining = delay;
    while !remaining.is_zero() {
        if signal.is_aborted() {
            return false;
        }
        let slice = remaining.min(std::time::Duration::from_millis(25));
        std::thread::sleep(slice);
        remaining = remaining.saturating_sub(slice);
    }
    !signal.is_aborted()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn scripted_engine_replays_then_echoes() {
        let engine = ScriptedEngine::from_value(
            json!({"responses": ["first", {"text": "second", "delayMs": 0}]}),
        )
        .unwrap();
        let request_for = |message: &str| PromptRequest {
            batch: Vec::new(),
            images: Vec::new(),
            message: message.to_string(),
            source: "test".to_string(),
            agent_message_id: None,
            custom_message: None,
        };
        let collect = |engine: &ScriptedEngine, index: usize, message: &str| {
            let mut final_message = None;
            engine.run_prompt(index, request_for(message), &|| false, &mut |event| {
                if let EngineEvent::AssistantMessage(value) = event {
                    final_message = Some(value);
                }
                true
            });
            final_message
        };
        assert_eq!(collect(&engine, 0, "hi").unwrap()["content"], "first");
        assert_eq!(collect(&engine, 1, "go").unwrap()["content"], "second");
        assert_eq!(
            collect(&engine, 2, "more").unwrap()["content"],
            "echo: more"
        );
    }

    #[test]
    fn cancellation_stops_the_prompt() {
        let engine = ScriptedEngine::default();
        let seen = Arc::new(AtomicUsize::new(0));
        let seen_clone = seen.clone();
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: "x".into(),
                source: "test".into(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                seen_clone.fetch_add(1, Ordering::SeqCst);
                match event {
                    EngineEvent::UserMessage(_) => false, // cancel right away
                    EngineEvent::Done(_) | EngineEvent::DoneAborted => true,
                    _ => true,
                }
            },
        );
        assert_eq!(seen.load(Ordering::SeqCst), 2); // user message + done
    }
}
