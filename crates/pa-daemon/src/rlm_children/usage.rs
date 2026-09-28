//! The child-usage attribution concern: the per-origin usage batches,
//! the forget/emit pairing, and the rearming watch loop.
use super::{
    Arc,
    ChildRecord,
    Duration,
    FOLLOWUP_START_GRACE_MS,
    FOLLOWUP_START_POLL_MS,
    Instant,
    Mutex,
    PathBuf,
    RlmChildUsageReport,
    SupervisorChildSessionsInner,
    WATCH_MAX_UNREACHABLE_POLLS,
    WATCH_POLL_INTERVAL_MS,
    WATCH_SETTLE_GRACE_MS,
    WATCH_WAIT_SLICE_MS,
};

impl SupervisorChildSessionsInner {
    /// Deliver the child's unattributed usage rows to the attribution
    /// producer as one per-origin report (TS
    /// `flushPendingChildUsageAttribution`'s observation seam; the
    /// producer folds the batches into the spawning parent assistant row
    /// and appends the durable `child_usage_attributed` rows). The cursor
    /// advances past every parsed row — attributed or not — so repeated
    /// observation never double-bills; without a wired sink nothing is
    /// read or consumed. A torn trailing line (a concurrent append) is
    /// skipped and lands on the next read.
    pub(super) async fn emit_child_usage(&self, record: &Arc<Mutex<ChildRecord>>) {
        let sink = self.usage_sink.lock().expect("usage sink lock").clone();
        let Some(sink) = sink else {
            return;
        };
        // One emission at a time per child — an interleaved re-read would
        // double-bill, and an interleaved DELIVERY would break the durable
        // rows' cumulative aggregate chain (the reader fold keeps the last
        // row's aggregate, so the second observer's rows would silently
        // drop out of the folded row). The emission lock spans the whole
        // flow; the record lock itself only ever frames short snapshots,
        // so the watcher polls and close paths never wait behind a big
        // file read.
        // Two statements on purpose: the record guard of the first drops
        // at its statement end, BEFORE the emit lock awaits — an emitter
        // that already holds the emit lock re-locks the record to advance
        // the cursor, so a record guard alive across the emit-lock wait
        // would deadlock the two.
        let emit_lock = record.lock().await.emit_lock.clone();
        let emit_guard = emit_lock.lock().await;
        let (rlm_child_id, session_file, from) = {
            let record_guard = record.lock().await;
            (
                record_guard.rlm_child_id.clone(),
                record_guard
                    .session_file
                    .clone()
                    .filter(|path| !path.is_empty()),
                record_guard.attributed_rows,
            )
        };
        let Some(session_file) = session_file else {
            return;
        };
        // The open+parse is a blocking read of a file that can reach tens
        // of megabytes: run it on the blocking pool, never the async
        // worker (a slow file read must not stall unrelated tasks on the
        // runtime).
        let path = PathBuf::from(session_file);
        let joined =
            tokio::task::spawn_blocking(move || crate::session_store::SessionFile::open(&path))
                .await
                .ok();
        let Some(Ok(store)) = joined else {
            // Same failure contract as before: a torn or unreadable file
            // leaves the cursor untouched — the next observation retries.
            return;
        };
        let (batches, next) = crate::rlm_child_usage::child_usage_batches(store.entries(), from);
        {
            let mut record_guard = record.lock().await;
            record_guard.attributed_rows = next;
        }
        if batches.is_empty() {
            return;
        }
        sink.record(RlmChildUsageReport {
            rlm_child_id,
            batches,
        })
        .await;
        drop(emit_guard);
    }

    /// Drop one child's attribution registration after its final
    /// observation (the close and delete paths call this once their last
    /// cursor walk completed — TS keeps a child's subscription alive only
    /// while the child lives, so sequential children must not accumulate
    /// registrations in the producer).
    pub(super) async fn forget_child_usage(&self, record: &Arc<Mutex<ChildRecord>>) {
        let sink = self.usage_sink.lock().expect("usage sink lock").clone();
        let Some(sink) = sink else {
            return;
        };
        let rlm_child_id = record.lock().await.rlm_child_id.clone();
        sink.forget(&rlm_child_id).await;
    }

    /// Start the follow-up usage watcher for a settled child that is busy
    /// again — a retained child running a delayed agent-message turn. TS
    /// keeps the child subscription alive after run settlement; the
    /// Rust task-run watcher retired at settle, so this observation-only
    /// watcher covers the follow-up turn's usage. It never touches the
    /// run status, notices, or the settle hook.
    pub(super) async fn arm_usage_watch(this: &Arc<Self>, record: &Arc<Mutex<ChildRecord>>) {
        {
            let mut record = record.lock().await;
            if record.closed_by_parent {
                return;
            }
            if record.usage_watch_live {
                // A watcher is already observing this child (armed for an
                // earlier delivery): ask IT to observe this delivery's
                // turn too, instead of arming a second watcher — the live
                // watcher retires only when no delivery is owed, so a
                // turn queued behind the one under observation never goes
                // unobserved.
                record.usage_rearm = true;
                return;
            }
            record.usage_watch_live = true;
        }
        let watcher = Arc::clone(this);
        let record = Arc::clone(record);
        tokio::spawn(async move {
            watcher.watch_child_usage(record).await;
        });
    }

