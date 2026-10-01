//! Supervisor-backed RLM child sessions: the daemon's implementation of the
//! pa-core [`RlmSubagentHost`] seam. `rlm.spawn` and `rlm.create_session`
//! create real daemon sessions through the supervisor link (one supervised
//! worker process per child), prompt them, and keep the parent-side roster
//! the kernel reads through `rlm.list_subagents`, `rlm.collect`, and
//! `rlm.delete_subagent`.
//!
//! Mechanism note: the TS daemon hosts children in-process
//! (`createRlmSubagentRuntime`); this redesign gives every child its own
//! supervised worker process, created through the supervisor like any other
//! session. The kernel-visible surface (handles, roster rows, collect
//! snapshots, selector errors) is TS parity.

use serde_json::Map;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use pa_core::kernel::rlm_runtime::create_default_rlm_subagent_session_name;
use pa_core::session_engine::rlm_host::{
    RlmChildResult, RlmCreateSessionHandle, RlmCreateSessionRequest, RlmDeleteSubagentResult,
    RlmHostFuture, RlmSpawnHandle, RlmSpawnRequest, RlmSubagentActivity, RlmSubagentEntry,
    RlmSubagentHost,
};
use pa_core::session_engine::rlm_notices::{
    create_rlm_child_terminal_notice, RlmChildTerminalNotice,
};
use pa_core::session_engine::rlm_usage::{RlmChildUsageReport, RlmChildUsageSink};
use pa_types::daemon::{DaemonCommand, DaemonSessionLifecycle, PromptInput};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::rlm_child_model::{
    assert_thinking_supported, compact_rlm_text, resolve_child_model, rlm_child_label,
};
use crate::supervisor_link::SupervisorLink;
use crate::util::now_ms;

/// Depth bound without an explicit override (TS `resolveRlmMaxDepth` default).
pub const DEFAULT_RLM_MAX_DEPTH: u32 = 2;

/// The close reason a parent hands its resident children (TS
/// `closeSessionOnce`'s reason arms, cascaded through
/// `closeChildSessions(parentState, reason)`):
///
/// - `Killed` — the child closes as killed: its scheduled jobs cancel and
///   its session file archives (TS `cancelScheduledJobsForSession`).
/// - `Shutdown` — the child keeps its resume entry: the jobs survive the
///   close (TS `closeKeepsResumeEntry("shutdown")`), so a later scheduled
///   wake can still fire them.
/// - `Replaced` — the replacement teardown keeps the child's plain cron
///   jobs but cancels its RLM heartbeats (TS
///   `cancelSubagentRlmHeartbeats`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildCloseReason {
    Killed,
    Shutdown,
    Replaced,
}

impl ChildCloseReason {
    /// The `rlmCloseReason` rest marker of the kill command the parent
    /// routes to the child worker (the plain client kill carries none and
    /// stays `Killed`).
    fn wire_marker(self) -> Option<&'static str> {
        match self {
            Self::Killed => None,
            Self::Shutdown => Some("shutdown"),
            Self::Replaced => Some("replaced"),
        }
    }
}

/// How long a detached child prompt waits for its spawning parent turn to
/// complete before prompting anyway (a stuck turn must not orphan the
/// child's task; the watcher still settles it).
const TURN_DONE_WAIT_SECS: u64 = 60;

/// Grace between the first idle observation of a child and the settle
/// decision (see the stability re-check in `watch_child_settle`).
const WATCH_SETTLE_GRACE_MS: u64 = 250;
/// Deadline for one child-session create over the link (TS uses 120s).
const CREATE_TIMEOUT_MS: u64 = 120_000;
const PROMPT_TIMEOUT_MS: u64 = 30_000;
const STATE_TIMEOUT_MS: u64 = 30_000;
const KILL_TIMEOUT_MS: u64 = 30_000;
/// Grace over a collect budget passed to the worker `wait_for_idle`.
const IDLE_WAIT_GRACE_MS: u64 = 5_000;
/// Budget for one terminal-notice delivery over the supervisor route.
const NOTICE_DELIVERY_TIMEOUT_MS: u64 = 30_000;
/// Prompts longer than this are not mirrored into create runtime metadata.
const RUNTIME_METADATA_PROMPT_MAX: usize = 4096;
/// One wait slice of the settle watcher: the supervisor's long-poll budget
/// for `wait_for_idle` covers it; longer runs re-slice.
const WATCH_WAIT_SLICE_MS: u64 = 60_000;
/// Re-poll cadence after a wait slice ends without a settled child.
const WATCH_POLL_INTERVAL_MS: u64 = 2_000;
/// Consecutive failed worker polls before settling an unreachable child as
/// errored; roster reads must never attempt their own worker recovery.
const WATCH_MAX_UNREACHABLE_POLLS: u32 = 150;

