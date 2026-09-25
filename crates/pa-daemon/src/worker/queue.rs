//! Queued input: the item model, the lanes, admission, delivery batching,
//! and queue recovery.
use super::*;

/// Queue delivery lanes (port of the session action store's two deliveries).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Steering,
    FollowUp,
}

impl Lane {
    fn as_str(&self) -> &'static str {
        match self {
            Lane::Steering => "steering",
            Lane::FollowUp => "follow_up",
        }
    }
}

/// The TS `_assertSessionActionAdmissionAvailable` rejection while the
/// queued-input pump is suspended (agent-session.ts).
/// How long the close paths (`shutdown`, `kill`) wait for aborted side
/// question runs to queue their terminal cancelled events before the
/// process exits. The runs observe the abort within their 20ms pump tick
/// and the stream teardown, so this is generous headroom, not a gate.
pub(crate) const SIDE_QUESTION_SETTLE_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) const QUEUED_INPUT_SUSPENDED: &str =
    "Cannot admit a session action while queued session input is suspended.";

/// The item's turn-execution class (TS `TurnExecutionPolicy`, the
/// `_pumpSessionInputs` batch-gathering's `turnExecutionPoliciesEqual`
/// gate): items co-deliver as one batched turn only within the same
/// class. Client-queued rows (the `steer`/`follow_up` commands and
/// prompt admissions behind work, TS `"queued"`) batch together;
/// injected rows (heartbeat fires, agent-message deliveries, goal and
/// autonomous continuations, TS `"injected"`) batch among themselves;
/// the idle session's direct-prompt hand-off (TS `"directPrompt"`)
/// never joins a queue batch.
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

