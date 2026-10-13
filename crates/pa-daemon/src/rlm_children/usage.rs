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
    /// report; the cursor advances only past the rows the sink persisted
    /// (no double-billing; a failed delivery re-reads the same rows);
    /// without a sink nothing is read, a torn trailing line lands on the
    /// next read. Returns false if the source could not be observed or its report is still owed.
    pub(super) async fn emit_child_usage(&self, record: &Arc<Mutex<ChildRecord>>) -> bool {
        let sink = self.usage_sink.lock().expect("usage sink lock").clone();
        let Some(sink) = sink else {
            return true;
        };
        // One emission at a time per child — an interleaved re-read
        // would double-bill, and the emission lock spans the whole flow
        // (the record lock only frames short snapshots).
        // Two statements on purpose: the first record guard drops BEFORE the
        // emit lock awaits — a record guard held across the emit-lock wait
        // would deadlock the two.
        let emit_lock = record.lock().await.emit_lock.clone();
        let emit_guard = emit_lock.lock().await;
        if record.lock().await.usage_registration_forgotten {
            return true;
        }
        let mut drain_fresh_interval = record.lock().await.pending_usage_report.is_some();
        let persisted = loop {
            let pending = record.lock().await.pending_usage_report.clone();
            let (report, next) = if let Some(pending) = pending {
                pending
            } else {
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
                    return true;
                };
                let Some(from) = from else {
                    return true;
                };
                let path = PathBuf::from(session_file);
                let joined = tokio::task::spawn_blocking(move || {
                    crate::session_store::SessionFile::open(&path)
                })
                .await
                .ok();
                let Some(Ok(store)) = joined else {
                    return false;
                };
                let (batches, next) =
                    crate::rlm_child_usage::child_usage_batches(store.entries(), from);
                if batches.is_empty() {
                    record.lock().await.attributed_rows = Some(next);
                    return true;
                }
                let report = RlmChildUsageReport {
                    report_id: uuid::Uuid::new_v4().to_string(),
                    rlm_child_id,
                    batches,
                };
                // Install before awaiting the sink. A canceled future leaves the immutable
                // interval available; newer child rows wait behind this exact report.
                record.lock().await.pending_usage_report = Some((report.clone(), next));
                (report, next)
            };
            let persisted = sink.record(report).await;
            if persisted {
                let mut record = record.lock().await;
                record.attributed_rows = Some(next);
                record.pending_usage_report = None;
                drop(record);
                if drain_fresh_interval {
                    drain_fresh_interval = false;
                    continue;
                }
            }
            break persisted;
        };
        drop(emit_guard);
        persisted
    }

    /// Replay a failed terminal observation once before its watcher retires.
    /// This caps observations, not elapsed time; a second failure stays owed to the existing owner.
    pub(super) async fn emit_final_child_usage(&self, record: &Arc<Mutex<ChildRecord>>) {
        if self.emit_child_usage(record).await {
            return;
        }
        if record.lock().await.closed_by_parent {
            return;
        }
        self.emit_child_usage(record).await;
    }

    /// Drop registration only after the final report persisted; return whether it is cleared.
    /// A failed bounded replay leaves both the report and its registration owed.
    pub(super) async fn forget_child_usage(&self, record: &Arc<Mutex<ChildRecord>>) -> bool {
        if record.lock().await.usage_registration_forgotten {
            return true;
        }
        let sink = self.usage_sink.lock().expect("usage sink lock").clone();
        let Some(sink) = sink else {
            return true;
        };
        // A failed final delivery keeps its report owed, and no observation
        // follows this call: replay it once before the registration drops,
        // or the forget orphans the retained report.
        // Also observe the frozen child's tail if a prior caller was canceled before capturing it.
        if !self.emit_child_usage(record).await {
            return false;
        }
        let emit_lock = record.lock().await.emit_lock.clone();
        let _emit_guard = emit_lock.lock().await;
        let mut row = record.lock().await;
        if row.usage_registration_forgotten {
            return true;
        }
        if row.pending_usage_report.is_some() {
            return false;
        }
        // Forget touches only the producer registry and does not re-enter the child record.
        // Serialize its acknowledgment with final emission and record the receipt without an await.
        sink.forget(&row.rlm_child_id).await;
        row.usage_registration_forgotten = true;
        true
    }

    /// Keep a confirmed-dead child's final accounting reachable after roster retirement.
    pub(super) fn retain_retired_usage(
        &self,
        record: &Arc<Mutex<ChildRecord>>,
        intent: super::RetirementIntent,
    ) {
        let mut retired = self
            .retired_usage
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !retired.iter().any(|held| Arc::ptr_eq(&held.record, record)) {
            retired.push(super::RetiredChild {
                record: Arc::clone(record),
                intent,
            });
        }
    }

    pub(super) fn retirement_intent(
        &self,
        record: &Arc<Mutex<ChildRecord>>,
    ) -> Option<super::RetirementIntent> {
        self.retired_usage
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .find(|held| Arc::ptr_eq(&held.record, record))
            .map(|held| held.intent)
    }

    pub(super) fn has_retired_usage(&self, record: &Arc<Mutex<ChildRecord>>) -> bool {
        self.retirement_intent(record).is_some()
    }

    pub(super) fn remove_retired_usage(&self, record: &Arc<Mutex<ChildRecord>>) {
        self.retired_usage
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|held| !Arc::ptr_eq(&held.record, record));
    }

    /// One bounded replay per matching receipt; never repeat a confirmed worker kill.
    pub(super) async fn replay_retired_usage(&self, target: Option<&str>) -> bool {
        let retired = self
            .retired_usage
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let mut persisted = true;
        for retirement in retired {
            let record = retirement.record;
            let matches = {
                let row = record.lock().await;
                target.is_none_or(|target| row.matches(target))
            };
            if !matches {
                continue;
            }
            let rename_lock = record.lock().await.rename_lock.clone();
            let _guard = rename_lock.lock().await;
            if !self
                .retired_usage
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .any(|held| Arc::ptr_eq(&held.record, &record))
            {
                continue;
            }
            // An interrupted caller still owns lifecycle completion through the roster.
            if self
                .children
                .lock()
                .await
                .iter()
                .any(|held| Arc::ptr_eq(held, &record))
            {
                continue;
            }
            let usage_persisted = self.forget_child_usage(&record).await;
            self.finish_retirement(&record).await;
            if usage_persisted {
                self.remove_retired_usage(&record);
            }
            persisted &= usage_persisted;
        }
        persisted
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
                            self.emit_final_child_usage(&record).await;
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
                                self.emit_final_child_usage(&record).await;
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
                                self.emit_final_child_usage(&record).await;
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
                self.emit_final_child_usage(&record).await;
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
