//! Snapshot / restore: capture state snapshots from the kernel, restore them,
//! and flush on dispose.

use super::{
    describe_failure, lock, Arc, CaptureFreshness, Duration, ExecuteOptions, ExecuteStatus, Inner,
    Instant, KernelState, ManifestStat, MemoSlot, Request, RestoreResult, RestoredNamespaceSkip,
    SnapshotResult, SnapshotSkip, Value, DEFAULT_SNAPSHOT_DEBOUNCE_MS, DEFAULT_SNAPSHOT_MAX_BYTES,
    DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES, REPAIR_STEP_TIMEOUT_MS, RESTORE_EXECUTION_TIMEOUT_MS,
    SNAPSHOT_EXECUTION_TIMEOUT_MS,
};

/// The runtime snapshot writer's reason for a name above the per-variable cap: such a skipped name
/// is a live over-cap survivor unless the same capture also pruned it.
const OVER_CAP_SKIP_REASON: &str = "exceeds per-variable snapshot size cap";

/// Bound on the witness stat pair's await: a stalled artifacts filesystem must not wedge a capture;
/// a timed-out stat reads as "not fresh".
const STAT_TIMEOUT: Duration = Duration::from_millis(250);

impl Inner {
    /// Serialize the user namespace to disk (best-effort, per-variable). `None` when the kernel
    /// isn't running or no snapshot target was configured.
    pub(crate) async fn capture_snapshot(
        self: &Arc<Self>,
        execution_timeout_ms: Option<u64>,
        prune_oversized: bool,
    ) -> Option<SnapshotResult> {
        let cfg = self.options.snapshot.clone()?;
        if !self.is_running_state() {
            return None;
        }
        // While the namespace provably cannot have changed, a fresh capture would reproduce the
        // committed payload: skip the kernel request.
        if let Some(fresh) = self.fresh_capture(prune_oversized).await {
            return Some(fresh);
        }
        // The user-settled count and the invalidation epoch the memo may claim, read before the
        // request is queued. Only a user cell settling ahead of this capture can move the count.
        let (user_executions_before, epoch_before) = {
            let g = lock(&self.guarded);
            (g.user_executions, g.freshness_epoch)
        };
        let request = Request::Snapshot {
            path: cfg.path.to_string_lossy().to_string(),
            manifest_path: cfg.manifest_path.to_string_lossy().to_string(),
            max_bytes: cfg.max_bytes.unwrap_or(DEFAULT_SNAPSHOT_MAX_BYTES),
            max_variable_bytes: cfg
                .max_variable_bytes
                .unwrap_or(DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES),
            prune_oversized,
        };
        let result = self
            .enqueue_request(
                request,
                "",
                ExecuteOptions {
                    internal: true,
                    ..ExecuteOptions::default()
                },
                execution_timeout_ms,
            )
            .await;
        match result {
            Ok(r) if r.result.status == ExecuteStatus::Ok => {
                let Some(fields) = &r.done_fields else {
                    self.append_diagnostic("state snapshot failed: no done fields");
                    return None;
                };
                let committed = SnapshotResult {
                    saved: as_string_array(fields, "saved"),
                    skipped: as_reason_array(fields, "skipped"),
                    pruned: {
                        let pruned = as_string_array(fields, "pruned");
                        (!pruned.is_empty()).then_some(pruned)
                    },
                    bytes: fields.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                    path: cfg.path.clone(),
                };
                // The commit sequence: the arm may only run while no LATER capture has committed.
                let capture_sequence = {
                    let mut g = lock(&self.guarded);
                    g.capture_sequence += 1;
                    g.capture_sequence
                };
                self.record_capture_freshness(
                    &cfg,
                    &committed,
                    user_executions_before,
                    epoch_before,
                    capture_sequence,
                )
                .await;
                Some(committed)
            }
            // A failed capture leaves the memo describing the last successful
            // commit — still valid while nothing settled since it.
            Ok(r) => {
                self.append_diagnostic(&format!(
                    "state snapshot {}: {}",
                    if r.result.status == ExecuteStatus::Aborted {
                        "timed out"
                    } else {
                        "failed"
                    },
                    describe_failure(&r.result),
                ));
                None
            }
            Err(error) => {
                self.append_diagnostic(&format!("state snapshot error: {error:#}"));
                None
            }
        }
    }

    fn is_running_state(&self) -> bool {
        lock(&self.guarded).state == KernelState::Running
    }