/// The turn-execution class restored from a wire `restore_actions`
/// payload (TS `restoreSessionActions` restores the full
/// `executionPolicy`): `nextTurnContextTiming` "commit" is the
/// client-queued policy; "preparation" with a preserved empty
/// extension prompt is injected; "preparation" without it is the
/// direct-prompt hand-off. An absent or unknown policy restores as the
/// dominant queued class.
pub(crate) fn restored_turn_policy(payload: &Value) -> TurnPolicy {
    let timing = payload
        .get("executionPolicy")
        .and_then(|policy| policy.get("nextTurnContextTiming"))
        .and_then(Value::as_str);
    match timing {
        Some("preparation") => {
            let preserved = payload
                .get("executionPolicy")
                .and_then(|policy| policy.get("preserveEmptyExtensionPrompt"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if preserved {
                TurnPolicy::Injected
            } else {
                TurnPolicy::Direct
            }
        }
        _ => TurnPolicy::Queued,
    }
}

/// The wire text of an aborted turn's settle (the `turn_end` error frame
/// and the waiting prompt's failure): the turn was aborted before an
/// assistant message was produced (a user abort, a queued-input
/// suspension).
pub(crate) const ABORTED_TURN_SETTLE_ERROR: &str = "No response produced.";

/// The wire text of a prompt cancelled before delivery (the
/// queue-invisible abort path).
pub(crate) const PROMPT_ABORTED_BEFORE_DELIVERY: &str = "Prompt aborted before delivery.";

/// The wire text of a queued prompt deleted through a queue mutation (TS
/// `QueuedMessageError` verbatim).
pub(crate) const QUEUED_PROMPT_DELETED: &str = "Queued prompt was deleted before delivery.";

/// The typed settle of one queued prompt, as the waiting caller's `done`
/// channel carries it. The variants classify the settle without reading
/// the (provider-controllable) error text: an aborted turn is not a
/// provider failure, and a withdrawn prompt never ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TurnSettle {
    /// The turn ran to its settle.
    Completed,
    /// The turn was aborted before an assistant message was produced.
    Aborted,
    /// The queued prompt was withdrawn before delivery (the abort
    /// cancel, a queue edit deleting the row); the text is the
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

/// TS `ActionStore` priority insertion: walk back only across a lower-priority
/// suffix. Never re-sort a lane: explicit moves and restored order can cross
/// priority boundaries, and equal-priority arrivals remain FIFO.
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
    /// The labeled queue-strip row (TS `payload.preview`): the queue
    /// snapshot serves it instead of `message` when the delivery carries
    /// one, and the active-action label reads it too (TS #2063
    /// `queuedAgentMessagePreview` returns `payload.preview ??
    /// payload.text`); the turn's prompt text stays `message`.
    pub(crate) preview: Option<String>,
    /// An injected custom row that replaces this turn's user message (the
    /// RLM child terminal notices ride the follow-up lane this way).
    pub(crate) custom_message: Option<Value>,
    /// The original agent-message text when this item came from an
    /// `agent_message` delivery (the marker `agent_messages_clear` /
    /// `agent_messages_pause` remove queued items by); `None` for items a
    /// client queued directly (`steer/follow_up`).
    pub(crate) agent_message: Option<String>,
    /// The scheduler's queue key (TS `followUpQueueKey`): a heartbeat's
    /// queued fire carries `heartbeat:<id>`, and a later fire replaces the
    /// queued item with the same key instead of stacking.
    pub(crate) queue_key: Option<String>,
    /// The prompt-admission id this admitted prompt registered (the
    /// `cancel_prompt_admission` bookkeeping); `None` for prompts that
    /// carried no admission id.
    pub(crate) admission_id: Option<String>,
    /// Images attached to the prompt (wire `images`: base64 payload plus
    /// mime type), admitted with the message as multimodal content.
    pub(crate) images: Vec<pa_agent::types::ImageContent>,
    pub(crate) done: Option<oneshot::Sender<TurnSettle>>,
    /// TS `payload.queueVisible`: the item shows in the queue projection
    /// and its delivery projects the active-action phase transitions
    /// (steer/follow-up lanes, agent-message deliveries, prompt-behind-work,
    /// heartbeat fires, restored rows). Injected continuations (goal,
    /// autonomous, post-compaction) and an idle session's direct prompt
    /// admission stay invisible: the TS wire shows no queue rows or
    /// active phases for them.
    pub(crate) queue_visible: bool,
    /// The item's turn-execution class (see [`TurnPolicy`]): the batch
    /// gathering's compatibility gate.
    pub(crate) policy: TurnPolicy,
    /// Membership of the one-shot forced steering batch (TS
    /// `_forcedAllSteeringActionIds`, armed by `abortAndSendQueued`):
    /// armed items co-deliver as one batched turn even under queue mode
    /// "one-at-a-time". Transient worker state — never journaled; a
    /// restart between the abort and the delivery loses the forced batch
    /// (the TS armed set is equally in-memory).
    pub(crate) forced_batch: bool,
}

/// Parse the wire `images` array of a prompt-family command (each entry
/// `{type: "image", data, mimeType}`). Entries that do not carry payload
/// data or a mime type are dropped, not failed: the text still admits.
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

/// The pending queue lanes of a session (journal persistence payload):
/// the full parked rows — message text, labeled preview, injected custom
/// row, queue key, and visibility — so crash/respawn recovery restores a
/// queued heartbeat as the heartbeat component, not a plain prompt.
pub(crate) struct QueueLanes {
    pub(crate) steering: Vec<crate::journal::WorkerQueueItemRecord>,
    pub(crate) follow_up: Vec<crate::journal::WorkerQueueItemRecord>,
}

/// Read the pending lanes off a locked core.
/// The wire `customMessage` of a prompt/follow-up command: an injected
/// custom row (`role: "custom"` with a non-empty `customType`) that
/// replaces the turn's user row. `Err` rejects the command loudly — a
/// malformed notice must not silently degrade into a plain prompt.
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

/// One queue-lane recovery checkpoint. The verdict and the persisted
/// lane snapshot come from one locked read, so a concurrent
/// enqueue/clear cannot be overwritten by a stale verdict and a stale
/// snapshot cannot resurrect cleared lanes.
#[derive(Clone, Copy)]
pub(crate) enum QueueCheckpoint {
    /// The lanes hold admitted live work: `busy = true` (TS
    /// `prompt_accepted` / `steer_queued` / `follow_up_queued` /
    /// `actions_restored`).
    Admitted { operation: &'static str },
    /// The verdict follows the lanes: `busy = whether lanes remain
    /// queued` (TS `turn_end` computes the same verdict over live
    /// work). Also used by queue mutations with no TS record (a clear,
    /// an edit, an agent-message drain) so the journal never keeps a
    /// stale verdict over a changed queue.
    Settle { operation: &'static str },
}

/// Write one queue-lane recovery checkpoint: under the recovery lock
/// (then the core lock, the documented order) the lanes are snapshotted
/// into the journal and the busy verdict is recorded from the same
/// read. Shared by the worker (`prompt` admission,
/// `steer`/`follow_up`/agent-message delivery, `restore_actions`, queue
/// clears/edits) and the turn runner (`turn_end` settle), which own the
/// same fields.
pub(crate) fn checkpoint_queue_recovery(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core_lock: &std::sync::Mutex<SessionCore>,
    checkpoint: QueueCheckpoint,
) {
    let mut guard = recovery.lock().unwrap();
    let Some(journal) = guard.as_mut() else {
        return;
    };
    // The lanes are read under the recovery lock (a microsecond core
    // hold — never across the journal's fsyncs, which would block every
    // concurrent command behind the write): every queue mutation that
    // persists lands its own snapshot under this same recovery lock, so
    // no persist can interleave between this read and the appends, and a
    // mutating non-persist (a runner pop) is corrected by the next
    // checkpoint's fresh read.
    let (active_session_id, session_id, session_file, lanes, turn_in_flight) = {
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
        )
    };
    let (busy, operation) = match checkpoint {
        QueueCheckpoint::Admitted { operation } => (true, operation),
        // TS computes a settled verdict from live session work
        // (`hasLiveSessionWork` — an active session counts — plus retries
        // and accepted prompts), never from the lanes alone: a withdrawal
        // landing mid-turn (queue purge, clear, drop) must not flip the
        // journal to idle while the turn still streams, or a crash in
        // that window parks live work. The turn's own settle reads the
        // idle flip first, so `turn_in_flight` is false at `turn_end`.
        QueueCheckpoint::Settle { operation } => (
            turn_in_flight || !lanes.steering.is_empty() || !lanes.follow_up.is_empty(),
            operation,
        ),
    };
    // The verdict never publishes over a snapshot that did not persist:
    // busy=true evidence must not promise a queue the journal cannot
    // replay (a skipped settled verdict keeps the previous record — the
    // worst case parks like any uncheckpointed session).
    if journal
        .record_queue_snapshot(&active_session_id, &lanes.steering, &lanes.follow_up)
        .is_err()
    {
        return;
    }
    let _ = journal.record(
        &active_session_id,
        &session_id,
        session_file.as_deref(),
        busy,
        operation,
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
            })
            .collect()
    }
    QueueLanes {
        steering: items(&core.steering),
        follow_up: items(&core.follow_up),
    }
}

