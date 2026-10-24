//! `rlm.watch.agent`: supervisor-owned activity subscriptions over the
//! parent session's child ledger (the nano-rlm watch series, stage 1).
//!
//! Ownership: one registry per parent session worker, held beside the
//! child ledger in [`super::SupervisorChildSessionsInner`]. The registry
//! and its shared poller live in the worker process, so a Python kernel
//! restart (or a cell ending) never drops a subscription; a parent
//! session worker restart rebuilds the registry empty (restart recovery
//! is explicitly out of the nano-rlm scope). Owner teardown
//! ([`Self::shutdown_agent_watch`], called from the close walk) cancels
//! every subscription and aborts the poller.
//!
//! Events are half-open message-index ranges plus activity transitions —
//! never child transcript content (enforced by construction: the child
//! snapshot is a count and a status label). Two sinks see one event:
//! the bounded readable ring (`rlm.watch.read`) and one coalesced
//! `display: false` wake row per poll batch
//! ([`AGENT_WATCH_NOTICE_CUSTOM_TYPE`], routed like the terminal
//! notices) — the wake row only for `wake: true` subscriptions; a
//! factory-owned wait pages the ring itself and never spends a parent
//! turn on its events. The registry is supervisor-owned (kernel
//! restarts never cross it: the kernel is a child process of the
//! worker that holds the registry), so a post-restart host call simply
//! re-lists it; a kernel restart mid-wait can strand a subscription
//! until its child settles or the session closes — the factory's
//! non-waking subscribes keep that leak silent.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};

use pa_core::session_engine::rlm_host::{
    RlmAgentWatch, RlmWatchAgentContent, RlmWatchEvent, RlmWatchReadPage, RlmWatchStatusChange,
};
use pa_core::session_engine::rlm_notices::{create_agent_watch_notice, AgentWatchNoticeLine};

use super::SupervisorChildSessionsInner;
use crate::util::now_ms;

/// Live subscriptions per owner (TS parity: `AGENT_WATCH_MAX_ACTIVE`).
pub(crate) const AGENT_WATCH_MAX_ACTIVE: usize = 64;
/// Monotonic registrations per owner; cancels never refund (TS
/// `totalRegistered`).
pub(crate) const AGENT_WATCH_MAX_TOTAL: u64 = 1024;
/// The shared poll cadence (TS `AGENT_WATCH_POLL_INTERVAL_MS`).
pub(crate) const AGENT_WATCH_POLL_INTERVAL_MS: u64 = 5_000;
/// One child snapshot's await bound inside a poll tick: an
/// unresponsive child costs one bounded slice per tick, never the
/// 30s `STATE_TIMEOUT_MS` of head-of-line blocking, so a healthy
/// sibling's event is not withheld behind dead links.
const AGENT_WATCH_SNAPSHOT_TIMEOUT_MS: u64 = 5_000;
/// The snapshot fan-out bound per tick: a chunk's link round trips
/// proceed concurrently (the batch is still one applied lock hold and
/// one wake row), and the load stays bounded at 64 subscriptions.
const AGENT_WATCH_SNAPSHOT_CONCURRENCY: usize = 8;
/// How long a subscription keeps polling a child whose snapshots keep
/// failing before it gives up with one terminal `-> unreachable` event.
/// Wall time, never a strike count: a hung link spends about 10s per
/// failed tick (the 5s cadence plus its own 5s snapshot await), so a
/// strike multiple of the cadence would report near 120s against the
/// documented ~60s bound — the give-up measures the failed-poll window
/// itself (the settle watcher's `WATCH_MAX_UNREACHABLE_POLLS` is the
/// different, strike-based shape; a watch is advisory, never a
/// liveness gate).
const WATCH_SUB_UNREACHABLE_GIVE_UP_MS: u64 = 60_000;
/// The readable event ring: bounded by entries and serialized bytes,
/// drop-oldest, and every drop is counted at the read surface.
const AGENT_WATCH_EVENT_RING_MAX: usize = 1024;
const AGENT_WATCH_EVENT_RING_MAX_BYTES: usize = 256 * 1024;
/// Server-side page cap for one `rlm.watch.read` (the pa-core handler
/// pins the same bound before the host sees the request).
const AGENT_WATCH_READ_LIMIT_MAX: u64 = 500;

/// One subscription's lifecycle (the registry row's `status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WatchStatus {
    /// Eligible for the poller.
    Active,
    /// Cancelled by the owner (an idempotent cancel, teardown).
    Cancelled,
    /// Terminal without a cancel: the child vanished or stayed
    /// unreachable past the give-up bound. Inspectable, never re-fires.
    Stopped,
}

