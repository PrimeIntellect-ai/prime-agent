//! Queued input: the item model, the lanes, admission, delivery batching,
//! and queue recovery.
use super::{
    emit_worker_event_with, json, oneshot, Arc, Duration, EventPump, Mutex, Notify, Result,
    SessionCore, Value, VecDeque, WorkerRecoveryJournal, AGENT_MESSAGE_SOURCE,
    AUTONOMOUS_QUEUE_KEY,
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

/// The `kill_if_idle` refusal (a Rust-only daemon extension, no TS
/// client sends it): the session holds a turn or queued work, so the
/// reclamation moves on — the ONE failure that means "do not stop",
/// every other failure leaves the stop's contract to the caller.
pub(crate) const KILL_IF_IDLE_HOLDS_WORK: &str = "the session holds work; refusing the idle kill";
/// The idle kill's other refusal: a live observer's connection (the
/// A2A link detaches before it asks, so any attached client left is a
/// foreign observer) never drops under a reclamation.
pub(crate) const KILL_IF_IDLE_HAS_CLIENT: &str =
    "the session holds an attached client; refusing the idle kill";

/// Whether a `kill_if_idle` answer is the worker's (or the saturated
/// route's) refusal — the ONE answer that keeps the candidate: the
/// worker's own texts (it holds a turn, queued work, or an attached
/// client) and the backpressured route's typed `worker_overloaded`
/// (the request never left the supervisor, and a worker at its
/// in-flight bound is by definition a busy one). Every other failure
/// leaves the stop's contract to the caller exactly like the
/// unconditional kill it replaces.
pub(crate) fn kill_refused_by_worker(response: &pa_types::daemon::DaemonResponse) -> bool {
    response.error_info == Some(pa_types::daemon::DaemonErrorInfo::WorkerOverloaded)
        || response.error.as_deref().is_some_and(|error| {
            error.contains(KILL_IF_IDLE_HOLDS_WORK) || error.contains(KILL_IF_IDLE_HAS_CLIENT)
        })
}

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

/// The wire text of a queued prompt withdrawn by `clear_queue` (TS
/// `clearQueue`'s `promptError` verbatim): a clear is an operator
/// action on the whole queue, not the delete of one row — the texts
/// stay distinct the way TS keeps them.
pub(crate) const QUEUED_PROMPT_CLEARED: &str = "Queued prompt was cleared before delivery.";

/// The wire text of a prompt refused because its admission was already
/// cancelled (the supervisor's cancellation ladder and the worker's
/// commit check answer with it verbatim; an A2A task settles CANCELED
/// on it).
pub(crate) const PROMPT_ADMISSION_CANCELLED: &str = "Prompt admission was cancelled.";

/// The wire text of a queued prompt withdrawn by its OWN admission's
/// cancel (TS `promptAndWait`'s abort-controller settle,
/// agent-session.ts's `Prompt was cancelled before it started.`
/// verbatim): the cancel-withdraw contract, distinct from a queue
/// mutation's delete (`QUEUED_PROMPT_DELETED`, which stays the
/// queue-delete text) and carrying the same typed cancellation kind.
pub(crate) const PROMPT_CANCELLED_BEFORE_START: &str = "Prompt was cancelled before it started.";

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
    /// The client's own admission id the delivery named, before the
    /// supervisor's rewrite (the `clientAdmissionId` wire member): the
    /// delivery's identity for event consumers — the rewritten
    /// `admission_id` is the daemon's own. `None` when the delivery
    /// named none. Never journaled (the admission's lifecycle: it does
    /// not survive a recovery).
    pub(crate) client_admission_id: Option<String>,
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
    /// The daemon's own kernel-notice provenance: `admit_kernel_notice`
    /// sets it at the producer, never the busy-dependent policy — a
    /// busy notice queues visibly like a client's steer, but it is the
    /// session's own work (the pickup mints no wire id for it and its
    /// run tags the engine-continuation source). A client can claim the
    /// notice's custom kind; it can never set this flag. Journaled with
    /// the row, so a revived worker keeps the class.
    pub(crate) kernel_notice: bool,
    /// The delivery-scoped batch isolation (the A2A prompt's
    /// `deliveryScoped` member, read at the prompt intake): the row's
    /// batch identity governs its co-delivery — a scoped row joins no
    /// batch and admits no other row, where the legacy rule (TS's) joins
    /// every compatible neighbor whatever their admissions name.
    /// Journaled with the row, so a revived worker keeps the class.
    pub(crate) delivery_scoped: bool,
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
                kernel_notice: item.kernel_notice,
                delivery_scoped: item.delivery_scoped,
                images: item.images.clone(),
            })
            .collect()
    }
    QueueLanes {
        steering: items(&core.steering),
        follow_up: items(&core.follow_up),
    }
}