/// TS `_pumpSessionInputs`'s batch gathering: the lane's front item
/// anchors the delivery; under queue mode "all" — or the forced steering
/// batch armed by `abort_and_send_queued` (TS `abortAndSendQueued`'s
/// `_forcedAllSteeringActionIds`) — the same-class prefix behind it joins
/// as co-delivered rows of ONE turn (TS `turnExecutionPoliciesEqual` +
/// the mode/armed-set gates).
///
/// Joining gates: the same turn-execution class; a plain user row (an
/// injected custom row always delivers solo — it replaces its turn's
/// user row); not a queued session command (TS batches only `turn`-kind
/// actions); and membership of the armed set while the forced batch
/// governs this delivery. The front item anchors regardless — a
/// non-batchable front delivers solo, exactly like TS's `first`.
pub(crate) fn gather_delivery_batch(core: &mut SessionCore, lane: Lane) -> Vec<QueuedItem> {
    let (items, mode) = match lane {
        Lane::Steering => (&mut core.steering, core.steering_mode.as_str()),
        Lane::FollowUp => (&mut core.follow_up, core.follow_up_mode.as_str()),
    };
    let Some(first) = items.front() else {
        return Vec::new();
    };
    // TS `_forcedAllSteeringBatch(first)`: the armed set forces "all" only
    // when the front item is armed; an un-armed front disarms the batch
    // once no armed item remains queued (a delivered item leaves the lane
    // with its flag, so the armed prefix exhausts itself). The read runs
    // before the front's delivery class — every pickup disarms an
    // exhausted arm, whatever it delivers.
    let forced = lane == Lane::Steering && core.forced_all_steering && first.forced_batch;
    let mut batch = Vec::new();
    if lane == Lane::Steering
        && core.forced_all_steering
        && !forced
        && !items.iter().any(|item| item.forced_batch)
    {
        core.forced_all_steering = false;
    }
    // The front's own delivery class decides the turn's shape before any
    // gathering (TS: the direct prompt hand-off never queues, an injected
    // custom row replaces its turn's user row, and a queued session
    // command runs as the command — none of those turns carry co-delivered
    // rows, so the front delivers solo).
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
) -> (VecDeque<QueuedItem>, VecDeque<QueuedItem>) {
    fn pending(lanes: Vec<crate::journal::WorkerQueueItemRecord>) -> VecDeque<QueuedItem> {
        // Images on a queued prompt do not survive the worker restart:
        // the recovery journal stores the delivery rows without the
        // process-local attachments (the TS command-recovery journal
        // keeps the same text-only shape for its lanes). Everything the
        // turn needs to deliver identically — the labeled preview, the
        // injected custom row, the queue key, the visibility flag —
        // rides the item record, so a restored queued heartbeat still
        // runs and persists as the `heartbeat_prompt` component.
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
                    agent_message: None,
                    queue_key: record.queue_key,
                    admission_id: None,
                    images: Vec::new(),
                    done: None,
                    queue_visible: record.queue_visible,
                    policy,
                    forced_batch: false,
                }
            })
            .collect()
    }

    let mut steering = VecDeque::new();
    let mut follow_up = VecDeque::new();
    if let Some((steering_lanes, follow_up_lanes)) =
        journal.latest_queue_snapshot(active_session_id)
    {
        steering = pending(steering_lanes);
        follow_up = pending(follow_up_lanes);
    }
    (steering, follow_up)
}

