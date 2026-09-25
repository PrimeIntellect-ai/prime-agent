//! The live session's state block: `SessionCore` holds the store, the queue
//! lanes, and the event sequencing shared by the connection tasks, the turn
//! runner, and the compaction manager (every access is through the core
//! mutex).
use super::*;

use std::collections::VecDeque;

use serde_json::Value;

use crate::session_store::SessionFile;
use crate::types::SessionActionSnapshot;

/// The live session: store, queue, sequencing. Shared by the connection tasks,
/// the turn runner, and the compaction manager; every access is through the
/// core mutex.
pub(crate) struct SessionCore {
    pub(crate) active_session_id: String,
    pub(crate) generation: String,
    pub(crate) last_event_sequence: u64,
    pub(crate) store: Option<SessionFile>,
    pub(crate) cwd: String,
    pub(crate) steering: VecDeque<QueuedItem>,
    pub(crate) follow_up: VecDeque<QueuedItem>,
    pub(crate) busy: bool,
    pub(crate) created: bool,
    pub(crate) attached_client_ids: Vec<String>,
    pub(crate) abort_requested: bool,
    /// A flow that detaches from the interrupted turn's events (TS
    /// `compact()`'s `_disconnectFromAgent()` before `abort()` — and the
    /// branch-navigation interrupt, the same teardown shape) swallowed the
    /// aborted turn's assistant row on the TS wire and in the session
    /// file, so the gate's aborted-row exception stays closed while such a
    /// flow settles its turn. Owned by the interrupt-and-settle helper that
    /// set it; cleared once the turn settled.
    pub(crate) suppress_aborted_row: bool,
    pub(crate) shutdown_requested: bool,
    /// True while a compaction run is in flight (TS `isCompacting`).
    pub(crate) compacting: bool,
    /// The turn's tool calls in flight, keyed by tool-call id (TS
    /// `session.state.pendingToolCalls`): the tool-execution frames add
    /// and remove ids, and the roster summary derives `isRunningTools`
    /// (`isStreaming && pendingToolCalls.size > 0`) from its size.
    pub(crate) running_tool_calls: std::collections::HashSet<String>,
    /// TS `autoCompactionEnabled` (settings default: on).
    pub(crate) auto_compaction_enabled: bool,
    /// The last broadcast queue snapshot (TS `_lastSessionActionSnapshot`):
    /// `session_action_update` fires only when the projection changed.
    pub(crate) last_action_snapshot: Option<SessionActionSnapshot>,
    /// This session's RLM recursion depth (children run at depth + 1).
    pub(crate) rlm_depth: u32,
    /// `top-level` | `subagent` (summary `runtimeKind`).
    pub(crate) runtime_kind: String,
    /// The subagent runtime identity (create `runtimeMetadata`): the child
    /// id under its parent and the parent's live/persisted ids, carried on
    /// every summary so the roster keys children `parentPath#childId`.
    pub(crate) rlm_child_id: Option<String>,
    pub(crate) parent_active_session_id: Option<String>,
    pub(crate) parent_session_id: Option<String>,
    /// The create command's harness `childScript` (the TS child runtime
    /// inherits the parent's `sessionConfig`; the Rust replacement keeps
    /// the seam across the runtime swap so a replacement session's
    /// children stay scripted). `None` for product sessions.
    pub(crate) child_script: Option<String>,
    /// The session's service-tier preference (TS `_serviceTierPreference`;
    /// `None` is the settings default "auto"). The effective tier clamps
    /// `priority` to `default` on models without fast mode.
    pub(crate) service_tier: Option<pa_types::ai::ServiceTier>,
    /// The queue delivery modes (TS `agent.steeringMode` / `followUpMode`):
    /// `"all"` or `"one-at-a-time"`. The steering default is `"all"`
    /// (every queued steer co-delivers as ONE turn at the next
    /// tool-call boundary; `"one-at-a-time"` stays selectable via the
    /// setting). The follow-up default is `"one-at-a-time"` (follow-ups
    /// drain when the session goes idle, one per turn).
    pub(crate) steering_mode: String,
    pub(crate) follow_up_mode: String,
    /// The one-shot forced steering batch (TS `_forcedAllSteeringActionIds`
    /// on the session, armed by `abortAndSendQueued`): while armed, armed
    /// steering items co-deliver as ONE batched turn at the next boundary
    /// — even under queue mode "one-at-a-time". Disarms when no armed
    /// item remains queued (TS `_forcedAllSteeringBatch`'s disarm read).
    pub(crate) forced_all_steering: bool,
    /// The scoped model list (TS `_scopedModels`): wire entries
    /// `{ model, thinkingLevel? }` the model cycler cycles within.
    pub(crate) scoped_models: Vec<Value>,
    /// A retry in flight was aborted (`abort_retry`); the turn's abort
    /// probe reads it and the next turn start clears it.
    pub(crate) retry_abort_requested: bool,
    /// TS `_sessionInputPumpSuspended`: `requestAbort`/`abortForUpdateRestart`
    /// (and manual `compact()`, which aborts first) suspend queued-input
    /// admission. While set, the turn runner drains nothing and a plain
    /// prompt (`prompt`/`prompt_and_wait` without `streamingBehavior`, TS
    /// `resumeIfIdle: command.streamingBehavior !== undefined`) is rejected
    /// with the TS admission error. Cleared by the TS resume sites: a
    /// `steer`/`follow_up` command or a prompt carrying
    /// `streamingBehavior`, `resume_queue`, an applied queued-message
    /// mutation, a cron/heartbeat fire (TS `promptHeartbeat` passes
    /// `resumeIfIdle: true`), and a successful compact with an active
    /// goal (TS `compact()`'s `resumeQueuedWork()` branch).
    pub(crate) queued_input_suspended: bool,
    /// Restored next-turn rows (TS `_pendingNextTurnMessages`,
    /// `restore_next_turn`): delivered as prefix rows with the next turn.
    pub(crate) pending_next_turn: Vec<Value>,
    /// The queue projection's active action (TS `getSessionActionSnapshot`
    /// reads the store's first active action): the runner sets the phase
    /// transitions of a queue-visible delivery (`preparing` at pickup,
    /// `committing` at the turn's first row — the prompt becomes visible
    /// in the conversation then, TS's commit fence — `running` at the
    /// turn's first assistant frame) and clears it once the delivered
    /// turn settles. The `preparing` projection is what a client renders
    /// as the queued strip's "Starting" row (TS #2063). The label rides
    /// the snapshot (TS #2063 `compactRlmText(queuedAgentMessagePreview(
    /// active))`: the delivery's labeled preview, else the message text).
    pub(crate) active_action: Option<crate::types::SessionActionActive>,
}

impl SessionCore {
    /// Whether a turn, compaction, or queued action is in flight — the TS
    /// `hasOngoingSessionWork` predicate. An active run owns the worker a
    /// little longer; the supervisor-lost exit waits for it to settle.
    pub(crate) fn has_ongoing_work(&self) -> bool {
        self.busy || self.compacting || !self.steering.is_empty() || !self.follow_up.is_empty()
    }

    /// A created session core for command modules' unit tests (the private
    /// bookkeeping fields stay owned here).
    #[cfg(test)]
    pub(crate) fn test_core(store: Option<SessionFile>, cwd: String) -> Self {
        SessionCore {
            active_session_id: store.as_ref().map_or_else(
                || "test-session".to_string(),
                |store| store.session_id().to_string(),
            ),
            generation: String::new(),
            last_event_sequence: 0,
            store,
            cwd,
            steering: VecDeque::new(),
            follow_up: VecDeque::new(),
            busy: false,
            created: true,
            attached_client_ids: Vec::new(),
            abort_requested: false,
            suppress_aborted_row: false,
            shutdown_requested: false,
            compacting: false,
            running_tool_calls: std::collections::HashSet::new(),
            auto_compaction_enabled: true,
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
        }
    }
}
