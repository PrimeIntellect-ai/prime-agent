//! Snapshot / restore: capture state snapshots from the kernel, restore them,
//! and flush on dispose.

use super::*;

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
                Some(SnapshotResult {
                    saved: as_string_array(fields, "saved"),
                    skipped: as_reason_array(fields, "skipped"),
                    pruned: {
                        let pruned = as_string_array(fields, "pruned");
                        (!pruned.is_empty()).then_some(pruned)
                    },
                    bytes: fields.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                    path: cfg.path,
                })
            }
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
                let failed = match &r.done_fields {
                    Some(fields) => as_reason_array(fields, "failed"),
                    None => {
                        self.append_diagnostic("state restore failed: no done fields");
                        {
                            let mut g = lock(&self.guarded);
                            g.pending_restore = false;
                            g.restore_incomplete = true;
                        }
                        return None;
                    }
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
            match memo.as_ref() {
                Some(existing) => existing.clone(),
                None => {
                    let slot = MemoSlot::new();
                    *memo = Some(slot.clone());
                    slot
                }
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
                if let Ok(_guard) = self.execution_queue.try_lock() {
                    // Release immediately: the snapshot's own request takes the slot next.
                    drop(_guard);
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