/// How long a follow-up usage watcher waits for a delivered message to
/// start the child's turn before retiring (a queued delivery the child
/// never picks up attributes nothing).
const FOLLOWUP_START_GRACE_MS: u64 = 30_000;
/// Poll cadence while a follow-up usage watcher waits for the turn to
/// start.
const FOLLOWUP_START_POLL_MS: u64 = 2_000;
/// The parent identity children are spawned from: recursion bounds, the
/// inherited model selector and thinking level, and the parent session's
/// persistence identity.
#[derive(Debug, Clone, Default)]
pub struct ParentIdentity {
    pub rlm_depth: u32,
    pub rlm_max_depth: u32,
    /// Parent model selector (`provider/id`); children inherit it.
    pub model: Option<String>,
    /// Parent working directory; children inherit it.
    pub cwd: Option<String>,
    /// Persisted parent session id (keys the session-artifacts tree).
    pub session_id: Option<String>,
    /// Parent session file path.
    pub session_file: Option<String>,
    /// Default thinking level children inherit.
    pub thinking: Option<String>,
    /// Verification seam: create children with a scripted engine file.
    pub child_script: Option<String>,
}

impl ParentIdentity {
    /// Identity with the default depth bound (TS `resolveRlmMaxDepth`).
    #[must_use]
    pub fn with_default_depth() -> Self {
        Self {
            rlm_max_depth: DEFAULT_RLM_MAX_DEPTH,
            ..Default::default()
        }
    }
}

/// One child's family-addressing identity: the same facts the RLM roster
/// row carries, snapshotted without a worker refresh. The agent-message
/// family view (and only it) reads children through this shape.
#[derive(Debug, Clone)]
pub struct RlmChildIdentity {
    pub rlm_child_id: String,
    pub active_session_id: String,
    pub session_id: Option<String>,
    pub session_name: String,
}

/// One tracked child session.
#[derive(Debug)]
struct ChildRecord {
    rlm_child_id: String,
    session_name: String,
    active_session_id: String,
    session_id: Option<String>,
    session_dir: String,
    label: String,
    started_at_ms: u64,
    /// Terminal state (`done` | `error` | `cancelled`); running while
    /// absent.
    settled_status: Option<&'static str>,
    /// TS `run.settled`: set only by the settle funnel, after the
    /// terminal notice is delivered - the terminal status above flips
    /// earlier (TS's `run.status`/`run.settled` pair), so the quiescence
    /// predicate waits out the notice window.
    settled: bool,
    answer_preview: Option<String>,
    answer_captured: bool,
    /// An agent message from this child reached the parent since its task
    /// was admitted (TS `_parentReplyCount`): the no-reply terminal notice
    /// is withheld once set.
    replied_since_task: bool,
    /// The terminal notice for this child was claimed: exactly one of the
    /// settle watcher, the delete path, or a late natural settle delivers
    /// it (double-claim races collapse here).
    notice_delivered: bool,
    /// The task prompt was admitted (the detached task reached its
    /// `prompt_child` call). Readers must not settle a pre-prompt child:
    /// it is idle with an empty queue by construction, which is exactly
    /// the idle shape a premature settle reads.
    prompt_admitted: bool,
    /// Terminal error text (TS `run.error`): the cancel reason for a
    /// cancelled run, the failure text for a failed one.
    error: Option<String>,
    /// The parent session closed while this child ran (a replacement
    /// teardown or a session close): the settle watcher exits without a
    /// notice — TS closes the child with the parent (`closeChildSessions`)
    /// and no terminal notice is owed to a session that is being torn
    /// down.
    closed_by_parent: bool,
    /// The child's durable session file: the usage walk's source.
    session_file: Option<String>,
    /// Rows of [`ChildRecord::session_file`] already folded into the
    /// parent's attribution rows. The walk resumes here, so repeated
    /// observation never double-bills a child.
    attributed_rows: usize,
    /// A follow-up usage watcher is live for this retained child
    /// (delayed agent messaging after the task run settled).
    usage_watch_live: bool,
    /// A delivery arrived while the follow-up usage watcher was live:
    /// the live watcher observes this delivery's turn too (re-arms at
    /// its settle) instead of a second watcher stacking behind it.
    usage_rearm: bool,
    /// Serializes usage emissions for this child (read, cursor advance,
    /// and sink delivery) without holding the record lock across them.
    emit_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl ChildRecord {
    /// Raw run status: `running` | `done` | `error` | `cancelled`.
    fn status(&self) -> &'static str {
        self.settled_status.unwrap_or("running")
    }