/// The running turn's admission identities: every anchoring item's
/// wire admission id (the supervisor's rewrite) AND its client
/// admission id (the delivery's own identity, `clientAdmissionId`): a
/// consumer — the identity-scoped withdraw, the turn's own unwind
/// sweep — can match the running turn by either half without the
/// daemon's rewrite table.
pub(crate) fn running_admission_ids(items: &[QueuedItem]) -> std::collections::HashSet<String> {
    items
        .iter()
        .flat_map(|item| {
            item.admission_id
                .clone()
                .into_iter()
                .chain(item.client_admission_id.clone())
        })
        .collect()
}

/// The running turn's client admission ids (the delivery's own
/// identity, `clientAdmissionId` — one id per uniform batch): the
/// engine's continuation mints stamp their rows with the owning
/// delivery's client id, so an identity-scoped withdrawal of that id
/// stops the session's own continuation work with the turn that drove
/// it.
pub(crate) fn running_client_admissions(items: &[QueuedItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| item.client_admission_id.clone())
        .collect()
}

/// The running turn's wire admission ids (the supervisor-assigned
/// halves, or a WORKER-MINTED id when a CLIENT'S OWN delivery names
/// none): the continuation mint's identity FALLBACK — a plain daemon
/// prompt (the TUI's, any plain client's) carries no client id AND the
/// supervisor assigns plain prompts no wire id, so the pickup mints
/// one here and the minted rows still carry a discriminating identity
/// instead of none at all. The mint is a CLIENT-delivery tool only:
/// the session's own internal rows — the engine's continuations, the
/// daemon-provenance child-status notices — never mint. Their chains
/// stay session-owned (unstamped, credited as the session's own
/// continuation by the consumer), where a fresh worker-admission stamp
/// would name a delivery no waiting task owns and the consumer would
/// refuse every later turn of the loop as FOREIGN (the truncated
/// answer that reports success).
pub(crate) fn running_wire_admissions(items: &[QueuedItem]) -> Vec<String> {
    let mut ids: Vec<String> = items
        .iter()
        .filter_map(|item| item.admission_id.clone())
        .collect();
    if ids.is_empty()
        && items
            .first()
            .is_some_and(crate::worker::is_clients_own_delivery)
    {
        ids.push(format!("worker-admission:{}", uuid::Uuid::new_v4()));
    }
    ids
}

/// The rows an identity-scoped lane sweep dropped: each lane's
/// withdrawn messages for the caller's answer, the agent rows their
/// bounce notice, and the waiters their withdrawn settle (see
/// [`sweep_named_deliveries`]).
#[derive(Default)]
pub(crate) struct SweptDeliveries {
    pub(crate) steering: Vec<String>,
    pub(crate) follow_up: Vec<String>,
    pub(crate) agent_rows: Vec<Value>,
    pub(crate) done: Vec<oneshot::Sender<TurnSettle>>,
}