    /// The recurring capture-freshness skip (see `CaptureFreshness`):
    /// `Some(result)` replays the last committed capture.
    async fn fresh_capture(self: &Arc<Self>, prune_oversized: bool) -> Option<SnapshotResult> {
        let (user_executions, memo) = {
            let g = lock(&self.guarded);
            (g.user_executions, g.capture_freshness.clone())
        };
        let memo = memo?;
        if user_executions != memo.user_executions {
            return None;
        }
        // A pruning capture still must run while live over-cap names
        // survive: it removes and discloses them (#227 semantics).
        if prune_oversized && memo.live_over_cap {
            return None;
        }
        let cfg = self.options.snapshot.clone()?;
        let current = stats_after_commit(&self.freshness_stat_probe, &cfg).await;
        // None never matches: a stalled or unavailable filesystem read (or
        // a memo armed without both stats) must not vouch for the payload.
        let (Some(current_payload), Some(current_manifest)) = current else {
            return None;
        };
        if Some(current_payload) != memo.payload_stat
            || Some(current_manifest) != memo.manifest_stat
        {
            return None;
        }
        // The invalidation epoch and the settle-race guard, read together under ONE lock
        // acquisition: reading both under the settle's acquisition closes the split-lock window.
        {
            let g = lock(&self.guarded);
            if g.freshness_epoch != memo.epoch || g.user_executions != memo.user_executions {
                return None;
            }
        }
        let mut result = memo.result;
        // The pruned names left the live namespace with the commit that
        // pruned them; a fresh prune finds nothing to disclose.
        result.pruned = None;
        Some(result)
    }

    /// Arm the freshness memo with a committed capture: the namespace stays provably unchanged
    /// until the next settled USER execution or an external payload replacement.
    async fn record_capture_freshness(
        self: &Arc<Self>,
        cfg: &crate::kernel::shared::KernelSnapshotConfig,
        result: &SnapshotResult,
        user_executions: u64,
        epoch: u64,
        capture_sequence: u64,
    ) {
        // The stat pair is the witness artifact. The memo arms ONLY with both stats present and the
        // epoch unmoved — a stalled, contended, or missing read never memoizes.
        let (payload_stat, manifest_stat) =
            stats_after_commit(&self.freshness_stat_probe, cfg).await;
        let live_over_cap = result.skipped.iter().any(|skip| {
            skip.reason == OVER_CAP_SKIP_REASON
                && !result
                    .pruned
                    .as_ref()
                    .is_some_and(|pruned| pruned.contains(&skip.name))
        });
        let mut g = lock(&self.guarded);
        if payload_stat.is_some()
            && manifest_stat.is_some()
            && g.freshness_epoch == epoch
            && g.capture_sequence == capture_sequence
        {
            g.capture_freshness = Some(CaptureFreshness {
                user_executions,
                epoch,
                payload_stat,
                manifest_stat,
                result: result.clone(),
                live_over_cap,
            });
        }
        // A missing stat pair or an epoch move never arms and leaves any
        // previous memo untouched: wiping would cost a redundant re-dump.
    }

