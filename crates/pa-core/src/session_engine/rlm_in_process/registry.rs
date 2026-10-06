//! The per-child record: run state, roster/collect projections, the
//! deleted-child tombstone, and the roster text helpers — the in-process
//! equivalent of the daemon host's `ChildRecord` (same wire semantics,
//! live child introspection instead of worker round trips).

use pa_types::ai::Usage;
use pa_types::session::ChildUsageOrigin;
use std::sync::{Arc, Weak};
use tokio::sync::{watch, Mutex};

use super::InProcessRlmHost;
use crate::session_engine::engine::SessionEngine;
use crate::session_engine::rlm_host::{RlmChildResult, RlmSubagentActivity, RlmSubagentEntry};

/// Cap on the answer preview handed to the parent model (TS
/// `compactRlmText`).
pub(crate) const ANSWER_PREVIEW_MAX_CHARS: usize = 160;
/// Cap on the one-line task label shown in kernel rosters.
pub(crate) const LABEL_MAX_CHARS: usize = 200;
/// A running child with no tracked activity for this long reports
/// `activity_stale_ms` (TS `RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS`).
pub(crate) const STALE_ACTIVITY_THRESHOLD_MS: u64 = 10 * 60_000;
const ELLIPSIS: &str = "...";

/// One resident child identity for the family roster join.
#[derive(Debug, Clone)]
pub struct ChildIdentity {
    pub rlm_child_id: String,
    pub session_id: String,
    pub session_name: String,
}

/// The kind of terminal notice one record may owe its parent — and the
/// settled verdict that agrees with it (the claim fixes both).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NoticeKind {
    Done,
    DoneReplied,
    Error,
    Cancelled,
    Closed,
    ParentGone,
}

/// The live child activity (TS `RlmChildRun.activity`): `waiting` while a
/// run streams without tools, `writing` while an assistant message
/// streams, `executing` while tools run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChildActivity {
    pub kind: &'static str,
    pub tool_name: Option<String>,
}

/// One tracked in-process child: the engine (the runtime, retained until
/// delete or close), the child's own children host (grandchildren spawn
/// through it), and the mutable run state.
pub struct InProcessChildRecord {
    pub(crate) rlm_child_id: String,
    /// The child's display name: the admission name until `rlm.rename`
    /// updates it (the durable session_info row is the source of truth;
    /// this copy feeds the roster rows).
    pub(crate) session_name: std::sync::RwLock<String>,
    /// The child session's durable id: its roster identity and the
    /// agent-message selector family members address it by.
    pub(crate) session_id: String,
    pub(crate) session_dir: String,
    pub(crate) label: String,
    pub(crate) started_at_ms: u64,
    /// The child session engine — the in-process runtime itself.
    pub(crate) engine: Arc<SessionEngine>,
    /// Immutable parent generation; a rebind must not redirect this notice.
    pub(crate) parent_engine: Weak<SessionEngine>,
    pub(crate) parent_session_id: String,
    /// The child's own children host (its recursive descendants).
    pub(crate) child_host: Arc<InProcessRlmHost>,
    /// The settle signal `collect` waits on.
    pub(crate) settled_tx: watch::Sender<bool>,
    /// A parked claim has exhausted its bounded retry burst; waiters may
    /// return a diagnostic without changing its verdict.
    parked_tx: watch::Sender<bool>,
    /// The closed signal the run task races its task prompt against: a
    /// delete or close mid-run (including before the prompt registers)
    /// tears the task down within one slice instead of letting a closed
    /// record start or keep a turn.
    pub(crate) closed_tx: watch::Sender<bool>,
    /// Abort the child task promptly without closing the winning notice
    /// admission before its durable+live transaction completes.
    pub(crate) task_cancel_tx: watch::Sender<bool>,
    state: Mutex<ChildRunState>,
    /// Serializes a sparse retry attempt with a generation close.
    pub(crate) notice_retry_gate: Mutex<()>,
}

