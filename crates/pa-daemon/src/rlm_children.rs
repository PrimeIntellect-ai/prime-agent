//! Supervisor-backed RLM child sessions: the daemon's [`RlmSubagentHost`]
//! seam. `rlm.spawn`/`rlm.create_session` create real daemon sessions and
//! keep the parent-side roster the kernel reads. Unlike TS, each child runs
//! in its own supervised worker process; the kernel surface stays TS parity.

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
    create_rlm_child_failure_message, create_rlm_child_terminal_notice, RlmChildTerminalNotice,
};
use pa_core::session_engine::rlm_usage::{RlmChildUsageReport, RlmChildUsageSink};
use pa_types::daemon::{DaemonCommand, DaemonSessionLifecycle, PromptInput};
use pa_types::session::CustomMessage;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::rlm_child_model::{
    assert_thinking_supported, cap_text, compact_rlm_text, resolve_child_model, rlm_child_label,
    ANSWER_TEXT_MAX_CHARS,
};
use crate::supervisor_link::SupervisorLink;
use crate::util::now_ms;

pub const DEFAULT_RLM_MAX_DEPTH: u32 = 2;

/// Close reasons: `Killed` — jobs cancel, the session file archives;
/// `Shutdown` — the resume entry survives, so a later scheduled wake can
/// fire the jobs; `Replaced` — cron jobs survive, RLM heartbeats cancel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildCloseReason {
    Killed,
    Shutdown,
    Replaced,
}

impl ChildCloseReason {
    /// The `rlmCloseReason` rest marker routed to the child worker; the
    /// plain client kill carries none and stays `Killed`.
    fn wire_marker(self) -> Option<&'static str> {
        match self {
            Self::Killed => None,
            Self::Shutdown => Some("shutdown"),
            Self::Replaced => Some("replaced"),
        }
    }
}

/// How long a detached child prompt waits for its spawning parent turn
/// before prompting anyway; a stuck turn must not orphan the child's task.
const TURN_DONE_WAIT_SECS: u64 = 60;

/// Grace between the first idle observation and the settle decision.
const WATCH_SETTLE_GRACE_MS: u64 = 250;
const CREATE_TIMEOUT_MS: u64 = 120_000;
const PROMPT_TIMEOUT_MS: u64 = 30_000;
const STATE_TIMEOUT_MS: u64 = 30_000;
const KILL_TIMEOUT_MS: u64 = 30_000;
/// Budget for one session rename over the supervisor route (TS uses 30s).
const RENAME_TIMEOUT_MS: u64 = 30_000;
/// Grace over a collect budget passed to the worker `wait_for_idle`.
const IDLE_WAIT_GRACE_MS: u64 = 5_000;
const NOTICE_DELIVERY_TIMEOUT_MS: u64 = 30_000;
/// Prompts longer than this are not mirrored into create runtime metadata.
const RUNTIME_METADATA_PROMPT_MAX: usize = 4096;
/// One wait slice of the settle watcher; longer runs re-slice.
const WATCH_WAIT_SLICE_MS: u64 = 60_000;
const WATCH_POLL_INTERVAL_MS: u64 = 2_000;
/// Failed worker polls before settling an unreachable child as errored;
/// roster reads never run their own worker recovery.
const WATCH_MAX_UNREACHABLE_POLLS: u32 = 150;

/// How long a follow-up usage watcher waits for the child's turn to start
/// before retiring; an unpicked delivery attributes nothing.
const FOLLOWUP_START_GRACE_MS: u64 = 30_000;
const FOLLOWUP_START_POLL_MS: u64 = 2_000;
#[derive(Debug, Clone, Default)]
pub struct ParentIdentity {
    pub rlm_depth: u32,
    pub rlm_max_depth: u32,
    /// Parent model selector (`provider/id`); children inherit it.
    pub model: Option<String>,
    pub cwd: Option<String>,
    /// Persisted parent session id (keys the session-artifacts tree).
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub thinking: Option<String>,
    /// Verification seam: create children with a scripted engine file.
    pub child_script: Option<String>,
}

impl ParentIdentity {
    #[must_use]
    pub fn with_default_depth() -> Self {
        Self {
            rlm_max_depth: DEFAULT_RLM_MAX_DEPTH,
            ..Default::default()
        }
    }
}

/// One child's family-addressing identity, snapshotted without a worker
/// refresh; only the agent-message family view reads children through this shape.
#[derive(Debug, Clone)]
pub struct RlmChildIdentity {
    pub rlm_child_id: String,
    pub active_session_id: String,
    pub session_id: Option<String>,
    pub session_name: String,
}