/// Remove every queued row naming one of `ids` — either identity half:
/// the wire admission id the supervisor assigned, or the client's own
/// admission id the delivery carried — from both lanes, in order: the
/// removal `withdraw_admission` answers its sweep with. A turn's own
/// unwind runs no such removal: a failed or aborted turn mints no
/// continuation (the error return precedes the goal mint and the goal
/// boundary is abort-gated), an A2A `taskId` continuation answers
/// -32004 before it ever queues, and the sibling child-status and
/// kernel notice rows are terminal results of work the delivery
/// spawned — a queued `[bash-done]` and a sibling child's notice are
/// queue-visible work `requestAbort` never cancels (the TS abort
/// demotes RLM terminal notices into the next turn's messages).
pub(crate) fn sweep_named_deliveries(
    core: &mut SessionCore,
    admissions: &crate::prompt_admission::WorkerAdmissions,
    ids: &[String],
) -> SweptDeliveries {
    let owns_admission = |item: &QueuedItem| {
        ids.iter().any(|id| {
            item.admission_id.as_deref() == Some(id.as_str())
                || item.client_admission_id.as_deref() == Some(id.as_str())
        })
    };
    let mut swept = SweptDeliveries {
        steering: Vec::new(),
        follow_up: Vec::new(),
        agent_rows: Vec::new(),
        done: Vec::new(),
    };
    for (lane, withdrawn) in [
        (&mut core.steering, &mut swept.steering),
        (&mut core.follow_up, &mut swept.follow_up),
    ] {
        let mut retained = VecDeque::with_capacity(lane.len());
        while let Some(mut item) = lane.pop_front() {
            if owns_admission(&item) {
                if let Some(id) = item.admission_id.as_deref() {
                    admissions.clear(id);
                }
                if item.agent_message.is_some() {
                    swept.agent_rows.extend(item.custom_message);
                }
                if let Some(done) = item.done.take() {
                    swept.done.push(done);
                }
                withdrawn.push(item.message);
            } else {
                retained.push_back(item);
            }
        }
        *lane = retained;
    }
    swept
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
    // The batch's delivery identity (the admission pair the anchor
    // names): the split is the DELIVERY-SCOPED rows' rule alone (the
    // A2A prompt's `deliveryScoped` flag) — a scoped row joins no batch
    // and admits no other row (an A2A taskId continuation never queues
    // at all: it answers -32004 before it reaches this worker), so the
    // match keeps one delivery's rows together without ever mixing a
    // foreign row in (a foreign-front batch would anchor the run on the
    // foreign delivery, and an admission-first batch would leak the
    // foreign row's reply into the conversation's run and mint a
    // spurious credit). Two UNSCOPED rows batch whatever their
    // admissions name — the TS-era rule: a legacy client's
    // admission-named prompts co-deliver as one turn, and their runs
    // anchor on the front row's identity exactly as TS's do.
    let first_scoped = first.delivery_scoped;
    let first_admission = (
        first.admission_id.clone(),
        first.client_admission_id.clone(),
    );
    batch.push(items.pop_front().expect("front checked"));
    if forced || mode == "all" {
        while let Some(next) = items.front() {
            if next.policy != first_policy
                || next.custom_message.is_some()
                || (forced && !next.forced_batch)
                || (first_scoped || next.delivery_scoped)
                    && (next.admission_id.clone(), next.client_admission_id.clone())
                        != first_admission
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
                    client_admission_id: None,
                    images: record.images,
                    done: None,
                    queue_visible: record.queue_visible,
                    policy,
                    forced_batch: record.forced_batch,
                    kernel_notice: record.kernel_notice,
                    delivery_scoped: record.delivery_scoped,
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
    work_notify: &Arc<Notify>,
    text: String,
) {
    {
        let mut core = core.lock().unwrap();
        // The minted continuation carries the running delivery's own
        // identity: the session's autonomous work is the delivery's
        // work, and a withdrawal naming that id (the A2A cancel of
        // the task the delivery named) sweeps the queued row and
        // aborts its running turn like any owned row. A delivery
        // without a client id (a plain daemon prompt) still names its
        // work through its wire id — the supervisor's rewrite, or the
        // worker's pickup mint for a plain delivery — the mint's
        // identity FALLBACK — so an event consumer can always tell one
        // delivery's minted rows from another's, never an unstamped
        // row every consumer would have to guess about.
        let owner = core
            .running_client_admissions
            .first()
            .or_else(|| core.running_wire_admissions.first())
            .cloned();
        core.follow_up.push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: text,
            custom_message: None,
            agent_message: None,
            queue_key: Some(AUTONOMOUS_QUEUE_KEY.to_string()),
            admission_id: None,
            client_admission_id: owner,
            images: Vec::new(),
            done: None,
            queue_visible: false,
            policy: TurnPolicy::Injected,
            forced_batch: false,
            kernel_notice: false,
            delivery_scoped: false,
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
        // The goal continuation carries the running delivery's own
        // identity (the loop the delivery's prompt started is the
        // delivery's work): a withdrawal naming that id sweeps the
        // queued continuation and aborts its running turn, and its loop
        // stop pauses the goal — an owed continuation the sweep cannot
        // reach (deferred behind unsettled children) retires with the
        // pause instead of minting behind the canceled task. A
        // delivery without a client id (a plain daemon prompt) still
        // names its work through its wire id — the supervisor's
        // rewrite, or the worker's pickup mint for a plain delivery
        // — the mint's identity FALLBACK (see
        // [`admit_autonomous_follow_up`]).
        let owner = core
            .running_client_admissions
            .first()
            .or_else(|| core.running_wire_admissions.first())
            .cloned();
        let item = QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: follow_up.request.message,
            custom_message: follow_up.request.custom_message,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            client_admission_id: owner,
            images: follow_up.request.images,
            done: None,
            queue_visible: false,
            policy: TurnPolicy::Injected,
            forced_batch: false,
            kernel_notice: false,
            delivery_scoped: false,
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
/// delivery revives with the row replaying. A bash completion row carries
/// the CREATING delivery's client admission id (the launch-time binding
/// the worker's bash-launch observer recorded): the notice turn then
/// runs as that delivery's own continuation — its frames credit to the
/// delivery's task, an identity-scoped withdrawal aborts it, and a
/// FOREIGN client's bash never credits to the awaiting A2A head.
pub(crate) fn admit_kernel_notice(
    recovery: &std::sync::Mutex<Option<WorkerRecoveryJournal>>,
    core: &Arc<Mutex<SessionCore>>,
    work_notify: &Arc<Notify>,
    notice: crate::engine::KernelNotice,
    session_is_closed: impl Fn() -> bool,
) {
    let crate::engine::KernelNotice { row, preview_label } = notice;
    let content = match &row.content {
        pa_types::ai::UserContent::Text(text) => text.clone(),
        pa_types::ai::UserContent::Blocks(_) => String::new(),
    };
    // The busy sample and the push share ONE critical section: a turn starting
    // between them would queue an invisible row for a busy session.
    let mut core_guard = core.lock().unwrap();
    // A notice that raced past the sink's first check is refused here or wiped
    // by the close's clear — never a completion turn for a closed session.
    if session_is_closed() {
        return;
    }
    // The creator binding: the completion row's pid resolves against the
    // launch table (the launch-time observation), and the binding leaves
    // with its use — one entry per launch, consumed by its own notice.
    let creator = row
        .details
        .as_ref()
        .and_then(|details| details.get("pid"))
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .and_then(|pid| {
            let creator = core_guard
                .kernel_bash_creators
                .iter()
                .position(|binding| binding.0 == pid)
                .and_then(|index| core_guard.kernel_bash_creators.remove(index))
                .map(|(_pid, creator)| creator);
            if creator.is_some() {
                core_guard.kernel_bash_activity.notify_waiters();
            }
            creator
        });
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
            client_admission_id: creator,
            images: Vec::new(),
            done: None,
            queue_visible,
            policy,
            forced_batch: false,
            // The producer's own provenance flag: busy or idle, the
            // row stays the session's kernel notice.
            kernel_notice: true,
            delivery_scoped: false,
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
    engine: Option<&dyn crate::engine::SessionEngine>,
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
        if let Some(engine) = engine {
            clear_withdrawn_progress_note(&core_guard, engine);
        }
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
