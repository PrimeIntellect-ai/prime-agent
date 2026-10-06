//! The child-usage attribution concern: the per-origin usage batches,
//! the forget/emit pairing, and the rearming watch loop.
use super::{
    Arc, ChildRecord, Duration, Instant, Mutex, PathBuf, RlmChildUsageReport,
    SupervisorChildSessionsInner, FOLLOWUP_START_GRACE_MS, FOLLOWUP_START_POLL_MS,
    WATCH_MAX_UNREACHABLE_POLLS, WATCH_POLL_INTERVAL_MS, WATCH_SETTLE_GRACE_MS,
    WATCH_WAIT_SLICE_MS,
};

impl SupervisorChildSessionsInner {
    /// Deliver the child's unattributed usage rows as one per-origin
    /// report; the cursor advances past every parsed row (no
    /// double-billing); without a sink nothing is read, a torn trailing
    /// line lands on the next read.
    pub(super) async fn emit_child_usage(&self, record: &Arc<Mutex<ChildRecord>>) {
        let sink = self.usage_sink.lock().expect("usage sink lock").clone();
        let Some(sink) = sink else {
            return;
        };
        // One emission at a time per child — an interleaved re-read
        // would double-bill, and the emission lock spans the whole flow
        // (the record lock only frames short snapshots).
        // Two statements on purpose: the first record guard drops BEFORE the
        // emit lock awaits — a record guard held across the emit-lock wait
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
        // A reseeded row nothing has observed yet: nothing to bill until a delivery primes it.
        let Some(from) = from else {
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
            record_guard.attributed_rows = Some(next);
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
    /// observation, so sequential children do not accumulate registrations in the producer.
    pub(super) async fn forget_child_usage(&self, record: &Arc<Mutex<ChildRecord>>) {
        let sink = self.usage_sink.lock().expect("usage sink lock").clone();
        let Some(sink) = sink else {
            return;
        };
        let rlm_child_id = record.lock().await.rlm_child_id.clone();
        sink.forget(&rlm_child_id).await;
    }

    /// Start the follow-up usage watcher for a settled child that is
    /// busy again (a delayed agent-message turn): observation-only, it
    /// never touches the run status, notices, or the settle hook.
    pub(super) async fn arm_usage_watch(this: &Arc<Self>, record: &Arc<Mutex<ChildRecord>>) {
        if record.lock().await.closed_by_parent {
            return;
        }
        // Prime a lazy cursor at the tail so the pre-restart history is never billed.
        if record.lock().await.attributed_rows.is_none() {
            // A local, not an if-let scrutinee: the scrutinee's guard would
            // live through the body and deadlock the re-lock below.
            let session_file = record
                .lock()
                .await
                .session_file
                .clone()
                .filter(|path| !path.is_empty());
            if let Some(session_file) = session_file {
                let path = PathBuf::from(session_file);
                let tail = tokio::task::spawn_blocking(move || {
                    crate::session_store::SessionFile::open(&path)
                        .map(|store| store.entries().len())
                })
                .await;
                // A failed read stays lazy: a zero cursor would re-bill the whole history.
                if let Ok(Ok(tail)) = tail {
                    record.lock().await.attributed_rows.get_or_insert(tail);
                }
            }
        }
        {
            let mut record = record.lock().await;
            if record.usage_watch_live {
                // A watcher is already live: ask IT to observe this
                // delivery's turn too, instead of arming a second watcher
                // (it retires only when no delivery is owed).
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

    /// Observe follow-up turns' usage: wait for the child to sit idle once, wait for the delivered
    /// turn to start (bounded), then idle-wait slices until it settles.
    async fn watch_child_usage(self: Arc<Self>, record: Arc<Mutex<ChildRecord>>) {
        loop {
            // Phase 0: the child must sit idle once before the delivered
            // turn can start (the run in flight at arm time is NOT the
            // delivered turn).
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
                // Phase 2: slice-wait until the turn settles (the task-run
                // watcher's cadence, minus its settle bookkeeping).
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
                            // the idle snapshot (different locks on the far
                            // side of a socket).
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
                // The turn never showed busy: it completed between two
                // polls (bill its rows) or never started (the cursor walk
                // is a no-op).
                self.emit_child_usage(&record).await;
            }
            // The tail: a delivery that arrived while this watcher was live
            // re-arms it; otherwise it retires. The flag read and clear
            // happen in ONE record-lock section, so an arm racing the tail
            // re-arms or spawns a fresh watcher.
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