/// The selector that reaches a child whether or not its worker is
/// resident: the persisted session id (the session-file stem the
/// supervisor's ledger wake resolves), else the RLM child id. The
/// spawn-time live id stops resolving once the worker passivates.
pub(crate) fn durable_child_selector(session_id: Option<&str>, rlm_child_id: &str) -> String {
    session_id.unwrap_or(rlm_child_id).to_string()
}

/// One tracked child session.
#[derive(Debug)]
struct ChildRecord {
    rlm_child_id: String,
    session_name: String,
    active_session_id: String,
    session_id: Option<String>,
    session_dir: String,
    model: String,
    label: String,
    started_at_ms: u64,
    /// Terminal state (`done` | `error` | `cancelled`); running while absent.
    settled_status: Option<&'static str>,
    /// Set only by the settle funnel, after the terminal notice is delivered; the
    /// terminal status flips earlier, so the quiescence predicate waits out the
    /// notice window.
    settled: bool,
    answer_preview: Option<String>,
    /// The full final-answer text (bounded by
    /// [`ANSWER_TEXT_MAX_CHARS`]), the collect envelope's binding lane:
    /// a consumer that extracts outputs (the factory's ports) needs the
    /// whole fenced JSON, while the roster rows keep the compact preview.
    answer_text: Option<String>,
    answer_captured: bool,
    /// A child agent message arrived since its task was admitted; the
    /// no-reply terminal notice is withheld once set.
    replied_since_task: bool,
    /// The terminal notice was claimed: exactly one of the settle watcher,
    /// the delete path, or a late natural settle delivers it.
    notice_delivered: bool,
    /// The task prompt was admitted; never settle a pre-prompt child (it
    /// is idle with an empty queue by construction).
    prompt_admitted: bool,
    /// Terminal error text: the cancel reason for a cancelled run, the
    /// failure text for a failed one.
    error: Option<String>,
    /// The parent session closed while this child ran: the settle watcher
    /// exits without a notice — none is owed to a session being torn down.
    closed_by_parent: bool,
    /// The child's durable session file: the usage walk's source.
    session_file: Option<String>,
    /// Rows of [`ChildRecord::session_file`] already folded into the
    /// parent's attribution rows. The walk resumes here, so repeated
    /// observation never double-bills a child. `None` on a reseeded row:
    /// nothing has been observed since the reseed, and the first delivery
    /// primes the cursor at the file's tail.
    attributed_rows: Option<usize>,
    /// A follow-up usage watcher is live for this retained child
    /// (delayed agent messaging after the task run settled).
    usage_watch_live: bool,
    /// A delivery arrived while the follow-up watcher was live: it re-arms
    /// at its settle instead of stacking a second watcher.
    usage_rearm: bool,
    /// Serializes usage emissions for this child without holding the record lock across them.
    emit_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    last_emitted_status: Option<&'static str>,
    /// Serializes parent-directed rename and delete for this child.
    rename_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}

impl ChildRecord {
    /// Raw run status: `running` | `done` | `error` | `cancelled`.
    fn status(&self) -> &'static str {
        self.settled_status.unwrap_or("running")
    }

    fn snapshot_value(&self) -> Value {
        let mut snapshot = json!({
            "id": self.rlm_child_id,
            "activeSessionId": self.active_session_id,
            "sessionName": self.session_name,
            "label": self.label,
            "status": self.status(),
            "durationMs": now_ms().saturating_sub(self.started_at_ms),
            "sessionDir": self.session_dir,
        });
        if !self.model.is_empty() {
            snapshot["model"] = json!(self.model);
        }
        if let Some(answer) = &self.answer_preview {
            snapshot["answerPreview"] = json!(answer);
        }
        if let Some(error) = &self.error {
            snapshot["error"] = json!(error);
        }
        snapshot
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
        self.matches_id(target) || self.session_name == target
    }

    /// The id selectors (the rename target resolution): every field a
    /// child handle or full session id can carry — never the name.
    fn matches_id(&self, target: &str) -> bool {
        self.rlm_child_id == target
            || self.active_session_id == target
            || self.session_id.as_deref() == Some(target)
    }
}

