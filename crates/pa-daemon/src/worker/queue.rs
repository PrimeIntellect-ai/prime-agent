//! Queued input: the item model, the lanes, admission, delivery batching,
//! and queue recovery.
use super::{
    emit_worker_event_with, json, oneshot, Arc, Duration, EventPump, Mutex, Notify, Result,
    SessionCore, Value, VecDeque, WorkerRecoveryJournal, AUTONOMOUS_QUEUE_KEY,
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
    let (active_session_id, session_id, session_file, lanes, turn_in_flight) = {
        let core = core_lock.lock().unwrap();
        if core.shutdown_requested {
            // The final attempt checkpoint owns shutdown's last verdict.
            return;
        }
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
    );
}

/// The picked batch's stable row identities must land before any engine row
/// can reach the session file. A failed pickup keeps the original queue safe.
pub(crate) fn checkpoint_picked_input(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core_lock: &std::sync::Mutex<SessionCore>,
) -> Result<()> {
    checkpoint_owned_input(recovery, core_lock, "picked")
}

pub(crate) fn checkpoint_owned_input(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core_lock: &std::sync::Mutex<SessionCore>,
    operation: &str,
) -> Result<()> {
    let mut guard = recovery.lock().unwrap();
    let Some(journal) = guard.as_mut() else {
        // Standalone turn tests intentionally have no journal; a product
        // worker must never accept input without its recovery sink.
        #[cfg(test)]
        return Ok(());
        #[cfg(not(test))]
        anyhow::bail!("picked input has no recovery journal");
    };
    let (active_session_id, session_id, session_file, lanes) = {
        let core = core_lock.lock().unwrap();
        anyhow::ensure!(
            !core.shutdown_requested,
            "shutdown owns final queue checkpoint"
        );
        (
            core.active_session_id.clone(),
            core.store
                .as_ref()
                .map(|store| store.session_id().to_string())
                .unwrap_or_default(),
            core.store
                .as_ref()
                .map(|store| store.path.to_string_lossy().to_string()),
            queue_lanes(&core),
        )
    };
    journal.record_queue_checkpoint(
        &active_session_id,
        &session_id,
        session_file.as_deref(),
        operation == "picked" || !lanes.steering.is_empty() || !lanes.follow_up.is_empty(),
        operation,
        &lanes.steering,
        &lanes.follow_up,
    )
}

pub(crate) fn queue_lanes(core: &SessionCore) -> QueueLanes {
    fn items(lane: &VecDeque<QueuedItem>) -> Vec<crate::journal::WorkerQueueItemRecord> {
        lane.iter().map(queue_item_record).collect()
    }
    let mut steering = items(&core.steering);
    let mut follow_up = items(&core.follow_up);
    for input in core
        .in_flight_input
        .iter()
        .rev()
        .filter(|input| !input.cancelled)
    {
        let mut record = input.item.clone();
        record.entry_id = Some(input.row_id.clone());
        match input.lane {
            Lane::Steering => steering.insert(0, record),
            Lane::FollowUp => follow_up.insert(0, record),
        }
    }
    QueueLanes {
        steering,
        follow_up,
    }
}

pub(crate) fn queue_item_record(item: &QueuedItem) -> crate::journal::WorkerQueueItemRecord {
    crate::journal::WorkerQueueItemRecord {
        message: item.message.clone(),
        priority: Some(item.priority),
        preview: item.preview.clone(),
        custom_message: item.custom_message.clone(),
        agent_message: item.agent_message.clone(),
        queue_key: item.queue_key.clone(),
        admission_id: item.admission_id.clone(),
        entry_id: None,
        images: item.images.clone(),
        queue_visible: item.queue_visible,
        policy: item.policy.journal_value().to_string(),
        forced_batch: item.forced_batch,
    }
}

/// The lane's front item anchors the delivery; under queue mode "all" — or
/// the forced steering batch — the same-class prefix behind it joins as
/// co-delivered rows of ONE turn. A non-batchable front delivers solo.
pub(crate) fn gather_delivery_batch(core: &mut SessionCore, lane: Lane) -> Vec<QueuedItem> {
    let (items, mode) = match lane {
        Lane::Steering => (&mut core.steering, core.steering_mode.as_str()),
        Lane::FollowUp => (&mut core.follow_up, core.follow_up_mode.as_str()),
    };
    let Some(first) = items.front() else {
        return Vec::new();
    };
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
#[cfg(test)]
pub(crate) fn restore_queue_snapshot(
    journal: &WorkerRecoveryJournal,
    active_session_id: &str,
) -> (VecDeque<QueuedItem>, VecDeque<QueuedItem>) {
    journal
        .latest_queue_snapshot(active_session_id)
        .map_or_else(
            || (VecDeque::new(), VecDeque::new()),
            |(steering, follow_up)| {
                (
                    restore_queue_records(steering),
                    restore_queue_records(follow_up),
                )
            },
        )
}

pub(crate) fn restore_queue_records(
    lanes: Vec<crate::journal::WorkerQueueItemRecord>,
) -> VecDeque<QueuedItem> {
    lanes
        .into_iter()
        .map(|record| {
            let policy = record.policy();
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
                agent_message: record.agent_message,
                queue_key: record.queue_key,
                admission_id: record.admission_id,
                images: record.images,
                done: None,
                queue_visible: record.queue_visible,
                policy,
                forced_batch: record.forced_batch,
            }
        })
        .collect()
}