/// Admit one engine-minted goal follow-up (TS `_queuePreparedPrompt`'s
/// steer arm and the queued `followUp` admission behind
/// `_getGoalContinuationMessages` / `_maybeResumeGoalContinuationAfterRlmWork`):
/// the mint's `goal_update` surfaces at the moment the state changed
/// (durable `thread_goal_state` entry first, then the broadcast), the
/// minted turn queues into its lane (the steering lane for the
/// budget-limit wrap-up steer, the follow-up lane for the continuation),
/// and the runner wakes (`resumeIfIdle`).
/// Admit one held autonomous continuation through the follow-up lane (TS
/// `_queueAutonomousContinuationForThresholdCompaction`'s queued `followUp`
/// admission): the runner wakes, the item runs as its own queue item after
/// the current run settles.
pub(crate) fn admit_autonomous_follow_up(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<Notify>,
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
    // The admission checkpoint (busy=true): an injected continuation
    // admitted while idle (after the previous settle) is undelivered
    // live work the journal must prove — the runner records nothing at
    // pickup, so a kill between this admission and the turn's settle
    // would otherwise read as idle and park the continuation on a
    // plain boot.
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
    // The admission checkpoint (busy=true, TS's queue strings by lane):
    // a minted follow-up admitted while idle is undelivered live work
    // the journal must prove until its turn settles (same gap as the
    // autonomous continuation above).
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
    // `resumeIfIdle`: the runner re-checks the queue at its loop head, so
    // the minted turn runs as the next admitted turn.
    work_notify.notify_one();
}

