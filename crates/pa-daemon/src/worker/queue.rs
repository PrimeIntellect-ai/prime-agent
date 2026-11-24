//! Queued input: the item model, the lanes, admission, delivery batching,
//! and queue recovery.
use super::inbox_wake_row::{delivered_notice_text, notice_text, shown_items};
use super::{
    emit_worker_event_with, json, oneshot, Arc, Duration, EventPump, Mutex, Result, SessionCore,
    Value, VecDeque, WorkerRecoveryJournal, AGENT_MESSAGE_SOURCE, AUTONOMOUS_QUEUE_KEY,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Steering,
    FollowUp,
}

impl Lane {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Lane::Steering => "steering",
            Lane::FollowUp => "follow_up",
        }
    }
}

/// How long the close paths (`shutdown`, `kill`) wait for aborted side
/// question runs to queue their terminal cancelled events: headroom, not a gate.
pub(crate) const SIDE_QUESTION_SETTLE_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) const QUEUED_INPUT_SUSPENDED: &str =
    "Cannot admit a session action while queued session input is suspended.";

/// The item's turn-execution class: items co-deliver as one batched turn only
/// within the same class; the direct-prompt hand-off never joins a batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnPolicy {
    Queued,
    Injected,
    Direct,
}

impl TurnPolicy {
    /// The journal record's string form (`worker.recovery` queue
    /// snapshots); the restore maps it back through the same names.
    pub(crate) fn journal_value(self) -> &'static str {
        match self {
            TurnPolicy::Queued => "queued",
            TurnPolicy::Injected => "injected",
            TurnPolicy::Direct => "direct",
        }
    }
}

/// The turn-execution class restored from a wire `restore_actions` payload;
/// an absent or unknown policy restores as the queued class.
pub(crate) fn restored_turn_policy(payload: &Value) -> TurnPolicy {
    let timing = payload
        .get("executionPolicy")
        .and_then(|policy| policy.get("nextTurnContextTiming"))
        .and_then(Value::as_str);
    match timing {
        Some("preparation") => TurnPolicy::Direct,
        _ => TurnPolicy::Queued,
    }
}

/// The wire text of an aborted turn's settle (the `turn_end` error frame and
/// the waiting prompt's failure): aborted before an assistant message.
pub(crate) const ABORTED_TURN_SETTLE_ERROR: &str = "No response produced.";

/// The wire text of a prompt cancelled before delivery (the
/// queue-invisible abort path).
pub(crate) const PROMPT_ABORTED_BEFORE_DELIVERY: &str = "Prompt aborted before delivery.";

/// The wire text of a queued prompt deleted through a queue mutation (TS
/// `QueuedMessageError` verbatim).
pub(crate) const QUEUED_PROMPT_DELETED: &str = "Queued prompt was deleted before delivery.";

/// The typed settle of one queued prompt: the variants classify the
/// settle without reading the (provider-controllable) error text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TurnSettle {
    Completed,
    Aborted,
    /// The prompt was withdrawn before delivery; the text is the
    /// wire-facing reason.
    Withdrawn(String),
    /// The turn settled with an error; the text surfaces to the waiting
    /// caller.
    Failed(String),
}

impl TurnSettle {
    /// The wire-facing failure text of the settle (`None` when the
    /// settle is a success).
    pub(crate) fn wire_error(&self) -> Option<String> {
        match self {
            TurnSettle::Completed => None,
            TurnSettle::Aborted => Some(ABORTED_TURN_SETTLE_ERROR.to_string()),
            TurnSettle::Withdrawn(text) | TurnSettle::Failed(text) => Some(text.clone()),
        }
    }
}

/// Priority is applied only at admission. Existing lane positions (including user
/// moves and restored snapshots) remain authoritative until another item arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueuePriority {
    Human,
    Pinned,
    #[serde(other)]
    Background,
}

impl QueuePriority {
    fn rank(self) -> u8 {
        match self {
            Self::Background => 0,
            Self::Human => 1,
            Self::Pinned => 2,
        }
    }
}

/// Priority insertion: walk back only across a lower-priority suffix. Never
/// re-sort a lane (moves and restored order can cross; equal priorities stay FIFO).
pub(crate) fn enqueue_priority(lane: &mut VecDeque<QueuedItem>, item: QueuedItem) {
    let mut index = lane.len();
    while index > 0 && lane[index - 1].priority.rank() < item.priority.rank() {
        index -= 1;
    }
    lane.insert(index, item);
}

