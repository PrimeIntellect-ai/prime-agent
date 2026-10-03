//! Session engine contract.
//!
//! The worker drives a [`SessionEngine`]: the worker owns the session store,
//! the queue, event sequencing, and wire framing; the engine owns turn
//! behavior. Today that is the scripted faux session (echo/scripted replies)
//! used by the integration harness and headless checks; the agent-loop crate
//! plugs into the same trait without touching any daemon mechanics.

use std::sync::Arc;

use anyhow::Result;
use pa_agent::abort::AbortSignal;
use pa_core::session_engine::provider_adapter::json_round_trip;
use pa_core::session_engine::provider_retry::{ProviderRetryPolicy, UNBOUNDED_BACKOFF_MS};
use pa_core::session_engine::side_question::{SideQuestionSink, SideQuestionTurn};
use serde_json::{json, Value};

// The wire types (the prompt/event records, the goal + bash notice plumbing,
// the RLM identity) and the compaction/branch-summary/side-question records
// moved to the child module at the same tree position (engine::wire); the
// re-exports keep every crate::engine::X path stable (the zero-bump cut).
mod wire;
pub use scripted::ScriptedEngine;
pub(crate) use wire::session_wire_value;
pub use wire::{
    empty_resource_snapshot, side_question_event_value, AssistantSnapshot, BashCompletionNotice,
    BashCompletionSink, BashConsumedNotice, BashConsumedSink, BranchSummaryOutcome,
    BranchSummaryRequest, BranchSummaryRun, CompactionOutcome, CompactionRequest, CompactionRun,
    EngineEvent, EngineModelSelection, GoalAdmissionSink, GoalContinuation, GoalTurnEndWork,
    PromptBatchRow, PromptRequest, RlmSessionIdentity, SavedSessionContext, SemanticSpawnOrigin,
    SessionInputProbe, SideQuestionOutcome, SideQuestionRequest, SIDE_QUESTION_STATUS_CANCELLED,
    SIDE_QUESTION_STATUS_COMPLETE, SIDE_QUESTION_STATUS_ERROR, SIDE_QUESTION_STATUS_RUNNING,
};

// The scripted faux session (the integration harness's deterministic engine,
// with its script records and the SessionEngine impl) moved to the child
// module at the same tree position (engine::scripted).
mod scripted;