    /// Kernel-roster status: `running` | `completed` | `error` |
    /// `cancelled` (TS keeps a cancelled run's status verbatim in the
    /// registry row).
    fn roster_status(&self) -> &'static str {
        match self.status() {
            "done" => "completed",
            "error" => "error",
            "cancelled" => "cancelled",
            _ => "running",
        }
    }

    fn matches(&self, target: &str) -> bool {
        self.rlm_child_id == target
            || self.active_session_id == target
            || self.session_name == target
            || self.session_id.as_deref() == Some(target)
    }
}

/// A deleted child's retained identity (TS `_deletedRlmChildRuns`
/// tombstone, #2388): the delete receipt promised a collectable cancelled
/// envelope, and only the fields that envelope reads survive the registry
/// removal, so a long-lived parent's deletions stay bounded (TS keeps the
/// label and the last progress note for the same reason).
#[derive(Debug, Clone)]
struct DeletedChild {
    rlm_child_id: String,
    active_session_id: String,
    session_id: Option<String>,
    session_name: String,
    session_dir: String,
    started_at_ms: u64,
    answer_preview: Option<String>,
    /// The envelope's error: the child's own terminal error when one was
    /// recorded, else the delete reason (TS
    /// `_rlmDeletedCollectEntryForRun`: `entry.error ?? "Deleted by parent
    /// orchestrator"`).
    error: String,
}

impl DeletedChild {
    /// The selector set a live record answers to (TS
    /// `_rlmDeletedRunMatchesTarget`): the tombstoned run has no session
    /// object left, so the registry identity stands in for the session
    /// selectors a mid-teardown run still answered to.
    fn matches(&self, target: &str) -> bool {
        self.rlm_child_id == target
            || self.active_session_id == target
            || self.session_name == target
            || self.session_id.as_deref() == Some(target)
    }
}

/// One spawn-name reservation's RAII release: the pending name must free
/// when the admission settles, fails, OR the spawn future is cancelled
/// mid-admission - the boxed [`RlmHostFuture`] is a cancellable future,
/// and a dropped admission that kept its manual release after the last
/// await would reject every later same-name spawn for the host's lifetime
/// (TS releases in every path around `_createRlmSubagentRuntime`).
struct SpawnNameReservationGuard {
    inner: std::sync::Arc<SupervisorChildSessionsInner>,
    name: String,
}

impl Drop for SpawnNameReservationGuard {
    fn drop(&mut self) {
        self.inner.release_spawn_name(&self.name);
    }
}

/// RLM children as supervisor-managed daemon sessions. A cheap shared handle:
/// the daemon hands the same children registry to every kernel handler call.
pub struct SupervisorChildSessions {
    inner: Arc<SupervisorChildSessionsInner>,
}

/// The `delete_subagent` completion hook (the worker wires its
/// context-tree cache invalidation): called once per completed delete
/// with the deleted child's id.
pub type DeleteNotifier = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