#[derive(Debug)]
pub(crate) struct QueuedItem {
    pub(crate) message: String,
    pub(crate) priority: QueuePriority,
    /// The labeled queue-strip row (the snapshot and the active-action
    /// label read it); the turn's prompt text stays `message`.
    pub(crate) preview: Option<String>,
    /// An injected custom row that replaces this turn's user message (the
    /// RLM child terminal notices ride the follow-up lane this way).
    pub(crate) custom_message: Option<Value>,
    /// The original agent-message text when this item came from an
    /// `agent_message` delivery (the markers remove queued items by).
    pub(crate) agent_message: Option<String>,
    /// The scheduler's queue key: a later fire replaces the queued
    /// item with the same key instead of stacking.
    pub(crate) queue_key: Option<String>,
    /// The prompt-admission id (the `cancel_prompt_admission`
    /// bookkeeping); `None` when it carried none.
    pub(crate) admission_id: Option<String>,
    /// Images attached to the prompt (wire `images`: base64 plus mime
    /// type).
    pub(crate) images: Vec<pa_agent::types::ImageContent>,
    pub(crate) done: Option<oneshot::Sender<TurnSettle>>,
    /// The item shows in the queue projection and projects the active-action
    /// phases; injected continuations and a direct prompt admission stay invisible.
    pub(crate) queue_visible: bool,
    /// The item's turn-execution class (see [`TurnPolicy`]): the batch
    /// gathering's compatibility gate.
    pub(crate) policy: TurnPolicy,
    /// Membership of the one-shot forced steering batch: armed items co-deliver as
    /// one batched turn even under "one-at-a-time". Never journaled.
    pub(crate) forced_batch: bool,
}

/// Parse the wire `images` array: entries without payload data or a
/// mime type are dropped, not failed — the text still admits.
pub(crate) fn parse_prompt_images(payload: &Value) -> Vec<pa_agent::types::ImageContent> {
    let Some(images) = payload.get("images").and_then(Value::as_array) else {
        return Vec::new();
    };
    images
        .iter()
        .filter_map(|image| {
            if image.get("type").and_then(Value::as_str) != Some("image") {
                return None;
            }
            let data = image.get("data").and_then(Value::as_str)?;
            let mime_type = image.get("mimeType").and_then(Value::as_str)?;
            Some(pa_agent::types::ImageContent {
                data: data.to_string(),
                mime_type: mime_type.to_string(),
            })
        })
        .collect()
}

/// The pending queue lanes of a session (journal persistence payload): the
/// full parked rows, so recovery restores a queued heartbeat's component.
pub(crate) struct QueueLanes {
    pub(crate) steering: Vec<crate::journal::WorkerQueueItemRecord>,
    pub(crate) follow_up: Vec<crate::journal::WorkerQueueItemRecord>,
}

/// The wire `customMessage` of a prompt/follow-up command: an injected custom
/// row that replaces the turn's user row. `Err` rejects loudly — a malformed
/// notice must not degrade into a plain prompt.
pub(crate) fn parse_custom_message(value: Option<&Value>) -> Result<Option<Value>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let invalid = "Invalid customMessage: expected a custom message object with a customType";
    let Some(object) = value.as_object() else {
        return Err(invalid.to_string());
    };
    if object.get("role").and_then(Value::as_str) != Some("custom") {
        return Err(invalid.to_string());
    }
    let custom_type = object
        .get("customType")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty());
    if custom_type.is_none() {
        return Err(invalid.to_string());
    }
    Ok(Some(value.clone()))
}