/// The mutable run state (the daemon `ChildRecord`'s mutable half, plus
/// the live introspection the in-process host can afford). No `Debug`:
/// the retained agent subscription has no debug form.
// The mirrored TS API shape is deliberate (the booleans are the product's
// own surface, not a refactor target).
#[allow(clippy::struct_excessive_bools)]
pub(crate) struct ChildRunState {
    /// Terminal state (`done` | `error` | `cancelled`); running while
    /// absent.
    pub(crate) settled_status: Option<&'static str>,
    pub(crate) answer_preview: Option<String>,
    pub(crate) error: Option<String>,
    /// An agent message from this child reached the parent since its task
    /// was admitted (TS `_parentReplyCount`): the no-reply terminal notice
    /// is withheld once set.
    pub(crate) replied_since_task: bool,
    /// Explicit replies awaiting their own strict durable admission.
    pub(crate) pending_replies: Vec<pa_types::session::CustomMessage>,
    /// The terminal-notice claim: single ownership of the notice AND the
    /// settled verdict that must agree with it. `None` until claimed;
    /// once taken, every later claimant defers to the holder. `Closed` and
    /// `ParentGone` owe no notice.
    pub(crate) notice: Option<NoticeKind>,
    /// Admission errors are visible on the live roster/collect while the
    /// first-wins claim remains pending for retry.
    pub(crate) admission_error: Option<String>,
    pub(crate) parked: bool,
    /// Once close owns this generation, a parked claim may not reactivate.
    pub(crate) generation_frozen: bool,
    /// The task prompt was admitted. Readers must not settle a pre-prompt
    /// child: it is idle by construction.
    pub(crate) prompt_admitted: bool,
    /// The parent session closed while this child ran: the run arm owes no
    /// notice and the watcher stops.
    pub(crate) closed_by_parent: bool,
    pub(crate) tool_use_count: u64,
    /// Concurrent tool executions (activity flips back to `waiting` at 0).
    pub(crate) running_tools: u32,
    pub(crate) activity: Option<ChildActivity>,
    /// Wall-clock ms of the last tracked activity; seeded at admission.
    pub(crate) last_activity_at_ms: u64,
    /// Pending per-origin usage batches (TS `pendingChildUsage`), flushed
    /// at child run ends and at settlement.
    pub(crate) pending_usage: Vec<(ChildUsageOrigin, Usage)>,
    /// The child agent event subscription (`Agent::subscribe` keeps the
    /// listener until it is explicitly removed — TS semantics). Taken and
    /// unsubscribed at the run task's end and on delete/close, so the
    /// record (and the engine, and the kernel) release once the registry
    /// drops them instead of leaking through the agent's listener list.
    pub(crate) listener: Option<pa_agent::agent::Subscription>,
}