/// Whether any record's settle funnel has not fired yet.
async fn any_unsettled(children: &[Arc<Mutex<ChildRecord>>]) -> bool {
    for record in children {
        if !record.lock().await.settled {
            return true;
        }
    }
    false
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
    /// The roster status the row carried at its delete (the idempotent
    /// re-delete receipt reports it verbatim, so a repeated retire reads
    /// the same verdict as the first).
    status: &'static str,
    answer_preview: Option<String>,
    /// The envelope's error: the child's own terminal error when one was
    /// recorded, else the delete reason.
    error: String,
}

impl DeletedChild {
    /// The registry identity stands in for the session selectors a
    /// mid-teardown run still answered to (no session object is left).
    fn matches(&self, target: &str) -> bool {
        self.rlm_child_id == target
            || self.active_session_id == target
            || self.session_name == target
            || self.session_id.as_deref() == Some(target)
    }
}

/// RAII release of a spawn-name reservation: the name frees on settle,
/// failure, and cancellation of the admission future alike.
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

/// The `delete_subagent` completion hook (context-tree cache
/// invalidation): once per completed delete with the deleted child's id.
pub type DeleteNotifier = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

pub(crate) type ChildUpdateSink = std::sync::Arc<dyn Fn(Value) + Send + Sync>;