/// One queue-lane recovery checkpoint: the verdict and the persisted
/// snapshot come from one locked read (no stale verdict).
#[derive(Clone, Copy)]
pub(crate) enum QueueCheckpoint {
    /// The lanes hold admitted live work: `busy = true`.
    Admitted { operation: &'static str },
    /// The verdict follows the lanes (`busy = lanes remain queued`); mutations
    /// with no TS record use it too, so the journal keeps no stale verdict.
    Settle { operation: &'static str },
}

/// Clear a withdrawn run's note before publishing an idle, empty queue.
/// Call while holding the core lock; summary readers take core then note too.
pub(crate) fn clear_withdrawn_progress_note(
    core: &SessionCore,
    engine: &dyn crate::engine::SessionEngine,
) {
    if !core.busy && core.steering.is_empty() && core.follow_up.is_empty() {
        engine.clear_progress_note();
    }
}

/// Write one queue-lane recovery checkpoint: under the recovery lock (then
/// the core lock) the lanes and the busy verdict record from the same read.
pub(crate) fn checkpoint_queue_recovery(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core_lock: &std::sync::Mutex<SessionCore>,
    checkpoint: QueueCheckpoint,
) {
    let mut guard = recovery.lock().unwrap();
    let Some(journal) = guard.as_mut() else {
        return;
    };
    // The lanes are read under the recovery lock (a microsecond core hold —
    // never across the journal's fsyncs): no persist interleaves this read.
    let (active_session_id, session_id, session_file, lanes, turn_in_flight, suspended) = {
        let core = core_lock.lock().unwrap();
        (
            core.active_session_id.clone(),
            core.store
                .as_ref()
                .map(|s| s.session_id().to_string())
                .unwrap_or_default(),
            core.store
                .as_ref()
                .map(|s| s.path.to_string_lossy().to_string()),
            queue_lanes(&core),
            core.busy,
            core.queued_input_suspended,
        )
    };
    let (busy, operation) = match checkpoint {
        QueueCheckpoint::Admitted { operation } => (true, operation),
        // A settled verdict never comes from the lanes alone: a withdrawal landing
        // mid-turn must not flip the journal to idle while the turn still streams,
        // or a crash in that window parks live work.
        QueueCheckpoint::Settle { operation } => (
            turn_in_flight || !lanes.steering.is_empty() || !lanes.follow_up.is_empty(),
            operation,
        ),
    };
    // The verdict never publishes over a snapshot that did not
    // persist: the pair rides ONE durable append.
    let _ = journal.record_queue_checkpoint(
        &active_session_id,
        &session_id,
        session_file.as_deref(),
        busy,
        operation,
        &lanes.steering,
        &lanes.follow_up,
        suspended,
    );
}

pub(crate) fn queue_lanes(core: &SessionCore) -> QueueLanes {
    fn items(lane: &VecDeque<QueuedItem>) -> Vec<crate::journal::WorkerQueueItemRecord> {
        lane.iter()
            .map(|item| crate::journal::WorkerQueueItemRecord {
                message: item.message.clone(),
                priority: Some(item.priority),
                preview: item.preview.clone(),
                custom_message: item.custom_message.clone(),
                queue_key: item.queue_key.clone(),
                queue_visible: item.queue_visible,
                policy: item.policy.journal_value().to_string(),
                forced_batch: item.forced_batch,
                images: item.images.clone(),
            })
            .collect()
    }
    QueueLanes {
        steering: items(&core.steering),
        follow_up: items(&core.follow_up),
    }
}

/// The lane's front item anchors the delivery; under queue mode "all" — or
/// the forced steering batch — the same-class prefix behind it joins as
/// co-delivered rows of ONE turn. A non-batchable front delivers solo
/// (an inbox custom row among them: `TurnPrompt::Injected` carries no
/// batch, so the notice takes its own turn — the sanctioned solo delivery).
pub(crate) fn gather_delivery_batch(core: &mut SessionCore, lane: Lane) -> Vec<QueuedItem> {
    let (items, mode) = match lane {
        Lane::Steering => (&mut core.steering, core.steering_mode.as_str()),
        Lane::FollowUp => (&mut core.follow_up, core.follow_up_mode.as_str()),
    };
    let Some(first) = items.front() else {
        return Vec::new();
    };
    // Only a real pickup starts a new delivery. Empty or parked lanes retain
    // the prior delivery's cancellation and successful completion facts.
    core.turn_cancelled = false;
    core.turn_completed = false;
    // The armed set forces "all" only when the front item is armed; an un-armed
    // front disarms the batch once no armed item remains queued.
    let forced = lane == Lane::Steering && core.forced_all_steering && first.forced_batch;
    let mut batch = Vec::new();
    if lane == Lane::Steering
        && core.forced_all_steering
        && !forced
        && !items.iter().any(|item| item.forced_batch)
    {
        core.forced_all_steering = false;
    }
    if first.custom_message.is_some()
        || first.policy == TurnPolicy::Direct
        || crate::session_commands::parse_prompt_session_command(&first.message).is_some()
    {
        batch.push(items.pop_front().expect("front checked"));
        return batch;
    }
    let first_policy = first.policy;
    batch.push(items.pop_front().expect("front checked"));
    if forced || mode == "all" {
        while let Some(next) = items.front() {
            if next.policy != first_policy
                || next.custom_message.is_some()
                || (forced && !next.forced_batch)
                || crate::session_commands::parse_prompt_session_command(&next.message).is_some()
            {
                break;
            }
            batch.push(items.pop_front().expect("front checked"));
        }
    }
    batch
}

/// Queue snapshot restore from the worker recovery journal (crash/respawn
/// recovery): the latest persisted lanes for this session.
pub(crate) fn restore_queue_snapshot(
    journal: &WorkerRecoveryJournal,
    active_session_id: &str,
) -> (VecDeque<QueuedItem>, VecDeque<QueuedItem>, bool) {
    fn pending(lanes: Vec<crate::journal::WorkerQueueItemRecord>) -> VecDeque<QueuedItem> {
        lanes
            .into_iter()
            .map(|record| {
                let policy = record.policy();
                // The journal retains the custom row, including the original
                // body. Reconstruct the marker used by clear/pause/status.
                let agent_message = record.custom_message.as_ref().and_then(|row| {
                    (row.get("customType").and_then(Value::as_str) == Some(AGENT_MESSAGE_SOURCE))
                        .then(|| {
                            row.get("details")?
                                .get("message")?
                                .as_str()
                                .map(str::to_string)
                        })
                        .flatten()
                });
                QueuedItem {
                    preview: record.preview,
                    message: record.message,
                    priority: record.priority.unwrap_or_else(|| {
                        if record.custom_message.is_some() {
                            QueuePriority::Background
                        } else {
                            QueuePriority::Human
                        }
                    }),
                    custom_message: record.custom_message,
                    agent_message,
                    queue_key: record.queue_key,
                    admission_id: None,
                    images: record.images,
                    done: None,
                    queue_visible: record.queue_visible,
                    policy,
                    forced_batch: record.forced_batch,
                }
            })
            .collect()
    }

    match journal.latest_queue_snapshot(active_session_id) {
        Some((steering, follow_up, suspended)) => {
            (pending(steering), pending(follow_up), suspended)
        }
        None => (VecDeque::new(), VecDeque::new(), false),
    }
}

/// Admit one held autonomous continuation through the follow-up lane:
/// the item runs as its own queue item after the current run settles.
pub(crate) fn admit_autonomous_follow_up(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<super::WorkNotify>,
    text: String,
) {
    {
        let mut core = core.lock().unwrap();
        core.follow_up.push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: text,
            custom_message: None,
            agent_message: None,
            queue_key: Some(AUTONOMOUS_QUEUE_KEY.to_string()),
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: false,
            policy: TurnPolicy::Injected,
            forced_batch: false,
        });
    }
    // The admission checkpoint: a continuation admitted while idle is undelivered
    // live work the journal must prove (a kill before the settle would park it).
    checkpoint_queue_recovery(
        recovery,
        core,
        QueueCheckpoint::Admitted {
            operation: "follow_up_queued",
        },
    );
    work_notify.notify_waiters();
}

