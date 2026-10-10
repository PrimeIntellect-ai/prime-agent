//! The digest inbox lane for agent messages (swarm PRs C + D, TS
//! `core/agent-message-inbox.ts` + `core/agent-message-digest-controller.ts`).
//!
//! With the digest lane enabled for a session, an inbound agent message from
//! a non-parent sender lands in a durable inbox instead of prompting; one
//! coalesced notice per batch wakes the recipient, which pulls contents with
//! `rlm.inbox.list()` / `rlm.inbox.read()`. Payloads persist as generic
//! session `custom` entries (`agent_message_inbox`), never replayed into
//! model context, so unread entries survive restarts.
//!
//! Lane ownership (PR D): senders never choose the lane — a sender always
//! prefers steering its recipient — so the receiving side decides from
//! per-recipient counters, with hysteresis (one crossed trigger switches
//! push -> digest; only every trigger relaxed below half switches back).
//! The TS daemon held one process-wide map keyed by recipient; in the Rust
//! split every session is its own worker, so the receiving worker owns the
//! controller and drops it with the session. A user pin ("push"/"digest")
//! suspends the controller entirely; "auto" returns control to it.
//!
//! Default off: push delivery keeps the exact current flow until the lane
//! is enabled (the config flag, the controller, or a pin).

use std::collections::VecDeque;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::Notify;

use super::{QueueCheckpoint, QueuePriority, QueuedItem, SessionCore, TurnPolicy};

/// TS `AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE`: the durable inbox row.
pub(crate) const AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE: &str = "agent_message_inbox";
/// TS `AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE`: the durable read marker.
pub(crate) const AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE: &str = "agent_message_inbox_read";
/// TS `AGENT_MESSAGE_DIGEST_NOTICE_CUSTOM_TYPE`: the one-per-batch wake row.
pub(crate) const AGENT_MESSAGE_DIGEST_NOTICE_CUSTOM_TYPE: &str = "agent_message_digest_notice";

/// TS `PREVIEW_MAX_CHARS`: inbox previews cap at this many chars.
const PREVIEW_MAX_CHARS: usize = 120;
/// TS digest notice sender list cap.
const DIGEST_NOTICE_MAX_SENDERS: usize = 5;
/// The trailing-5-minute window the controller's pending pressure reads
/// (TS `MessagingStats.arrivals.last5m`).
const ARRIVALS_WINDOW_MS: u64 = 5 * 60 * 1000;
/// The arrivals ring's bucket width: arrivals landing inside the same
/// second share one counted row, so the ring holds at most one row per
/// second of window however hot the push path runs (the controller reads
/// only the trailing count; a per-arrival row grew one entry per
/// delivery for the window's whole span).
const ARRIVALS_BUCKET_MS: u64 = 1_000;
/// The chars-per-token heuristic of the ingestion share (TS
/// `estimateMessagingTokens`: chars / 4 over the working context).
const CONTEXT_TOKENS_PER_CHAR: f64 = 4.0;
/// The digest inbox's admission cap: the push lane's per-session
/// pending-message bound (`DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION`),
/// applied to UNREAD inbox entries so a digested backlog never grows the
/// durable session file without bound.
const INBOX_MAX_UNREAD: usize =
    pa_core::session_engine::agent_messaging::DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION;

/// The user pin for the lane (PR D): "auto" hands control to the daemon-side
/// controller; a pinned lane never flips. The Rust port ships the controller
/// DORMANT: sessions start push-pinned (the default-off requirement — an
/// auto-armed default would flip long-running orchestrators onto the digest
/// lane and break the established parent-child reply protocol), and
/// `rlm.inbox.configure("auto")` arms the controller.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum DigestLanePin {
    Auto,
    #[default]
    Push,
    Digest,
}

impl DigestLanePin {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            DigestLanePin::Auto => "auto",
            DigestLanePin::Push => "push",
            DigestLanePin::Digest => "digest",
        }
    }
}

// ---------------------------------------------------------------------------
// Durable inbox entries (TS `AgentMessageInboxEntryData`)
// ---------------------------------------------------------------------------

/// The durable inbox entry payload (the `data` of the `agent_message_inbox`
/// custom entry). TS shape, camelCase; `kind` distinguishes delivered agent
/// messages (PR C) from watch events routed onto the digest lane (PR E).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxEntryData {
    pub message_id: String,
    pub content: String,
    pub from: InboxEndpoint,
    pub from_relationship: String,
    pub target: InboxTarget,
    pub received_at: String,
    /// `"agent_message"` for delivered reports; `"watch"` for watch events.
    #[serde(default = "default_inbox_kind")]
    pub kind: String,
    /// Present for watch entries: which watch produced the event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch: Option<String>,
}

fn default_inbox_kind() -> String {
    "agent_message".to_string()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxEndpoint {
    active_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxTarget {
    active_session_id: String,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_name: Option<String>,
}

/// One inbox record: the durable entry plus its read state.
#[derive(Debug, Clone)]
pub(crate) struct InboxRecord {
    id: String,
    data: InboxEntryData,
    read: bool,
}

impl InboxRecord {
    /// TS `AgentMessageInboxEntryView` (`rlm.inbox.list()` rows).
    #[must_use]
    pub fn view(&self) -> Value {
        json!({
            "id": self.id,
            "messageId": self.data.message_id,
            "from": endpoint_value(&self.data.from),
            "fromRelationship": self.data.from_relationship,
            "receivedAt": self.data.received_at,
            "read": self.read,
            "preview": preview(&self.data.content),
            "content": self.data.content,
            "kind": self.data.kind,
            "watch": self.data.watch,
        })
    }
}

fn endpoint_value(endpoint: &InboxEndpoint) -> Value {
    let mut value = json!({ "activeSessionId": endpoint.active_session_id });
    if let Some(name) = &endpoint.session_name {
        value["sessionName"] = json!(name);
    }
    value
}

/// TS `preview`: the first `PREVIEW_MAX_CHARS` chars plus an ellipsis.
fn preview(content: &str) -> String {
    if content.chars().count() > PREVIEW_MAX_CHARS {
        let clipped: String = content.chars().take(PREVIEW_MAX_CHARS).collect();
        format!("{clipped}...")
    } else {
        content.to_string()
    }
}

/// The store-backed inbox state: lazily loaded records keyed to the store
/// identity (a replacement session reloads from its own file).
#[derive(Debug, Default)]
struct InboxState {
    loaded_key: Option<(PathBuf, String)>,
    records: Vec<InboxRecord>,
}

impl InboxState {
    /// Load (or reload) the records from the store's durable entries: the
    /// inbox rows in file order plus the read-marker message ids. A
    /// compacted window's index omits the discarded prefix — an unread
    /// inbox entry older than the boundary must not vanish from
    /// `rlm.inbox.list()`/`read()` after a restart — so whenever the
    /// index does not cover the whole file the records hydrate from the
    /// complete durable history (the active file, which a windowed store
    /// never rewrites).
    fn load_from(&mut self, store: &crate::session_store::SessionFile) {
        let key = (store.path.clone(), store.session_id().to_string());
        if self.loaded_key.as_ref() == Some(&key) {
            return;
        }
        self.records = if store.index_covers_whole_file() {
            Self::records_from_index(store)
        } else {
            // None only when the complete history cannot be read at all
            // (the window open already proved the file readable, so this
            // is a torn open): fall back to the retained window's rows.
            Self::records_from_complete_history(&store.path)
                .unwrap_or_else(|| Self::records_from_index(store))
        };
        self.loaded_key = Some(key);
    }

    /// The records from the in-memory index (the full open, or a window
    /// that retained the whole file).
    fn records_from_index(store: &crate::session_store::SessionFile) -> Vec<InboxRecord> {
        let mut read_message_ids = std::collections::HashSet::new();
        let mut pending: Vec<InboxRecord> = Vec::new();
        for entry in store.entries() {
            if entry.type_ != "custom" {
                continue;
            }
            let custom_type = entry
                .fields
                .get("customType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if custom_type == AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE {
                if let Some(message_id) = entry
                    .fields
                    .get("data")
                    .and_then(|data| data.get("messageId"))
                    .and_then(Value::as_str)
                {
                    read_message_ids.insert(message_id.to_string());
                }
            } else if custom_type == AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE {
                if let Ok(data) = serde_json::from_value::<InboxEntryData>(
                    entry.fields.get("data").cloned().unwrap_or(Value::Null),
                ) {
                    if data.message_id.is_empty() {
                        continue;
                    }
                    pending.push(InboxRecord {
                        id: entry.id.clone(),
                        data,
                        read: false,
                    });
                }
            }
        }
        for record in &mut pending {
            record.read = read_message_ids.contains(&record.data.message_id);
        }
        pending
    }

    /// The records from the complete durable history: every line of the
    /// session file, in file order, filtered to the inbox rows and the
    /// read markers. Malformed lines (a torn tail write) are skipped.
    fn records_from_complete_history(path: &Path) -> Option<Vec<InboxRecord>> {
        let file = std::fs::File::open(path).ok()?;
        let reader = std::io::BufReader::new(file);
        let mut read_message_ids = std::collections::HashSet::new();
        let mut pending: Vec<InboxRecord> = Vec::new();
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(row) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if row.get("type").and_then(Value::as_str) != Some("custom") {
                continue;
            }
            let custom_type = row
                .get("customType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if custom_type == AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE {
                if let Some(message_id) = row
                    .get("data")
                    .and_then(|data| data.get("messageId"))
                    .and_then(Value::as_str)
                {
                    read_message_ids.insert(message_id.to_string());
                }
            } else if custom_type == AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE {
                let Some(id) = row.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if let Ok(data) = serde_json::from_value::<InboxEntryData>(
                    row.get("data").cloned().unwrap_or(Value::Null),
                ) {
                    if data.message_id.is_empty() {
                        continue;
                    }
                    pending.push(InboxRecord {
                        id: id.to_string(),
                        data,
                        read: false,
                    });
                }
            }
        }
        for record in &mut pending {
            record.read = read_message_ids.contains(&record.data.message_id);
        }
        Some(pending)
    }
}

// ---------------------------------------------------------------------------
// The digest-lane controller (PR D, TS `AgentMessageDigestController`)
// ---------------------------------------------------------------------------

/// The pre-registered trigger thresholds (PR D's design values; the
/// starvation eval exists to verify they sit at the measured crossing
/// point). Defaults in [`DigestLaneController::new`].
#[derive(Debug, Clone, Copy)]
pub(crate) struct DigestControllerOptions {
    /// Switch to digest when the arrivals EMA reaches this value (default 5).
    pub pending_ema_trigger: f64,
    /// Switch to digest when the agent-message context share reaches this
    /// value (default 0.2).
    pub ingestion_share_trigger: f64,
    /// Switch to digest when the ingestion-turn share reaches this value
    /// (default 0.3).
    pub ingestion_turn_share_trigger: f64,
    /// EMA smoothing factor per evaluation (default 0.3).
    pub ema_alpha: f64,
}

impl Default for DigestControllerOptions {
    fn default() -> Self {
        DigestControllerOptions {
            pending_ema_trigger: 5.0,
            ingestion_share_trigger: 0.2,
            ingestion_turn_share_trigger: 0.3,
            ema_alpha: 0.3,
        }
    }
}

/// The lane the session currently delivers on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DigestLaneMode {
    Push,
    Digest,
}