struct SupervisorChildSessionsInner {
    link: Arc<SupervisorLink>,
    agent_dir: PathBuf,
    parent_active_session_id: String,
    // The identity lock is only ever a data swap (never held across an
    // await), so a std mutex keeps the setter callable from sync engine
    // paths (the create command) without a runtime `block_on`.
    identity: std::sync::Mutex<ParentIdentity>,
    children: Mutex<Vec<Arc<Mutex<ChildRecord>>>>,
    /// Spawn-name reservations held until admission is durable (TS
    /// `_pendingRlmSubagentSessionNames`, #2396): a requested name is
    /// reserved across the whole admission - from the pre-create
    /// availability check through the child record's registration - so two
    /// parallel same-name spawns cannot both admit. A default name embeds
    /// its fresh child id and never reserves (TS parity).
    pending_spawn_names: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Delete-receipt tombstones (TS `_deletedRlmChildRuns`, #2388): a
    /// deleted child leaves its identity behind the registry so `collect`
    /// can answer a just-deleted selector with the settled cancelled
    /// envelope the delete receipt promised instead of the
    /// unknown-selector error. Keyed by child id exactly like TS's Map -
    /// a second receipt for the same child overwrites the first and can
    /// never stack a duplicate that would turn the settled answer into
    /// the ambiguous-selector error. Entries live until this parent
    /// session's host dies, exactly like TS.
    deleted_children: std::sync::Mutex<std::collections::HashMap<String, DeletedChild>>,
    /// Bumped once per completed parent turn (the worker's `EngineEvent::Done`
    /// boundary). Prompt tasks spawned mid-turn wait for the next bump so
    /// the parent's continuation request is always in flight (and its
    /// response recorded) before the child's first model turn starts — the
    /// deterministic ordering TS gets from its single-threaded event loop.
    turn_done: tokio::sync::watch::Sender<u64>,
    /// The parent engine's child-settle hook (goal continuation resume);
    /// `None` until the engine wires it.
    settle_hook: std::sync::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// The quiescence barrier's wake (TS `waitForRlmQuiescence`,
    /// agent-session.ts): `notify_waiters` fires once per settled child
    /// run - every settle site funnels through the settle hook below -
    /// and once per close walk, so a barrier parked behind descendant
    /// work re-reads the registry when the descendants settle.
    settle_notify: tokio::sync::Notify,
    /// The worker's model-allowlist refusal telemetry (`model refused`):
    /// `spawn/create_session` refusals emit through the engine's shared
    /// lazily-built client.
    model_refusal_telemetry: std::sync::Arc<crate::model_allowlist::ModelRefusalTelemetry>,
    /// The engine's child-usage attribution producer (wired once the
    /// session engine is built; observation emits per-origin batches
    /// into it — the producer owns the target row and the durable
    /// append).
    usage_sink: std::sync::Mutex<Option<std::sync::Arc<dyn RlmChildUsageSink>>>,
    /// The delete notification hook (wired by the worker with its
    /// context-tree cache handle): a deleted child must leave the cached
    /// `/context` children immediately, not ride out the next background
    /// refresh.
    delete_notifier: std::sync::Mutex<Option<DeleteNotifier>>,
}

impl Clone for SupervisorChildSessions {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl SupervisorChildSessions {
    /// Children registry bound to one parent session worker.
    pub fn new(
        link: Arc<SupervisorLink>,
        agent_dir: PathBuf,
        parent_active_session_id: String,
        model_refusal_telemetry: std::sync::Arc<crate::model_allowlist::ModelRefusalTelemetry>,
    ) -> Self {
        Self {
            inner: Arc::new(SupervisorChildSessionsInner {
                link,
                agent_dir,
                parent_active_session_id,
                identity: std::sync::Mutex::new(ParentIdentity::with_default_depth()),
                children: Mutex::new(Vec::new()),
                pending_spawn_names: std::sync::Mutex::new(std::collections::HashSet::new()),
                deleted_children: std::sync::Mutex::new(std::collections::HashMap::new()),
                turn_done: tokio::sync::watch::Sender::new(0),
                settle_hook: std::sync::Mutex::new(None),
                settle_notify: tokio::sync::Notify::new(),
                model_refusal_telemetry,
                usage_sink: std::sync::Mutex::new(None),
                delete_notifier: std::sync::Mutex::new(None),
            }),
        }
    }

    /// Wire the delete notification hook (the worker's context-tree cache
    /// invalidation): called once per completed `delete_subagent` with
    /// the deleted child's id.
    ///
    /// # Panics
    ///
    /// Panics when the delete-notifier mutex is poisoned (a holder
    /// panicked while holding the lock).
    pub fn set_delete_notifier(&self, notifier: DeleteNotifier) {
        *self
            .inner
            .delete_notifier
            .lock()
            .expect("delete notifier lock") = Some(notifier);
    }

    /// The worker saw the parent's turn end: release prompt tasks waiting
    /// on the boundary (called once per `EngineEvent::Done`).
    pub fn notify_turn_done(&self) {
        self.inner.turn_done.send_modify(|value| *value += 1);
    }