    /// Observe follow-up turns' usage: wait for the child to sit idle
    /// once (the arm can land mid-run — a message delivered during the
    /// task run queues behind it), wait for the delivered turn to start
    /// (bounded — a delivery the child never picks up attributes
    /// nothing), then idle-wait slices until the turn settles, emitting
    /// observed rows along the way exactly like the task-run watcher's
    /// slices. A delivery that arrived while this watcher was live
    /// re-arms it for another turn instead of arming a second watcher,
    /// so consecutive follow-up turns each get an observation.
    async fn watch_child_usage(self: Arc<Self>, record: Arc<Mutex<ChildRecord>>) {
        loop {
            // Phase 0: the child must sit idle once before the delivered
            // turn can start (the run in flight at arm time is NOT the
            // delivered turn; retiring on its settle would leave the
            // queued follow-up unobserved).
            let mut unreachable_polls: u32 = 0;
            loop {
                if record.lock().await.closed_by_parent {
                    record.lock().await.usage_watch_live = false;
                    return;
                }
                let active_session_id = record.lock().await.active_session_id.clone();
                match self.child_busy(&active_session_id).await {
                    Ok(false) => break,
                    Ok(true) => {}
                    Err(_) => {
                        unreachable_polls += 1;
                        if unreachable_polls >= WATCH_MAX_UNREACHABLE_POLLS {
                            // A dead child keeps whatever rows its file
                            // already holds; capture them, then stop.
                            self.emit_child_usage(&record).await;
                            record.lock().await.usage_watch_live = false;
                            return;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(FOLLOWUP_START_POLL_MS)).await;
            }
            // Phase 1: the delivered turn must start before it can be
            // observed.
            let start_deadline = Instant::now() + Duration::from_millis(FOLLOWUP_START_GRACE_MS);
            let mut turn_started = false;
            loop {
                if record.lock().await.closed_by_parent {
                    record.lock().await.usage_watch_live = false;
                    return;
                }
                let active_session_id = record.lock().await.active_session_id.clone();
                match self.child_busy(&active_session_id).await {
                    Ok(true) => {
                        turn_started = true;
                        break;
                    }
                    Ok(false) | Err(_) if Instant::now() >= start_deadline => break,
                    Ok(false) | Err(_) => {}
                }
                tokio::time::sleep(Duration::from_millis(FOLLOWUP_START_POLL_MS)).await;
            }
            if turn_started {
                // Phase 2: slice-wait until the turn settles (the
                // task-run watcher's cadence, minus its settle
                // bookkeeping).
                let mut unreachable_polls: u32 = 0;
                loop {
                    if record.lock().await.closed_by_parent {
                        break;
                    }
                    let active_session_id = record.lock().await.active_session_id.clone();
                    self.wait_for_child(
                        &active_session_id,
                        Duration::from_millis(WATCH_WAIT_SLICE_MS),
                    )
                    .await;
                    match self.child_busy(&active_session_id).await {
                        Ok(false) => {
                            // Settle grace: the delivered-turn pop races
                            // the idle snapshot (the queue and the busy
                            // flag change under different locks on the
                            // far side of a socket).
                            tokio::time::sleep(Duration::from_millis(WATCH_SETTLE_GRACE_MS)).await;
                            if matches!(self.child_busy(&active_session_id).await, Ok(false)) {
                                self.emit_child_usage(&record).await;
                                break;
                            }
                        }
                        Ok(true) => {
                            // Mid-turn rows landed since the last slice.
                            self.emit_child_usage(&record).await;
                            unreachable_polls = 0;
                        }
                        Err(_) => {
                            unreachable_polls += 1;
                            if unreachable_polls >= WATCH_MAX_UNREACHABLE_POLLS {
                                // A dead child keeps whatever rows its
                                // file already holds; capture them, then
                                // stop.
                                self.emit_child_usage(&record).await;
                                break;
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(WATCH_POLL_INTERVAL_MS)).await;
                }
            } else {
                // The turn never showed busy: it either completed
                // between two polls (its rows are on disk — bill them) or
                // the delivery never started a turn (the cursor walk is a
                // no-op). Observe once before the tail decides whether
                // another delivery is owed — the TS subscription never
                // stops observing a live child.
                self.emit_child_usage(&record).await;
            }
            // The tail: a delivery that arrived while this watcher was
            // live re-arms it for another turn (the flag was set instead
            // of a second watcher); otherwise the observation retires.
            // The flag read, its clear, and the live-flag clear happen in
            // ONE record-lock section: an arm racing the tail either
            // sees the live flag still set (its re-arm request is
            // consumed here and this watcher loops) or sees it already
            // clear (it spawns a fresh watcher) — the decision can never
            // strand a re-arm request behind a retired watcher.
            let rearm = {
                let mut record = record.lock().await;
                let rearm = record.usage_rearm;
                record.usage_rearm = false;
                if !rearm {
                    record.usage_watch_live = false;
                }
                rearm
            };
            if !rearm {
                return;
            }
        }
    }
}
