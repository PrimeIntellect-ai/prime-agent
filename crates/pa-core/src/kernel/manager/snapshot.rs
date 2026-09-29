//! Snapshot / restore: capture state snapshots from the kernel, restore them,
//! and flush on dispose.

use super::{
    describe_failure, lock, Arc, CaptureFreshness, Duration, ExecuteOptions, ExecuteStatus, Inner,
    Instant, KernelState, ManifestStat, MemoSlot, Request, RestoreResult, RestoredNamespaceSkip,
    SnapshotResult, SnapshotSkip, Value, DEFAULT_SNAPSHOT_DEBOUNCE_MS, DEFAULT_SNAPSHOT_MAX_BYTES,
    DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES, REPAIR_STEP_TIMEOUT_MS, RESTORE_EXECUTION_TIMEOUT_MS,
    SNAPSHOT_EXECUTION_TIMEOUT_MS,
};

/// The runtime snapshot writer's reason for a name above the per-variable
/// cap (prime-agent-runtime/src/rlm/repl.py): such a skipped name is a live
/// over-cap survivor unless the same capture also pruned it.
const OVER_CAP_SKIP_REASON: &str = "exceeds per-variable snapshot size cap";

/// Bound on the witness stat pair's await: a stalled (network/FUSE)
/// artifacts filesystem must not wedge a capture; a timed-out stat reads
/// as "not fresh" (the consult skips the skip, the arm never matches).
const STAT_TIMEOUT: Duration = Duration::from_millis(250);

// ---------------------------------------------------------------------------
// Snapshot / restore
// ---------------------------------------------------------------------------