    /// Register the child-settle hook (TS
    /// `_maybeResumeGoalContinuationAfterRlmWork`'s settle sites): fired
    /// once per settled child run — the natural settle watcher, the
    /// cancel walk, and the delete path — so a goal continuation owed
    /// behind descendant work re-evaluates when descendants settle.
    ///
    /// # Panics
    ///
    /// Panics when the settle-hook mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub fn set_settle_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.inner.settle_hook.lock().expect("settle hook lock") = Some(hook);
    }

    /// Wire the engine's child-usage attribution producer: the child
    /// observation sites (settle, staleness slices, and the
    /// capture-before-unlink teardown paths) deliver per-origin batches
    /// into this sink (TS `flushPendingChildUsageAttribution`'s Rust
    /// seam — the producer owns the target row and the durable append).
    ///
    /// # Panics
    ///
    /// Panics when the usage-sink mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub fn set_usage_sink(&self, sink: Arc<dyn RlmChildUsageSink>) {
        *self.inner.usage_sink.lock().expect("usage sink lock") = Some(sink);
    }

    /// Whether a spawn-name reservation currently holds `name` (the TS
    /// test peeks `_pendingRlmSubagentSessionNames`; the reservation must
    /// span the whole admission and release at its settle).
    #[cfg(test)]
    pub fn spawn_name_reserved(&self, name: &str) -> bool {
        self.inner
            .pending_spawn_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(name)
    }