/// A picked input is still in the queue checkpoint. Omit only IDs proven
/// present in the synced session file; an uncertain append cannot duplicate.
pub(crate) fn restore_queue_snapshot_reconciled(
    journal: &WorkerRecoveryJournal,
    active_session_id: &str,
    session_file: &std::path::Path,
) -> Result<(VecDeque<QueuedItem>, VecDeque<QueuedItem>)> {
    let Some((mut steering, mut follow_up)) = journal.latest_queue_snapshot(active_session_id)
    else {
        return Ok((VecDeque::new(), VecDeque::new()));
    };
    let pending_ids: std::collections::HashSet<&str> = steering
        .iter()
        .chain(&follow_up)
        .filter_map(|item| item.entry_id.as_deref())
        .collect();
    if !pending_ids.is_empty() {
        // An untouched picked prompt can precede the session file's first
        // append. A missing file contains no accepted row; an existing file
        // must be synced and parsed in full before any replay decision.
        let text = if session_file.exists() {
            crate::journal::sync_regular_file(session_file)?;
            std::fs::read_to_string(session_file)?
        } else {
            String::new()
        };
        let mut landed = std::collections::HashSet::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let row: Value = serde_json::from_str(line)?;
            if let Some(id) = row.get("id").and_then(Value::as_str) {
                if pending_ids.contains(id) {
                    landed.insert(id.to_string());
                }
            }
        }
        steering.retain(|item| !item.entry_id.as_ref().is_some_and(|id| landed.contains(id)));
        follow_up.retain(|item| !item.entry_id.as_ref().is_some_and(|id| landed.contains(id)));
    }
    Ok((
        restore_queue_records(steering),
        restore_queue_records(follow_up),
    ))
}

/// Admit one held autonomous continuation through the follow-up lane:
/// the item runs as its own queue item after the current run settles.
pub(crate) fn admit_autonomous_follow_up(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<Notify>,
    text: String,
) {
    {
        let mut core = core.lock().unwrap();
        if core.shutdown_requested || core.recovery_hold {
            return;
        }
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
    work_notify: &Arc<Notify>,
    work: crate::engine::GoalTurnEndWork,
) {
    let (lane, follow_up) = match work {
        crate::engine::GoalTurnEndWork::BudgetLimitSteer(follow_up) => (Lane::Steering, follow_up),
        crate::engine::GoalTurnEndWork::Continuation(follow_up) => (Lane::FollowUp, follow_up),
    };
    if let Some(goal) = &follow_up.goal_update {
        {
            let mut guard = core.lock().unwrap();
            if guard.shutdown_requested || guard.recovery_hold {
                return;
            }
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
        if core.shutdown_requested || core.recovery_hold {
            return;
        }
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

/// Admit one detached kernel bash completion notice: the row queues on the
/// steering lane (busy sessions keep a visible steer row, idle sessions wake
/// into it); a crash before the delivery revives with the row replaying.
pub(crate) fn admit_bash_completion_notice(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<Notify>,
    notice: &crate::engine::BashCompletionNotice,
    session_is_closed: impl Fn() -> bool,
) {
    let row = pa_core::session_engine::messages::create_async_bash_completion_message(
        notice.pid,
        &notice.command,
        notice.exit_code,
        crate::util::now_ms(),
    );
    let content = match &row.content {
        pa_types::ai::UserContent::Text(text) => text.clone(),
        pa_types::ai::UserContent::Blocks(_) => String::new(),
    };
    // The busy sample and the push share ONE critical section: a turn starting
    // between them would queue an invisible row for a busy session.
    let mut core_guard = core.lock().unwrap();
    // A notice that raced past the sink's first check is refused here or wiped
    // by the close's clear — never a completion turn for a closed session.
    if session_is_closed() || core_guard.shutdown_requested || core_guard.recovery_hold {
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
            preview: Some(format!(
                "{}: {content}",
                pa_core::session_engine::messages::ASYNC_BASH_COMPLETION_PREVIEW_LABEL
            )),
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

/// Withdraw one queued bash completion notice: the kernel read the result
/// before the notice delivered (pids are reused, so the command disambiguates).
pub(crate) fn withdraw_bash_completion_notice(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    notice: &crate::engine::BashConsumedNotice,
) {
    let removed = {
        let mut core_guard = core.lock().unwrap();
        let before = core_guard.steering.len() + core_guard.follow_up.len();
        // The front-most match across the two lanes, never the
        // whole set.
        let mut withdrawn = false;
        let mut withdraw_one = |item: &QueuedItem| {
            if !withdrawn && is_bash_completion_notice_for(item, notice) {
                withdrawn = true;
                false
            } else {
                true
            }
        };
        core_guard.steering.retain(&mut withdraw_one);
        core_guard.follow_up.retain(withdraw_one);
        before != core_guard.steering.len() + core_guard.follow_up.len()
    };
    if removed {
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
    if row.get("customType").and_then(Value::as_str)
        != Some(pa_core::session_engine::messages::ASYNC_BASH_COMPLETION_CUSTOM_TYPE)
    {
        return false;
    }
    let details = row.get("details").unwrap_or(&Value::Null);
    details.get("pid").and_then(Value::as_u64) == Some(u64::from(notice.pid))
        && details.get("command").and_then(Value::as_str) == Some(notice.command.as_str())
}
