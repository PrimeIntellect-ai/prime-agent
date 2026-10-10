//! The live session's state block.
use super::{Lane, QueuedItem};

use std::collections::VecDeque;

use serde_json::Value;

use crate::session_store::SessionFile;
use crate::types::SessionActionSnapshot;

/// The live session: store, queue, sequencing; shared by the connection
/// tasks, the runner, and the compaction manager via the core mutex.
pub(crate) struct SessionCore {
    pub(crate) active_session_id: String,
    pub(crate) generation: String,
    pub(crate) last_event_sequence: u64,
    pub(crate) store: Option<SessionFile>,
    pub(crate) cwd: String,
    pub(crate) steering: VecDeque<QueuedItem>,
    pub(crate) follow_up: VecDeque<QueuedItem>,
    /// Picked rows remain owned until each matching session entry can be
    /// confirmed durable. The running batch leaves the visible lanes.
    pub(crate) in_flight_input: Vec<InFlightInput>,
    pub(crate) busy: bool,
    pub(crate) created: bool,
    pub(crate) attached_client_ids: Vec<String>,
    pub(crate) abort_requested: bool,
    /// A flow that detaches from the interrupted turn's events (a manual
    /// `compact`, a branch navigation) swallowed the aborted row in TS, so the
    /// gate's aborted-row exception stays closed while it settles its turn.
    pub(crate) suppress_aborted_row: bool,
    pub(crate) shutdown_requested: bool,
    pub(crate) shutdown_interrupted_turn: bool,
    pub(crate) cancel_handoffs_pending: usize,
    #[cfg(test)]
    pub(crate) pickup_checkpoint_gate: Option<std::sync::Arc<PickupCheckpointGate>>,
    /// True while a compaction run is in flight (TS `isCompacting`).
    pub(crate) compacting: bool,
    /// The turn's tool calls in flight, keyed by tool-call id: the
    /// roster summary derives `isRunningTools` from its size.
    pub(crate) running_tool_calls: std::collections::HashSet<String>,
    /// Admission ids belonging to the current in-flight turn. The queue
    /// handoff and owned cancellation both inspect this under the core lock.
    pub(crate) running_admission_ids: std::collections::HashSet<String>,
    /// TS `autoCompactionEnabled` (settings default: on).
    pub(crate) auto_compaction_enabled: bool,
    /// The last broadcast queue snapshot (TS `_lastSessionActionSnapshot`):
    /// `session_action_update` fires only when the projection changed.
    pub(crate) last_action_snapshot: Option<SessionActionSnapshot>,
    /// This session's RLM recursion depth (children run at depth + 1).
    pub(crate) rlm_depth: u32,
    /// The wall-clock ms of this session's last activity: stamped every time
    /// the runner parks after work, so the idle-eviction clock measures from
    /// the true end of the last activity. Zero means "no activity yet".
    pub(crate) last_activity_ms: u64,
    /// `top-level` | `subagent` (summary `runtimeKind`).
    pub(crate) runtime_kind: String,
    /// The subagent runtime identity (create `runtimeMetadata`): the child id
    /// and the parent's ids, so the roster keys children `parentPath#childId`.
    pub(crate) rlm_child_id: Option<String>,
    pub(crate) parent_active_session_id: Option<String>,
    pub(crate) parent_session_id: Option<String>,
    /// The create command's harness `childScript` (kept across the runtime swap
    /// so a replacement's children stay scripted); `None` for product sessions.
    pub(crate) child_script: Option<String>,
    /// The session's service-tier preference (TS `_serviceTierPreference`,
    /// `None` = "auto"): clamps `priority` to `default` without fast mode.
    pub(crate) service_tier: Option<pa_types::ai::ServiceTier>,
    /// The ACTIVE tier the engine's request slot carries: the preference clamped
    /// to the current model. Diverges from `service_tier` only while the current
    /// model does not support the requested tier.
    pub(crate) active_service_tier: Option<pa_types::ai::ServiceTier>,
    /// The queue delivery modes: "all" or "one-at-a-time". The steering default
    /// is "all" (queued steers co-deliver as ONE turn); the follow-up default is
    /// "one-at-a-time" (drain one per turn when idle).
    pub(crate) steering_mode: String,
    pub(crate) follow_up_mode: String,
    /// The one-shot forced steering batch (armed by `abort_and_send_queued`):
    /// armed items co-deliver as ONE batched turn at the next boundary, even
    /// under "one-at-a-time". Disarms when no armed item remains queued.
    pub(crate) forced_all_steering: bool,
    /// The scoped model list (TS `_scopedModels`): wire entries
    /// `{ model, thinkingLevel? }` the model cycler cycles within.
    pub(crate) scoped_models: Vec<Value>,
    /// A retry in flight was aborted (`abort_retry`); the turn's abort
    /// probe reads it and the next turn start clears it.
    pub(crate) retry_abort_requested: bool,
    /// Queued-input admission is suspended (`requestAbort` and manual `compact()`
    /// set it): the runner drains nothing and a plain prompt is rejected. Cleared
    /// by the resume sites: `steer`/`follow_up`, `streamingBehavior`, `resume_queue`,
    /// a queued-message mutation, a cron/heartbeat fire, a compact with an active goal.
    pub(crate) queued_input_suspended: bool,
    /// A supervisor-held shutdown needs an explicit, durable `resume_queue`;
    /// ordinary steer/follow-up resume sites cannot release this fence.
    pub(crate) recovery_hold: bool,
    /// Restored next-turn rows (TS `_pendingNextTurnMessages`,
    /// `restore_next_turn`): delivered as prefix rows with the next turn.
    pub(crate) pending_next_turn: Vec<Value>,
    /// The queue projection's active action: the runner sets the phase transitions
    /// (`preparing` at pickup, `committing` at the first row, `running` at the
    /// first assistant frame) and clears it once the turn settles.
    pub(crate) active_action: Option<crate::types::SessionActionActive>,
}