impl Inner {
    /// Serialize the user namespace to disk (best-effort, per-variable).
    /// `None` when the kernel isn't running or no snapshot target was
    /// configured. Never fails on kernel errors; they land in diagnostics.
    pub(crate) async fn capture_snapshot(
        self: &Arc<Self>,
        execution_timeout_ms: Option<u64>,
        prune_oversized: bool,
    ) -> Option<SnapshotResult> {
        let cfg = self.options.snapshot.clone()?;
        if !self.is_running_state() {
            return None;
        }
        // While the namespace provably cannot have changed since the last
        // committed capture, a fresh capture would reproduce the committed
        // payload byte-for-byte: skip the kernel request (the full-namespace
        // re-dump serialized on the kernel's single request queue).
        if let Some(fresh) = self.fresh_capture(prune_oversized).await {
            return Some(fresh);
        }
        // The user-settled count and the invalidation epoch the memo may
        // claim once this capture commits, read before the request is
        // queued. This capture and every other internal state request (the
        // listing, the repair bootstrap) settle without touching the user
        // counter, and the kernel runs one request at a time, so only a
        // user cell settling ahead of this capture can move the count
        // first — which leaves the claim stale-low (the next consult never
        // matches), never wrong-fresh. The epoch carries the
        // invalidation-revive ordering: a namespace-code/restore settle or
        // a kernel start that lands while this capture's own request is in
        // flight bumps it, and the post-await arm re-checks it before
        // memoizing.
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
                // This capture's commit sequence: the arm may only run
                // while no LATER capture has committed, or a straggling
                // earlier record's delayed stat probe could pair its stale
                // result lists with the newer capture's files.
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
            // A failed or timed-out capture leaves the memo describing the
            // last successful commit: the payload still matches the
            // namespace while no execution settled since, so the next
            // capture consults it unchanged.
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

    /// The recurring capture-freshness skip (see `CaptureFreshness`).
    /// `Some(result)` replays the last committed capture — the caller sees
    /// exactly what a fresh capture of the unchanged namespace would report.
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
        // survive: it removes them from the namespace and the compaction
        // notice discloses the removal (#227 semantics).
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
        // The invalidation epoch and the settle-race guard, read together
        // under ONE lock acquisition: a namespace-code/restore settle or a
        // kernel start invalidated the memo since the arm — never replay;
        // and the count was sampled before the stat await, so a user cell
        // can settle while it runs — the decision must describe the
        // namespace at decision time. Reading both under the same
        // acquisition the settle bumps closes the split-lock window where
        // an internal request could invalidate the memo between the two
        // checks while leaving the count unchanged (a cell settling after
        // this read is the settles-after-the-capture class a real dump
        // misses too).
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

    /// Arm the freshness memo with a committed capture: the namespace on
    /// disk is the live one again, and stays provably unchanged until the
    /// next settled USER execution, a settled request that runs namespace
    /// code or replaces the namespace (see `resolve_execution`), or an
    /// external replacement of the committed payload or manifest.
    async fn record_capture_freshness(
        self: &Arc<Self>,
        cfg: &crate::kernel::shared::KernelSnapshotConfig,
        result: &SnapshotResult,
        user_executions: u64,
        epoch: u64,
        capture_sequence: u64,
    ) {
        // The stat pair is the witness artifact: the payload stat is the
        // load-bearing one (it fingerprints what a later restore reads),
        // the manifest stat catches the paired bookkeeping being replaced.
        // The memo arms ONLY with both stats present and the epoch
        // unmoved: a stalled, contended, or missing filesystem read never
        // memoizes, and any previous memo is left untouched (its stat pair
        // described the files as of its own commit, which this capture
        // just rewrote — the stale pair can no longer match a later
        // consult, so it is inert). The epoch re-check after the await
        // closes the invalidation-revive ordering: a namespace-code or
        // restore settle or a kernel start that landed while this
        // capture's own request ran must not be re-described by this arm.
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
        // A missing stat pair (a contended probe) or an epoch move never
        // arms — and leaves any previous memo untouched: that memo's stat
        // pair described the files as of ITS commit, and this capture just
        // rewrote both, so the stale pair can no longer match a later
        // consult (the count and epoch checks cover the changed-namespace
        // corners). An inert memo is strictly safer to leave than to wipe:
        // wiping would cost the next capture a redundant re-dump of an
        // unchanged namespace.
    }

    /// Revive a previously snapshotted namespace into the kernel.
    /// `None` when no snapshot is configured or the restore failed.
    /// Repair restores bypass the repair gate; every restore is bounded so a
    /// wedged kernel cannot stall start()/worker recovery forever.
    pub(crate) async fn perform_restore(
        self: &Arc<Self>,
        protocol_repair: bool,
    ) -> Option<RestoreResult> {
        let cfg = self.options.snapshot.clone()?;
        // Before the attempt, so a failed or timed-out restore still arms the
        // skip; repair retries (reprovision after a failed first restore) keep
        // the non-repair stat.
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
            // Suppress the debounced auto-snapshot the following bootstrap
            // schedules until the skip arm (installed after that bootstrap) or
            // a user cell takes over. The awaited enqueue settled the restore
            // itself, so the recorded count already includes it.
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
                // A partial restore (some names failed to revive) still
                // leaves the on-disk payload the fuller copy: the dispose
                // flush must not overwrite it either.
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

    /// Arm the one-shot post-restore snapshot skip: the bootstrap-scheduled
    /// snapshot would rewrite identical content, or after a failed restore
    /// clobber the healthy on-disk copy with a skills-only payload. Call after
    /// the bootstrap succeeds — its own settled execution must not defeat the
    /// arm.
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

    /// One-shot: consumed whether or not it fires. The skip holds only when no
    /// execution settled since the arm AND the manifest stat still matches the
    /// one recorded before the restore attempt.
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
        // teardown kill: with no manager left, the scheduled flush is moot
        // (dispose paths flush explicitly before dropping).
        let inner = Arc::downgrade(self);
        *timer = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(debounce)).await;
            if let Some(inner) = inner.upgrade() {
                // The bootstrap that followed a restore schedules this flush;
                // while the namespace is unchanged, rewriting the just-restored
                // payload (or clobbering a still-valid one after a failed
                // restore) is the one write that must not happen.
                if inner.consume_restored_snapshot_skip().await {
                    return;
                }
                // The boot that followed a restore owns this window: the
                // restore and its bootstrap settle without a user cell, and
                // the skip arm lands only after the bootstrap (production
                // order). The +1 is the bootstrap's own settle; any user cell
                // is the +2 that ends the hold.
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

    /// Concurrent teardowns (dispose vs a signal-handler shutdown) join one
    /// flush: a second flusher would clear the execution guard while the first
    /// is still snapshotting and enqueue a duplicate final snapshot behind it.
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
        // A kernel that never restored the saved namespace — or restored only
        // part of it, or whose failed restore armed the reprovision retry —
        // must not overwrite it: the on-disk snapshot is strictly fresher
        // than this namespace.
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

/// File-stat identity of a snapshot manifest; `None` when it cannot be stated.
/// Releases the probe claim on any exit path, including a dropped future
/// (see [`stats_after_commit`]).
struct ProbeClaimGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for ProbeClaimGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

/// Stat the committed payload + manifest pair, off the executor, bounded,
/// and SERIALIZED: a stalled (network/FUSE) artifacts filesystem must not
/// wedge the capture path, and a stalled `fs::metadata` cannot be
/// interrupted — repeated unbounded probes would accumulate blocked pool
/// tasks. One probe is in flight at a time; a probe that is already in
/// flight (or times out) reads as `(None, None)`, which NEVER matches —
/// the consult treats it as not-fresh and the arm refuses to memoize.
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
    // A drop guard, not a trailing store: the capture future can be
    // dropped at ANY await (the debounce timer's abort, a teardown) — a
    // cancelled probe must release the claim or every later call would
    // read as in-flight and the skip would stay off for the manager's
    // lifetime.
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
