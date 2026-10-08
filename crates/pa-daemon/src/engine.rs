//! Session engine contract.
//!
//! The worker owns the session store, the queue, event sequencing, and wire
//! framing; the engine owns turn behavior.

use std::sync::Arc;

use anyhow::Result;
use pa_agent::abort::AbortSignal;
use pa_core::session_engine::provider_adapter::json_round_trip;
use pa_core::session_engine::provider_retry::{ProviderRetryPolicy, UNBOUNDED_BACKOFF_MS};
use pa_core::session_engine::side_question::{SideQuestionSink, SideQuestionTurn};
use serde_json::{json, Value};

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

mod scripted;

/// The turn behavior a worker session runs.
pub trait SessionEngine: Send + Sync {
    /// The session's shared MCP manager, when the engine owns one: the
    /// `replace_acp_mcp_servers` command writes through it.
    fn acp_mcp_manager(
        &self,
    ) -> Option<std::sync::Arc<std::sync::Mutex<pa_core::mcp::McpManager>>> {
        None
    }

    /// The session's current goal state as the wire `GoalState` value.
    /// Engines without thread goals report the empty state.
    fn goal_state_value(&self) -> Value {
        serde_json::to_value(pa_core::goals::empty_goal_state()).unwrap_or(Value::Null)
    }

    /// Purge the queued goal-context turns: withdraw minted continuations
    /// waiting to run; engines without a queue do nothing.
    fn purge_queued_goal_contexts(&self) {}

    /// Release the session's kernel at a parent-owned child's idle settle: a
    /// snapshot-flushing stop; engines that cannot release (scripted harness, no
    /// kernel, failed settled gates) no-op.
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

    /// Mint the owed post-compaction goal continuation; `None` when the
    /// engine mints nothing. The worker owns the queue and admits the turn.
    fn mint_post_compaction_goal_continuation(&self) -> Option<GoalContinuation> {
        None
    }

    /// Release the engine's pending-continuation guard: the caller admitted
    /// (or withdrew) a minted goal continuation. Engines without thread goals do nothing.
    fn clear_pending_goal_continuation(&self) {}