impl InProcessChildRecord {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        rlm_child_id: String,
        session_name: String,
        session_id: String,
        session_dir: String,
        label: String,
        started_at_ms: u64,
        engine: Arc<SessionEngine>,
        parent_engine: Weak<SessionEngine>,
        parent_session_id: String,
        child_host: Arc<InProcessRlmHost>,
    ) -> Self {
        let (settled_tx, _) = watch::channel(false);
        let (parked_tx, _) = watch::channel(false);
        let (closed_tx, _) = watch::channel(false);
        let (task_cancel_tx, _) = watch::channel(false);
        Self {
            rlm_child_id,
            session_name: std::sync::RwLock::new(session_name),
            session_id,
            session_dir,
            label,
            started_at_ms,
            engine,
            parent_engine,
            parent_session_id,
            child_host,
            settled_tx,
            parked_tx,
            closed_tx,
            task_cancel_tx,
            notice_retry_gate: Mutex::new(()),
            state: Mutex::new(ChildRunState {
                settled_status: None,
                answer_preview: None,
                error: None,
                replied_since_task: false,
                pending_replies: Vec::new(),
                notice: None,
                admission_error: None,
                parked: false,
                generation_frozen: false,
                prompt_admitted: false,
                closed_by_parent: false,
                tool_use_count: 0,
                running_tools: 0,
                activity: Some(ChildActivity {
                    kind: "waiting",
                    tool_name: None,
                }),
                last_activity_at_ms: started_at_ms,
                pending_usage: Vec::new(),
                listener: None,
            }),
        }
    }

    /// The child's display name (the admission name until `rlm.rename`).
    ///
    /// # Panics
    ///
    /// Panics when the session-name lock is poisoned.
    pub(crate) fn session_name(&self) -> String {
        self.session_name.read().expect("session name lock").clone()
    }

    /// Apply a rename (TS `rlm.rename`): the roster rows read the new
    /// name from the next read.
    ///
    /// # Panics
    ///
    /// Panics when the session-name lock is poisoned.
    pub(crate) fn set_session_name(&self, name: String) {
        *self.session_name.write().expect("session name lock") = name;
    }

    /// The mutable run state (the record's identity half is immutable).
    pub(crate) async fn state(&self) -> tokio::sync::MutexGuard<'_, ChildRunState> {
        self.state.lock().await
    }

    /// Raw run status: `running` | `done` | `error` | `cancelled`.
    fn status(state: &ChildRunState) -> &'static str {
        state.settled_status.unwrap_or("running")
    }

    /// Kernel-roster status: `running` | `completed` | `error` |
    /// `cancelled` (TS keeps a cancelled run's status verbatim).
    fn roster_status(state: &ChildRunState) -> &'static str {
        match Self::status(state) {
            "done" => "completed",
            other => other,
        }
    }

    /// Whether the run is still unsettled.
    pub(crate) async fn is_running(&self) -> bool {
        self.state().await.settled_status.is_none()
    }

    /// Wake `collect` waiters: the terminal verdict, accounting, and
    /// notice admission have all landed.
    pub(crate) fn publish_settled(&self) {
        let _ = self.settled_tx.send(true);
    }

    /// Mark the record closed by its parent (delete or close) and wake the
    /// closed watch so the run task stops racing its prompt against a
    /// record that no longer belongs to the registry.
    pub(crate) async fn request_task_cancel(&self) {
        self.state().await.closed_by_parent = true;
        self.task_cancel_tx.send_replace(true);
    }

    pub(crate) async fn mark_closed(&self) {
        self.request_task_cancel().await;
        self.closed_tx.send_replace(true);
    }

    /// Whether the record was closed by its parent (a cheap flag read for
    /// the settle loop's ticks; the watch is the prompt race's wake).
    pub(crate) async fn is_closed(&self) -> bool {
        self.state().await.closed_by_parent
    }

    /// Take and unsubscribe the child event listener (idempotent). The
    /// agent's listener list is the last edge that keeps this record
    /// (and its engine, and its kernel) alive after the registry drops
    /// it.
    pub(crate) async fn unsubscribe_listener(&self) {
        if let Some(listener) = self.state().await.listener.take() {
            listener.unsubscribe().await;
        }
    }

    /// The first claim fixes both the terminal verdict and notice obligation.
    pub(crate) async fn claim_notice(&self, kind: NoticeKind) -> bool {
        let mut state = self.state().await;
        if state.notice.is_some() {
            return false;
        }
        state.notice = Some(kind);
        true
    }

    /// Resolve the reply check in the same critical section as the Done claim.
    pub(crate) async fn claim_done(&self) -> bool {
        let mut state = self.state().await;
        if state.notice.is_some() {
            return false;
        }
        state.notice = Some(if state.replied_since_task {
            NoticeKind::DoneReplied
        } else {
            NoticeKind::Done
        });
        true
    }

    pub(crate) async fn claimed_kind(&self) -> Option<NoticeKind> {
        self.state().await.notice
    }

    pub(crate) async fn begin_reply(&self, row: pa_types::session::CustomMessage) {
        let mut state = self.state().await;
        state.replied_since_task = true;
        state.pending_replies.push(row);
    }

    pub(crate) async fn reply_admitted(&self, id: &str) {
        let mut state = self.state().await;
        state.pending_replies.retain(|row| {
            row.details
                .as_ref()
                .and_then(|details| details.get("id"))
                .and_then(serde_json::Value::as_str)
                != Some(id)
        });
    }

    pub(crate) async fn admission_failed(&self, error: &anyhow::Error) {
        let diagnostic = format!("Terminal notice admission pending: {error}");
        tracing::error!(child_id = %self.rlm_child_id, "{diagnostic}");
        self.state().await.admission_error = Some(diagnostic);
    }

    /// Publish only a matching committed claim. `DoneReplied` returns false
    /// while any explicit reply is still awaiting strict admission.
    pub(crate) async fn publish_verdict(&self, kind: NoticeKind, error: Option<String>) -> bool {
        let mut state = self.state().await;
        assert_eq!(
            state.notice,
            Some(kind),
            "only the terminal claimant publishes"
        );
        if state.settled_status.is_some() {
            return true;
        }
        if kind == NoticeKind::DoneReplied && !state.pending_replies.is_empty() {
            return false;
        }
        state.settled_status = Some(match kind {
            NoticeKind::Done | NoticeKind::DoneReplied => "done",
            NoticeKind::Error => "error",
            NoticeKind::Cancelled | NoticeKind::Closed | NoticeKind::ParentGone => "cancelled",
        });
        state.error = error;
        state.admission_error = None;
        state.parked = false;
        state.activity = None;
        drop(state);
        self.parked_tx.send_replace(false);
        self.publish_settled();
        true
    }

    /// Wait for the winning claim to become public; there is no artificial
    /// deadline that can change the terminal verdict.
    /// Wait for the winning transaction to commit OR report a parked
    /// admission failure. Returning false never changes its claim/verdict.
    pub(crate) async fn await_settled_or_parked(&self) -> bool {
        let mut settled = self.settled_tx.subscribe();
        let mut parked = self.parked_tx.subscribe();
        loop {
            let state = self.state().await;
            if state.settled_status.is_some() {
                return true;
            }
            if state.parked {
                return false;
            }
            drop(state);
            tokio::select! {
                changed = settled.changed() => {
                    if changed.is_err() { return false; }
                }
                changed = parked.changed() => {
                    if changed.is_err() { return false; }
                }
            }
        }
    }

    pub(crate) async fn mark_parked(&self) {
        self.state().await.parked = true;
        self.parked_tx.send_replace(true);
    }

    pub(crate) async fn clear_parked(&self) -> bool {
        let mut state = self.state().await;
        if state.generation_frozen {
            return false;
        }
        state.parked = false;
        drop(state);
        self.parked_tx.send_replace(false);
        true
    }

    /// The closer cannot act on a stale park: wait through a live retry,
    /// then freeze the actual parked/committed state before descendants run.
    pub(crate) async fn freeze_for_close(&self) -> bool {
        loop {
            self.await_settled_or_parked().await;
            let _gate = self.notice_retry_gate.lock().await;
            let mut state = self.state().await;
            if state.settled_status.is_none() && !state.parked {
                continue;
            }
            let parked = state.parked;
            state.generation_frozen = true;
            state.closed_by_parent = true;
            drop(state);
            self.task_cancel_tx.send_replace(true);
            self.closed_tx.send_replace(true);
            return parked;
        }
    }

    pub(crate) async fn parked_error(&self) -> Option<String> {
        self.state().await.admission_error.clone()
    }

    /// The roster row (live introspection: real activity, tool counts, the
    /// child's latest progress note, and staleness).
    pub(crate) async fn entry(&self, now_ms: u64) -> RlmSubagentEntry {
        let state = self.state().await;
        let running = state.settled_status.is_none();
        let progress_note = self
            .engine
            .rlm
            .notes
            .latest_note()
            .await
            .map(|(note, _)| note);
        let activity_stale_ms = running
            .then(|| {
                let stale_candidate = state
                    .activity
                    .as_ref()
                    .is_none_or(|activity| activity.kind != "executing");
                stale_candidate.then(|| now_ms.saturating_sub(state.last_activity_at_ms))
            })
            .flatten()
            .filter(|stale| *stale >= STALE_ACTIVITY_THRESHOLD_MS);
        RlmSubagentEntry {
            rlm_child_id: self.rlm_child_id.clone(),
            active_session_id: Some(self.session_id.clone()),
            session_id: Some(self.session_id.clone()),
            session_name: self.session_name(),
            session_dir: self.session_dir.clone(),
            status: Self::roster_status(&state),
            activity: running.then(|| RlmSubagentActivity {
                kind: state
                    .activity
                    .as_ref()
                    .map_or("waiting", |activity| activity.kind),
                tool_name: state
                    .activity
                    .as_ref()
                    .and_then(|activity| activity.tool_name.clone()),
            }),
            tool_use_count: Some(state.tool_use_count),
            duration_ms: Some(now_ms.saturating_sub(self.started_at_ms)),
            answer_preview: state.answer_preview.clone(),
            replied_since_task: Some(state.replied_since_task),
            progress_note,
            label: (!self.label.is_empty()).then(|| self.label.clone()),
            last_activity_at: Some(state.last_activity_at_ms),
            activity_stale_ms,
        }
    }

    /// One collect envelope.
    pub(crate) async fn collect_result(&self, now_ms: u64) -> RlmChildResult {
        let state = self.state().await;
        RlmChildResult {
            rlm_child_id: self.rlm_child_id.clone(),
            session_name: Some(self.session_name()),
            session_dir: Some(self.session_dir.clone()),
            status: Self::status(&state),
            settled: state.settled_status.is_some(),
            answer_preview: state.answer_preview.clone(),
            error: state
                .error
                .clone()
                .or_else(|| state.admission_error.clone()),
            duration_ms: Some(now_ms.saturating_sub(self.started_at_ms)),
            tool_use_count: Some(state.tool_use_count),
            replied_since_task: Some(state.replied_since_task),
        }
    }
}