/// One controller evaluation's inputs (TS `AgentMessageDigestEvaluation`):
/// `None` shares are unmeasured, not crossed.
#[derive(Debug, Clone, Copy)]
pub(crate) struct DigestEvaluation {
    /// Agent-message arrivals in the trailing 5-minute window.
    pub pending: u64,
    /// Agent-message share of working context, when measurable.
    pub ingestion_share: Option<f64>,
    /// Ingestion turns over all model turns, when measurable.
    pub ingestion_turn_share: Option<f64>,
    pub current_mode: DigestLaneMode,
}

/// Why the controller answered the way it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DigestDecisionReason {
    PendingPressure,
    IngestionContextShare,
    IngestionTurnShare,
    Recovered,
    Hold,
}

/// One controller decision (TS `AgentMessageDigestDecision`). The reason
/// and the smoothed EMA keep the TS decision shape for the controller's
/// tests; production reads `mode` and `changed`.
pub(crate) struct DigestDecision {
    pub mode: DigestLaneMode,
    pub changed: bool,
    /// The TS decision shape's diagnostic fields (test-asserted).
    #[allow(dead_code)]
    pub reason: DigestDecisionReason,
    #[allow(dead_code)]
    pub pending_ema: f64,
}

/// The hysteresis controller: one crossed trigger switches push -> digest;
/// only every trigger relaxed below half its value switches back, so the
/// lane cannot flap on a borderline observation.
#[derive(Debug)]
pub(crate) struct DigestLaneController {
    options: DigestControllerOptions,
    pending_ema: f64,
    observed: bool,
}

impl Default for DigestLaneController {
    fn default() -> Self {
        DigestLaneController::new(DigestControllerOptions::default())
    }
}

impl DigestLaneController {
    #[must_use]
    pub fn new(options: DigestControllerOptions) -> Self {
        DigestLaneController {
            options,
            pending_ema: 0.0,
            observed: false,
        }
    }

    /// Evaluate one delivery window. Event-driven: the delivery path calls
    /// this before each inbound agent-message delivery, never on a timer.
    pub fn evaluate(&mut self, input: DigestEvaluation) -> DigestDecision {
        self.pending_ema = if self.observed {
            self.options.ema_alpha * input.pending as f64
                + (1.0 - self.options.ema_alpha) * self.pending_ema
        } else {
            input.pending as f64
        };
        self.observed = true;

        if input.current_mode == DigestLaneMode::Push {
            // Any single trigger crossed: switch before starvation compounds.
            if self.pending_ema >= self.options.pending_ema_trigger {
                return DigestDecision {
                    mode: DigestLaneMode::Digest,
                    changed: true,
                    reason: DigestDecisionReason::PendingPressure,
                    pending_ema: self.pending_ema,
                };
            }
            if input
                .ingestion_share
                .is_some_and(|share| share >= self.options.ingestion_share_trigger)
            {
                return DigestDecision {
                    mode: DigestLaneMode::Digest,
                    changed: true,
                    reason: DigestDecisionReason::IngestionContextShare,
                    pending_ema: self.pending_ema,
                };
            }
            if input
                .ingestion_turn_share
                .is_some_and(|share| share >= self.options.ingestion_turn_share_trigger)
            {
                return DigestDecision {
                    mode: DigestLaneMode::Digest,
                    changed: true,
                    reason: DigestDecisionReason::IngestionTurnShare,
                    pending_ema: self.pending_ema,
                };
            }
            return DigestDecision {
                mode: DigestLaneMode::Push,
                changed: false,
                reason: DigestDecisionReason::Hold,
                pending_ema: self.pending_ema,
            };
        }

        // Digest -> push only when every trigger is relaxed below half value.
        let recovered = self.pending_ema < self.options.pending_ema_trigger / 2.0
            && input
                .ingestion_share
                .is_none_or(|share| share < self.options.ingestion_share_trigger / 2.0)
            && input
                .ingestion_turn_share
                .is_none_or(|share| share < self.options.ingestion_turn_share_trigger / 2.0);
        DigestDecision {
            mode: if recovered {
                DigestLaneMode::Push
            } else {
                DigestLaneMode::Digest
            },
            changed: recovered,
            reason: if recovered {
                DigestDecisionReason::Recovered
            } else {
                DigestDecisionReason::Hold
            },
            pending_ema: self.pending_ema,
        }
    }
}

// ---------------------------------------------------------------------------
// Per-session counters (the controller's trigger inputs)
// ---------------------------------------------------------------------------

/// One counted slice of the arrivals ring: every arrival landing inside
/// the same [`ARRIVALS_BUCKET_MS`]-wide slice shares this row, so the
/// ring stays bounded at one row per slice of window under sustained
/// traffic (the count is all the controller reads).
#[derive(Debug, Default)]
struct ArrivalsBucket {
    start_ms: u64,
    count: u64,
}

/// The receiving worker's trigger counters. The TS controller read the
/// instrumentation counters of PR A (`messaging_stats`); that
/// instrumentation is not part of this port, so the digest lane owns the
/// minimal counters it needs: the arrivals window (a 5-minute ring), the
/// model/ingestion turn counts (turn-granular, the worker-side equivalent
/// of the TS assistant-step counters), and the controller state itself.
#[derive(Debug, Default)]
struct DigestCounters {
    arrivals: VecDeque<ArrivalsBucket>,
    controller: DigestLaneController,
}

impl DigestCounters {
    fn record_arrival(&mut self, now_ms: u64) {
        let start_ms = now_ms / ARRIVALS_BUCKET_MS * ARRIVALS_BUCKET_MS;
        self.prune_arrivals(now_ms);
        match self.arrivals.back_mut() {
            Some(bucket) if bucket.start_ms == start_ms => bucket.count += 1,
            _ => self
                .arrivals
                .push_back(ArrivalsBucket { start_ms, count: 1 }),
        }
    }

    fn prune_arrivals(&mut self, now_ms: u64) {
        // A bucket's last arrival sits at start_ms + bucket width; the
        // bucket leaves the window once even that newest arrival is older
        // than the trailing window (the same edge the per-arrival stamps
        // pruned on, applied at bucket granularity).
        while self.arrivals.front().is_some_and(|bucket| {
            now_ms.saturating_sub(bucket.start_ms + ARRIVALS_BUCKET_MS) >= ARRIVALS_WINDOW_MS
        }) {
            self.arrivals.pop_front();
        }
    }

    fn arrivals_last_5m(&mut self, now_ms: u64) -> u64 {
        self.prune_arrivals(now_ms);
        self.arrivals.iter().map(|bucket| bucket.count).sum()
    }
}

// ---------------------------------------------------------------------------
// The digest lane manager (receiving-worker side)
// ---------------------------------------------------------------------------

/// The receiving worker's digest lane: the durable inbox, the user pin,
/// the controller with its counters, and the notice admission/withdrawal
/// through the worker's queue lanes.
pub(crate) struct AgentMessageDigest {
    core: Arc<Mutex<SessionCore>>,
    recovery: Arc<Mutex<Option<crate::journal::WorkerRecoveryJournal>>>,
    work_notify: Arc<Notify>,
    inbox: Mutex<InboxState>,
    counters: Mutex<DigestCounters>,
    /// The model/ingestion turn counts, lock-free on purpose: the turn
    /// runner counts from inside its event path (after the abort gate,
    /// while it HOLDS the core lock), and the controller reads them while
    /// holding the counters lock and taking the core lock — a counter
    /// mutex taken under the core lock would invert that order (ABBA).
    model_turns: std::sync::atomic::AtomicU64,
    ingestion_turns: std::sync::atomic::AtomicU64,
}