pub(crate) fn admit_goal_follow_up(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    events: &Arc<EventPump>,
    work_notify: &Arc<super::WorkNotify>,
    work: crate::engine::GoalTurnEndWork,
) {
    let (lane, follow_up) = match work {
        crate::engine::GoalTurnEndWork::BudgetLimitSteer(follow_up) => (Lane::Steering, follow_up),
        crate::engine::GoalTurnEndWork::Continuation(follow_up) => (Lane::FollowUp, follow_up),
    };
    if let Some(goal) = &follow_up.goal_update {
        {
            let mut guard = core.lock().unwrap();
            if let Some(store) = guard.store.as_mut() {
                let _ = store.persist_entry(
                    "custom",
                    json!({
                        "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
                        "data": goal,
                    }),
                );
            }
        }
        emit_worker_event_with(core, events, json!({ "type": "goal_update", "goal": goal }));
    }
    {
        let mut core = core.lock().unwrap();
        let item = QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: follow_up.request.message,
            custom_message: follow_up.request.custom_message,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: follow_up.request.images,
            done: None,
            queue_visible: false,
            policy: TurnPolicy::Injected,
            forced_batch: false,
        };
        match lane {
            Lane::Steering => enqueue_priority(&mut core.steering, item),
            Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
        }
    }
    // The admission checkpoint: same idle-admission gap as the
    // autonomous continuation above.
    checkpoint_queue_recovery(
        recovery,
        core,
        QueueCheckpoint::Admitted {
            operation: match lane {
                Lane::Steering => "steer_queued",
                Lane::FollowUp => "follow_up_queued",
            },
        },
    );
    // The runner re-checks the queue at its loop head, so the minted
    // turn runs as the next admitted turn.
    work_notify.notify_one();
}

/// Admit one kernel notice (a detached bash completion or a factory run
/// milestone): the row queues on the steering lane (busy sessions keep a
/// visible steer row, idle sessions wake into it); a crash before the
/// delivery revives with the row replaying.
pub(crate) fn admit_kernel_notice(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<super::WorkNotify>,
    notice: crate::engine::KernelNotice,
    session_is_closed: impl Fn() -> bool,
) {
    let crate::engine::KernelNotice { row, preview_label } = notice;
    // Block rows (a rich cell completion) keep a readable text preview for
    // the queue strip while the custom row carries the actual blocks.
    let content = row.content.text();
    // The busy sample and the push share ONE critical section: a turn starting
    // between them would queue an invisible row for a busy session.
    let mut core_guard = core.lock().unwrap();
    // A notice that raced past the sink's first check is refused here or wiped
    // by the close's clear — never a completion turn for a closed session.
    if session_is_closed() {
        return;
    }
    let (policy, queue_visible) = if core_guard.busy {
        (TurnPolicy::Queued, true)
    } else {
        (TurnPolicy::Injected, false)
    };
    {
        core_guard.steering.push_back(QueuedItem {
            priority: QueuePriority::Background,
            // The queue strip's labeled preview (TS `previewLabel`).
            preview: Some(format!("{preview_label}: {content}")),
            message: content,
            custom_message: Some(crate::session_commands::custom_message_value(&row)),
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible,
            policy,
            forced_batch: false,
        });
    }
    // The checkpoint re-locks the core (documented order: recovery lock
    // first), so the admission's guard must release first.
    drop(core_guard);
    // The busy-evidence checkpoint: the notice is undelivered live
    // work until its turn settles.
    checkpoint_queue_recovery(
        recovery,
        core,
        QueueCheckpoint::Admitted {
            operation: "steer_queued",
        },
    );
    work_notify.notify_one();
}

/// The queue-strip coalescing key of the inbox arrival notice: one
/// queued short row announces every arrival until it delivers.
pub(crate) const INBOX_ARRIVAL_QUEUE_KEY: &str = "inbox:arrival";
/// The coalescing key of the periodic unread reminder.
pub(crate) const INBOX_REMINDER_QUEUE_KEY: &str = "inbox:reminder";

/// Remove every row with this queue key from both lanes. Returns whether
/// any row left.
pub(crate) fn remove_keyed(core: &mut SessionCore, key: &str) -> bool {
    let before = core.steering.len() + core.follow_up.len();
    core.steering
        .retain(|item| item.queue_key.as_deref() != Some(key));
    core.follow_up
        .retain(|item| item.queue_key.as_deref() != Some(key));
    core.steering.len() + core.follow_up.len() != before
}