// The trait-side test battery moved to the child module at the same tree
// position (engine::tests); the #[cfg(test)] decl rides at the facade tail.

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

    /// Release the session's kernel at a parent-owned child's idle settle
    /// (TS #2483's `_passivateSettledRlmChildRuntime` inline arm,
    /// worker-side): a snapshot-flushing stop that keeps the session
    /// listable, inspectable, collectable, and deletable; the next
    /// kernel use revives from the flushed snapshot. The turn runner
    /// fires this best-effort from its park arm once the worker core
    /// proved the parent-owned, unattached, unqueued idle state;
    /// engines that cannot release (scripted harness engines, engines
    /// without a kernel, or engines whose settled gates fail) no-op
    /// and the child stays resident.
    fn release_settled_child_kernel(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(std::future::ready(()))
    }

    /// Whether the whole-worker idle passivation gates pass (the
    /// `idleEvictionMinutes` consumer re-checks them before asking the
    /// supervisor for the graceful stop): the engine's settled gates
    /// plus an empty RLM child registry. The registry rule holds
    /// because a revival rebuilds the registry from the spawn ledger as
    /// settled rows only — live run state (answer previews, collect
    /// envelopes, in-flight watchers) does not come back, so the stop
    /// would still discard state the revival cannot restore. The
    /// default `false` keeps scripted harness engines and kernel-less
    /// embeddings resident — the same conservative arm as the release
    /// default.
    fn can_passivate_worker(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(std::future::ready(false))
    }

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

    /// Release the engine's pending-continuation guard: the caller
    /// admitted (or withdrew) a minted goal continuation, so the next
    /// boundary may mint again (the pending-never-re-arms contract —
    /// the owed flag clears at the queue). Engines without thread goals
    /// do nothing.
    fn clear_pending_goal_continuation(&self) {}

    /// The engine's current pending-continuation handle, READ without
    /// clearing (the mirror read — the core a mint about to spawn will
    /// use). Engines without thread goals have none.
    fn goal_pending_handle(&self) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
        None
    }

    /// Release one mint's OWN pending-continuation handle (the item's
    /// captured handle, or the spawn-captured handle for a lost task):
    /// an admission or drop names the specific mint, never the mutable
    /// mirror. An item that armed no guard releases nothing. Engines
    /// without thread goals release nothing.
    fn release_goal_continuation_handle(
        &self,
        _handle: &Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) {
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
    ///
    /// # Errors
    ///
    /// Errors when the armed round itself fails (its model call); every
    /// silent outcome stays `Ok(None)`, and engines without the
    /// compact-trigger machine never error.
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
    ///
    /// # Errors
    ///
    /// Errors when the moved branch's live-context rebuild fails; the
    /// parked-branch path (no session built yet) and the goal reload do
    /// not error.
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
    ///
    /// `saved` is the [`SavedSessionContext`] the caller already read off an
    /// open store (TS reads its loaded entries; the create path holds the
    /// store its own `open_windowed` built) — passing it skips the restore's
    /// second windowed open of the same file. `None` reads the file. Engines
    /// without a persisted model context do nothing.
    fn restore_session_model(
        &self,
        _session_path: &std::path::Path,
        _saved: Option<SavedSessionContext>,
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

    /// The create command's `--models` scope, resolved once per create by
    /// the daemon against its registry (TS main.ts:838-851:
    /// `config.models ?? settings.enabledModels` → `resolveModelScope`),
    /// plus whether the session continues an existing file (TS
    /// `hasExistingSession`): the startup chain starts a fresh session on
    /// the first scoped model or the saved default when it is in scope
    /// (main.ts:548-568); a continuing session keeps its own model. The
    /// default is a no-op (scripted engines run no startup chain).
    fn configure_startup_scope(
        &self,
        _scoped_models: Vec<pa_core::models::ScopedModel>,
        _is_continuing: bool,
    ) {
    }

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

    /// True while the session is parked waiting out a provider-reported
    /// usage reset (TS `session.isQuotaParked`): the park ended the turn
    /// cleanly and a durable wake resumes it. Scripted harness engines
    /// never park.
    fn is_quota_parked(&self) -> bool {
        false
    }

    /// True while any RLM child this session spawned is still running
    /// (each child counts its own descendants the same way). Scripted
    /// harness engines spawn no children.
    fn has_running_subagents(&self) -> bool {
        false
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
    ///
    /// # Errors
    ///
    /// Errors when a carried thinking level is not a known level name, so
    /// the create fails instead of a later turn; engines without an RLM
    /// identity never error.
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
    /// `createAgentConnectionCommands`): prompt templates, then skills.
    /// The core session lock is async, so the engine answers through a
    /// boxed future. Engines without a resource surface report none.
    fn connection_commands(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Value>> + Send + '_>> {
        Box::pin(async { Vec::new() })
    }

    /// The connection resource snapshot (TS
    /// `createAgentConnectionResourceSnapshot`): context files, skills,
    /// prompts, and their diagnostics. The core session lock is async,
    /// so the engine answers through a boxed future. Engines without a
    /// resource surface report the empty snapshot.
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
    ///
    /// # Errors
    ///
    /// Errors when the engine does not support refinement (the default
    /// answer), or when model resolution, the session build, the
    /// refinement round, or the result conversion fails; the caller
    /// surfaces the error as the command failure.
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
    ///
    /// # Errors
    ///
    /// The ported engines never error this command: the global settings
    /// write failure rides the result's `globalError` field instead (the
    /// TS shape), and the default engine answers the static result.
    fn set_rlm_max_depth(&self, max_depth: u64, global: bool) -> Result<Value> {
        let _ = global;
        Ok(json!({ "maxDepth": max_depth, "source": "chat", "globalSaved": false }))
    }
}

#[cfg(test)]
mod tests;