impl AgentMessageDigest {
    pub(crate) fn new(
        core: Arc<Mutex<SessionCore>>,
        recovery: Arc<Mutex<Option<crate::journal::WorkerRecoveryJournal>>>,
        work_notify: Arc<Notify>,
    ) -> Self {
        AgentMessageDigest {
            core,
            recovery,
            work_notify,
            inbox: Mutex::new(InboxState::default()),
            counters: Mutex::new(DigestCounters::default()),
            model_turns: std::sync::atomic::AtomicU64::new(0),
            ingestion_turns: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Record one accepted inbound agent message (both lanes, TS
    /// `MessagingStats`' arrivals definition: every accepted arrival —
    /// never a rejected one, so retries against a full queue or inbox do
    /// not pin the pending-pressure EMA above the recovery
    /// half-threshold). The digest lane records at its durable append
    /// ([`Self::route_inbound_message`]); the push lane records at the
    /// delivery path's enqueue (the caller's queue cap is the push
    /// lane's admission).
    pub(crate) fn record_arrival(&self, now_ms: u64) {
        self.counters
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .record_arrival(now_ms);
    }

    /// Count one model turn (an assistant row the worker persisted, TS's
    /// per-step counter at turn granularity); an ingestion turn is one
    /// whose turn was driven by an agent-message delivery. Lock-free (see
    /// the struct docs) so it stays safe under the caller's core lock.
    pub(crate) fn note_model_turn(&self, ingestion: bool) {
        use std::sync::atomic::Ordering::Relaxed;
        self.model_turns.fetch_add(1, Relaxed);
        self.ingestion_turns
            .fetch_add(u64::from(ingestion), Relaxed);
    }

    /// The ingestion-turn share over all model turns.
    fn ingestion_turn_share(&self) -> Option<f64> {
        use std::sync::atomic::Ordering::Relaxed;
        let model_turns = self.model_turns.load(Relaxed);
        let ingestion_turns = self.ingestion_turns.load(Relaxed);
        (model_turns > 0).then(|| ingestion_turns as f64 / model_turns as f64)
    }

    /// Reset the core-held lane state (the pin + the mode) — the part of
    /// a session replacement's reset ([`Self::reset_for_replacement`],
    /// driven by `SessionNavigation::replace_session`) that touches the
    /// core-held fields. The TS `AgentSession` was per-session, so its
    /// replacement started with the default lane; the new Rust session
    /// inherits neither the retired session's pin nor its mode. The
    /// caller holds the core lock.
    pub(crate) fn reset_lane_state_locked(core: &mut SessionCore) {
        core.agent_message_digest_mode = false;
        core.agent_message_digest_pin = DigestLanePin::default();
    }

    /// The session-replacement reset: ONE `[counters -> core]` hold
    /// covering the store swap (the `swap` closure), the lane reset, and
    /// the counters reset. The delivery path evaluates under the same
    /// order (counters first, then core — nesting them the other way
    /// would invert that order and deadlock), and the turn runner
    /// accounts its turns while holding the core lock, so nothing can
    /// interleave the reset: neither a retired session's in-flight
    /// delivery can populate the replacement's fresh counters nor the
    /// replacement's early traffic can be erased by the reset.
    pub(crate) fn reset_for_replacement<R>(&self, swap: impl FnOnce(&mut SessionCore) -> R) -> R {
        let mut counters = self
            .counters
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let swapped = swap(&mut core);
        Self::reset_lane_state_locked(&mut core);
        counters.arrivals.clear();
        counters.controller = DigestLaneController::default();
        self.model_turns
            .store(0, std::sync::atomic::Ordering::Relaxed);
        self.ingestion_turns
            .store(0, std::sync::atomic::Ordering::Relaxed);
        swapped
    }

    /// The user pin (`rlm.inbox.configure`, PR D): "push"/"digest" fixes
    /// delivery and suspends the controller; "auto" returns control.
    ///
    /// # Errors
    ///
    /// Returns an error when `mode` is not `"auto"`, `"push"`, or `"digest"`.
    pub(crate) fn configure_pin(&self, mode: &str) -> anyhow::Result<Value> {
        let pin = match mode {
            "auto" => DigestLanePin::Auto,
            "push" => DigestLanePin::Push,
            "digest" => DigestLanePin::Digest,
            _ => {
                anyhow::bail!("rlm.inbox.configure mode must be \"auto\", \"push\", or \"digest\"")
            }
        };
        let digest = {
            let mut core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            core.agent_message_digest_pin = pin;
            if pin != DigestLanePin::Auto {
                core.agent_message_digest_mode = pin == DigestLanePin::Digest;
            }
            core.agent_message_digest_mode
        };
        Ok(json!({
            "mode": pin.as_str(),
            "pinned": pin != DigestLanePin::Auto,
            "digest": digest,
        }))
    }

    /// The daemon-side lane decision (PR D): evaluate the controller before
    /// one inbound delivery, flip the session's lane when it says so, then
    /// decide whether THIS delivery digests. Parent-to-child instructions
    /// always stay push; a user pin suspends the controller entirely.
    fn evaluate_and_decide(&self, now_ms: u64, sender_is_parent: bool) -> bool {
        let mut counters = self
            .counters
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if core.agent_message_digest_pin == DigestLanePin::Auto {
            let pending = counters.arrivals_last_5m(now_ms);
            let ingestion_share = context_share_locked(&core);
            let ingestion_turn_share = self.ingestion_turn_share();
            let decision = counters.controller.evaluate(DigestEvaluation {
                pending,
                ingestion_share,
                ingestion_turn_share,
                current_mode: if core.agent_message_digest_mode {
                    DigestLaneMode::Digest
                } else {
                    DigestLaneMode::Push
                },
            });
            if decision.changed {
                core.agent_message_digest_mode = decision.mode == DigestLaneMode::Digest;
            }
        }
        // The hard boundary regardless of the lane: a parent steering this
        // session is never digested.
        core.agent_message_digest_mode && !sender_is_parent
    }

    /// The full pre-delivery routing for one inbound agent message (PR C):
    /// run the daemon-side lane decision and — on the digest lane — store
    /// the payload durably and ensure the one-per-batch notice. The
    /// arrival records only at acceptance: on the digest lane after the
    /// durable append succeeds (a failed append or the unread-entry cap
    /// refusal below answers the delivery failure instead), and on the
    /// push lane at the delivery path's enqueue. Returns `None` for the
    /// push lane (the caller runs the existing delivery unchanged; the
    /// caller's queue cap is the push lane's admission, so a rejected
    /// delivery never records).
    pub(crate) fn route_inbound_message(
        &self,
        message_id: &str,
        message: &str,
        sender: &Value,
        from_relationship: Option<&str>,
    ) -> anyhow::Result<Option<Value>> {
        let now_ms = crate::util::now_ms();
        let sender_is_parent = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            sender_is_parent_of(sender, &core)
        };
        if !self.evaluate_and_decide(now_ms, sender_is_parent) {
            return Ok(None);
        }
        // The inbox admission cap (the push lane's pending-message bound,
        // applied to unread inbox entries) rides the append's ONE lock
        // section (see [`Self::append_inbox_message`]): the dispatcher runs
        // deliveries concurrently, so a separate check-then-append would
        // let every in-flight delivery observe the cap and append past it.
        let Some((target, digest_at)) =
            self.append_inbox_message(message_id, message, sender, from_relationship)?
        else {
            // The lane flipped to push between the evaluate and the
            // append (a session replacement reset it): the push path
            // delivers this message instead.
            return Ok(None);
        };
        // Accepted: the entry reached the durable store (the arrivals
        // ring counts it — never the rejected attempts above).
        self.record_arrival(now_ms);
        self.ensure_digest_notice();
        Ok(Some(json!({
            "target": target,
            "digestAt": digest_at,
        })))
    }

    /// Store one agent message durably and return the receipt's target
    /// endpoint plus the digest timestamp, or `None` when the lane is no
    /// longer digest under this hold.
    ///
    /// Both the admission cap and the lane re-validation run inside this
    /// ONE inbox+core lock section. The cap: the dispatcher delivers
    /// agent messages concurrently, so a cap check in a separate section
    /// could let every in-flight delivery observe the cap and append past
    /// it — the durable inbox must never grow beyond its advertised
    /// bound. The lane: the delivery's evaluate ran in an earlier lock
    /// section, and a session replacement (one atomic store swap + pin
    /// reset) may have completed in between — a stale digest decision
    /// must never append into the replacement's store (replacements
    /// start push-pinned), so the lane is re-read here and a flipped
    /// lane answers `None` (the caller runs the push path).
    ///
    /// # Errors
    ///
    /// Returns the store's error when the durable append fails, and the
    /// capacity error when the unread inbox is at its admission cap.
    fn append_inbox_message(
        &self,
        message_id: &str,
        message: &str,
        sender: &Value,
        from_relationship: Option<&str>,
    ) -> anyhow::Result<Option<(Value, String)>> {
        let mut inbox = self
            .inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !core.agent_message_digest_mode {
            return Ok(None);
        }
        if let Some(store) = core.store.as_ref() {
            inbox.load_from(store);
        }
        let unread = inbox.records.iter().filter(|record| !record.read).count();
        if unread >= INBOX_MAX_UNREAD {
            anyhow::bail!(
                "Target session has too many pending messages: {INBOX_MAX_UNREAD} unread inbox entries, limit is {INBOX_MAX_UNREAD}"
            );
        }
        let received_at = crate::util::now_iso();
        let from = InboxEndpoint {
            active_session_id: sender
                .get("activeSessionId")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            session_name: sender
                .get("sessionName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_string),
        };
        let target = Self::target_value_locked(&core);
        let data = InboxEntryData {
            message_id: message_id.to_string(),
            content: message.to_string(),
            from,
            from_relationship: from_relationship.unwrap_or("sibling").to_string(),
            target: InboxTarget {
                active_session_id: target
                    .get("activeSessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                session_id: target
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                session_name: target
                    .get("sessionName")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
            received_at: received_at.clone(),
            kind: "agent_message".to_string(),
            watch: None,
        };
        Self::append_entry_locked(&mut inbox, &mut core, &data)?;
        Ok(Some((target, received_at)))
    }

    /// The receiving session's endpoint (TS `createAgentSessionMessageEndpoint`):
    /// the receipt's `target` and the inbox entry's target share this shape.
    fn target_value_locked(core: &SessionCore) -> Value {
        let store = core.store.as_ref();
        let mut target = json!({
            "activeSessionId": core.active_session_id,
            "sessionId": store.map(|store| store.session_id().to_string()).unwrap_or_default(),
            "runtimeKind": core.runtime_kind,
        });
        if let Some(name) = store
            .and_then(|store| store.session_name())
            .filter(|name| !name.is_empty())
        {
            target["sessionName"] = json!(name);
        }
        target
    }

    /// Append one inbox entry durably (the `agent_message_inbox` custom
    /// entry) and to the in-memory records. The durable write propagates
    /// its error (TS `appendCustomEntryWithRollback` throws): a digested
    /// message is only accepted once its entry reached the session file —
    /// an in-memory-only record would silently vanish on restart. A worker
    /// without a session store keeps the entry in memory only (the records
    /// still serve; no durable write was possible).
    ///
    /// # Errors
    ///
    /// Returns the store's error when the durable append fails.
    fn append_entry_locked(
        inbox: &mut InboxState,
        core: &mut SessionCore,
        data: &InboxEntryData,
    ) -> anyhow::Result<()> {
        let id = match core.store.as_mut() {
            Some(store) => {
                let entry = json!({
                    "customType": AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE,
                    "data": data,
                });
                match store.persist_entry("custom", entry) {
                    Ok(id) => id,
                    Err(error) => {
                        // The failed append can be pre- OR post-write: the
                        // lease append's fsync errors AFTER the bytes
                        // reached the session file, while the store's
                        // in-memory index only records a successful
                        // append. A row that verifiably reached the file IS
                        // the digested delivery (TS: accepted once its
                        // entry reached the session file) — accept it so
                        // the sender never retries a duplicate.
                        if let Some(row) = core
                            .store
                            .as_ref()
                            .filter(|store| !store.path.as_os_str().is_empty())
                            .and_then(|store| {
                                Self::durable_inbox_row(&store.path, &data.message_id)
                            })
                        {
                            // Adopt the durable row into the store's index
                            // (the index-after-append step never ran): a
                            // later cache invalidation reloads from the
                            // index, and a session rewrite serializes it —
                            // without the adoption either one would drop
                            // or erase the row the receipt just accepted.
                            if let Some(store) = core.store.as_mut() {
                                let _ = store.index_durable_row(&row);
                            }
                            let id = row
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            inbox.records.push(InboxRecord {
                                id,
                                data: data.clone(),
                                read: false,
                            });
                            return Ok(());
                        }
                        // No durable row (a pre-write failure): the
                        // in-memory records must not keep trusting the
                        // pre-append load either — invalidate the loaded
                        // key so the next inbox access reloads the store's
                        // index (whatever it knows; a reload from the file
                        // happens at the next worker restart, which opens
                        // and indexes the durable rows).
                        inbox.loaded_key = None;
                        return Err(error);
                    }
                }
            }
            None => String::new(),
        };
        inbox.records.push(InboxRecord {
            id,
            data: data.clone(),
            read: false,
        });
        Ok(())
    }

    /// The durable reconciliation for a failed append (the post-write
    /// class): the lease append's fsync errors AFTER the bytes reached
    /// the session file, so the row may be durable while the store's
    /// in-memory index (built only on a successful append) lacks it.
    /// Scan the file itself for the row this append minted and answer
    /// its entry id.
    fn durable_inbox_row(store_path: &PathBuf, message_id: &str) -> Option<Value> {
        let content = std::fs::read_to_string(store_path).ok()?;
        crate::session_store::parse_session_entries(&content)
            .into_iter()
            .find(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("custom")
                    && entry.get("customType").and_then(Value::as_str)
                        == Some(AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE)
                    && entry
                        .get("data")
                        .and_then(|data| data.get("messageId"))
                        .and_then(Value::as_str)
                        == Some(message_id)
            })
    }

    /// Store one watch event (agent or job) on the digest lane (PR E):
    /// a `watch`-kinded inbox entry. The caller holds the inbox and core
    /// locks (the admission cap rides the same section).
    fn append_watch_locked(
        inbox: &mut InboxState,
        core: &mut SessionCore,
        watch: &str,
        content: &str,
    ) {
        let received_at = crate::util::now_iso();
        let data = InboxEntryData {
            message_id: format!(
                "watch-{watch}-{}-{}",
                crate::util::now_ms(),
                uuid::Uuid::new_v4().simple()
            ),
            content: content.to_string(),
            from: InboxEndpoint {
                active_session_id: "watch".to_string(),
                session_name: None,
            },
            from_relationship: "watch".to_string(),
            target: InboxTarget {
                active_session_id: "watch".to_string(),
                session_id: "watch".to_string(),
                session_name: None,
            },
            received_at,
            kind: "watch".to_string(),
            watch: Some(watch.to_string()),
        };
        let _ = Self::append_entry_locked(inbox, core, &data);
    }

    /// The unread/total counts of the durable inbox.
    fn inbox_records(&self) -> Vec<InboxRecord> {
        let mut inbox = self
            .inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(store) = core.store.as_ref() {
            inbox.load_from(store);
        }
        inbox.records.clone()
    }

    /// The `rlm.inbox.list()` snapshot: entries, unread, total.
    pub(crate) fn inbox_snapshot(&self) -> Value {
        let records = self.inbox_records();
        let unread = records.iter().filter(|record| !record.read).count();
        json!({
            "entries": records.iter().map(InboxRecord::view).collect::<Vec<_>>(),
            "unread": unread,
            "total": records.len(),
        })
    }

    /// The `rlm.inbox.read()` body (PR C): mark entries read (durable
    /// marker), return their full contents, and cancel a still-pending
    /// notice once everything is read. Without ids, reads every unread
    /// entry; unknown ids are ignored.
    pub(crate) fn read_inbox(&self, ids: Option<Vec<String>>) -> anyhow::Result<Value> {
        let mut inbox = self
            .inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let wanted = ids.map(|ids| ids.into_iter().collect::<std::collections::HashSet<_>>());
        let mut entries: Vec<Value> = Vec::new();
        {
            // ONE inbox+core hold across the load and the marker writes:
            // the load reads the store's records and the writes persist
            // read markers into the store, and a session replacement
            // (which swaps `core.store` without ever taking the inbox
            // lock) could land in a gap between two holds — the retired
            // session's markers would append into the replacement's file
            // and the retired store would never record the read.
            let mut core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(store) = core.store.as_ref() {
                inbox.load_from(store);
            }
            for record in &mut inbox.records {
                let matches = match &wanted {
                    Some(wanted) => wanted.contains(&record.id),
                    None => !record.read,
                };
                if !matches {
                    continue;
                }
                if !record.read {
                    // The durable read marker writes BEFORE the record
                    // flips (a failed write answers an error instead of
                    // marking an unread entry read — a restart must never
                    // silently redeliver it). A failed write must also
                    // never hide what the batch already marked: the call
                    // answers the entries whose markers are durable, the
                    // failing (and every later) record stays unread and
                    // re-reads on the next pull, where the failure
                    // surfaces again on an empty batch. Only a failure
                    // with NOTHING marked stays loud as an error.
                    let mut marker_failed = false;
                    if let Some(store) = core.store.as_mut() {
                        if let Err(error) = store.persist_entry(
                            "custom",
                            json!({
                                "customType": AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE,
                                "data": { "messageId": record.data.message_id },
                            }),
                        ) {
                            if entries.is_empty() {
                                return Err(error);
                            }
                            marker_failed = true;
                        } else {
                            record.read = true;
                        }
                    } else {
                        record.read = true;
                    }
                    if marker_failed {
                        break;
                    }
                }
                entries.push(record.view());
            }
        }
        let unread = inbox.records.iter().filter(|record| !record.read).count();
        if unread == 0 {
            self.withdraw_pending_digest_notices();
        }
        Ok(json!({ "entries": entries, "unread": unread }))
    }

    /// TS `_ensureAgentMessageDigestNotice`: one live notice covers the
    /// whole batch; later arrivals wait for the recipient to pull them
    /// with `rlm.inbox.read()` in that turn. Quiet (queue-invisible,
    /// injected) on the follow-up lane; an idle session wakes on it.
    ///
    /// The unread snapshot, the one-live-notice check, and the enqueue
    /// share ONE inbox+core hold: a concurrent `read_inbox` (which holds
    /// the inbox lock across its whole body, including the fully-read
    /// withdrawal) cannot slip between the check and the enqueue, so a
    /// notice never lands for an inbox the read already emptied — the
    /// stale wake the two-section form allowed.
    pub(crate) fn ensure_digest_notice(&self) {
        let mut inbox = self
            .inbox
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(store) = core.store.as_ref() {
            inbox.load_from(store);
        }
        let unread: Vec<&InboxRecord> =
            inbox.records.iter().filter(|record| !record.read).collect();
        if unread.is_empty() {
            return;
        }
        if core.shutdown_requested {
            return;
        }
        // The one-live-notice check: a pending digest notice covers the batch.
        let notice_pending = core
            .follow_up
            .iter()
            .chain(core.steering.iter())
            .any(is_digest_notice_item);
        if notice_pending {
            return;
        }
        let senders: Vec<String> = {
            let mut senders = Vec::new();
            for record in &unread {
                let sender = record
                    .data
                    .from
                    .session_name
                    .clone()
                    .unwrap_or_else(|| record.data.from.active_session_id.clone());
                if !senders.contains(&sender) {
                    senders.push(sender);
                }
            }
            senders
        };
        let content = digest_notice_content(unread.len(), &senders);
        let row = json!({
            "role": "custom",
            "customType": AGENT_MESSAGE_DIGEST_NOTICE_CUSTOM_TYPE,
            "content": content,
            "display": false,
            "details": Value::Null,
            "timestamp": crate::util::now_ms(),
        });
        core.follow_up.push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: content,
            custom_message: Some(row),
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            // TS `queueVisible: false`: the notice never shows as a queue
            // row; the turn still wakes an idle session.
            queue_visible: false,
            policy: TurnPolicy::Injected,
            forced_batch: false,
        });
        drop(inbox);
        drop(core);
        super::checkpoint_queue_recovery(
            &self.recovery,
            &self.core,
            QueueCheckpoint::Admitted {
                operation: "follow_up_queued",
            },
        );
        self.work_notify.notify_one();
    }
    /// TS `_cancelPendingDigestNotices`: withdraw every undelivered digest
    /// notice once the inbox is fully read (a read-before-delivery cancels
    /// the pending wake).
    fn withdraw_pending_digest_notices(&self) {
        let removed = {
            let mut core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let before = core.steering.len() + core.follow_up.len();
            core.steering.retain(|item| !is_digest_notice_item(item));
            core.follow_up.retain(|item| !is_digest_notice_item(item));
            before != core.steering.len() + core.follow_up.len()
        };
        if removed {
            super::checkpoint_queue_recovery(
                &self.recovery,
                &self.core,
                QueueCheckpoint::Settle {
                    operation: "queue_purged",
                },
            );
        }
    }

    /// Route one watch event (agent or job, PR E) through the notice
    /// pipeline: on the digest lane the event lands in the inbox (one
    /// coalesced notice per batch); on the push lane it injects the same
    /// quiet notice the async-bash completions ride (queue-if-busy,
    /// resume-if-idle), never content beyond the range.
    pub(crate) fn emit_watch_notice(&self, watch: &str, target: &str, content: &str) {
        let digest = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            core.agent_message_digest_mode
        };
        if digest {
            // The same admission cap as digested messages: a watch event at
            // a full inbox is dropped quietly (advisory range notices never
            // grow the durable file past the bound). The capacity check and
            // the append run in ONE inbox+core lock section — watch events
            // arrive concurrently with message deliveries, and a separate
            // check-then-append could let them all observe the cap and
            // append past it. The lane re-validation rides the same hold:
            // the mode was read in an earlier section, and a session
            // replacement (store swap + pin reset) may have completed in
            // between — the retired session's watch event must not land
            // in the replacement's store (the replacement's own poll
            // passes re-emit from its own baselines). The event drops
            // quietly on a flipped lane.
            {
                let mut inbox = self
                    .inbox
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut core = self
                    .core
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if core.agent_message_digest_mode {
                    if let Some(store) = core.store.as_ref() {
                        inbox.load_from(store);
                    }
                    let unread = inbox.records.iter().filter(|record| !record.read).count();
                    if unread < INBOX_MAX_UNREAD {
                        Self::append_watch_locked(&mut inbox, &mut core, watch, content);
                    }
                }
            }
            self.ensure_digest_notice();
            return;
        }
        let mut core = self
            .core
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if core.shutdown_requested {
            return;
        }
        // The coalescing bound on a busy session: the 5-second poller can
        // emit faster than the runner drains, and one queued notice per
        // event would pile onto the steering lane unbounded (up to 64
        // watches x 12 polls/minute for the busy turn's whole duration).
        // One UNDELIVERED push-lane notice per watch TARGET: the newest
        // event supersedes the pending row's content (the ranges are
        // advisory; the newest one always reflects that target's latest
        // state). Distinct children and distinct jobs keep their own row
        // — one pending row per coarse watch kind would drop every
        // target's range except the last one the pass emitted.
        if let Some(pending) = core
            .steering
            .iter_mut()
            .find(|item| is_push_watch_notice_for(item, watch, target))
        {
            pending.message = content.to_string();
            if let Some(row) = pending.custom_message.as_mut() {
                row["content"] = json!(content);
                row["timestamp"] = json!(crate::util::now_ms());
            }
            return;
        }
        let row = json!({
            "role": "custom",
            "customType": crate::agent_watch::AGENT_WATCH_NOTICE_CUSTOM_TYPE,
            "content": content,
            "display": false,
            "details": { "watch": watch, "target": target },
            "timestamp": crate::util::now_ms(),
        });
        let (policy, queue_visible) = if core.busy {
            (TurnPolicy::Queued, true)
        } else {
            (TurnPolicy::Injected, false)
        };
        core.steering.push_back(QueuedItem {
            priority: QueuePriority::Background,
            preview: None,
            message: content.to_string(),
            custom_message: Some(row),
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible,
            policy,
            forced_batch: false,
        });
        drop(core);
        super::checkpoint_queue_recovery(
            &self.recovery,
            &self.core,
            QueueCheckpoint::Admitted {
                operation: "steer_queued",
            },
        );
        self.work_notify.notify_one();
    }
}

/// Whether one queued item is an UNDELIVERED push-lane watch notice for
/// the given watch and TARGET (the coalescing key: one pending row per
/// watched target, never per coarse watch kind).
fn is_push_watch_notice_for(item: &QueuedItem, watch: &str, target: &str) -> bool {
    let details = item
        .custom_message
        .as_ref()
        .and_then(|row| row.get("details"));
    item.custom_message
        .as_ref()
        .and_then(|row| row.get("customType"))
        .and_then(Value::as_str)
        == Some(crate::agent_watch::AGENT_WATCH_NOTICE_CUSTOM_TYPE)
        && details
            .and_then(|details| details.get("watch"))
            .and_then(Value::as_str)
            == Some(watch)
        && details
            .and_then(|details| details.get("target"))
            .and_then(Value::as_str)
            == Some(target)
}

/// Whether one queued item is an undelivered digest notice.
fn is_digest_notice_item(item: &QueuedItem) -> bool {
    item.custom_message
        .as_ref()
        .and_then(|row| row.get("customType"))
        .and_then(Value::as_str)
        == Some(AGENT_MESSAGE_DIGEST_NOTICE_CUSTOM_TYPE)
}

/// TS `createAgentMessageDigestNoticeContent` (post-PR-E wording: the inbox
/// carries agent messages and watch events): the one-per-batch wake text.
#[must_use]
pub(crate) fn digest_notice_content(unread_count: usize, senders: &[String]) -> String {
    let sender_list = senders
        .iter()
        .take(DIGEST_NOTICE_MAX_SENDERS)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let from = if sender_list.is_empty() {
        String::new()
    } else if senders.len() > DIGEST_NOTICE_MAX_SENDERS {
        format!(" (from: {sender_list}, ...)")
    } else {
        format!(" (from: {sender_list})")
    };
    format!(
        "You have {unread_count} unread inbox item{} in your inbox{from}.\n\
         List them with `await rlm.inbox.list()` or read all of them with `await rlm.inbox.read()`.",
        if unread_count == 1 { "" } else { "s" }
    )
}

/// Whether the delivery's sender is THIS session's parent (the durable
/// parent edge): parent-to-child instructions always stay push.
fn sender_is_parent_of(sender: &Value, core: &SessionCore) -> bool {
    let sender_id = |key: &str| {
        sender
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    if let Some(parent) = core.parent_session_id.as_deref() {
        if sender_id("sessionId") == Some(parent) {
            return true;
        }
    }
    if let Some(parent) = core.parent_active_session_id.as_deref() {
        if sender_id("activeSessionId") == Some(parent) {
            return true;
        }
    }
    false
}

/// The ingestion context share (the TS heuristic estimate of PR A): agent-
/// message tokens (chars/4 over the delivered `agent_message` custom rows
/// in the working window) over the last assistant usage's context tokens.
/// `None` when either side is unmeasured — unmeasured never triggers.
fn context_share_locked(core: &SessionCore) -> Option<f64> {
    let store = core.store.as_ref()?;
    // One reversed pass over the ACTIVE BRANCH (the parent chain from the
    // leaf — the model's real working context) collects both inputs: the
    // newest assistant usage (the context-token denominator) and EVERY
    // delivered `agent_message` custom row on it. The whole-file walk the
    // first round used also counted abandoned-branch rows and entries the
    // working context dropped.
    let branch = store.branch();
    let mut context_tokens: Option<u64> = None;
    let mut agent_message_chars: usize = 0;
    for entry in branch.iter().rev() {
        if entry.type_ == "message" {
            let message = entry.fields.get("message");
            let role = message
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str);
            let usage = message
                .and_then(|message| message.get("usage"))
                .filter(|usage| !usage.is_null());
            if role == Some("assistant") && context_tokens.is_none() {
                let Some(usage) = usage else {
                    continue;
                };
                context_tokens = Some(
                    usage
                        .get("input")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .saturating_add(usage.get("cacheRead").and_then(Value::as_u64).unwrap_or(0))
                        .saturating_add(
                            usage.get("cacheWrite").and_then(Value::as_u64).unwrap_or(0),
                        ),
                );
            }
        }
        if entry.type_ == "custom_message"
            && entry.fields.get("customType").and_then(Value::as_str)
                == Some(pa_core::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE)
        {
            let content = entry.fields.get("content").cloned().unwrap_or(Value::Null);
            let text = match &content {
                Value::String(text) => Some(text.clone()),
                Value::Object(map) => map.get("text").and_then(Value::as_str).map(str::to_string),
                _ => None,
            };
            if let Some(text) = text {
                agent_message_chars += text.chars().count();
            }
        }
    }
    let context_tokens = context_tokens.filter(|tokens| *tokens > 0)?;
    let estimated = agent_message_chars as f64 / CONTEXT_TOKENS_PER_CHAR;
    Some(estimated / context_tokens as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evaluation(
        pending: u64,
        ingestion_share: Option<f64>,
        ingestion_turn_share: Option<f64>,
        current_mode: DigestLaneMode,
    ) -> DigestEvaluation {
        DigestEvaluation {
            pending,
            ingestion_share,
            ingestion_turn_share,
            current_mode,
        }
    }

    #[test]
    fn switches_to_digest_on_the_first_crossed_trigger_from_any_trigger() {
        let mut controller = DigestLaneController::default();
        let decision = controller.evaluate(evaluation(6, None, None, DigestLaneMode::Push));
        assert!(decision.changed);
        assert_eq!(decision.mode, DigestLaneMode::Digest);
        assert_eq!(decision.reason, DigestDecisionReason::PendingPressure);

        let mut controller = DigestLaneController::default();
        let decision = controller.evaluate(evaluation(0, Some(0.25), None, DigestLaneMode::Push));
        assert!(decision.changed);
        assert_eq!(decision.reason, DigestDecisionReason::IngestionContextShare);

        let mut controller = DigestLaneController::default();
        let decision = controller.evaluate(evaluation(0, None, Some(0.4), DigestLaneMode::Push));
        assert!(decision.changed);
        assert_eq!(decision.reason, DigestDecisionReason::IngestionTurnShare);
    }

    #[test]
    fn holds_digest_until_every_trigger_relaxes_below_half_its_value() {
        let mut controller = DigestLaneController::default();
        controller.evaluate(evaluation(6, None, None, DigestLaneMode::Push));
        // One quiet observation is not recovery: the EMA relaxes below 2.5
        // only after several.
        let decision = controller.evaluate(evaluation(1, None, None, DigestLaneMode::Digest));
        assert!(!decision.changed);
        assert_eq!(decision.mode, DigestLaneMode::Digest);
        // Relaxed shares but the EMA still above half: hold.
        let decision =
            controller.evaluate(evaluation(0, Some(0.05), Some(0.1), DigestLaneMode::Digest));
        assert!(!decision.changed);
        assert_eq!(decision.reason, DigestDecisionReason::Hold);
        // Fully quiet at last: recover.
        let decision =
            controller.evaluate(evaluation(0, Some(0.05), Some(0.1), DigestLaneMode::Digest));
        assert!(decision.changed);
        assert_eq!(decision.mode, DigestLaneMode::Push);
        assert_eq!(decision.reason, DigestDecisionReason::Recovered);
    }

    #[test]
    fn never_flaps_on_a_single_borderline_observation() {
        let mut controller = DigestLaneController::default();
        controller.evaluate(evaluation(6, None, None, DigestLaneMode::Push));
        // Borderline values (above half, below the trigger) hold digest.
        let decision =
            controller.evaluate(evaluation(2, Some(0.12), Some(0.2), DigestLaneMode::Digest));
        assert!(!decision.changed);
        let decision =
            controller.evaluate(evaluation(2, Some(0.12), Some(0.2), DigestLaneMode::Digest));
        assert!(!decision.changed);
        assert_eq!(decision.mode, DigestLaneMode::Digest);
    }

    #[test]
    fn unknown_shares_are_unmeasured_never_crossed() {
        let mut controller = DigestLaneController::default();
        let decision = controller.evaluate(evaluation(3, None, None, DigestLaneMode::Push));
        assert!(!decision.changed);
        assert_eq!(decision.mode, DigestLaneMode::Push);
        assert_eq!(decision.reason, DigestDecisionReason::Hold);
    }

    #[test]
    fn smooths_pending_pressure_with_an_ema_before_the_trigger() {
        let mut controller = DigestLaneController::new(DigestControllerOptions {
            ema_alpha: 0.5,
            ..DigestControllerOptions::default()
        });
        let decision = controller.evaluate(evaluation(4, None, None, DigestLaneMode::Push));
        assert!(!decision.changed);
        assert!((decision.pending_ema - 4.0).abs() < f64::EPSILON);
        let decision = controller.evaluate(evaluation(8, None, None, DigestLaneMode::Push));
        assert!(decision.changed);
        assert!((decision.pending_ema - 6.0).abs() < f64::EPSILON);
    }

    #[test]
    fn digest_notice_content_matches_the_ts_wording() {
        let one = digest_notice_content(1, &["sender".to_string()]);
        assert!(one.contains("You have 1 unread inbox item in your inbox (from: sender)."));
        assert!(one.contains("await rlm.inbox.list()"));
        let many = digest_notice_content(
            7,
            &[
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
                "d".to_string(),
                "e".to_string(),
                "f".to_string(),
            ],
        );
        assert!(many.contains("7 unread inbox items"));
        // TS caps the sender list at five: "e, ..." trails the shown set.
        assert!(many.contains("e, ..."));
        assert!(!many.contains("e, f"));
    }

    #[test]
    fn preview_caps_at_120_chars() {
        assert_eq!(preview("short"), "short");
        let long = "x".repeat(200);
        let clipped = preview(&long);
        assert_eq!(clipped.chars().count(), 123);
        assert!(clipped.ends_with("..."));
    }

    #[test]
    fn sender_is_parent_of_reads_the_durable_parent_edge() {
        let mut core = super::super::SessionCore::test_core(None, "/tmp".to_string());
        assert!(!sender_is_parent_of(
            &json!({ "activeSessionId": "someone" }),
            &core
        ));
        core.parent_active_session_id = Some("parent-active".to_string());
        assert!(sender_is_parent_of(
            &json!({ "activeSessionId": "parent-active" }),
            &core
        ));
        core.parent_session_id = Some("parent-session".to_string());
        assert!(sender_is_parent_of(
            &json!({ "sessionId": "parent-session", "activeSessionId": "other" }),
            &core
        ));
    }

    /// The durable-replay contract (TS `agent-message-inbox`): entries and
    /// read markers persist as `custom` session entries, so unread entries
    /// survive restarts and a fresh inbox over the same store replays them.
    #[test]
    fn inbox_entries_and_read_markers_replay_from_the_durable_store() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
        store.set_path(path.clone());
        store.rewrite().unwrap();
        let digest = AgentMessageDigest::new(
            std::sync::Arc::new(std::sync::Mutex::new(super::super::SessionCore::test_core(
                Some(store),
                "/tmp".to_string(),
            ))),
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            std::sync::Arc::new(tokio::sync::Notify::new()),
        );
        assert!(digest
            .configure_pin("digest")
            .unwrap()
            .get("digest")
            .and_then(Value::as_bool)
            .unwrap_or(false));
        let digested = digest
            .route_inbound_message(
                "agentmsg_1",
                "REPORT 481",
                &json!({
                    "activeSessionId": "child-active",
                    "sessionName": "child-1",
                }),
                Some("child"),
            )
            .expect("digested")
            .expect("digest receipt");
        assert!(digested.get("digestAt").is_some());
        let snapshot = digest.inbox_snapshot();
        assert_eq!(snapshot["unread"], json!(1));
        assert_eq!(snapshot["total"], json!(1));
        assert_eq!(snapshot["entries"][0]["content"], json!("REPORT 481"));
        assert_eq!(snapshot["entries"][0]["kind"], json!("agent_message"));

        // A fresh manager over a reloaded store keeps the entry and the
        // read state (the read markers are durable too).
        let read = digest.read_inbox(None).unwrap();
        assert_eq!(read["unread"], json!(0));
        assert!(read["entries"][0]["read"].as_bool().unwrap());
        assert_eq!(read["entries"][0]["content"], json!("REPORT 481"));

        let reloaded_store = crate::session_store::SessionFile::open(&path).unwrap();
        let digest = AgentMessageDigest::new(
            std::sync::Arc::new(std::sync::Mutex::new(super::super::SessionCore::test_core(
                Some(reloaded_store),
                "/tmp".to_string(),
            ))),
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            std::sync::Arc::new(tokio::sync::Notify::new()),
        );
        let snapshot = digest.inbox_snapshot();
        assert_eq!(snapshot["total"], json!(1));
        assert_eq!(snapshot["unread"], json!(0));
        assert_eq!(snapshot["entries"][0]["read"], json!(true));
    }

    /// The arrivals ring counts ACCEPTED arrivals only (TS
    /// `MessagingStats`' arrivals definition): the digest lane records
    /// at its durable append, the push lane records at the delivery
    /// path's enqueue (the caller's queue cap is that lane's admission),
    /// and a rejected delivery records nothing — retries against a full
    /// inbox or queue must not pin the controller's pending-pressure EMA
    /// above the recovery half-threshold while every send fails.
    #[test]
    fn route_records_arrivals_only_for_accepted_deliveries() {
        let ring = |digest: &AgentMessageDigest| {
            digest
                .counters
                .lock()
                .unwrap()
                .arrivals_last_5m(crate::util::now_ms())
        };
        let sender = json!({ "activeSessionId": "sender", "sessionName": "sender" });
        let digest_over = |store: Option<crate::session_store::SessionFile>| {
            AgentMessageDigest::new(
                std::sync::Arc::new(std::sync::Mutex::new(super::super::SessionCore::test_core(
                    store,
                    "/tmp".to_string(),
                ))),
                std::sync::Arc::new(std::sync::Mutex::new(None)),
                std::sync::Arc::new(tokio::sync::Notify::new()),
            )
        };

        // Accepted digest-lane delivery: exactly one arrival.
        let dir = tempfile::TempDir::new().unwrap();
        let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
        store.set_path(dir.path().join("session.jsonl"));
        store.rewrite().unwrap();
        let digest = digest_over(Some(store));
        digest.configure_pin("digest").unwrap();
        digest
            .route_inbound_message("agentmsg_ok", "accepted", &sender, Some("sibling"))
            .expect("digest receipt");
        assert_eq!(
            ring(&digest),
            1,
            "the accepted delivery recorded no arrival"
        );

        // Rejected digest-lane delivery (the durable append fails): none.
        let mut broken = crate::session_store::SessionFile::create("/tmp", None, 0);
        broken.set_path(dir.path().to_path_buf()); // a directory: every append fails
        let digest = digest_over(Some(broken));
        digest.configure_pin("digest").unwrap();
        digest
            .route_inbound_message("agentmsg_reject", "rejected", &sender, Some("sibling"))
            .expect_err("the broken store answered success");
        assert_eq!(
            ring(&digest),
            0,
            "the rejected delivery counted as an arrival"
        );

        // Push-lane route: the arrival belongs to the delivery path's
        // enqueue (the caller's queue cap is the push admission), so the
        // route itself records nothing.
        let digest = digest_over(None);
        digest.configure_pin("push").unwrap();
        let routed = digest
            .route_inbound_message("agentmsg_push", "pushed", &sender, Some("sibling"))
            .expect("route failed");
        assert!(routed.is_none(), "a push-pinned route digested");
        assert_eq!(ring(&digest), 0, "the push route pre-recorded an arrival");
    }

    /// The arrivals ring is count-aggregated (the bounded form): sustained
    /// traffic spread across the whole window preserves the
    /// trailing-window count exactly, while the ring itself never grows
    /// past one counted row per bucket of window — the per-arrival row of
    /// the first cut held one entry per delivery for the window's whole
    /// span, so a hot push path grew the worker's memory without bound.
    #[test]
    fn the_arrivals_ring_stays_bounded_under_sustained_traffic() {
        let mut counters = DigestCounters::default();
        let now = 100 * ARRIVALS_WINDOW_MS;
        // 30_000 arrivals spread across the window (100 per second).
        for index in 0..30_000u64 {
            counters.record_arrival(now - ARRIVALS_WINDOW_MS + index / 100);
        }
        assert_eq!(
            counters.arrivals_last_5m(now),
            30_000,
            "the bucketed ring lost trailing-window arrivals"
        );
        assert!(
            counters.arrivals.len() <= (ARRIVALS_WINDOW_MS / ARRIVALS_BUCKET_MS) as usize + 1,
            "the ring grew past its per-bucket bound: {}",
            counters.arrivals.len()
        );
        // The window slides: aged-out buckets leave the ring entirely.
        assert_eq!(
            counters.arrivals_last_5m(now + ARRIVALS_WINDOW_MS),
            0,
            "an aged-out bucket survived the window"
        );
        assert!(
            counters.arrivals.is_empty(),
            "the pruned ring kept {} stale buckets",
            counters.arrivals.len()
        );
    }

    /// A test digest over a real store (the burst tests need the durable
    /// append to run in full).
    fn digest_over_store() -> (Arc<AgentMessageDigest>, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
        store.set_path(dir.path().join("session.jsonl"));
        store.rewrite().unwrap();
        let digest = AgentMessageDigest::new(
            std::sync::Arc::new(std::sync::Mutex::new(SessionCore::test_core(
                Some(store),
                "/tmp".to_string(),
            ))),
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            std::sync::Arc::new(tokio::sync::Notify::new()),
        );
        digest.configure_pin("digest").unwrap();
        (std::sync::Arc::new(digest), dir)
    }

    fn sibling_sender() -> Value {
        json!({ "activeSessionId": "sender", "sessionName": "sender" })
    }

    /// The admission cap and the durable append are ONE lock section: with
    /// the cap check in a separate section, every concurrently in-flight
    /// delivery observes the below-cap count and appends, growing the
    /// durable inbox past its advertised bound. The test parks a burst of
    /// deliveries at the append's inbox lock (the check would already
    /// have run in the two-section form), then releases them at once —
    /// exactly ONE lands; the rest answer the capacity error.
    #[test]
    fn concurrent_deliveries_cannot_append_past_the_inbox_cap() {
        let (digest, _dir) = digest_over_store();
        // Fill the inbox to one below the cap.
        for index in 0..INBOX_MAX_UNREAD - 1 {
            digest
                .route_inbound_message(
                    &format!("agentmsg_fill_{index}"),
                    "fill",
                    &sibling_sender(),
                    Some("sibling"),
                )
                .expect("route failed")
                .expect("the capped prefill digested");
        }
        // Park the burst at the append section.
        let parked_inbox = digest.inbox.lock().unwrap();
        let mut deliveries = Vec::new();
        for index in 0..8 {
            let digest = std::sync::Arc::clone(&digest);
            deliveries.push(std::thread::spawn(move || {
                digest.route_inbound_message(
                    &format!("agentmsg_burst_{index}"),
                    "burst",
                    &sibling_sender(),
                    Some("sibling"),
                )
            }));
        }
        // The burst settles at the inbox acquisition (their evaluates ran:
        // the lane is digest-pinned).
        std::thread::sleep(std::time::Duration::from_millis(200));
        drop(parked_inbox);
        let mut digested = 0;
        for delivery in deliveries {
            match delivery.join().unwrap() {
                Ok(Some(_receipt)) => digested += 1,
                Ok(None) => panic!("a digest-lane route fell to push"),
                Err(error) => assert!(
                    error.to_string().contains("too many pending messages"),
                    "unexpected refusal: {error}"
                ),
            }
        }
        assert_eq!(digested, 1, "more than one burst delivery landed");
        let snapshot = digest.inbox_snapshot();
        assert_eq!(
            snapshot["unread"],
            json!(INBOX_MAX_UNREAD),
            "the burst grew the inbox past the cap: {snapshot}"
        );
    }

    /// The watch-event admission cap rides the same ONE lock section as
    /// its durable append: with the check in a separate section, a burst
    /// of watch events (which arrive concurrently with the digest
    /// deliveries through the shared poll sink) would all observe the
    /// below-cap count and all append. The parked-burst shape again
    /// allows exactly ONE entry.
    #[test]
    fn concurrent_watch_events_cannot_append_past_the_inbox_cap() {
        let (digest, _dir) = digest_over_store();
        for index in 0..INBOX_MAX_UNREAD - 1 {
            digest.emit_watch_notice(
                "agent",
                &format!("c{index}"),
                &format!("[watch-agent child:c{index}]"),
            );
        }
        let parked_inbox = digest.inbox.lock().unwrap();
        let mut watchers = Vec::new();
        for index in 0..8 {
            let digest = std::sync::Arc::clone(&digest);
            watchers.push(std::thread::spawn(move || {
                digest.emit_watch_notice(
                    "agent",
                    &format!("w{index}"),
                    &format!("[watch-agent child:w{index}]"),
                );
            }));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        drop(parked_inbox);
        for watcher in watchers {
            watcher.join().unwrap();
        }
        let snapshot = digest.inbox_snapshot();
        assert_eq!(
            snapshot["unread"],
            json!(INBOX_MAX_UNREAD),
            "the watch burst grew the inbox past the cap: {snapshot}"
        );
    }

    /// A delivery that decided digest BEFORE a session replacement must
    /// not append into the replacement's store: the evaluate ran in an
    /// earlier lock section, the replacement's store swap + pin reset can
    /// complete while the delivery is parked between its sections, and
    /// the append's own lane re-validation must answer push — the stale
    /// decision falls to the push path and the replacement's durable
    /// inbox stays empty (replacements start push-pinned).
    #[test]
    fn a_delivery_parked_across_a_replacement_never_digests_into_it() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut old_store = crate::session_store::SessionFile::create("/tmp", None, 0);
        old_store.set_path(dir.path().join("old-session.jsonl"));
        old_store.rewrite().unwrap();
        let core = std::sync::Arc::new(std::sync::Mutex::new(SessionCore::test_core(
            Some(old_store),
            "/tmp".to_string(),
        )));
        let digest = std::sync::Arc::new(AgentMessageDigest::new(
            std::sync::Arc::clone(&core),
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            std::sync::Arc::new(tokio::sync::Notify::new()),
        ));
        digest.configure_pin("digest").unwrap();
        // Park the delivery between its evaluate (which decides digest)
        // and its append: hold the inbox lock across the replacement.
        let parked_inbox = digest.inbox.lock().unwrap();
        let delivery = {
            let digest = std::sync::Arc::clone(&digest);
            std::thread::spawn(move || {
                digest.route_inbound_message(
                    "agentmsg_parked",
                    "REPORT 481",
                    &sibling_sender(),
                    Some("sibling"),
                )
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(200));
        // The replacement: the digest's one [counters -> core] hold (the
        // same section `SessionNavigation::replace_session` runs).
        let mut fresh = crate::session_store::SessionFile::create("/tmp", None, 0);
        fresh.set_path(dir.path().join("fresh-session.jsonl"));
        fresh.rewrite().unwrap();
        drop(digest.reset_for_replacement(|core| core.store.replace(fresh)));
        // Release the parked delivery: the stale digest decision must be
        // refused at the append.
        drop(parked_inbox);
        let routed = delivery.join().unwrap().expect("route failed");
        assert!(routed.is_none(), "the stale decision digested: {routed:?}");
        let snapshot = digest.inbox_snapshot();
        assert_eq!(
            snapshot["total"],
            json!(0),
            "the replacement's inbox: {snapshot}"
        );
    }

    /// A replacement reset leaves the controller's counters fresh: the
    /// retired session's arrivals and turn accounting must not leak into
    /// the replacement's lane evaluation (an auto-armed replacement would
    /// read stale pressure and mis-decide).
    #[test]
    fn a_replacement_reset_clears_the_counters_and_turn_accounting() {
        let (digest, _dir) = digest_over_store();
        digest.record_arrival(crate::util::now_ms());
        digest.note_model_turn(true);
        digest.reset_for_replacement(|_| ());
        let ring = digest
            .counters
            .lock()
            .unwrap()
            .arrivals_last_5m(crate::util::now_ms());
        assert_eq!(ring, 0, "the retired session's arrival survived the reset");
        assert!(
            digest.ingestion_turn_share().is_none(),
            "the retired session's turn accounting survived the reset"
        );
    }

    /// A failed durable append must not leave the in-memory inbox
    /// trusting its pre-append load: the store append can fail AFTER the
    /// row reached the file (the lease append's post-write flush), and a
    /// stale loaded key would hide that row until a restart — the
    /// sender's retry would then surface BOTH rows as duplicates with
    /// the original invisible in between. The failed append invalidates
    /// the loaded key, so the next inbox read reloads the store's truth.
    #[test]
    fn a_failed_durable_append_reloads_the_inbox_from_the_store() {
        let dir = tempfile::TempDir::new().unwrap();
        let store_path = dir.path().join("session.jsonl");
        // A directory at the store's path: every append fails, and the
        // store's identity (path + session id) stays fixed.
        std::fs::create_dir(&store_path).unwrap();
        let mut broken = crate::session_store::SessionFile::create("/tmp", None, 0);
        let session_id = broken.session_id().to_string();
        broken.set_path(store_path.clone());
        let digest = AgentMessageDigest::new(
            std::sync::Arc::new(std::sync::Mutex::new(SessionCore::test_core(
                Some(broken),
                "/tmp".to_string(),
            ))),
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            std::sync::Arc::new(tokio::sync::Notify::new()),
        );
        digest.configure_pin("digest").unwrap();
        digest
            .route_inbound_message(
                "agentmsg_failed",
                "must not silently digest",
                &sibling_sender(),
                Some("sibling"),
            )
            .expect_err("the directory-path store answered success");
        // The durable truth appears at the same path and under the same
        // session id (the post-write failure's row): a real session file
        // with one unread inbox entry.
        std::fs::remove_dir(&store_path).unwrap();
        let inbox_row = json!({
            "type": "custom",
            "id": "crash-row",
            "timestamp": "2026-01-01T00:00:03.000Z",
            "customType": AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE,
            "data": {
                "messageId": "agentmsg_failed",
                "content": "must not silently digest",
                "from": { "activeSessionId": "sender", "sessionName": "sender" },
                "fromRelationship": "sibling",
                "target": { "activeSessionId": "target", "sessionId": "target" },
                "receivedAt": "2026-01-01T00:00:03.000Z",
                "kind": "agent_message",
            },
        });
        let header = json!({
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": "2026-01-01T00:00:00.000Z",
            "cwd": "/tmp",
        });
        std::fs::write(&store_path, format!("{header}\n{inbox_row}\n")).unwrap();
        let reopened = crate::session_store::SessionFile::open(&store_path).unwrap();
        {
            let mut core = digest
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            core.store = Some(reopened);
        }
        // The next snapshot must show the durable row: a stale loaded key
        // would answer the pre-append empty records.
        let snapshot = digest.inbox_snapshot();
        assert_eq!(
            snapshot["total"],
            json!(1),
            "the failed append left the inbox stale: {snapshot}"
        );
        assert_eq!(snapshot["unread"], json!(1));
        assert_eq!(
            snapshot["entries"][0]["content"],
            json!("must not silently digest")
        );
    }

    /// The post-write failure class: the lease append's fsync errors after
    /// the bytes reached the file, so the row is durable while the append
    /// reports failure. The digest reconciles against the file and
    /// ACCEPTS the delivery (the sender never retries a duplicate), while
    /// a pre-write failure keeps refusing — no durable row, nothing
    /// counted (the TS `appendCustomEntryWithRollback` contract). Unix
    /// only: the append failure is forced with a read-only session file.
    #[cfg(unix)]
    #[test]
    fn a_post_write_failure_is_reconciled_against_the_durable_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let store_path = dir.path().join("session.jsonl");
        let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
        let session_id = store.session_id().to_string();
        store.set_path(store_path.clone());
        store.rewrite().unwrap();
        // The row the append would write reached the file (the post-write
        // class): seeded exactly as the lease append leaves it.
        let header = json!({
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": "2026-01-01T00:00:00.000Z",
            "cwd": "/tmp",
        });
        let row = json!({
            "type": "custom",
            "id": "row-postwrite",
            "timestamp": "2026-01-01T00:00:03.000Z",
            "customType": AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE,
            "data": {
                "messageId": "agentmsg_postwrite",
                "content": "REPORT 481",
                "from": { "activeSessionId": "sender", "sessionName": "sender" },
                "fromRelationship": "sibling",
                "target": { "activeSessionId": "target", "sessionId": "target" },
                "receivedAt": "2026-01-01T00:00:03.000Z",
                "kind": "agent_message",
            },
        });
        std::fs::write(&store_path, format!("{header}\n{row}\n")).unwrap();
        // Every append now fails (the file is read-only) — but the durable
        // row is present, so the delivery must reconcile and accept.
        let mut permissions = std::fs::metadata(&store_path).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o444);
        std::fs::set_permissions(&store_path, permissions).unwrap();
        let digest = AgentMessageDigest::new(
            std::sync::Arc::new(std::sync::Mutex::new(SessionCore::test_core(
                Some(store),
                "/tmp".to_string(),
            ))),
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            std::sync::Arc::new(tokio::sync::Notify::new()),
        );
        digest.configure_pin("digest").unwrap();
        let receipt = digest
            .route_inbound_message(
                "agentmsg_postwrite",
                "REPORT 481",
                &sibling_sender(),
                Some("sibling"),
            )
            .expect("route failed");
        assert!(
            receipt.is_some(),
            "the durable row was not accepted: {receipt:?}"
        );
        let snapshot = digest.inbox_snapshot();
        assert_eq!(snapshot["total"], json!(1), "{snapshot}");
        assert_eq!(
            snapshot["entries"][0]["id"],
            json!("row-postwrite"),
            "the reconciled row keeps its durable id: {snapshot}"
        );
        assert_eq!(snapshot["unread"], json!(1));
        // The accepted row must ALSO live in the store's index (the
        // index-after-append step never ran): a later cache invalidation
        // reloads from the index — without the adoption that reload drops
        // the row the receipt just accepted.
        digest.inbox.lock().unwrap().loaded_key = None; // force the reload
        let snapshot = digest.inbox_snapshot();
        assert_eq!(
            snapshot["total"],
            json!(1),
            "the reloaded inbox dropped the accepted row: {snapshot}"
        );
        assert_eq!(
            snapshot["entries"][0]["id"],
            json!("row-postwrite"),
            "{snapshot}"
        );
        // And a rewrite (which serializes the index) must keep the row in
        // the file: without the adoption the rewrite erases it after the
        // sender already received the digest receipt.
        let mut permissions = std::fs::metadata(&store_path).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o644);
        std::fs::set_permissions(&store_path, permissions).unwrap();
        {
            let mut core = digest
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            core.store.as_mut().expect("the store").rewrite().unwrap();
        }
        let content = std::fs::read_to_string(&store_path).unwrap();
        assert!(
            content.contains("row-postwrite"),
            "the rewrite erased the accepted durable row"
        );
    }