/// The first queued row with this queue key, and its lane.
fn keyed_row_mut<'a>(core: &'a mut SessionCore, key: &str) -> Option<(Lane, &'a mut QueuedItem)> {
    let is_keyed = |item: &QueuedItem| item.queue_key.as_deref() == Some(key);
    if let Some(index) = core.steering.iter().position(is_keyed) {
        return Some((Lane::Steering, &mut core.steering[index]));
    }
    let index = core.follow_up.iter().position(is_keyed)?;
    Some((Lane::FollowUp, &mut core.follow_up[index]))
}

/// The inbox ids one arrival row announces: `details.covers` on its
/// custom row, journaled with the row, so a restored row keeps them.
fn covers_of(item: &QueuedItem) -> Vec<String> {
    item.custom_message
        .as_ref()
        .and_then(|row| row.get("details")?.get("covers")?.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|id| id.as_str().map(str::to_string))
        .collect()
}

/// The ids the queued arrival row announces: the messages the agent was
/// not told about yet. Empty when no arrival row is queued.
pub(crate) fn queued_arrival_covers(core: &SessionCore) -> Vec<String> {
    core.steering
        .iter()
        .chain(core.follow_up.iter())
        .find(|item| item.queue_key.as_deref() == Some(INBOX_ARRIVAL_QUEUE_KEY))
        .map(covers_of)
        .unwrap_or_default()
}

/// The arrival notice over the covered messages that are still waiting:
/// the preview, the text, and the covered messages. `None` when none of
/// them waits any more.
fn arrival_rendering(
    inbox: &pa_core::session_engine::inbox::SessionInbox,
    covers: &[String],
) -> Option<(
    String,
    String,
    Vec<pa_core::session_engine::inbox::InboxMessage>,
)> {
    let waiting = inbox.waiting_messages();
    let batch: Vec<_> = waiting
        .iter()
        .filter(|message| covers.contains(&message.id))
        .cloned()
        .collect();
    if batch.is_empty() {
        return None;
    }
    let (preview, text) = notice_text(&batch, waiting.len());
    Some((preview, inbox.with_persistence_error_clause(text), batch))
}

fn covered_ids(batch: &[pa_core::session_engine::inbox::InboxMessage]) -> Value {
    json!(batch
        .iter()
        .map(|message| message.id.as_str())
        .collect::<Vec<_>>())
}

/// Store one notice in the session's inbox and announce it on the queued
/// arrival row, due after `wake_delay` (`inbox_wake_row::wake_delay`). A
/// closing session only stores it: the next session open announces it
/// ([`announce_waiting_inbox`]). Returns whether the announcement waits
/// behind a running turn (the receipt's `queued`).
pub(crate) fn store_and_announce(
    core: &mut SessionCore,
    inbox: &pa_core::session_engine::inbox::SessionInbox,
    session_is_closed: bool,
    notice: pa_core::session_engine::inbox::InboxNotice,
    lane: Lane,
    wake_delay: Duration,
) -> bool {
    let message = inbox.push(notice, pa_core::autonomous::now_millis());
    if session_is_closed {
        return true;
    }
    announce_inbox_arrivals(core, inbox, vec![message.id], lane, wake_delay)
}

/// Queue one arrival row for the waiting messages no queued arrival row
/// covers yet (a session opened over unread mail), due at once. Returns
/// whether a row changed.
pub(crate) fn announce_waiting_inbox(
    core: &mut SessionCore,
    inbox: &pa_core::session_engine::inbox::SessionInbox,
) -> bool {
    let covered = queued_arrival_covers(core);
    let uncovered: Vec<String> = inbox
        .waiting_messages()
        .into_iter()
        .map(|message| message.id)
        .filter(|id| !covered.contains(id))
        .collect();
    if uncovered.is_empty() {
        return false;
    }
    announce_inbox_arrivals(core, inbox, uncovered, Lane::Steering, Duration::ZERO);
    true
}

