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
    /// Repair restores bypass the repair gate and are bounded so a stalled
    /// kernel cannot wedge it.
    pub(crate) async fn perform_restore(
        self: &Arc<Self>,
        protocol_repair: bool,
    ) -> Option<RestoreResult> {
        let cfg = self.options.snapshot.clone()?;
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
                protocol_repair.then_some(REPAIR_STEP_TIMEOUT_MS),
            )
            .await;
        match result {
            Ok(r) if r.result.status == ExecuteStatus::Ok => {
                lock(&self.guarded).pending_restore = false;
                let Some(fields) = &r.done_fields else {
                    self.append_diagnostic("state restore failed: no done fields");
                    return None;
                };
                Some(RestoreResult {
                    restored: as_string_array(fields, "restored"),
                    failed: as_reason_array(fields, "failed"),
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
                None
            }
            Err(error) => {
                self.append_diagnostic(&format!("state restore error: {error:#}"));
                None
            }
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
        // A kernel that never restored the saved namespace must not overwrite
        // it: the on-disk snapshot is strictly fresher than this namespace.
        if lock(&self.guarded).pending_restore {
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