#[cfg(test)]
pub(crate) struct PickupCheckpointGate {
    pub(crate) entered: std::sync::Arc<tokio::sync::Notify>,
    pub(crate) release: std::sync::Arc<tokio::sync::Notify>,
}

#[derive(Clone)]
pub(crate) struct InFlightInput {
    pub(crate) lane: Lane,
    pub(crate) row_id: String,
    pub(crate) item: crate::journal::WorkerQueueItemRecord,
    pub(crate) attempted: bool,
    pub(crate) committed: bool,
    pub(crate) cancelled: bool,
}

impl SessionCore {
    /// Whether a turn, compaction, or queued action is in flight (TS
    /// `hasOngoingSessionWork`); the supervisor-lost exit waits for it to settle.
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
            in_flight_input: Vec::new(),
            busy: false,
            created: true,
            attached_client_ids: Vec::new(),
            abort_requested: false,
            suppress_aborted_row: false,
            shutdown_requested: false,
            shutdown_interrupted_turn: false,
            cancel_handoffs_pending: 0,
            pickup_checkpoint_gate: None,
            last_activity_ms: 0,
            compacting: false,
            running_tool_calls: std::collections::HashSet::new(),
            running_admission_ids: std::collections::HashSet::new(),
            auto_compaction_enabled: true,
            last_action_snapshot: Some(SessionActionSnapshot::default()),
            rlm_depth: 0,
            runtime_kind: "top-level".to_string(),
            rlm_child_id: None,
            parent_active_session_id: None,
            parent_session_id: None,
            child_script: None,
            service_tier: None,
            active_service_tier: None,
            steering_mode: "all".to_string(),
            follow_up_mode: "one-at-a-time".to_string(),
            forced_all_steering: false,
            scoped_models: Vec::new(),
            retry_abort_requested: false,
            queued_input_suspended: false,
            recovery_hold: false,
            pending_next_turn: Vec::new(),
            active_action: None,
        }
    }
}