    /// The barrier's wake permit (the `settle_notify` field owns the
    /// semantics).
    pub(crate) fn settle_notified(&self) -> tokio::sync::futures::Notified<'_> {
        self.inner.settle_notify.notified()
    }

    /// Whether any tracked child run is still unsettled (TS
    /// `_hasUnsettledRlmQuiescenceWork`'s child-run arm: a run whose
    /// settle funnel has not fired - the terminal status flips before
    /// the terminal notice is delivered, `run.settled` after).
    pub async fn any_running(&self) -> bool {
        let children = self.inner.children.lock().await;
        for record in children.iter() {
            if !record.lock().await.settled {
                return true;
            }
        }
        false
    }

    /// Close every tracked child session with the parent session (TS
    /// `closeChildSessions`, the daemon host's
    /// `disposeRlmSubagentRuntimes` for the replacement teardown, and the
    /// `closeSessionOnce(reason)` cascade every session close runs, with
    /// the parent's own close reason). The ruling: a parent that replaces
    /// or closes its runtime disposes its supervisor-backed children - a
    /// plain stop, not a delete (no `rlmLedgerDelete` marker, so the spawn
    /// edge and the passive roster row survive like TS), no terminal
    /// notice (the parent session is going away), and each child's own
    /// close cascades to its children through the child worker's kill
    /// handler with the same close reason.
    ///
    /// # Errors
    ///
    /// Returns the first close failure after walking every child (a
    /// failed close keeps the child tracked so the caller can retry); a
    /// child whose session is already gone is a completed no-op.
    pub async fn close_children(&self, reason: ChildCloseReason) -> Result<()> {
        self.inner.close_children_inner(reason).await
    }

    /// Replace the parent identity (the worker session sets it once its own
    /// session exists).
    ///
    /// # Panics
    ///
    /// Panics when the identity mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub fn set_identity(&self, identity: ParentIdentity) {
        *self.inner.identity.lock().expect("identity lock") = identity;
    }

    /// The inherited RLM depth bound (TS `getRlmMaxDepthStatus().maxDepth`
    /// before any chat override).
    ///
    /// # Panics
    ///
    /// Panics when the identity mutex is poisoned (a holder panicked
    /// while holding the lock).
    #[must_use]
    pub fn rlm_max_depth(&self) -> u32 {
        self.inner
            .identity
            .lock()
            .expect("identity lock")
            .rlm_max_depth
    }

    /// The parent identity's model selector — the source an inherited
    /// spawn resolves; the engine keeps it in step with every live model
    /// change (the session build stamps it, a switch follows it).
    /// Test-only read: production spawn resolution reads the identity
    /// field directly; this accessor exists so the switch-propagation
    /// regression test can assert the registry's state.
    #[cfg(test)]
    pub(crate) fn parent_model(&self) -> Option<String> {
        self.inner
            .identity
            .lock()
            .expect("identity lock")
            .model
            .clone()
    }

    /// Wire snapshots of the tracked children (TS
    /// `RlmChildAgentSnapshot`, the `get_rlm_children` response and the
    /// context-tree children): the child id, its live identity, label,
    /// run status, elapsed duration, answer preview, and session dir.
    /// `parent_id` (the parent's own RLM node id) is overlaid by the
    /// worker, which owns that identity.
    ///
    /// # Panics
    ///
    /// Panics when the identity mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub async fn child_snapshots(&self) -> Vec<Value> {
        let model = self
            .inner
            .identity
            .lock()
            .expect("identity lock")
            .model
            .clone();
        let children = self.inner.children.lock().await;
        let mut snapshots = Vec::new();
        for record in children.iter() {
            let record = record.lock().await;
            let mut snapshot = json!({
                "id": record.rlm_child_id,
                "activeSessionId": record.active_session_id,
                "sessionName": record.session_name,
                "label": record.label,
                "status": record.status(),
                "durationMs": now_ms().saturating_sub(record.started_at_ms),
                "sessionDir": record.session_dir,
            });
            if let Some(model) = &model {
                snapshot["model"] = json!(model);
            }
            if let Some(answer) = &record.answer_preview {
                snapshot["answerPreview"] = json!(answer);
            }
            snapshots.push(snapshot);
        }
        snapshots
    }

    /// The children registry snapshot behind the `agent_message` family
    /// view: the same registry `rlm.list_subagents` reads (the resident
    /// child set of this parent), without the per-child worker refresh -
    /// addressing never blocks on a status round trip.
    pub async fn child_identities(&self) -> Vec<RlmChildIdentity> {
        let children = self.inner.children.lock().await;
        let mut identities = Vec::with_capacity(children.len());
        for record in children.iter() {
            let record = record.lock().await;
            identities.push(RlmChildIdentity {
                rlm_child_id: record.rlm_child_id.clone(),
                active_session_id: record.active_session_id.clone(),
                session_id: record.session_id.clone(),
                session_name: record.session_name.clone(),
            });
        }
        identities
    }

    /// Re-arm usage observation for one of this session's children after
    /// an agent message was delivered to it (delayed messaging: a
    /// follow-up turn on a settled child; TS keeps the child's
    /// subscription alive, so every completion attributes). No-op for a
    /// target that is not one of this session's children or a child
    /// already under observation.
    pub async fn observe_child_usage(&self, target: &str) {
        let Some(record) = self.inner.find_record(target).await else {
            return;
        };
        SupervisorChildSessionsInner::arm_usage_watch(&self.inner, &record).await;
    }

    /// Record that `child_active_session_id` sent an agent message to this
    /// parent since its task was admitted. The settle watcher reads the
    /// flag before delivering a no-reply terminal notice (TS
    /// `_parentReplyCount`).
    pub async fn mark_replied(&self, child_active_session_id: &str) {
        let children = self.inner.children.lock().await;
        for record in children.iter() {
            let mut record = record.lock().await;
            if record.active_session_id == child_active_session_id {
                record.replied_since_task = true;
                return;
            }
        }
    }

    /// Test seam: settle a pushed child record (the passivation-gate
    /// tests exercise a registry that holds only settled children).
    #[cfg(test)]
    pub(crate) async fn settle_test_child(&self, child_active_session_id: &str) {
        let children = self.inner.children.lock().await;
        for record in children.iter() {
            let mut record = record.lock().await;
            if record.active_session_id == child_active_session_id {
                record.settled_status = Some("done");
                // The settle funnel's flag (`fire_settle_hook`): the
                // quiescence predicate reads it, not the terminal status.
                record.settled = true;
            }
        }
    }

    /// Test seam: admit one child record without the supervisor round trip
    /// (the controller tests exercise the family join on registry state).
    #[cfg(test)]
    pub(crate) async fn push_test_child(&self, identity: RlmChildIdentity) {
        self.inner
            .children
            .lock()
            .await
            .push(Arc::new(Mutex::new(ChildRecord {
                rlm_child_id: identity.rlm_child_id,
                session_name: identity.session_name,
                active_session_id: identity.active_session_id,
                session_id: identity.session_id,
                session_dir: String::new(),
                label: String::new(),
                started_at_ms: 0,
                settled_status: None,
                settled: false,
                answer_preview: None,
                answer_captured: false,
                replied_since_task: false,
                notice_delivered: false,
                prompt_admitted: true,
                error: None,
                closed_by_parent: false,
                session_file: None,
                attributed_rows: 0,
                usage_watch_live: false,
                usage_rearm: false,
                emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            })));
    }

    /// Set only the inherited model selector (the engine resolves its model
    /// when it builds the session, after the create command arrived).
    ///
    /// # Panics
    ///
    /// Panics when the identity mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub fn set_model(&self, model: String) {
        self.inner.identity.lock().expect("identity lock").model = Some(model);
    }

    /// Set the session's RLM depth bound (TS `setRlmMaxDepth`): the
    /// registry is the bound every spawn checks, so the override is the
    /// live limit children respect immediately.
    ///
    /// # Panics
    ///
    /// Panics when the identity mutex is poisoned (a holder panicked
    /// while holding the lock).
    pub fn set_rlm_max_depth(&self, max_depth: u32) {
        self.inner
            .identity
            .lock()
            .expect("identity lock")
            .rlm_max_depth = max_depth;
    }

    /// Cancel one live child run by id (TS `cancelRlmChildRun`): abort the
    /// child worker's in-flight turn and claim its terminal notice (the
    /// no-reply notice is suppressed, exactly the TS
    /// `run.suppressTerminalNotice` path). Returns whether a live run was
    /// cancelled; an unknown or already-settled child id answers `false`.
    pub async fn cancel_child_run(&self, child_id: &str) -> bool {
        self.inner.cancel_child_run(child_id).await
    }

    /// Delete one inactive child by id (TS `deleteInactiveRlmSubagent`):
    /// `"running"` when the child still has work in flight (the caller
    /// answers the wire `reason: "running"` refusal), `"deleted"` once the
    /// child is torn down with its ledger tombstone, `"not_found"` for an
    /// unknown id. A teardown failure surfaces as `Err` (the TS delete
    /// throws through the wire arm).
    ///
    /// # Errors
    ///
    /// Returns an error when the child teardown fails (the kill of the
    /// child worker times out or errors), which the TS delete throws
    /// through the wire arm.
    pub async fn delete_inactive_subagent(&self, child_id: &str) -> Result<&'static str> {
        self.inner.delete_inactive_subagent(child_id).await
    }

    fn entry(record: &ChildRecord) -> RlmSubagentEntry {
        let running = record.settled_status.is_none();
        RlmSubagentEntry {
            rlm_child_id: record.rlm_child_id.clone(),
            active_session_id: Some(record.active_session_id.clone()),
            session_id: record.session_id.clone(),
            session_name: record.session_name.clone(),
            session_dir: record.session_dir.clone(),
            status: record.roster_status(),
            // Live tool introspection across worker processes is a follow-up;
            // a running child reports `executing`.
            activity: running.then_some(RlmSubagentActivity {
                kind: "executing",
                tool_name: None,
            }),
            tool_use_count: None,
            duration_ms: Some(now_ms().saturating_sub(record.started_at_ms)),
            answer_preview: record.answer_preview.clone(),
            replied_since_task: None,
            progress_note: None,
            label: (!record.label.is_empty()).then(|| record.label.clone()),
            last_activity_at: Some(record.started_at_ms),
            activity_stale_ms: None,
        }
    }

    fn collect_result(record: &ChildRecord) -> RlmChildResult {
        RlmChildResult {
            rlm_child_id: record.rlm_child_id.clone(),
            session_name: Some(record.session_name.clone()),
            session_dir: Some(record.session_dir.clone()),
            status: record.status(),
            settled: record.settled_status.is_some(),
            answer_preview: record.answer_preview.clone(),
            error: record.error.clone(),
            duration_ms: Some(now_ms().saturating_sub(record.started_at_ms)),
            tool_use_count: None,
            replied_since_task: None,
        }
    }

    /// TS `_rlmDeletedCollectEntryForRun`: the envelope for a target whose
    /// delete receipt already returned. The delete accepted the
    /// cancellation, so the entry reports it as a settled answer instead
    /// of a snapshot that invites re-polling.
    fn deleted_collect_result(deleted: &DeletedChild) -> RlmChildResult {
        RlmChildResult {
            rlm_child_id: deleted.rlm_child_id.clone(),
            session_name: Some(deleted.session_name.clone()),
            session_dir: Some(deleted.session_dir.clone()),
            status: "cancelled",
            settled: true,
            answer_preview: deleted.answer_preview.clone(),
            error: Some(deleted.error.clone()),
            duration_ms: Some(now_ms().saturating_sub(deleted.started_at_ms)),
            tool_use_count: None,
            replied_since_task: None,
        }
    }
}