/// A deleted child's retained identity (TS `_deletedRlmChildRuns`): the
/// delete receipt promised a collectable cancelled envelope, and only the
/// fields that envelope reads survive the registry removal.
#[derive(Debug, Clone)]
pub(crate) struct DeletedChild {
    pub rlm_child_id: String,
    pub session_id: String,
    pub session_name: String,
    pub session_dir: String,
    pub started_at_ms: u64,
    pub answer_preview: Option<String>,
    pub error: String,
}

impl DeletedChild {
    /// The selector set a live record answered to (TS
    /// `_rlmDeletedRunMatchesTarget`).
    pub(crate) fn matches(&self, target: &str) -> bool {
        self.rlm_child_id == target || self.session_id == target || self.session_name == target
    }

    /// The settled cancelled envelope (TS `_rlmDeletedCollectEntryForRun`).
    pub(crate) fn collect_result(&self) -> RlmChildResult {
        RlmChildResult {
            rlm_child_id: self.rlm_child_id.clone(),
            session_name: Some(self.session_name.clone()),
            session_dir: Some(self.session_dir.clone()),
            status: "cancelled",
            settled: true,
            answer_preview: self.answer_preview.clone(),
            error: Some(self.error.clone()),
            duration_ms: Some(super::now_ms().saturating_sub(self.started_at_ms)),
            tool_use_count: None,
            replied_since_task: None,
        }
    }
}