    /// The engine's current pending-continuation handle, read without
    /// clearing. Engines without thread goals have none.
    fn goal_pending_handle(&self) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
        None
    }

    /// Release one mint's own pending-continuation handle: an admission or
    /// drop names the specific mint, never the mutable mirror.
    fn release_goal_continuation_handle(
        &self,
        _handle: &Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) {
    }

    /// Run one prompt. `prompt_index` counts accepted prompts. `aborted` is
    /// the worker's cancel probe (checked between retry waits, where no
    /// events flow to observe it); `emit` returning `false` cancels.
    fn run_prompt(
        &self,
        prompt_index: usize,
        request: PromptRequest,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    );

    /// Abort the in-flight turn eagerly: the live run's provider fetch
    /// cancels immediately, not at the next streamed event. Engines without
    /// a real agent loop no-op.
    fn abort_in_flight_turn(&self) {}

    /// Switch the queue delivery modes live: apply the persisted mode to
    /// the engine's agent-level queues too.
    fn set_queue_modes(&self, steering: Option<&str>, follow_up: Option<&str>) {
        let _ = (steering, follow_up);
    }

    /// Run one side question: a second LLM turn over a clone of the
    /// conversation, excluded from the session history. `signal` aborts;
    /// `sink` receives partial answers.
    fn run_side_question(
        &self,
        request: SideQuestionRequest,
        signal: &AbortSignal,
        sink: &SideQuestionSink,
    ) -> SideQuestionOutcome;

    /// Run one compaction (`compact` command): summarize the pre-cut
    /// history. The engine owns the model call; `signal` aborts the run.
    fn run_compaction(&self, request: CompactionRequest, signal: &AbortSignal)
        -> CompactionOutcome;

    /// Abort the in-flight automatic compaction — TS `abortCompaction`
    /// also aborts the auto controller, not just the manual run.
    fn abort_auto_compaction(&self) {}

    /// Consume a pending compact-trigger auto-refine review: the engine
    /// resolves the model and runs the gated round. `Ok(None)` is every
    /// silent outcome — no trigger armed, a gate drop, cooldown, or decline.
    ///
    /// # Errors
    ///
    /// Errors when the armed round itself fails (its model call).
    fn consume_compact_auto_refine(
        &self,
    ) -> anyhow::Result<Option<pa_core::refinement::RefinementResult>> {
        Ok(None)
    }

    /// Run one branch summary (`navigate_tree` with `summarize`): summarize
    /// the abandoned branch's entries; the engine owns the model call.
    fn run_branch_summary(
        &self,
        request: BranchSummaryRequest,
        signal: &AbortSignal,
    ) -> BranchSummaryOutcome;

    /// Rebuild the engine's live context from a durable branch: the worker
    /// moves its store first, then hands the new branch's entries over;
    /// `goal_reload` reloads the goal state from the moved branch, so a
    /// summary rebuild continues the same timeline.
    ///
    /// # Errors
    ///
    /// Errors when the live-context rebuild fails.
    fn rebuild_session_context(
        &self,
        branch_entries: Vec<pa_types::session::FileEntry>,
        goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> Result<()>;

    /// The `goal_update` payload for a goal state change published outside
    /// a turn: `Some` when the state changed since the last announcement.
    fn goal_update_after_rebuild(&self) -> Option<Value> {
        None
    }

    /// Retire the live session runtime before the replacement rebuilds:
    /// a replacement must never keep the old kernel (TS starts the moved-to
    /// session cold); tree moves never run this.
    fn teardown_for_replacement(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }

    /// Context window (tokens) of the engine's resolved model, when known.
    /// Drives the `contextUsage` estimate in `get_session_stats`.
    fn model_context_window(&self) -> Option<u64> {
        None
    }
    /// The worker's turn loop completed: engines hosting RLM children
    /// release prompt tasks spawned mid-turn, so the parent's continuation
    /// request always reaches the provider before a child's first turn.
    fn on_turn_done(&self) {}

    /// Finalize session telemetry at session close: emit `agent session
    /// ended` and flush once. Best-effort: never fail or block shutdown.
    fn end_telemetry(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(std::future::ready(()))
    }

    /// The daemon `kill` path: emit `session archived` then finalize, after
    /// the turn settles. Best-effort like `end_telemetry`.
    fn archive_session_telemetry(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(std::future::ready(()))
    }

    /// The `(provider, model id)` pair the session will run on; fresh
    /// daemon sessions record it in their creation prefix (`model_change`).
    fn creation_model(&self) -> Option<(String, String)> {
        None
    }

    /// Tell the engine which session file the worker owns (the
    /// conversation-log path and the session-local harness dir).
    fn set_session_file(&self, path: std::path::PathBuf) {
        let _ = path;
    }

    /// A session being revived restores the model its file pins before the
    /// startup chain, so it does not silently land on the startup-chain
    /// default. `saved` skips a second windowed open; `None` reads the file.
    fn restore_session_model(
        &self,
        _session_path: &std::path::Path,
        _saved: Option<SavedSessionContext>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(std::future::ready(()))
    }

    /// The on-the-record reason a revived session's model fell back — a
    /// model fallback must never be silent.
    fn model_fallback_message(&self) -> Option<String> {
        None
    }

    /// Merge an explicit selection over the engine's live selection:
    /// explicit wire flags replace, absent fields keep. A live merge that
    /// must NOT fold into the reset target ([`Self::configure_create_model`]).
    fn configure_model(&self, _selection: EngineModelSelection) {}

    /// Adopt the explicit model selection carried by the create command:
    /// the flags are authoritative and survive every session replacement.
    fn configure_create_model(&self, _selection: EngineModelSelection) {}

    /// The create command's `--models` scope, plus whether the session
    /// continues an existing file: fresh sessions start on the first
    /// scoped model or the saved default; continuing sessions keep their own.
    fn configure_startup_scope(
        &self,
        _scoped_models: Vec<pa_core::models::ScopedModel>,
        _is_continuing: bool,
    ) {
    }

    /// Set the session's resolved service-tier preference before the next request.
    fn configure_service_tier(&self, _tier: Option<pa_types::ai::ServiceTier>) {}

    /// The effective thinking level as a wire name (`"off"`, `"minimal"`, ...):
    /// the create-config flag (else the settings default, else `"medium"`),
    /// clamped to the model's supported levels; `None` records `"off"`.
    fn effective_thinking_level(&self) -> Option<String> {
        None
    }

    /// The session's assembled system prompt, when the engine can produce
    /// it synchronously (the HTML export embeds it).
    fn export_system_prompt(&self) -> Option<String> {
        None
    }

    /// The session's registered tools for the export's tools section: built
    /// now when not yet built; `None` mid-turn.
    fn export_tools(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + '_>> {
        Box::pin(async { None })
    }

    /// Pre-rendered HTML for custom-tool calls/results, keyed by tool-call
    /// id (TS `preRenderCustomTools`); `None` when nothing rendered.
    fn export_rendered_tools(
        &self,
        _entries: &[Value],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + '_>> {
        Box::pin(async { None })
    }

    /// The engine's resolved model as connection-state wire data
    /// (`{ id, provider, reasoning }`), for the splash and tray labels.
    fn model_metadata(&self) -> Option<Value> {
        None
    }

    /// True while the session is parked waiting out a provider-reported
    /// usage reset: the turn ended cleanly and a durable wake resumes it.
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

    /// Apply a live thinking-level switch (`set_thinking_level`): the
    /// level merges over the selection, clamped to the supported levels.
    fn switch_thinking_level(&self, _level: pa_types::ai::ModelThinkingLevel) -> bool {
        false
    }

    /// The resolved model's supported thinking levels as wire names;
    /// `None` records `["off"]` for the caller.
    fn supported_thinking_levels(&self) -> Option<Vec<String>> {
        None
    }

    /// The session's newest accepted progress note; engines without a note
    /// store report `None`.
    fn progress_note(&self) -> Option<String> {
        None
    }

    /// Clears the stored note at the run boundary; engines without a note
    /// store do nothing.
    fn clear_progress_note(&self) {}

    /// The session's autonomous-run status snapshot (the accounting lock
    /// is async-held, hence the boxed future). The scripted harness reports `None`.
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

    /// The worker's live session summary (the `create` response data):
    /// rendered into the sender identity block of worker-to-worker messages.
    fn set_session_summary(&self, _summary: Value) {}

    /// Adopt the RLM identity from the session's create command. Fails
    /// when a carried value is invalid, so the create fails, not a later turn.
    ///
    /// # Errors
    ///
    /// Errors when a carried thinking level is not a known level name.
    fn configure_rlm_identity(&self, _identity: RlmSessionIdentity) -> Result<()> {
        Ok(())
    }

    /// Rebind the engine's session cwd: a `switch_session` / `import_jsonl`
    /// onto a file with another recorded cwd moves the rebuilt session's cwd.
    fn set_cwd(&self, _cwd: std::path::PathBuf) {}

    /// An agent message from one of this session's RLM children reached this
    /// session: the child's terminal no-reply notice can be withheld.
    fn mark_child_reply(&self, _child_active_session_id: &str) {}

    /// One accepted `rlm.progress.note` from an RLM child of this session
    /// reached the worker: the child's roster row carries the newest note.
    fn mark_child_note(&self, _child_active_session_id: &str, _message: &str, _timestamp_ms: u64) {}

    /// The session's RLM children as wire snapshots (the `get_rlm_children`
    /// response and the context-tree children).
    fn rlm_child_snapshots(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Value>> + Send + '_>> {
        Box::pin(async { Vec::new() })
    }

    /// The connection-surface command catalog: prompt templates, then
    /// skills. Engines without a resource surface report none.
    fn connection_commands(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<Value>> + Send + '_>> {
        Box::pin(async { Vec::new() })
    }

    /// The connection resource snapshot: context files, skills, prompts,
    /// and their diagnostics.
    fn resource_snapshot(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + '_>> {
        Box::pin(async { empty_resource_snapshot() })
    }

    /// The session's system prompt. Engines without a prompt report the
    /// empty string.
    fn system_prompt(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send + '_>> {
        Box::pin(async { Ok(String::new()) })
    }

    /// One tool definition by name, when the engine exposes one.
    fn tool_definition(
        &self,
        _name: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + '_>> {
        Box::pin(async { None })
    }

    /// Run one refinement (the daemon `refine` command): plan, apply, and
    /// persist the harness state.
    ///
    /// # Errors
    ///
    /// Errors when the engine does not support refinement, or model
    /// resolution, the session build, or the round fails.
    fn run_refinement(
        &self,
        options: pa_core::session_engine::refine::RefineOptions,
    ) -> Result<Value> {
        let _ = options;
        anyhow::bail!("This session does not support refinement")
    }

    /// The session's RLM max-depth status `{ maxDepth, source }`, with the
    /// TS source vocabulary (`default` | `env` | `global` | `inherited` | `chat`).
    fn rlm_max_depth_status(&self) -> Value {
        json!({
            "maxDepth": crate::rlm_children::DEFAULT_RLM_MAX_DEPTH,
            "source": "default",
        })
    }

    /// Cancel one live RLM child run by id (the `cancel_rlm_child`
    /// command): `true` when a live run was cancelled.
    fn cancel_rlm_child<'a>(
        &'a self,
        child_id: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
        let _ = child_id;
        Box::pin(async { false })
    }

    /// Delete one inactive RLM child by id (TS `deleteInactiveRlmSubagent`).
    /// Outcomes are TS-verbatim (`"deleted"` | `"not_found"` | `"running"`).
    fn delete_rlm_subagent<'a>(
        &'a self,
        child_id: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<&'static str>> + Send + 'a>,
    > {
        let _ = child_id;
        Box::pin(async { Ok("not_found") })
    }

    /// Returns `{ maxDepth, source, globalSaved }` plus `globalError` when
    /// the requested global settings write failed.
    ///
    /// # Errors
    ///
    /// Never errors: the global write failure rides `globalError` instead.
    fn set_rlm_max_depth(&self, max_depth: u64, global: bool) -> Result<Value> {
        let _ = global;
        Ok(json!({ "maxDepth": max_depth, "source": "chat", "globalSaved": false }))
    }
}

#[cfg(test)]
mod tests;