/// Add `ids` to the queued arrival row, or queue a fresh row on `lane`.
/// The row keeps its place; a follow-up row moves to steering when a
/// steering arrival joins it, so one row carries the most urgent lane of
/// its batch. The row is due at the earliest of its arrivals' due times
/// (now plus `wake_delay`), so a waking arrival flushes held successes.
/// Returns whether the row waits behind a running turn.
fn announce_inbox_arrivals(
    core: &mut SessionCore,
    inbox: &pa_core::session_engine::inbox::SessionInbox,
    ids: Vec<String>,
    lane: Lane,
    wake_delay: Duration,
) -> bool {
    let queued = core.busy;
    let existing = keyed_row_mut(core, INBOX_ARRIVAL_QUEUE_KEY)
        .map(|(row_lane, item)| (row_lane, covers_of(item)));
    let due = tokio::time::Instant::now() + wake_delay;
    core.inbox_wake_due = Some(match core.inbox_wake_due {
        Some(earlier) if existing.is_some() => earlier.min(due),
        _ => due,
    });
    let mut covers = existing
        .as_ref()
        .map(|(_, covers)| covers.clone())
        .unwrap_or_default();
    covers.extend(ids);
    let Some((preview, text, batch)) = arrival_rendering(inbox, &covers) else {
        remove_keyed(core, INBOX_ARRIVAL_QUEUE_KEY);
        return queued;
    };
    // The wake eligibility and the cell-delivery bit ride the row (see
    // `row_wakes_a_cell` and `queued_cell_completion_deliveries`).
    let mut custom_message = pa_core::session_engine::inbox::create_inbox_notice_row(
        &text,
        pa_types::inbox_notice::INBOX_NOTICE_CLASS_ARRIVAL,
        batch.len(),
        batch_wakes_a_cell(&batch),
        batch_covers_cell_done(&batch),
        pa_core::autonomous::now_millis(),
    );
    custom_message["details"]["covers"] = covered_ids(&batch);
    let item = QueuedItem {
        priority: QueuePriority::Background,
        preview: Some(preview),
        message: text,
        custom_message: Some(custom_message),
        agent_message: None,
        queue_key: Some(INBOX_ARRIVAL_QUEUE_KEY.to_string()),
        admission_id: None,
        images: Vec::new(),
        done: None,
        // An idle session takes the notice as an injected turn; a busy
        // one shows it on the queue strip.
        queue_visible: queued,
        policy: if queued {
            TurnPolicy::Queued
        } else {
            TurnPolicy::Injected
        },
        forced_batch: false,
    };
    match (existing.map(|(row_lane, _)| row_lane), lane) {
        (Some(Lane::FollowUp), Lane::Steering) => {
            remove_keyed(core, INBOX_ARRIVAL_QUEUE_KEY);
            core.steering.push_back(item);
        }
        (Some(_), _) => {
            if let Some((_, row)) = keyed_row_mut(core, INBOX_ARRIVAL_QUEUE_KEY) {
                *row = item;
            }
        }
        (None, Lane::Steering) => core.steering.push_back(item),
        (None, Lane::FollowUp) => core.follow_up.push_back(item),
    }
    queued
}

/// Retract or re-render the queued inbox wake rows over the live store:
/// the arrival row's covers trim to the waiting messages (no waiting
/// covered message drops the row), and the reminder follows the live
/// count. Run after every read and withdrawal. Returns whether a row
/// changed.
pub(crate) fn refresh_inbox_wake_rows(
    core: &mut SessionCore,
    inbox: &pa_core::session_engine::inbox::SessionInbox,
) -> bool {
    let mut changed = false;
    let covers = queued_arrival_covers(core);
    if !covers.is_empty() {
        match arrival_rendering(inbox, &covers) {
            None => changed |= remove_keyed(core, INBOX_ARRIVAL_QUEUE_KEY),
            Some((preview, text, batch)) => {
                if let Some((_, item)) = keyed_row_mut(core, INBOX_ARRIVAL_QUEUE_KEY) {
                    if rerender_inbox_notice(
                        item,
                        &text,
                        batch.len(),
                        batch_wakes_a_cell(&batch),
                        batch_covers_cell_done(&batch),
                    ) {
                        item.preview = Some(preview);
                        if let Some(details) = item
                            .custom_message
                            .as_mut()
                            .and_then(|row| row.get_mut("details"))
                            .and_then(Value::as_object_mut)
                        {
                            details.insert("covers".to_string(), covered_ids(&batch));
                        }
                        changed = true;
                    }
                }
            }
        }
    }
    let (count, _, _) = inbox.count();
    if count == 0 {
        changed |= remove_keyed(core, INBOX_REMINDER_QUEUE_KEY);
    } else if let Some((_, item)) = keyed_row_mut(core, INBOX_REMINDER_QUEUE_KEY) {
        let reminder = inbox
            .with_persistence_error_clause(pa_core::session_engine::inbox::reminder_notice(count));
        // A reminder stays wakeable input and is nobody's pending cell
        // delivery.
        changed |= rerender_inbox_notice(item, &reminder, count, true, false);
    }
    changed
}

/// Deliver the inbox arrival row the runner just picked: it re-renders
/// over the covered messages still waiting, counting the items it shows
/// (`inbox_wake_row::shown_items`) as read, so the model is never told to
/// read what it was just shown. The shown items stay in the inbox until
/// the row's transcript row is accepted
/// ([`consume_shown_inbox_items_locked`]); an abort or crash before that
/// leaves them waiting. Items the row only counts wait for a read.
pub(crate) fn deliver_inbox_arrival_row_locked(
    core: &mut SessionCore,
    item: &mut QueuedItem,
    inbox: &pa_core::session_engine::inbox::SessionInbox,
) {
    core.inbox_wake_due = None;
    let covers = covers_of(item);
    let waiting = inbox.waiting_messages();
    let batch: Vec<_> = waiting
        .iter()
        .filter(|message| covers.contains(&message.id))
        .cloned()
        .collect();
    if batch.is_empty() {
        return;
    }
    let shown: std::collections::BTreeSet<String> = shown_items(&batch)
        .into_iter()
        .map(|message| message.id.clone())
        .collect();
    let (preview, text) = delivered_notice_text(&batch, waiting.len() - shown.len());
    rerender_inbox_notice(
        item,
        &inbox.with_persistence_error_clause(text),
        batch.len(),
        batch_wakes_a_cell(&batch),
        batch_covers_cell_done(&batch),
    );
    item.preview = Some(preview);
    core.inbox_shown_unaccepted = shown;
}