    /// A marker-write failure mid-batch must never hide what the batch
    /// already marked durably: the call answers every entry whose read
    /// marker is durable, the failing (and every later) record stays
    /// unread and re-reads on the next pull, and only a failure with
    /// nothing marked stays loud as an error.
    #[test]
    fn a_failed_marker_write_mid_batch_returns_the_marked_entries() {
        let dir = tempfile::TempDir::new().unwrap();
        let store_path = dir.path().join("session.jsonl");
        let inbox_row = |row_id: &str, message_id: &str, content: &str| {
            json!({
                "type": "custom", "id": row_id, "timestamp": "2026-01-01T00:00:03.000Z",
                "customType": AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE,
                "data": {
                    "messageId": message_id,
                    "content": content,
                    "from": { "activeSessionId": "sender", "sessionName": "sender" },
                    "fromRelationship": "sibling",
                    "target": { "activeSessionId": "target", "sessionId": "target" },
                    "receivedAt": "2026-01-01T00:00:03.000Z",
                    "kind": "agent_message",
                },
            })
        };
        let marker_row = json!({
            "type": "custom", "id": "row-marker", "timestamp": "2026-01-01T00:00:04.000Z",
            "customType": AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE,
            "data": { "messageId": "msg-e1" },
        });
        let header = json!({
            "type": "session", "version": 3, "id": "marker-batch",
            "timestamp": "2026-01-01T00:00:00.000Z", "cwd": "/tmp",
        });
        std::fs::write(
            &store_path,
            format!(
                "{header}\n{}\n{marker_row}\n{}\n",
                inbox_row("row-e1", "msg-e1", "first marked earlier"),
                inbox_row("row-e2", "msg-e2", "second must re-read"),
            ),
        )
        .unwrap();
        let mut store = crate::session_store::SessionFile::open(&store_path).unwrap();
        // The append-proof path (a directory): every marker write fails
        // while the loaded index keeps both inbox rows and the marker.
        store.set_path(dir.path().to_path_buf());
        let digest = AgentMessageDigest::new(
            std::sync::Arc::new(std::sync::Mutex::new(SessionCore::test_core(
                Some(store),
                "/tmp".to_string(),
            ))),
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            std::sync::Arc::new(tokio::sync::Notify::new()),
        );
        digest.configure_pin("digest").unwrap();

        // The loud arm: this batch marks nothing (e1 is already read,
        // the ids-less pull meets only e2) — the failed write errors.
        digest.read_inbox(None).unwrap_err();

        // The partial arm: e1 is already durably marked, so its view
        // must answer even though e2's marker write fails mid-batch.
        let result = digest
            .read_inbox(Some(vec!["row-e1".to_string(), "row-e2".to_string()]))
            .unwrap();
        assert_eq!(result["entries"].as_array().unwrap().len(), 1);
        assert_eq!(result["entries"][0]["id"], json!("row-e1"));
        assert_eq!(
            result["entries"][0]["content"],
            json!("first marked earlier"),
            "the durably-marked entry was lost: {result}"
        );
        assert_eq!(result["unread"], json!(1));

        // e2 stays unread and re-readable: the failure hid nothing.
        let snapshot = digest.inbox_snapshot();
        assert_eq!(snapshot["unread"], json!(1));
        assert_eq!(
            snapshot["entries"][1]["content"],
            json!("second must re-read"),
            "{snapshot}"
        );
    }