    /// Revive a previously snapshotted namespace. `None` when no snapshot is configured or the
    /// restore failed; every restore is bounded so a wedged kernel cannot stall `start()`.
    pub(crate) async fn perform_restore(
        self: &Arc<Self>,
        protocol_repair: bool,
    ) -> Option<RestoreResult> {
        let cfg = self.options.snapshot.clone()?;
        // Before the attempt, so a failed restore still arms the skip;
        // repair retries keep the non-repair stat.
        if !protocol_repair {
            // Off the executor: a stalled (network/FUSE) artifacts filesystem
            // must not wedge the async worker during startup or recovery.
            let manifest_path = cfg.manifest_path.clone();
            let stat = tokio::task::spawn_blocking(move || manifest_stat_of(&manifest_path))
                .await
                .ok();
            lock(&self.guarded).restored_manifest_stat = stat;
        }
        let request = Request::Restore {
            path: cfg.path.to_string_lossy().to_string(),
            max_bytes: cfg.max_bytes.unwrap_or(DEFAULT_SNAPSHOT_MAX_BYTES),
            max_variable_bytes: cfg
                .max_variable_bytes
                .unwrap_or(DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES),
        };
        let result = self
            .enqueue_request(
                request,
                "",
                ExecuteOptions {
                    internal: true,
                    protocol_repair,
                    ..ExecuteOptions::default()
                },
                Some(if protocol_repair {
                    REPAIR_STEP_TIMEOUT_MS
                } else {
                    RESTORE_EXECUTION_TIMEOUT_MS
                }),
            )
            .await;
        if !protocol_repair {
            // Suppress the debounced auto-snapshot the following bootstrap schedules
            // until the skip arm or a user cell takes over.
            let mut g = lock(&self.guarded);
            g.restore_boot_hold = Some(g.completed_executions);
        }
        match result {
            Ok(r) if r.result.status == ExecuteStatus::Ok => {
                let failed = if let Some(fields) = &r.done_fields {
                    as_reason_array(fields, "failed")
                } else {
                    self.append_diagnostic("state restore failed: no done fields");
                    {
                        let mut g = lock(&self.guarded);
                        g.pending_restore = false;
                        g.restore_incomplete = true;
                    }
                    return None;
                };
                // A partial restore still leaves the on-disk payload the fuller copy:
                // the dispose flush must not overwrite it either.
                let incomplete = !failed.is_empty();
                {
                    let mut g = lock(&self.guarded);
                    g.pending_restore = false;
                    g.restore_incomplete = incomplete;
                }
                Some(RestoreResult {
                    restored: as_string_array(r.done_fields.as_ref().expect("checked"), "restored"),
                    failed,
                    path: cfg.path,
                })
            }
            Ok(r) => {
                self.append_diagnostic(&format!(
                    "state restore {}: {}",
                    if r.result.status == ExecuteStatus::Aborted {
                        "timed out"
                    } else {
                        "failed"
                    },
                    describe_failure(&r.result),
                ));
                // The namespace never got the saved state, so the on-disk
                // payload must stay the fresher copy.
                if !protocol_repair {
                    let mut g = lock(&self.guarded);
                    g.pending_restore = true;
                    g.restore_incomplete = true;
                }
                None
            }
            Err(error) => {
                self.append_diagnostic(&format!("state restore error: {error:#}"));
                if !protocol_repair {
                    let mut g = lock(&self.guarded);
                    g.pending_restore = true;
                    g.restore_incomplete = true;
                }
                None
            }
        }
    }

    /// Arm the one-shot post-restore snapshot skip: the bootstrap-scheduled snapshot would rewrite
    /// identical content.
    pub(crate) fn mark_restored_namespace_fresh(self: &Arc<Self>) {
        let mut g = lock(&self.guarded);
        // No attempted non-repair restore to match.
        let Some(manifest_stat) = g.restored_manifest_stat.take() else {
            return;
        };
        g.restored_namespace_skip = Some(RestoredNamespaceSkip {
            manifest_stat,
            completed_executions: g.completed_executions,
        });
    }

    /// One-shot: consumed whether or not it fires. The skip holds only when no execution settled
    /// since the arm AND the manifest stat still matches the one.
    async fn consume_restored_snapshot_skip(self: &Arc<Self>) -> bool {
        let skip = lock(&self.guarded).restored_namespace_skip.take();
        let Some(skip) = skip else {
            return false;
        };
        if lock(&self.guarded).completed_executions != skip.completed_executions {
            return false;
        }
        let Some(cfg) = self.options.snapshot.clone() else {
            return false;
        };
        // Off the executor, like the arming stat in perform_restore.
        let stat = tokio::task::spawn_blocking(move || manifest_stat_of(&cfg.manifest_path))
            .await
            .ok()
            .flatten();
        match (stat, skip.manifest_stat) {
            (Some(current), Some(armed)) => current == armed,
            (None, None) => true,
            _ => false,
        }
    }