struct SupervisorChildSessionsInner {
    link: Arc<SupervisorLink>,
    agent_dir: PathBuf,
    parent_active_session_id: String,
    /// The parent session's live name (the worker's summary, the TS
    /// `sessionName` of every spawn row's `from` endpoint): `None` until
    /// the worker publishes a summary, and refreshed by every rename.
    parent_session_name: std::sync::Mutex<Option<String>>,
    // Std mutex: the identity lock is only a data swap, never held across
    // an await, so sync engine paths can set it without a runtime `block_on`.
    identity: std::sync::Mutex<ParentIdentity>,
    children: Mutex<Vec<Arc<Mutex<ChildRecord>>>>,
    /// Spawn-name reservations held until admission is durable, so
    /// parallel same-name spawns cannot both admit (default names never reserve).
    pending_spawn_names: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Delete-receipt tombstones: a deleted child's identity stays behind
    /// the registry so `collect` answers a just-deleted selector.
    deleted_children: std::sync::Mutex<std::collections::HashMap<String, DeletedChild>>,
    /// Bumped once per completed parent turn: mid-turn prompt tasks wait for the next bump (the
    /// continuation is in flight before the child's first model turn).
    turn_done: tokio::sync::watch::Sender<u64>,
    /// The parent engine's child-settle hook (goal continuation resume).
    settle_hook: std::sync::Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// Whether any tracked child run is unsettled (the `any_running`
    /// verdict, re-read at every registry change): a sync read for the
    /// worker's session summary, and a change feed the worker turns into
    /// roster pushes.
    running: tokio::sync::watch::Sender<bool>,
    /// The quiescence barrier's wake (TS `waitForRlmQuiescence`,
    /// agent-session.ts): `notify_waiters` fires once per settled child
    /// run - every settle site funnels through the settle hook below -
    /// and once per close walk, so a barrier parked behind descendant
    /// work re-reads the registry when the descendants settle.
    settle_notify: tokio::sync::Notify,
    /// The model-allowlist refusal telemetry: `spawn`/`create_session`
    /// refusals emit through the engine's shared lazily-built client.
    model_refusal_telemetry: std::sync::Arc<crate::model_allowlist::ModelRefusalTelemetry>,
    /// The engine's child-usage attribution producer; it owns the target
    /// row and the durable append.
    usage_sink: std::sync::Mutex<Option<std::sync::Arc<dyn RlmChildUsageSink>>>,
    /// The delete notification hook: a deleted child must leave the cached
    /// `/context` children immediately, not wait for the next refresh.
    delete_notifier: std::sync::Mutex<Option<DeleteNotifier>>,
    child_update_sink: std::sync::Mutex<Option<ChildUpdateSink>>,
    /// The parent session's semantic-edge recorder (wired once the session
    /// engine is built; the settle watcher records a returned child's last
    /// committed request into it). `None` until the build or for sessions
    /// without a semantic identity.
    semantic_edges: std::sync::Mutex<
        Option<std::sync::Arc<pa_core::session_engine::semantic_edges::SemanticEdgeRecorder>>,
    >,
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
                parent_session_name: std::sync::Mutex::new(None),
                identity: std::sync::Mutex::new(ParentIdentity::with_default_depth()),
                children: Mutex::new(Vec::new()),
                pending_spawn_names: std::sync::Mutex::new(std::collections::HashSet::new()),
                deleted_children: std::sync::Mutex::new(std::collections::HashMap::new()),
                turn_done: tokio::sync::watch::Sender::new(0),
                settle_hook: std::sync::Mutex::new(None),
                running: tokio::sync::watch::Sender::new(false),
                settle_notify: tokio::sync::Notify::new(),
                model_refusal_telemetry,
                usage_sink: std::sync::Mutex::new(None),
                delete_notifier: std::sync::Mutex::new(None),
                child_update_sink: std::sync::Mutex::new(None),
                semantic_edges: std::sync::Mutex::new(None),
            }),
        }
    }

    /// Wire the delete notification hook (context-tree cache invalidation).
    ///
    /// # Panics
    ///
    /// Panics when the delete-notifier mutex is poisoned.
    pub fn set_delete_notifier(&self, notifier: DeleteNotifier) {
        *self
            .inner
            .delete_notifier
            .lock()
            .expect("delete notifier lock") = Some(notifier);
    }

    pub(crate) fn set_child_update_sink(&self, sink: ChildUpdateSink) {
        *self
            .inner
            .child_update_sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sink);
    }

    /// The worker saw the parent's turn end: release prompt tasks waiting
    /// on the boundary (called once per `EngineEvent::Done`).
    pub fn notify_turn_done(&self) {
        self.inner.turn_done.send_modify(|value| *value += 1);
    }

    /// Register the child-settle hook: fired once per settled child run
    /// so an owed goal continuation re-evaluates.
    ///
    /// # Panics
    ///
    /// Panics when the settle-hook mutex is poisoned.
    pub fn set_settle_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.inner.settle_hook.lock().expect("settle hook lock") = Some(hook);
    }

    /// Wire the engine's child-usage attribution producer.
    ///
    /// # Panics
    ///
    /// Panics when the usage-sink mutex is poisoned.
    pub fn set_usage_sink(&self, sink: Arc<dyn RlmChildUsageSink>) {
        *self.inner.usage_sink.lock().expect("usage sink lock") = Some(sink);
    }

    /// Wire the parent session's semantic-edge recorder (the per-build
    /// handoff beside the usage sink): the settle watcher records a
    /// returned child's last committed request into it.
    ///
    /// # Panics
    ///
    /// Panics when the semantic-edges mutex is poisoned.
    pub fn set_semantic_edges(
        &self,
        recorder: Option<
            std::sync::Arc<pa_core::session_engine::semantic_edges::SemanticEdgeRecorder>,
        >,
    ) {
        *self
            .inner
            .semantic_edges
            .lock()
            .expect("semantic edges lock") = recorder;
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

    /// The barrier's wake permit (semantics on the `settle_notify` field).
    pub(crate) fn settle_notified(&self) -> tokio::sync::futures::Notified<'_> {
        self.inner.settle_notify.notified()
    }

    /// Whether any tracked child run is still unsettled (one whose settle funnel has
    /// not fired).
    pub async fn any_running(&self) -> bool {
        self.inner.any_running().await
    }

    /// The last [`Self::any_running`] verdict, without awaiting the
    /// registry: the session summary counts this session as working
    /// while any of its children still runs.
    #[must_use]
    pub fn has_running_children(&self) -> bool {
        *self.inner.running.borrow()
    }

    /// A feed that changes whenever [`Self::has_running_children`] flips.
    #[must_use]
    pub fn subscribe_running(&self) -> tokio::sync::watch::Receiver<bool> {
        self.inner.running.subscribe()
    }

    /// Close every tracked child session with the parent (TS
    /// `closeChildSessions`): a plain stop, not a delete; no terminal notice.
    ///
    /// # Errors
    ///
    /// Returns the first close failure after walking every child (kept tracked for retry).
    pub async fn close_children(&self, reason: ChildCloseReason) -> Result<()> {
        self.inner.close_children_inner(reason).await
    }

    /// Replace the parent identity (set once the worker session exists).
    ///
    /// # Panics
    ///
    /// Panics when the identity mutex is poisoned.
    pub fn set_identity(&self, identity: ParentIdentity) {
        *self.inner.identity.lock().expect("identity lock") = identity;
    }

    /// Replace the parent session's live name (the worker's summary — the
    /// `sessionName` of the spawn kickoff's `from` endpoint); `None` when
    /// the summary carries none.
    ///
    /// # Panics
    ///
    /// Panics when the name mutex is poisoned (a holder panicked while
    /// holding the lock).
    pub fn set_parent_session_name(&self, name: Option<String>) {
        *self
            .inner
            .parent_session_name
            .lock()
            .expect("parent session name lock") = name;
    }

    /// Rebuild the children registry from the spawn ledger (a restarted
    /// parent lists its ledger children again).
    pub async fn reseed_from_ledger(&self) {
        self.inner.reseed_from_ledger().await;
    }

    /// The inherited RLM depth bound (TS `getRlmMaxDepthStatus().maxDepth`
    /// before any chat override).
    ///
    /// # Panics
    ///
    /// Panics when the identity mutex is poisoned.
    #[must_use]
    pub fn rlm_max_depth(&self) -> u32 {
        self.inner
            .identity
            .lock()
            .expect("identity lock")
            .rlm_max_depth
    }

    /// Test-only read of the identity's model selector (for the regression test).
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
    pub async fn child_snapshots(&self) -> Vec<Value> {
        let children = self.inner.children.lock().await;
        let mut snapshots = Vec::new();
        for record in children.iter() {
            let record = record.lock().await;
            snapshots.push(record.snapshot_value());
        }
        snapshots
    }

    /// Registry snapshot for the `agent_message` family view: no
    /// per-child worker refresh, so addressing never blocks.
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

    /// Re-arm usage observation for a child after an agent message was
    /// delivered to it; no-op for non-children or already-observed targets.
    pub async fn observe_child_usage(&self, target: &str) {
        let Some(record) = self.inner.find_record(target).await else {
            return;
        };
        SupervisorChildSessionsInner::arm_usage_watch(&self.inner, &record).await;
    }

    /// Record that this child replied since its task was admitted; the
    /// settle watcher reads the flag before a no-reply notice.
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

    /// Test seam: settle a pushed child record (the gate tests need a settled-only
    /// registry).
    #[cfg(test)]
    pub(crate) async fn settle_test_child(&self, child_active_session_id: &str) {
        let children = self.inner.children.lock().await;
        for record in children.iter() {
            let mut record = record.lock().await;
            if record.active_session_id == child_active_session_id {
                record.settled_status = Some("done");
                // The settle funnel's flag: the quiescence predicate reads it, not
                // the terminal status.
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
                model: String::new(),
                label: String::new(),
                started_at_ms: 0,
                settled_status: None,
                settled: false,
                answer_preview: None,
                answer_text: None,
                answer_captured: false,
                replied_since_task: false,
                notice_delivered: false,
                prompt_admitted: true,
                error: None,
                closed_by_parent: false,
                session_file: None,
                attributed_rows: Some(0),
                usage_watch_live: false,
                usage_rearm: false,
                emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
                last_emitted_status: None,
                rename_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            })));
    }

    /// Set only the inherited model selector (the engine resolves its
    /// model when it builds the session).
    ///
    /// # Panics
    ///
    /// Panics when the identity mutex is poisoned.
    pub fn set_model(&self, model: String) {
        self.inner.identity.lock().expect("identity lock").model = Some(model);
    }

    /// Set the session's RLM depth bound: the registry is the bound every
    /// spawn checks, so children respect it immediately.
    ///
    /// # Panics
    ///
    /// Panics when the identity mutex is poisoned.
    pub fn set_rlm_max_depth(&self, max_depth: u32) {
        self.inner
            .identity
            .lock()
            .expect("identity lock")
            .rlm_max_depth = max_depth;
    }

    /// Cancel one live child run: abort the worker's in-flight turn and
    /// claim the terminal notice. `false` for an unknown or settled id.
    pub async fn cancel_child_run(&self, child_id: &str) -> bool {
        self.inner.cancel_child_run(child_id).await
    }

    /// Delete one inactive child by id: `"running"` while work is in flight,
    /// `"deleted"` once torn down, `"not_found"` for an unknown id.
    ///
    /// # Errors
    ///
    /// Returns an error when the child teardown fails (the kill times out or errors).
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
            answer_text: record.answer_text.clone(),
            error: record.error.clone(),
            duration_ms: Some(now_ms().saturating_sub(record.started_at_ms)),
            tool_use_count: None,
            replied_since_task: None,
        }
    }

    /// The envelope for a target whose delete receipt already returned:
    /// a settled answer, not a snapshot that invites re-polling.
    fn deleted_collect_result(deleted: &DeletedChild) -> RlmChildResult {
        RlmChildResult {
            rlm_child_id: deleted.rlm_child_id.clone(),
            session_name: Some(deleted.session_name.clone()),
            session_dir: Some(deleted.session_dir.clone()),
            status: "cancelled",
            settled: true,
            answer_preview: deleted.answer_preview.clone(),
            answer_text: None,
            error: Some(deleted.error.clone()),
            duration_ms: Some(now_ms().saturating_sub(deleted.started_at_ms)),
            tool_use_count: None,
            replied_since_task: None,
        }
    }
}