impl WatchStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Cancelled => "cancelled",
            Self::Stopped => "stopped",
        }
    }
}

/// One agent activity subscription. The deterministic id
/// (`watch-agent-<rlm_child_id>`) makes a re-register a re-baseline, not
/// a second subscription (TS cancel-then-register).
#[derive(Debug)]
struct AgentWatchSubscription {
    id: String,
    child_id: String,
    child_name: String,
    /// The message count the next event grows from; `None` until the
    /// child's first reachable snapshot arms the baseline (a register
    /// against an unreachable child never fabricates growth).
    baseline: Option<u64>,
    /// The activity label the next status transition compares against;
    /// the register snapshot's own label, so an already-running child
    /// does not fabricate an `idle -> running` event on its first poll.
    last_status: &'static str,
    created_at_ms: u64,
    status: WatchStatus,
    total_events: u64,
    /// The wall-clock time of the first snapshot failure of the current
    /// dead streak (`None` while the child stays reachable); the
    /// give-up measures elapsed time from here, never poll strikes.
    unreachable_since_ms: Option<u64>,
    /// Bumped on every register: a poll observation carries the epoch it
    /// was taken under, so one taken before a re-baseline is discarded
    /// instead of emitting a backwards range against the new baseline.
    epoch: u64,
    /// Whether this subscription's events also deliver the coalesced
    /// wake row (`false` for factory-owned waits: the factory reads the
    /// ring itself, and a leaked or parked subscription must not spend a
    /// parent LLM turn per poll batch).
    wake: bool,
}

/// The registry caps' refusals (TS text).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentWatchRegisterError {
    ActiveLimit,
    TotalLimit,
}

impl AgentWatchRegisterError {
    pub(crate) fn message(self) -> String {
        match self {
            Self::ActiveLimit => {
                format!("Agent watch limit reached ({AGENT_WATCH_MAX_ACTIVE} active)")
            }
            Self::TotalLimit => {
                format!("Agent watch total limit reached ({AGENT_WATCH_MAX_TOTAL})")
            }
        }
    }
}

/// The per-owner watch registry: subscriptions, the bounded event ring,
/// and the shared poller handle. All mutations go through
/// [`AgentWatchRegistry`]; child snapshots (link round trips) stay
/// outside the lock.
#[derive(Debug)]
pub(crate) struct AgentWatchRegistry {
    subscriptions: HashMap<String, AgentWatchSubscription>,
    total_registered: u64,
    events: VecDeque<RlmWatchEvent>,
    events_bytes: usize,
    dropped: u64,
    next_seq: u64,
    /// The per-registration epoch mint (see
    /// `AgentWatchSubscription::epoch`).
    next_epoch: u64,
    /// Bumped on every poller spawn: a poller exits when its generation
    /// is superseded, so an emptied registry's sleeper never co-polls
    /// with a fresh spawn's poller.
    poll_generation: u64,
    poll: Option<tokio::task::JoinHandle<()>>,
    /// The poll cadence; the `AGENT_WATCH_POLL_INTERVAL_MS` default, a
    /// test knob below.
    poll_interval_ms: u64,
    /// One child snapshot's await bound inside a poll tick; the
    /// `AGENT_WATCH_SNAPSHOT_TIMEOUT_MS` default, a test knob below.
    snapshot_timeout_ms: u64,
}

impl Default for AgentWatchRegistry {
    fn default() -> Self {
        Self {
            subscriptions: HashMap::new(),
            total_registered: 0,
            events: VecDeque::new(),
            events_bytes: 0,
            dropped: 0,
            next_seq: 0,
            next_epoch: 0,
            poll_generation: 0,
            poll: None,
            poll_interval_ms: AGENT_WATCH_POLL_INTERVAL_MS,
            snapshot_timeout_ms: AGENT_WATCH_SNAPSHOT_TIMEOUT_MS,
        }
    }
}

impl AgentWatchRegistry {
    /// The poll cadence the loop reads (at least 1ms so a test knob of 0
    /// can never hot-spin).
    pub(crate) fn poll_interval(&self) -> u64 {
        self.poll_interval_ms.max(1)
    }

    /// One child snapshot's await bound inside a poll tick (at least
    /// 1ms, same hot-spin guard as the cadence).
    pub(crate) fn snapshot_timeout(&self) -> u64 {
        self.snapshot_timeout_ms.max(1)
    }