/// Admit one detached kernel bash completion notice (TS
/// `bash.completed` -> `_promptInjectedMessage(message, {
/// streamingBehavior: "steer", queueIfBusy: true, resumeIfIdle: true })`):
/// the `[bash-done pid:N exit:M]` row queues on the steering lane — a
/// busy session keeps a visible steer row, an idle session wakes into
/// the turn that runs on the row. The admission carries the recovery
/// busy-evidence checkpoint, so a crash between the notice and its
/// delivery revives the worker with the row replaying (the wake
/// survives worker re-adoption and revival).
pub(crate) fn admit_bash_completion_notice(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<Notify>,
    notice: crate::engine::BashCompletionNotice,
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
        _ => String::new(),
    };
    // TS `queueVisible: visibleQueued` + the schedule's execution policy:
    // busy sessions queue a visible row, idle sessions wake on an
    // invisible injected turn. The busy sample and the push share ONE
    // critical section: a turn starting between a separate sample and
    // the push would queue an invisible row for a busy session.
    let mut core_guard = core.lock().unwrap();
    // The close paths mark the session and then clear the lanes in their
    // own core section: a notice that raced past the sink's first check
    // is refused here (the marker is visible by now), or the close's
    // clear wipes it — never a completion turn for a closed session.
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
            // TS `previewLabel` (`injectedMessagePreviewLabel` ->
            // `ASYNC_BASH_COMPLETION_PREVIEW_LABEL`): the queue strip
            // reads `Background command finished: <content>` (the TUI's
            // labeled-preview prefix).
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
    // The fire checkpoint (busy=true, TS's steering queue string): the
    // notice is undelivered live work until its turn settles — the same
    // evidence the goal/autonomous continuations record.
    checkpoint_queue_recovery(
        recovery,
        core,
        QueueCheckpoint::Admitted {
            operation: "steer_queued",
        },
    );
    // `resumeIfIdle`: the runner re-checks the queue at its loop head.
    work_notify.notify_one();
}

/// Withdraw one queued bash completion notice (TS `bash.consumed` ->
/// `_withdrawAsyncBashCompletionNotice`): the kernel read the finished
/// command's result before the notice delivered, so the undelivered row
/// cancels — one read withdraws one notice, and pids are reused across
/// handles, so the command disambiguates (`_isAsyncBashCompletionActionFor`).
pub(crate) fn withdraw_bash_completion_notice(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    notice: crate::engine::BashConsumedNotice,
) {
    let removed = {
        let mut core_guard = core.lock().unwrap();
        let before = core_guard.steering.len() + core_guard.follow_up.len();
        // TS withdraws ONE row per read ("pid reuse can queue an
        // identical key twice, and the read belongs to the older
        // handle, which is the earlier notice"): the front-most match
        // across the two lanes, never the whole set.
        let mut withdrawn = false;
        let mut withdraw_one = |item: &QueuedItem| {
            if !withdrawn && is_bash_completion_notice_for(item, &notice) {
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
        // The withdrawal refreshes the verdict (and the snapshot) so a
        // consumed notice cannot keep busy=true promising a revive the
        // withdrawn row would replay (a mid-turn withdrawal stays busy
        // through the in-flight turn).
        checkpoint_queue_recovery(
            recovery,
            core,
            QueueCheckpoint::Settle {
                operation: "queue_purged",
            },
        );
    }
}

/// Whether one queued item is the async-bash-completion notice for this
/// pid+command (TS `_isAsyncBashCompletionActionFor`: the custom row's
/// details carry both — pids alone are reused).
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
    details.get("pid").and_then(Value::as_u64) == Some(notice.pid as u64)
        && details.get("command").and_then(Value::as_str) == Some(notice.command.as_str())
}