/// Withdraw the items the delivered arrival row showed, once its
/// transcript row is accepted; a queued reminder follows the drained count.
pub(crate) fn consume_shown_inbox_items_locked(
    core: &mut SessionCore,
    inbox: &pa_core::session_engine::inbox::SessionInbox,
) {
    let shown = std::mem::take(&mut core.inbox_shown_unaccepted);
    if shown.is_empty() {
        return;
    }
    inbox.withdraw_ids(&shown);
    refresh_inbox_wake_rows(core, inbox);
}

/// Queue one periodic unread reminder on the steering lane while the
/// inbox holds messages (the reminderIntervalMs cycle in
/// `agent_inbox.rs`); a later reminder replaces the queued one. Returns
/// whether a row was queued.
pub(crate) fn admit_inbox_reminder(
    core: &mut SessionCore,
    inbox: &pa_core::session_engine::inbox::SessionInbox,
) -> bool {
    let (count, _, _) = inbox.count();
    if count == 0 {
        return false;
    }
    let message =
        inbox.with_persistence_error_clause(pa_core::session_engine::inbox::reminder_notice(count));
    // A reminder stays wakeable input for a running cell; it repeats a
    // count, so it is nobody's pending cell delivery.
    let custom_message = pa_core::session_engine::inbox::create_inbox_notice_row(
        &message,
        pa_types::inbox_notice::INBOX_NOTICE_CLASS_REMINDER,
        count,
        true,
        false,
        pa_core::autonomous::now_millis(),
    );
    let queued = core.busy;
    remove_keyed(core, INBOX_REMINDER_QUEUE_KEY);
    core.steering.push_back(QueuedItem {
        priority: QueuePriority::Background,
        preview: Some("Inbox reminder".to_string()),
        message,
        custom_message: Some(custom_message),
        agent_message: None,
        queue_key: Some(INBOX_REMINDER_QUEUE_KEY.to_string()),
        admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: queued,
        policy: if queued {
            TurnPolicy::Queued
        } else {
            TurnPolicy::Injected
        },
        forced_batch: false,
    });
    true
}

/// Re-render one queued inbox notice row's text: the queue's `message`
/// and the custom row's `content`, `details.count`, and cell bits move
/// together — a stale custom row would deliver an old count — while its
/// sender, class, and admission timestamp stay. Returns whether the text
/// changed.
fn rerender_inbox_notice(
    item: &mut QueuedItem,
    text: &str,
    count: usize,
    wakes_cell: bool,
    covers_cell_done: bool,
) -> bool {
    if item.message == text {
        return false;
    }
    item.message = text.to_string();
    if let Some(row) = item.custom_message.as_mut() {
        if let Some(object) = row.as_object_mut() {
            object.insert("content".to_string(), json!(text));
            if let Some(details) = object.get_mut("details").and_then(Value::as_object_mut) {
                details.insert("count".to_string(), json!(count));
                details.insert("wakesCell".to_string(), json!(wakes_cell));
                details.insert("coversCellDone".to_string(), json!(covers_cell_done));
            }
        }
    }
    true
}

/// Whether an arrivals batch contains anything besides bare cell
/// completions: the wake eligibility of the inbox arrival row that covers
/// it (a cell-done-only batch never ends a running cell's wait).
fn batch_wakes_a_cell(batch: &[pa_core::session_engine::inbox::InboxMessage]) -> bool {
    batch
        .iter()
        .any(|message| message.class != pa_types::inbox_notice::INBOX_CLASS_CELL_DONE)
}

/// Whether an arrivals batch contains a bare cell completion: the
/// covered cell's pending delivery rides the inbox arrival row, so the
/// quiescence observation counts it until the row delivers.
fn batch_covers_cell_done(batch: &[pa_core::session_engine::inbox::InboxMessage]) -> bool {
    batch
        .iter()
        .any(|message| message.class == pa_types::inbox_notice::INBOX_CLASS_CELL_DONE)
}

/// Withdraw one queued bash completion notice: the kernel read the finished
/// command's result through its handle (`bash.consumed`, fired by any read
/// of a finished handle inside a live cell — `poll()`, `output()`, `tail()`,
/// or an await; pids are reused, so the command disambiguates). The same
/// collection removes the notice's inbox message: the kernel already read
/// the result, so the bash-done must not wait for an explicit
/// `rlm.inbox.read()`, and the queued inbox rows must not promise it.
pub(crate) fn withdraw_bash_completion_notice(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    notice: &crate::engine::BashConsumedNotice,
    engine: Option<&dyn crate::engine::SessionEngine>,
) {
    let mut core_guard = core.lock().unwrap();
    // Looked up under the core lock: a replacement swaps the store inside
    // the same lock, so the withdrawal and the wake rows it edits belong to
    // one session.
    let inbox = engine.and_then(crate::engine::SessionEngine::inbox_store);
    // The direct-lane full-row withdrawal (the kill-switch lane): the
    // front-most match across the two lanes, never the whole set.
    let mut removed = false;
    let mut withdraw_one = |item: &QueuedItem| {
        if !removed && is_bash_completion_notice_for(item, notice) {
            removed = true;
            false
        } else {
            true
        }
    };
    core_guard.steering.retain(&mut withdraw_one);
    core_guard.follow_up.retain(withdraw_one);
    let inbox_rows_changed = inbox.as_deref().is_some_and(|inbox| {
        inbox
            .withdraw_bash_completion(notice.pid, &notice.command)
            .is_some()
            && refresh_inbox_wake_rows(&mut core_guard, inbox)
    });
    // The idle-session progress note clears only once the lanes it
    // reported on are final (the sweep may have emptied them).
    if let Some(engine) = engine {
        clear_withdrawn_progress_note(&core_guard, engine);
    }
    drop(core_guard);
    if removed || inbox_rows_changed {
        // The withdrawal refreshes the verdict so a consumed notice cannot keep
        // busy=true promising a revive the withdrawn row would replay.
        checkpoint_queue_recovery(
            recovery,
            core,
            QueueCheckpoint::Settle {
                operation: "queue_purged",
            },
        );
    }
}