    fn bump_epoch(&mut self) -> u64 {
        self.next_epoch += 1;
        self.next_epoch
    }

    /// The subscription's current epoch (test seam for scripting stale
    /// observations).
    #[cfg(test)]
    pub(crate) fn subscription_epoch(&self, id: &str) -> u64 {
        self.subscriptions
            .get(id)
            .expect("an epoch is read for a subscription the test registered")
            .epoch
    }

    fn active_count(&self) -> usize {
        self.subscriptions
            .values()
            .filter(|subscription| subscription.status == WatchStatus::Active)
            .count()
    }

    pub(crate) fn has_active(&self) -> bool {
        self.active_count() > 0
    }

    /// Register (or re-baseline) the one watch of a resolved child.
    /// A re-register of a live subscription is the TS
    /// cancel-then-register re-baseline: it consumes no new slot and
    /// never burns the monotonic total cap, and it bumps the epoch so a
    /// poll observation taken under the old registration is discarded.
    /// Only a real snapshot re-baselines: a re-register without one (an
    /// unreachable or unadmitted child) keeps the row's baseline, so an
    /// armed watch never falls back to a quiet arming read that absorbs
    /// the growth since.
    /// A row that was cancelled or stopped is a new registration: the
    /// caps apply and the total advances (it never refunds).
    pub(crate) fn register(
        &mut self,
        child_id: &str,
        child_name: &str,
        baseline: Option<(u64, &'static str)>,
        at_ms: u64,
        wake: bool,
    ) -> Result<RlmAgentWatch, AgentWatchRegisterError> {
        let id = format!("watch-agent-{child_id}");
        let arming_baseline = baseline.map(|(count, _)| count);
        let arming_status = baseline.map_or("idle", |(_, status)| status);
        let already_active = self
            .subscriptions
            .get(&id)
            .is_some_and(|subscription| subscription.status == WatchStatus::Active);
        if already_active {
            let epoch = self.bump_epoch();
            let subscription = self
                .subscriptions
                .get_mut(&id)
                .expect("the active row was just checked");
            if let Some((count, status)) = baseline {
                subscription.baseline = Some(count);
                subscription.last_status = status;
            }
            subscription.child_name = child_name.to_string();
            subscription.created_at_ms = at_ms;
            subscription.unreachable_since_ms = None;
            subscription.epoch = epoch;
            // Sticky: the shared per-child row serves the model's watch and the
            // factory wait; a wake=false re-arm must not silence wake rows an
            // earlier registration asked for.
            subscription.wake = subscription.wake || wake;
            return Ok(self.row(&id));
        }
        if self.active_count() >= AGENT_WATCH_MAX_ACTIVE {
            return Err(AgentWatchRegisterError::ActiveLimit);
        }
        if self.total_registered >= AGENT_WATCH_MAX_TOTAL {
            return Err(AgentWatchRegisterError::TotalLimit);
        }
        self.total_registered += 1;
        let epoch = self.bump_epoch();
        self.subscriptions.insert(
            id.clone(),
            AgentWatchSubscription {
                id: id.clone(),
                child_id: child_id.to_string(),
                child_name: child_name.to_string(),
                baseline: arming_baseline,
                last_status: arming_status,
                created_at_ms: at_ms,
                status: WatchStatus::Active,
                total_events: 0,
                unreachable_since_ms: None,
                epoch,
                wake,
            },
        );
        Ok(self.row(&id))
    }

    /// Idempotent cancel: only an `Active` subscription flips and
    /// answers `true`. Published events stay readable (nano-rlm).
    pub(crate) fn cancel(&mut self, id: &str) -> bool {
        self.flip(id, WatchStatus::Cancelled)
    }

    /// A vanished child (deleted from the roster, or a roster that lost
    /// it) ends its subscription with ONE terminal `-> vanished` status
    /// event, zero-width like the unreachable give-up: a consumer parked
    /// on the feed learns the target is gone instead of timing out
    /// against a dead subscription (the factory settles a wait on a
    /// vanished target through its failure policy instead of a silent
    /// timeout). An observation from before a re-baseline is stale: its
    /// child was resolved under the old registration and must not stop
    /// the new one.
    pub(crate) fn mark_vanished(
        &mut self,
        id: &str,
        epoch: u64,
        at_ms: u64,
    ) -> Option<RlmWatchEvent> {
        let subscription = self.subscriptions.get_mut(id)?;
        if subscription.status != WatchStatus::Active || subscription.epoch != epoch {
            return None;
        }
        subscription.status = WatchStatus::Stopped;
        Some(Self::build_event(
            subscription,
            subscription.baseline.unwrap_or_default(),
            subscription.baseline.unwrap_or_default(),
            Some((subscription.last_status, "vanished")),
            at_ms,
        ))
    }

    /// A settled-but-never-admitted child (a kickoff that failed
    /// permanently: the spawn watcher killed the worker and
    /// `settle_failed` retained the roster row) ends its subscription
    /// with ONE zero-width terminal `-> failed` event, like the
    /// vanished and unreachable ends. The record can never admit, so
    /// the poller's unadmitted skip would otherwise loop forever
    /// against a dead child while a parked consumer times out and the
    /// row keeps burning an active slot. An observation from before a
    /// re-baseline is stale, exactly like the vanish arm.
    pub(crate) fn mark_failed_kickoff(
        &mut self,
        id: &str,
        epoch: u64,
        at_ms: u64,
    ) -> Option<RlmWatchEvent> {
        let subscription = self.subscriptions.get_mut(id)?;
        if subscription.status != WatchStatus::Active || subscription.epoch != epoch {
            return None;
        }
        subscription.status = WatchStatus::Stopped;
        Some(Self::build_event(
            subscription,
            subscription.baseline.unwrap_or_default(),
            subscription.baseline.unwrap_or_default(),
            Some((subscription.last_status, "failed")),
            at_ms,
        ))
    }

    /// Whether the child has an active, still-unarmed subscription (the
    /// admission arm's short-circuit: nothing to arm, no snapshot).
    pub(crate) fn has_unarmed_for_child(&self, child_id: &str) -> bool {
        self.subscriptions.values().any(|subscription| {
            subscription.status == WatchStatus::Active
                && subscription.child_id == child_id
                && subscription.baseline.is_none()
        })
    }

    /// The admission arm: one snapshot taken at the admission boundary
    /// arms every still-unarmed watch on the child. First writer wins —
    /// the poller's arming read may have landed first — so the arm only
    /// touches rows whose baseline is still `None`.
    pub(crate) fn arm_admitted(&mut self, child_id: &str, count: u64, status: &'static str) {
        for subscription in self.subscriptions.values_mut() {
            if subscription.status == WatchStatus::Active
                && subscription.child_id == child_id
                && subscription.baseline.is_none()
            {
                subscription.baseline = Some(count);
                subscription.last_status = status;
            }
        }
    }

    /// Owner teardown: every subscription ends cancelled.
    pub(crate) fn cancel_all(&mut self) {
        for subscription in self.subscriptions.values_mut() {
            subscription.status = WatchStatus::Cancelled;
        }
    }

    fn flip(&mut self, id: &str, status: WatchStatus) -> bool {
        match self.subscriptions.get_mut(id) {
            Some(subscription) if subscription.status == WatchStatus::Active => {
                subscription.status = status;
                true
            }
            _ => false,
        }
    }

    /// Apply one child snapshot: quiet unless the count grew or the
    /// activity label changed. An unreachable child accumulates a
    /// dead-poll streak and, past the give-up bound, ends the
    /// subscription with one `-> unreachable` status event.
    pub(crate) fn apply_snapshot(
        &mut self,
        id: &str,
        epoch: u64,
        snapshot: &Result<(u64, &'static str)>,
        at_ms: u64,
    ) -> Option<RlmWatchEvent> {
        let subscription = self.subscriptions.get_mut(id)?;
        if subscription.status != WatchStatus::Active {
            return None;
        }
        if subscription.epoch != epoch {
            return None; // stale: taken under a superseded registration
        }
        // An unreachable child accumulates a dead-poll streak and, past
        // the give-up bound, ends the subscription with one terminal
        // `-> unreachable` status event. The give-up is elapsed wall
        // time since the streak's first failure, never a strike count:
        // a hung link spends the 5s cadence plus its own snapshot await
        // per failed tick, so strikes overshoot the bound the docs
        // state.
        let Ok((count, status)) = snapshot else {
            let since = *subscription.unreachable_since_ms.get_or_insert(at_ms);
            if at_ms.saturating_sub(since) < WATCH_SUB_UNREACHABLE_GIVE_UP_MS {
                return None;
            }
            subscription.status = WatchStatus::Stopped;
            return Some(Self::build_event(
                subscription,
                subscription.baseline.unwrap_or_default(),
                subscription.baseline.unwrap_or_default(),
                Some((subscription.last_status, "unreachable")),
                at_ms,
            ));
        };
        let (count, status) = (*count, *status);
        subscription.unreachable_since_ms = None;
        // The arming read: a register against an unreachable child never
        // fabricates a 0..count growth event.
        let Some(baseline) = subscription.baseline else {
            subscription.baseline = Some(count);
            subscription.last_status = status;
            return None;
        };
        // A shrunk count (a compacted child) is a re-baseline, never a
        // backwards `start > end` growth range: the shrink reports only
        // when the status changed too (zero-width).
        let baseline = if count < baseline {
            subscription.baseline = Some(count);
            count
        } else {
            baseline
        };
        if count == baseline && status == subscription.last_status {
            return None; // no growth, no repeat status event: quiet
        }
        let change =
            (status != subscription.last_status).then_some((subscription.last_status, status));
        let event = Self::build_event(subscription, baseline, count, change, at_ms);
        subscription.baseline = Some(count);
        subscription.last_status = status;
        Some(event)
    }

    fn build_event(
        subscription: &mut AgentWatchSubscription,
        start: u64,
        end: u64,
        status: Option<(&'static str, &'static str)>,
        at_ms: u64,
    ) -> RlmWatchEvent {
        subscription.total_events += 1;
        RlmWatchEvent {
            id: format!("watch_{}", uuid::Uuid::new_v4().simple()),
            seq: 0, // assigned by push_event
            subscription_id: subscription.id.clone(),
            kind: "watch.agent",
            content: RlmWatchAgentContent {
                target: subscription.child_id.clone(),
                start,
                end,
                status: status.map(|(from, to)| RlmWatchStatusChange { from, to }),
            },
            at_ms,
        }
    }

    /// Append one event to the bounded ring (drop-oldest past either
    /// bound) and answer the event with its assigned `seq`.
    pub(crate) fn push_event(&mut self, mut event: RlmWatchEvent) -> RlmWatchEvent {
        self.next_seq += 1;
        event.seq = self.next_seq;
        self.events_bytes += event_wire_size(&event);
        self.events.push_back(event.clone());
        while self.events.len() > AGENT_WATCH_EVENT_RING_MAX
            || self.events_bytes > AGENT_WATCH_EVENT_RING_MAX_BYTES
        {
            match self.events.pop_front() {
                Some(dropped) => {
                    self.events_bytes = self.events_bytes.saturating_sub(event_wire_size(&dropped));
                    self.dropped += 1;
                }
                None => break,
            }
        }
        event
    }

    /// One readable page: the events with `seq > since_seq`, the cursor
    /// the next read passes, and the ring's cumulative drop count.
    /// A FULL page means unread events may remain beyond it: the cursor
    /// is the last event examined, never the ring's tail (which would
    /// skip them). A partial page has every event past `since_seq` in
    /// hand, so the tail is the resume point.
    pub(crate) fn read(&self, since_seq: u64, limit: u64) -> RlmWatchReadPage {
        let page_limit = limit.min(AGENT_WATCH_READ_LIMIT_MAX);
        let events: Vec<RlmWatchEvent> = self
            .events
            .iter()
            .filter(|event| event.seq > since_seq)
            .take(page_limit as usize)
            .cloned()
            .collect();
        let next_seq = if events.len() as u64 >= page_limit {
            events.last().map_or(self.next_seq, |event| event.seq)
        } else {
            self.next_seq
        };
        RlmWatchReadPage {
            events,
            next_seq,
            dropped: self.dropped,
        }
    }

    /// The owner's watch rows, oldest first (stable replies).
    pub(crate) fn rows(&self) -> Vec<RlmAgentWatch> {
        let mut rows: Vec<RlmAgentWatch> =
            self.subscriptions.keys().map(|id| self.row(id)).collect();
        rows.sort_by(|a, b| {
            a.created_at_ms
                .cmp(&b.created_at_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        rows
    }

    fn row(&self, id: &str) -> RlmAgentWatch {
        let subscription = self
            .subscriptions
            .get(id)
            .expect("a row is read from the same registry that holds it");
        RlmAgentWatch {
            id: subscription.id.clone(),
            child_id: subscription.child_id.clone(),
            child_name: subscription.child_name.clone(),
            messages: subscription.baseline.unwrap_or_default(),
            status: subscription.status.as_str(),
            total_events: subscription.total_events,
            created_at_ms: subscription.created_at_ms,
        }
    }

    /// Test seam: whether a poller handle is parked (the emptied-poller
    /// exit-clear pin reads it from the sibling test module).
    #[cfg(test)]
    pub(crate) fn has_parked_poller(&self) -> bool {
        self.poll.is_some()
    }

    /// Test knob: shorten the poll cadence (the 5s default is TS parity).
    #[cfg(test)]
    pub(crate) fn set_poll_interval_ms(&mut self, interval_ms: u64) {
        self.poll_interval_ms = interval_ms;
    }

    /// Test knob: shorten the snapshot await bound (the 5s default keeps
    /// one dead link from withholding a healthy sibling's batch).
    #[cfg(test)]
    pub(crate) fn set_snapshot_timeout_ms(&mut self, timeout_ms: u64) {
        self.snapshot_timeout_ms = timeout_ms;
    }
}

/// The serialized footprint of one ring event (the ring's byte bound).
fn event_wire_size(event: &RlmWatchEvent) -> usize {
    serde_json::to_string(event)
        .map(|wire| wire.len())
        .unwrap_or_default()
}

/// One poll observation: a snapshot result, the vanished-child arm, a
/// settled-but-never-admitted child (its kickoff failed permanently), or
/// an unadmitted child (its task prompt has not landed: observe nothing
/// this tick, so the parent's own kickoff never fabricates growth).
/// All carry the registration epoch the observation was taken under, so
/// a re-baseline discards one taken before it.
enum WatchObservation {
    Snapshot(String, u64, Result<(u64, &'static str)>),
    Vanished(String, u64),
    /// The kickoff failed before the prompt ever admitted (the worker
    /// was killed and `settle_failed` retained the roster row with an
    /// error verdict): one terminal `-> failed` event ends the watch.
    FailedKickoff(String, u64),
    /// An unadmitted child: no snapshot this tick (the skip is keyed by
    /// the subscription row the poll stage already resolved).
    Unadmitted,
}

impl SupervisorChildSessionsInner {
    /// `rlm.watch.agent`: resolve the target against the live roster
    /// (child id first, then session name — the roster selector order),
    /// baseline off one child snapshot, and register. An unmatched
    /// target is a hard error, never an empty watch. A child whose task
    /// prompt has not landed yet (`rlm.spawn` returns before the
    /// detached prompt reaches the worker) registers WITHOUT a baseline:
    /// the first snapshot after admission arms it, so the parent's own
    /// kickoff prompt landing never fabricates a growth event that a
    /// same-tick short run then reads as activity.
    pub(super) async fn watch_agent_register(
        &self,
        target: &str,
        wake: bool,
    ) -> Result<RlmAgentWatch> {
        let Some(record) = self.find_record_ordered(target).await else {
            bail!("No direct child matches \"{target}\"");
        };
        let (child_id, child_name, active_session_id) = {
            let record = record.lock().await;
            if !record.prompt_admitted {
                // Unarmed until the prompt lands. The row is inserted
                // under the record lock the spawn watcher flips
                // `prompt_admitted` under before its admission arm looks
                // for unarmed rows: either this read sees the admission,
                // or the row exists when the arm looks.
                return self
                    .agent_watch
                    .lock()
                    .await
                    .register(
                        &record.rlm_child_id,
                        &record.session_name,
                        None,
                        now_ms(),
                        wake,
                    )
                    .map_err(|error| anyhow!(error.message()));
            }
            (
                record.rlm_child_id.clone(),
                record.session_name.clone(),
                record.active_session_id.clone(),
            )
        };
        // The register-time baseline snapshot is a link round trip on
        // the same lane the poller snapshots: bound it by the registry's
        // snapshot timeout, not the 30s `STATE_TIMEOUT_MS` — a dead link
        // must not park the kernel's `rlm.watch.agent` call (a wait-only
        // entry state does this inside `run()`).
        let snapshot_timeout_ms = self.agent_watch.lock().await.snapshot_timeout();
        let baseline = tokio::time::timeout(
            Duration::from_millis(snapshot_timeout_ms),
            self.child_watch_snapshot(&active_session_id),
        )
        .await
        .unwrap_or_else(|_| Err(anyhow!("agent watch snapshot timed out")))
        .ok();
        let at_ms = now_ms();
        let mut registry = self.agent_watch.lock().await;
        registry
            .register(&child_id, &child_name, baseline, at_ms, wake)
            .map_err(|error| anyhow!(error.message()))
    }

    /// The task prompt just admitted (host.rs's spawn watcher): the
    /// unadmitted window is over, so every watch registered inside the
    /// spawn -> `watch.agent` window arms NOW, off one bounded snapshot
    /// at the admission boundary — a fast child that finishes before
    /// the next poll tick still reports its growth instead of being
    /// absorbed whole into the baseline by the poller's later arming
    /// read. The arm is quiet (the arming-read contract) and only
    /// touches rows whose baseline is still unarmed; an unreachable
    /// child at the boundary stays unarmed for the poller's arming read.
    pub(super) async fn admit_agent_watch_baselines(
        &self,
        child_id: &str,
        active_session_id: &str,
    ) {
        if !self
            .agent_watch
            .lock()
            .await
            .has_unarmed_for_child(child_id)
        {
            return;
        }
        let snapshot_timeout_ms = self.agent_watch.lock().await.snapshot_timeout();
        let snapshot = tokio::time::timeout(
            Duration::from_millis(snapshot_timeout_ms),
            self.child_watch_snapshot(active_session_id),
        )
        .await
        .unwrap_or_else(|_| Err(anyhow!("agent watch snapshot timed out")))
        .ok();
        let Some((count, status)) = snapshot else {
            return; // unreachable at the boundary: the poller arms it later
        };
        self.agent_watch
            .lock()
            .await
            .arm_admitted(child_id, count, status);
    }

    /// Owner teardown: cancel every subscription, retire the poller
    /// generation (a live poller exits at its next tick), and abort a
    /// parked poller outright so nothing holds the runtime open for a
    /// dead session's watches.
    pub(super) async fn shutdown_agent_watch(&self) {
        let poller = {
            let mut registry = self.agent_watch.lock().await;
            registry.cancel_all();
            registry.poll_generation += 1;
            registry.poll.take()
        };
        if let Some(poller) = poller {
            poller.abort();
        }
    }
}

/// Start the shared poller if none is running (the first successful
/// subscribe is the only caller). Generation-keyed: an emptied registry's
/// winding-down poller never co-polls with a fresh one.
pub(super) async fn ensure_agent_watch_poller(inner: &Arc<SupervisorChildSessionsInner>) {
    let generation = {
        let mut registry = inner.agent_watch.lock().await;
        if registry
            .poll
            .as_ref()
            .is_some_and(|poller| !poller.is_finished())
        {
            return;
        }
        registry.poll_generation += 1;
        registry.poll_generation
    };
    let poller = tokio::spawn(agent_watch_poll_loop(Arc::clone(inner), generation));
    let mut registry = inner.agent_watch.lock().await;
    if registry.poll_generation == generation {
        registry.poll = Some(poller);
    }
}

/// The shared poller: one loop for every active subscription of one
/// owner. Each tick snapshots each watched child over the supervisor
/// link (outside the registry lock), applies the results under one lock
/// hold, and delivers one coalesced quiet wake row for the whole batch.
async fn agent_watch_poll_loop(inner: Arc<SupervisorChildSessionsInner>, generation: u64) {
    loop {
        let interval_ms = inner.agent_watch.lock().await.poll_interval();
        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
        let targets: Vec<(String, u64, String)> = {
            let mut registry = inner.agent_watch.lock().await;
            if registry.poll_generation != generation || !registry.has_active() {
                if registry.poll_generation == generation {
                    // The exit decision is made under this lock: clear
                    // the parked handle here too, or a subscribe landing
                    // before the task is marked finished still sees an
                    // unfinished poller, starts none, and that
                    // subscription is never polled. A superseded
                    // generation already has its replacement parked in
                    // the slot; leave that handle alone.
                    registry.poll = None;
                }
                return; // superseded, emptied, or torn down: exit quietly
            }
            registry
                .subscriptions
                .values()
                .filter(|subscription| subscription.status == WatchStatus::Active)
                .map(|subscription| {
                    (
                        subscription.id.clone(),
                        subscription.epoch,
                        subscription.child_id.clone(),
                    )
                })
                .collect()
        };
        // Child resolution and snapshots are link round trips: never
        // hold the registry lock across them. A chunk's round trips
        // proceed concurrently (a healthy child's event is not withheld
        // behind an unresponsive sibling's 30s link timeout), each
        // bounded by the snapshot timeout; the chunk order keeps the
        // observations (and so the ring) in target order.
        let snapshot_timeout_ms = inner.agent_watch.lock().await.snapshot_timeout();
        let mut observations = Vec::with_capacity(targets.len());
        for chunk in targets.chunks(AGENT_WATCH_SNAPSHOT_CONCURRENCY) {
            let results = futures::future::join_all(chunk.iter().map(
                |(subscription_id, epoch, child_id)| async {
                    let Some(record) = inner.find_record_by_child_id(child_id).await else {
                        return WatchObservation::Vanished(subscription_id.clone(), *epoch);
                    };
                    let (active_session_id, prompt_admitted, settled_status) = {
                        let record = record.lock().await;
                        (
                            record.active_session_id.clone(),
                            record.prompt_admitted,
                            record.settled_status,
                        )
                    };
                    if !prompt_admitted {
                        if settled_status.is_some() {
                            // The kickoff failed permanently: the record
                            // can never admit, so the unadmitted skip
                            // would loop forever against a dead child.
                            // End the watch with one terminal event.
                            return WatchObservation::FailedKickoff(
                                subscription_id.clone(),
                                *epoch,
                            );
                        }
                        // The task prompt has not landed (the spawn ->
                        // watch window): observing now would fabricate
                        // the parent's own kickoff as the first growth
                        // event. Skip the tick; the baseline arms on
                        // the first post-admission snapshot instead.
                        return WatchObservation::Unadmitted;
                    }
                    let snapshot = tokio::time::timeout(
                        Duration::from_millis(snapshot_timeout_ms),
                        inner.child_watch_snapshot(&active_session_id),
                    )
                    .await
                    .unwrap_or_else(|_| Err(anyhow!("agent watch snapshot timed out")));
                    WatchObservation::Snapshot(subscription_id.clone(), *epoch, snapshot)
                },
            ))
            .await;
            observations.extend(results);
        }
        // Apply under one hold: events land in the ring in observation
        // order, and the wake row's lines read each subscription's row
        // name from the same lock.
        let lines: Vec<(RlmWatchEvent, String)> = {
            let mut registry = inner.agent_watch.lock().await;
            if registry.poll_generation != generation {
                return;
            }
            let mut lines = Vec::new();
            for observation in observations {
                match observation {
                    WatchObservation::Unadmitted => {} // no observation this tick
                    WatchObservation::FailedKickoff(subscription_id, epoch) => {
                        if let Some(event) =
                            registry.mark_failed_kickoff(&subscription_id, epoch, now_ms())
                        {
                            let event = registry.push_event(event);
                            let (child_name, wake) = registry
                                .subscriptions
                                .get(&event.subscription_id)
                                .map(|subscription| {
                                    (subscription.child_name.clone(), subscription.wake)
                                })
                                .unwrap_or_default();
                            if wake {
                                lines.push((event, child_name));
                            }
                        }
                    }
                    WatchObservation::Vanished(subscription_id, epoch) => {
                        if let Some(event) =
                            registry.mark_vanished(&subscription_id, epoch, now_ms())
                        {
                            let event = registry.push_event(event);
                            let (child_name, wake) = registry
                                .subscriptions
                                .get(&event.subscription_id)
                                .map(|subscription| {
                                    (subscription.child_name.clone(), subscription.wake)
                                })
                                .unwrap_or_default();
                            if wake {
                                lines.push((event, child_name));
                            }
                        }
                    }
                    WatchObservation::Snapshot(subscription_id, epoch, snapshot) => {
                        if let Some(event) =
                            registry.apply_snapshot(&subscription_id, epoch, &snapshot, now_ms())
                        {
                            let event = registry.push_event(event);
                            let (child_name, wake) = registry
                                .subscriptions
                                .get(&event.subscription_id)
                                .map(|subscription| {
                                    (subscription.child_name.clone(), subscription.wake)
                                })
                                .unwrap_or_default();
                            if wake {
                                lines.push((event, child_name));
                            }
                        }
                    }
                }
            }
            lines
        };
        if !lines.is_empty() {
            let notice_lines: Vec<AgentWatchNoticeLine> = lines
                .iter()
                .map(|(event, child_name)| AgentWatchNoticeLine {
                    subscription_id: &event.subscription_id,
                    child_id: &event.content.target,
                    child_name,
                    from_index: event.content.start,
                    to_index: event.content.end,
                    status: event
                        .content
                        .status
                        .as_ref()
                        .map(|change| (change.from, change.to)),
                })
                .collect();
            inner
                .deliver_terminal_notice(create_agent_watch_notice(&notice_lines, now_ms()))
                .await;
        }
    }
}