impl SupervisorChildSessionsInner {
    /// Fire the settle hook off-thread (the settle sites run inside
    /// watcher tasks; the hook owns its own scheduling). The funnel is
    /// the one definition of a settled run (TS's run task `finally`): it
    /// marks the record settled and wakes the quiescence barrier, only
    /// after the terminal notice is delivered.
    pub(crate) async fn fire_settle_hook(&self, record: &Arc<Mutex<ChildRecord>>) {
        record.lock().await.settled = true;
        self.settle_notify.notify_waiters();
        let hook = self
            .settle_hook
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(hook) = hook {
            std::thread::spawn(move || hook());
        }
    }
    /// Wait for the parent turn that spawned a task to complete (generation
    /// strictly greater than the one captured at spawn admission). Bounded:
    /// a turn that never settles releases the child anyway.
    pub async fn wait_turn_done(&self, generation: u64) {
        let mut receiver = self.turn_done.subscribe();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(TURN_DONE_WAIT_SECS),
            receiver.wait_for(|value| *value > generation),
        )
        .await;
    }

    /// Send one daemon command over the supervisor link and return its
    /// response data. The link owns timeouts/reconnects; this only maps the
    /// command to its wire value.
    async fn command(&self, command: &DaemonCommand, timeout_ms: u64) -> Result<Value> {
        let wire = serde_json::to_value(command).context("serialize supervisor link command")?;
        self.link
            .request_success(wire, Duration::from_millis(timeout_ms))
            .await
    }

    /// A child session name conflicts when any retained or live child of
    /// this parent already holds it (the parent-side half of the TS
    /// `_assertRlmSubagentSessionNameAvailable` check; the supervisor's
    /// create assertion is the daemon-wide half).
    async fn assert_name_available(&self, name: &str, depth: u32) -> Result<()> {
        let children = self.children.lock().await;
        for record in children.iter() {
            if record.lock().await.session_name == name {
                return Err(spawn_name_unavailable(name, depth));
            }
        }
        Ok(())
    }

    /// Reserve a requested spawn name (TS `_startRlmChildRun` holds it
    /// until admission settles, #2396): `false` when another admission of
    /// this parent session already holds the name, so the racing spawn
    /// fails closed before any create reaches the supervisor.
    fn reserve_spawn_name(&self, name: &str) -> bool {
        self.pending_spawn_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(name.to_string())
    }

    /// Release one spawn-name reservation: the admission settled (the
    /// record's registration made the name durable, so it transfers from
    /// the pending reservation to the live registry) or failed (the name
    /// is free for the next spawn).
    fn release_spawn_name(&self, name: &str) {
        self.pending_spawn_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(name);
    }

    /// The per-child session directory under the parent's artifacts tree
    /// (TS `_createChildRlmSessionDir`); the child session persists inside it.
    fn child_session_dir(&self, child_id: &str, identity: &ParentIdentity) -> Result<PathBuf> {
        let base = match &identity.session_id {
            Some(session_id) => self
                .agent_dir
                .join("session-artifacts")
                .join(session_id)
                .join(child_id),
            // No persistent parent artifacts dir: an ephemeral temp dir, the
            // TS `_createEphemeralRlmSessionDir` fallback.
            None => std::env::temp_dir().join(format!("prime-agent-rlm-{child_id}")),
        };
        std::fs::create_dir_all(&base)
            .with_context(|| format!("create RLM child session dir {}", base.display()))?;
        Ok(base)
    }
}

/// The spawn-name-unavailability error (TS
/// `formatAgentSessionNameUnavailable`): one source so the reservation
/// refusal and the availability check stay byte-identical.
fn spawn_name_unavailable(name: &str, depth: u32) -> anyhow::Error {
    anyhow!(
        "Agent name \"{name}\" is unavailable: an agent of that name already exists at depth {depth} under this parent"
    )
}

mod host;
mod lifecycle;
mod registry;
mod usage;

#[cfg(test)]
mod watch_tests;

#[cfg(test)]
mod usage_emit_tests;

/// TS #2396: the spawn-name reservation spans the whole admission. A
/// gated fake supervisor parks each `create` until the test answers, so
/// the reservation's lifecycle is observable: held across the parked
/// admission, closed to a racing same-name spawn, and freed at the
/// admission settle - success or failure.
#[cfg(test)]
mod spawn_name_reservation_tests;