/// Whether one queued item is the completion notice for this pid+command
/// (the details carry both — pids alone are reused).
fn is_bash_completion_notice_for(
    item: &QueuedItem,
    notice: &crate::engine::BashConsumedNotice,
) -> bool {
    let Some(row) = item.custom_message.as_ref() else {
        return false;
    };
    if !is_bash_completion_row(row) {
        return false;
    }
    let details = row.get("details").unwrap_or(&Value::Null);
    details.get("pid").and_then(Value::as_u64) == Some(u64::from(notice.pid))
        && details.get("command").and_then(Value::as_str) == Some(notice.command.as_str())
}

/// Whether one queued row is an admitted `[bash-done]` notice: completed
/// bash work whose wake is still pending delivery.
fn is_bash_completion_row(row: &Value) -> bool {
    row.get("customType").and_then(Value::as_str)
        == Some(pa_core::session_engine::messages::ASYNC_BASH_COMPLETION_CUSTOM_TYPE)
}

/// Whether one queued steering row is wakeable input for a running cell:
/// every user and agent row is; a backgrounded cell's own completion row
/// never is (the kernel runs one cell at a time, so a cell still waiting
/// when the notice lands started after the backgrounded one settled, and
/// the notice cannot concern it); an inbox arrival row carries its stored
/// eligibility bit (a restored row without the bit is conservatively
/// wakeable — one extra detach, never a lost steer).
pub(crate) fn row_wakes_a_cell(item: &QueuedItem) -> bool {
    let Some(row) = item.custom_message.as_ref() else {
        return true;
    };
    let custom_type = row
        .get("customType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if custom_type
        == pa_core::session_engine::messages::ASYNC_BACKGROUND_CELL_COMPLETION_CUSTOM_TYPE
    {
        return false;
    }
    if custom_type == pa_types::inbox_notice::INBOX_NOTICE_CUSTOM_TYPE
        && row.pointer("/details/class").and_then(Value::as_str)
            == Some(pa_types::inbox_notice::INBOX_NOTICE_CLASS_ARRIVAL)
    {
        return row
            .pointer("/details/wakesCell")
            .and_then(Value::as_bool)
            .unwrap_or(true);
    }
    true
}

/// The `[bash-done]` notices still queued for delivery across the
/// steering and follow-up lanes: completed bash work the bash lane will
/// still wake the session for.
pub(crate) fn queued_bash_completion_notices(core: &SessionCore) -> usize {
    core.steering
        .iter()
        .chain(core.follow_up.iter())
        .filter(|item| {
            item.custom_message
                .as_ref()
                .is_some_and(is_bash_completion_row)
        })
        .count()
}

/// Whether one queued row is a cell completion still pending delivery:
/// a full `[cell-done]` row, or the coalesced inbox arrival row whose
/// covered batch contains a cell completion (the stored
/// `details.coversCellDone` bit — a restored row without the bit counts
/// conservatively, so pending work is never hidden).
fn is_cell_delivery_row(row: &Value) -> bool {
    let custom_type = row
        .get("customType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if custom_type
        == pa_core::session_engine::messages::ASYNC_BACKGROUND_CELL_COMPLETION_CUSTOM_TYPE
    {
        return true;
    }
    custom_type == pa_types::inbox_notice::INBOX_NOTICE_CUSTOM_TYPE
        && row.pointer("/details/class").and_then(Value::as_str)
            == Some(pa_types::inbox_notice::INBOX_NOTICE_CLASS_ARRIVAL)
        && row
            .pointer("/details/coversCellDone")
            .and_then(Value::as_bool)
            .unwrap_or(true)
}

/// The cell completions still queued for delivery across the steering and
/// follow-up lanes: one count per pending row, never per historical
/// unread inbox entry. The quiescence observation reads it, so a
/// backgrounded cell's terminal notice reports as outstanding work until
/// its row actually delivers.
pub(crate) fn queued_cell_completion_deliveries(core: &SessionCore) -> usize {
    core.steering
        .iter()
        .chain(core.follow_up.iter())
        .filter(|item| {
            item.custom_message
                .as_ref()
                .is_some_and(is_cell_delivery_row)
        })
        .count()
}