    /// A compacted window's index omits the discarded prefix: an unread
    /// inbox entry older than the boundary must still hydrate from the
    /// complete durable history (the active file, which a windowed store
    /// never rewrites), so it stays listed, counted, and wake-capable
    /// after a restart.
    #[test]
    fn a_windowed_reload_hydrates_inbox_rows_older_than_the_boundary() {
        let dir = tempfile::TempDir::new().unwrap();
        let store_path = dir.path().join("session.jsonl");
        let inbox_row = json!({
            "type": "custom", "id": "row-inbox-old", "timestamp": "2026-01-01T00:00:01.000Z",
            "customType": AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE,
            "data": {
                "messageId": "msg-old",
                "content": "older than the window",
                "from": { "activeSessionId": "sender", "sessionName": "sender" },
                "fromRelationship": "sibling",
                "target": { "activeSessionId": "target", "sessionId": "target" },
                "receivedAt": "2026-01-01T00:00:01.000Z",
                "kind": "agent_message",
            },
        });
        let rows = [
            json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
            json!({"type":"thinking_level_change","id":"settings","parentId":null,"timestamp":"2026-01-01T00:00:00.500Z","thinkingLevel":"high"}),
            inbox_row,
            json!({"type":"message","id":"u0","parentId":"settings","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"first","timestamp":1}}),
            json!({"type":"message","id":"u1","parentId":"u0","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"user","content":"second","timestamp":2}}),
            json!({"type":"compaction","id":"compact","parentId":"u1","timestamp":"2026-01-01T00:00:03.000Z","summary":"summary","firstKeptEntryId":"u1","tokensBefore":999}),
            json!({"type":"message","id":"leaf","parentId":"compact","timestamp":"2026-01-01T00:00:04.000Z","message":{"role":"user","content":"latest","timestamp":3}}),
        ];
        let body: String = rows.iter().map(|row| row.to_string() + "\n").collect();
        std::fs::write(&store_path, &body).unwrap();
        let store = crate::session_store::SessionFile::open_windowed(&store_path).unwrap();
        // The finding's premise: the windowed index omits the discarded
        // prefix (the pre-boundary inbox row).
        assert!(
            store
                .entries()
                .iter()
                .all(|entry| entry.id != "row-inbox-old"),
            "the fixture's inbox row is inside the retained window: adjust the boundary"
        );
        assert!(
            !store.index_covers_whole_file(),
            "the fixture must exercise a compacted window"
        );
        let digest = AgentMessageDigest::new(
            std::sync::Arc::new(std::sync::Mutex::new(SessionCore::test_core(
                Some(store),
                "/tmp".to_string(),
            ))),
            std::sync::Arc::new(std::sync::Mutex::new(None)),
            std::sync::Arc::new(tokio::sync::Notify::new()),
        );
        let snapshot = digest.inbox_snapshot();
        assert_eq!(snapshot["total"], json!(1), "{snapshot}");
        assert_eq!(snapshot["unread"], json!(1), "{snapshot}");
        assert_eq!(
            snapshot["entries"][0]["content"],
            json!("older than the window"),
            "the pre-boundary inbox entry vanished: {snapshot}"
        );
    }
}