impl SupervisorChildSessionsInner {
    /// Fire the settle hook off-thread (the settle sites run inside
    /// watcher tasks; the hook owns its own scheduling). The funnel marks
    /// the record settled and wakes the barrier only after the terminal
    /// notice is delivered.
    pub(crate) async fn fire_settle_hook(&self, record: &Arc<Mutex<ChildRecord>>) {
        record.lock().await.settled = true;
        self.refresh_running().await;
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

    /// Whether any tracked child run's settle funnel has not fired yet.
    pub(crate) async fn any_running(&self) -> bool {
        let children = self.children.lock().await;
        any_unsettled(&children).await
    }

    /// Re-read [`Self::any_running`] into the `running` feed after a
    /// registry change (a registration, a settle, a close walk). The read
    /// and the publish share one hold of the children lock, so racing
    /// refreshes publish in order and the last one always reflects the
    /// registry after every change that preceded it.
    pub(crate) async fn refresh_running(&self) {
        let children = self.children.lock().await;
        let running = any_unsettled(&children).await;
        self.running.send_if_modified(|current| {
            let changed = *current != running;
            *current = running;
            changed
        });
    }

    pub(crate) async fn emit_child_update(&self, record: &Arc<Mutex<ChildRecord>>) {
        let sink = self
            .child_update_sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let Some(sink) = sink else {
            return;
        };
        let row = {
            let mut record = record.lock().await;
            let status = record.status();
            if record.last_emitted_status == Some(status) {
                return;
            }
            record.last_emitted_status = Some(status);
            record.snapshot_value()
        };
        sink(row);
    }

    pub(crate) async fn emit_child_removal(&self, record: &Arc<Mutex<ChildRecord>>) {
        let sink = self
            .child_update_sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let Some(sink) = sink else {
            return;
        };
        let row = {
            let record = record.lock().await;
            json!({
                "id": record.rlm_child_id,
                "activeSessionId": record.active_session_id,
                "sessionName": record.session_name,
                "label": record.session_name,
                "status": "cancelled",
                "sessionDir": record.session_dir,
                "error": "Deleted by parent orchestrator",
            })
        };
        sink(row);
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

    /// Send one daemon command over the link; the link owns timeouts/reconnects.
    async fn command(&self, command: &DaemonCommand, timeout_ms: u64) -> Result<Value> {
        let wire = serde_json::to_value(command).context("serialize supervisor link command")?;
        self.link
            .request_success(wire, Duration::from_millis(timeout_ms))
            .await
    }

    /// A name conflicts when any retained or live child already holds it
    /// (the parent-side half of the check).
    async fn assert_name_available(&self, name: &str, depth: u32) -> Result<()> {
        let children = self.children.lock().await;
        for record in children.iter() {
            if record.lock().await.session_name == name {
                return Err(spawn_name_unavailable(name, depth));
            }
        }
        Ok(())
    }

    /// Reserve a requested spawn name: `false` when another admission already holds it.
    fn reserve_spawn_name(&self, name: &str) -> bool {
        self.pending_spawn_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(name.to_string())
    }

    /// Release one spawn-name reservation: the registration made the
    /// name durable, or the admission failed and the name is free again.
    fn release_spawn_name(&self, name: &str) {
        self.pending_spawn_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(name);
    }

    /// The per-child session directory under the parent's artifacts tree.
    fn child_session_dir(&self, child_id: &str, identity: &ParentIdentity) -> Result<PathBuf> {
        let base = match &identity.session_id {
            Some(session_id) => self
                .agent_dir
                .join("session-artifacts")
                .join(session_id)
                .join(child_id),
            // No persistent parent artifacts dir: an ephemeral temp dir.
            None => std::env::temp_dir().join(format!("prime-agent-rlm-{child_id}")),
        };
        std::fs::create_dir_all(&base)
            .with_context(|| format!("create RLM child session dir {}", base.display()))?;
        Ok(base)
    }
}

/// One source so the reservation refusal and the availability check stay byte-identical.
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

/// A gated fake supervisor parks each `create` until the test answers,
/// so the reservation's lifecycle is observable.
#[cfg(test)]
mod spawn_name_reservation_tests;