/// Whether a live record answers to `target`: child id, session id, or
/// name (the TS selector set).
pub(crate) fn record_matches(record: &InProcessChildRecord, target: &str) -> bool {
    record.rlm_child_id == target || record.session_id == target || record.session_name() == target
}

/// Collapse whitespace and cap at the roster limit (TS `compactRlmText`).
#[must_use]
pub(crate) fn compact_rlm_text(text: &str) -> String {
    let compact: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    cap_text(&compact, ANSWER_PREVIEW_MAX_CHARS)
}

/// One-line task label: collapsed prompt, capped for roster rows (TS
/// `rlmChildLabel`).
#[must_use]
pub(crate) fn rlm_child_label(prompt: &str) -> String {
    let collapsed: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let collapsed = if collapsed.is_empty() {
        "child agent".to_string()
    } else {
        collapsed
    };
    cap_text(&collapsed, LABEL_MAX_CHARS)
}

/// Whitespace-collapsed text capped at `max` chars with an ellipsis.
fn cap_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max - ELLIPSIS.len()).collect();
    format!("{}{}", kept.trim_end(), ELLIPSIS)
}

/// Registry mutation over the host's state: the tombstone and
/// spawn-name operations the host's own spawn/delete paths drive (the
/// daemon keeps the same split in its `rlm_children/registry.rs`).
impl super::InProcessRlmHost {
    /// Record a delete receipt's tombstone (TS #2388): the cancelled
    /// collect envelope reads only these fields, so the retained identity
    /// stays bounded.
    pub(crate) async fn remember_deleted_child(&self, record: &InProcessChildRecord) {
        let (error, answer_preview) = {
            let state = record.state().await;
            (state.error.clone(), state.answer_preview.clone())
        };
        let deleted = DeletedChild {
            rlm_child_id: record.rlm_child_id.clone(),
            session_id: record.session_id.clone(),
            session_name: record.session_name(),
            session_dir: record.session_dir.clone(),
            started_at_ms: record.started_at_ms,
            answer_preview,
            error: error.unwrap_or_else(|| "Deleted by parent orchestrator".to_string()),
        };
        self.inner
            .deleted_children
            .lock()
            .expect("deleted children lock")
            .insert(deleted.rlm_child_id.clone(), deleted);
    }