    /// Debounced auto-snapshot after a successful execution: a later resume
    /// (or a crash before graceful shutdown) revives the most recent namespace.
    pub(crate) fn schedule_snapshot(self: &Arc<Self>) {
        if self.options.snapshot.is_none() {
            return;
        }
        let debounce = self
            .options
            .snapshot
            .as_ref()
            .and_then(|cfg| cfg.debounce_ms)
            .unwrap_or(DEFAULT_SNAPSHOT_DEBOUNCE_MS);
        let mut timer = lock(&self.snapshot_timer);
        if let Some(existing) = timer.take() {
            existing.abort();
        }
        // Weak so a dropped manager's pending debounce cannot delay the
        // teardown kill (dispose paths flush explicitly before dropping).
        let inner = Arc::downgrade(self);
        *timer = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(debounce)).await;
            if let Some(inner) = inner.upgrade() {
                // The bootstrap schedules this flush; rewriting the just-restored payload while the
                // namespace is unchanged is the one write that must not happen.
                if inner.consume_restored_snapshot_skip().await {
                    return;
                }
                // The boot that followed a restore owns this window: the +1 is the
                // bootstrap's own settle; a user cell is the +2 that ends the hold.
                let (held, completed) = {
                    let g = lock(&inner.guarded);
                    (g.restore_boot_hold, g.completed_executions)
                };
                if held.is_some_and(|held| completed <= held + 1) {
                    return;
                }
                inner
                    .capture_snapshot(Some(SNAPSHOT_EXECUTION_TIMEOUT_MS), false)
                    .await;
            }
        }));
    }

    /// Concurrent teardowns join one flush: a second flusher would clear the
    /// execution guard mid-snapshot and enqueue a duplicate final snapshot.
    pub(crate) async fn flush_snapshot_for_dispose(self: &Arc<Self>) {
        let slot = {
            let mut memo = lock(&self.flush_memo);
            if let Some(existing) = memo.as_ref() {
                existing.clone()
            } else {
                let slot = MemoSlot::new();
                *memo = Some(slot.clone());
                slot
            }
        };
        let owns = {
            let memo = lock(&self.flush_memo);
            matches!(memo.as_ref(), Some(current) if Arc::ptr_eq(current, &slot))
        };
        if owns {
            self.run_snapshot_flush_for_dispose().await;
            slot.finish(None);
            let mut memo = lock(&self.flush_memo);
            if matches!(memo.as_ref(), Some(current) if Arc::ptr_eq(current, &slot)) {
                *memo = None;
            }
        } else {
            let _ = slot.wait().await;
        }
    }

    async fn run_snapshot_flush_for_dispose(self: &Arc<Self>) {
        if self.options.snapshot.is_none() || !self.is_running_state() {
            return;
        }
        // A kernel that never (fully) restored the saved namespace must not
        // overwrite it: the on-disk snapshot is strictly fresher.
        if lock(&self.guarded).pending_restore || lock(&self.guarded).restore_incomplete {
            return;
        }
        // Block new external executions so none can splice ahead of the final
        // snapshot and stall dispose.
        lock(&self.guarded).flushing_snapshot_for_dispose = true;
        async {
            if lock(&self.guarded).active_execution.is_some() {
                let _ = self.interrupt(None).await;
            }
            // Wait for the execution queue to drain, bounded by the snapshot
            // execution timeout.
            let deadline = Instant::now() + Duration::from_millis(SNAPSHOT_EXECUTION_TIMEOUT_MS);
            let drained = loop {
                if let Ok(guard) = self.execution_queue.try_lock() {
                    // Release immediately: the snapshot's own request takes the slot next.
                    drop(guard);
                    break true;
                }
                if Instant::now() >= deadline {
                    break false;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            if !drained {
                return;
            }
            self.capture_snapshot(Some(SNAPSHOT_EXECUTION_TIMEOUT_MS), false)
                .await;
        }
        .await;
        // Reset: a superseding start() can revive this kernel for new work.
        lock(&self.guarded).flushing_snapshot_for_dispose = false;
    }
}

/// File-stat identity of a snapshot manifest. Releases the probe claim on any exit path, including
/// a dropped future (see [`stats_after_commit`]).
struct ProbeClaimGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for ProbeClaimGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// Stat the committed payload + manifest pair, off the executor and SERIALIZED: a stalled artifacts
/// filesystem must not wedge the capture path. A probe already in flight reads as `(None, None)`,
/// which NEVER matches.
async fn stats_after_commit(
    claim: &std::sync::atomic::AtomicBool,
    cfg: &crate::kernel::shared::KernelSnapshotConfig,
) -> (Option<ManifestStat>, Option<ManifestStat>) {
    let payload = cfg.path.clone();
    let manifest = cfg.manifest_path.clone();
    // Serialize: a stalled probe keeps exactly one pool task blocked, not
    // one per capture; every other caller reads as no-stats.
    if claim.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return (None, None);
    }
    // A drop guard, not a trailing store: the capture future can be dropped at ANY await — a
    // cancelled probe must release the claim or the skip would stay off.
    let _guard = ProbeClaimGuard(claim);
    let probe = tokio::task::spawn_blocking(move || {
        (manifest_stat_of(&payload), manifest_stat_of(&manifest))
    });
    match tokio::time::timeout(STAT_TIMEOUT, probe).await {
        Ok(Ok(pair)) => pair,
        _ => (None, None),
    }
}
fn manifest_stat_of(path: &std::path::Path) -> Option<ManifestStat> {
    std::fs::metadata(path).ok().map(|m| ManifestStat {
        mtime: m.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
        size: m.len(),
    })
}

fn as_string_array(fields: &Value, key: &str) -> Vec<String> {
    fields
        .get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn as_reason_array(fields: &Value, key: &str) -> Vec<SnapshotSkip> {
    fields
        .get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|entry| {
                    let obj = entry.as_object()?;
                    Some(SnapshotSkip {
                        name: obj.get("name")?.as_str()?.to_string(),
                        reason: obj
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