    /// The delete tombstones matching one selector (the collect path's
    /// just-deleted envelopes).
    pub(crate) fn deleted_children_matching(&self, target: &str) -> Vec<DeletedChild> {
        self.inner
            .deleted_children
            .lock()
            .expect("deleted children lock")
            .values()
            .filter(|deleted| deleted.matches(target))
            .cloned()
            .collect()
    }

    /// Reserve a requested spawn name (TS #2396): `false` when another
    /// admission of this parent session already holds it, so a racing
    /// spawn fails closed before any engine build.
    pub(crate) fn reserve_spawn_name(&self, name: &str) -> bool {
        self.inner
            .pending_spawn_names
            .lock()
            .expect("spawn name lock")
            .insert(name.to_string())
    }

    /// Release one spawn-name reservation (the admission settled or
    /// failed).
    pub(crate) fn release_spawn_name(&self, name: &str) {
        self.inner
            .pending_spawn_names
            .lock()
            .expect("spawn name lock")
            .remove(name);
    }

    /// Whether a requested spawn name is currently reserved (the TS test
    /// peek).
    ///
    /// # Panics
    ///
    /// Panics when the spawn-name lock is poisoned.
    #[must_use]
    pub fn spawn_name_reserved(&self, name: &str) -> bool {
        self.inner
            .pending_spawn_names
            .lock()
            .expect("spawn name lock")
            .contains(name)
    }

    /// A child session name conflicts when any retained or live child of
    /// this parent already holds it (the TS
    /// `_assertRlmSubagentSessionNameAvailable` parent-side half).
    pub(crate) async fn assert_name_available(&self, name: &str, depth: u32) -> anyhow::Result<()> {
        let children = self.children().await;
        for record in &children {
            if record.session_name() == name {
                anyhow::bail!(spawn_name_unavailable(name, depth));
            }
        }
        Ok(())
    }
}

/// The spawn-name-unavailability error (TS
/// `formatAgentSessionNameUnavailable`): one source so the reservation
/// refusal and the availability check stay byte-identical.
pub(crate) fn spawn_name_unavailable(name: &str, depth: u32) -> String {
    format!("Agent name \"{name}\" is unavailable: an agent of that name already exists at depth {depth} under this parent")
}
