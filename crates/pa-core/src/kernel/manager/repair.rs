//! Protocol repair: fail-frame handling, child repair/rebootstrap, and repair
//! supersession/awaiting.

use super::*;

// ---------------------------------------------------------------------------
// Protocol repair
// ---------------------------------------------------------------------------

impl Inner {
    /// A JSON object that was not a valid protocol frame: fail the in-flight
    /// request and replace the child, since its stream framing is corrupted.
    pub(crate) fn fail_protocol_frame(self: &Arc<Self>, generation: u64, diagnostic: &str) {
        if self.start_stale(generation) {
            return;
        }
        self.append_diagnostic(diagnostic);
        let error = format!("Kernel protocol error: {diagnostic}");
        {
            let mut g = lock(&self.guarded);
            if g.state == KernelState::Starting {
                g.startup_protocol_error = Some(error.clone());
            }
        }
        if let Some(tx) = lock(&self.guarded).ready_tx.take() {
            let _ = tx.send(Err(anyhow!("{error}")));
        }
        self.reject_active_execution(&error);
        {
            let g = lock(&self.guarded);
            if g.teardown_in_flight > 0 || g.state != KernelState::Running {
                return;
            }
        }
        let existing = lock(&self.guarded).protocol_repair.clone();
        if let Some(existing) = existing {
            // A repair's own replacement child corrupted: discard it instead
            // of respawn-looping.
            self.append_diagnostic(
                "replacement kernel corrupted during protocol repair; giving up",
            );
            existing.owner.superseded.store(true, Ordering::SeqCst);
            // performRestore clears pendingRestore, so it still being set
            // means the corruption struck at or before the restore phase: the
            // snapshot stays the prime suspect (ambiguous attribution,
            // loop-safe). Corruption strictly after a successful restore never
            // implicates the snapshot.
            let snapshot_suspect = lock(&self.guarded).pending_restore;
            self.kill_child_to_idle();
            if snapshot_suspect {
                lock(&self.guarded).pending_restore = false;
            }
            return;
        }
        let owner = Arc::new(RepairOwner {
            superseded: AtomicBool::new(false),
        });
        let handle = Arc::new(RepairHandle {
            owner: owner.clone(),
            slot: MemoSlot::new(),
        });
        lock(&self.guarded).protocol_repair = Some(handle.clone());
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            inner.repair_protocol_child(generation, owner.clone()).await;
            let superseded = handle.owner.superseded.load(Ordering::SeqCst);
            let current = lock(&inner.guarded).protocol_repair.clone();
            if matches!(&current, Some(current) if Arc::ptr_eq(&current.owner, &handle.owner))
                && !superseded
            {
                handle.slot.finish(None);
            } else {
                handle
                    .slot
                    .finish(Some(anyhow!("protocol repair superseded")));
            }
            let mut g = lock(&inner.guarded);
            if matches!(&g.protocol_repair, Some(current) if Arc::ptr_eq(&current.owner, &handle.owner))
            {
                g.protocol_repair = None;
            }
        });
    }

    /// Replace the corrupted child: fresh spawn, restore the saved namespace,
    /// re-run the runtime bootstrap. Never lets a failure wedge the kernel.
    async fn repair_protocol_child(self: &Arc<Self>, generation: u64, owner: Arc<RepairOwner>) {
        if self.start_stale(generation) || lock(&self.guarded).state == KernelState::Shutdown {
            return;
        }
        self.kill_child_to_idle();

        if let Err(error) = self.do_start(&KernelStartOptions::default()).await {
            self.finish_failed_protocol_repair(&owner, Some(format!("{error:#}")));
            return;
        }
        let generation = self.current_generation();
        if self.start_stale(generation) || lock(&self.guarded).state != KernelState::Running {
            self.finish_failed_protocol_repair(&owner, None);
            return;
        }

        let restored = self.perform_restore(true).await;
        if self.start_stale(generation) || lock(&self.guarded).state != KernelState::Running {
            self.finish_failed_protocol_repair(&owner, None);
            return;
        }
        if self.options.snapshot.is_some() && restored.is_none() {
            if self.repair_superseded(&owner) {
                return;
            }
            self.append_diagnostic("protocol repair restore failed; discarding replacement kernel");
            self.kill_child_to_idle();
            // The snapshot is the declared culprit; the lazy path must not retry it.
            lock(&self.guarded).pending_restore = false;
            return;
        }

        // Restore revives only the user namespace; live handles (rlm, bash,
        // skills) come from the runtime bootstrap, so a repaired kernel must
        // re-run it.
        let Some(code) = self.options.bootstrap_code.clone() else {
            return;
        };
        let bootstrapped = self.bootstrap_repaired_kernel(&code).await;
        if self.start_stale(generation) || lock(&self.guarded).state != KernelState::Running {
            self.finish_failed_protocol_repair(&owner, None);
            return;
        }
        if !bootstrapped {
            if self.repair_superseded(&owner) {
                return;
            }
            self.append_diagnostic(
                "protocol repair bootstrap failed; discarding replacement kernel",
            );
            self.kill_child_to_idle();
        }
    }

    fn repair_superseded(&self, owner: &Arc<RepairOwner>) -> bool {
        if owner.superseded.load(Ordering::SeqCst) {
            return true;
        }
        let current = lock(&self.guarded).protocol_repair.clone();
        !matches!(&current, Some(handle) if Arc::ptr_eq(&handle.owner, owner))
    }

    /// Bounded bootstrap of a repaired kernel; `false` when it failed. Never throws.
    async fn bootstrap_repaired_kernel(self: &Arc<Self>, code: &str) -> bool {
        // Boxed: enqueue -> rebootstrap -> reprovision -> this call is a
        // recursive cycle, and recursive async fns need one boxed link.
        let result = Box::pin(self.enqueue_request(
            Request::Execute {
                code: code.to_string(),
            },
            code,
            ExecuteOptions {
                internal: true,
                protocol_repair: true,
                ..ExecuteOptions::default()
            },
            Some(REPAIR_STEP_TIMEOUT_MS),
        ))
        .await;
        match result {
            Ok(r) if r.result.status == ExecuteStatus::Ok => {
                lock(&self.guarded).pending_rebootstrap = false;
                true
            }
            Ok(r) => {
                let detail = r.result.error.as_ref().map_or_else(
                    || r.result.stderr.trim_end().to_string(),
                    |e| e.evalue.clone(),
                );
                self.append_diagnostic(&format!("protocol repair bootstrap failed: {detail}"));
                false
            }
            Err(error) => {
                self.append_diagnostic(&format!("protocol repair bootstrap error: {error:#}"));
                false
            }
        }
    }

    /// A fresh kernel started after a discarded repair has none of the runtime
    /// bootstrap's live handles (rlm, bash, skills) and an empty namespace:
    /// reprovision (restore, then bootstrap) before any user request.
    pub(crate) async fn ensure_kernel_rebootstrapped(
        self: &Arc<Self>,
        signal: Option<&AbortSignal>,
    ) -> anyhow::Result<()> {
        let code = self.options.bootstrap_code.clone();
        let needs_restore = self.options.snapshot.is_some() && lock(&self.guarded).pending_restore;
        let needs_bootstrap = code.is_some() && lock(&self.guarded).pending_rebootstrap;
        // An in-flight repair owns its kernel's restore/bootstrap sequence,
        // and a teardown's final snapshot must never trigger reprovisioning.
        if (!needs_restore && !needs_bootstrap)
            || lock(&self.guarded).protocol_repair.is_some()
            || lock(&self.guarded).teardown_in_flight > 0
            || lock(&self.guarded).state != KernelState::Running
        {
            return Ok(());
        }
        let task = {
            let mut memo = lock(&self.rebootstrap_memo);
            if let Some(existing) = memo.as_ref() {
                existing.clone()
            } else {
                let inner = Arc::clone(self);
                let slot = MemoSlot::new();
                let run_slot = slot.clone();
                tokio::spawn(async move {
                    let ok = inner.reprovision_fresh_kernel().await;
                    run_slot.finish(
                        (!ok).then(|| anyhow!("Kernel bootstrap failed after protocol repair")),
                    );
                });
                *memo = Some(slot.clone());
                slot
            }
        };
        // An aborted request never executes, so it may skip the wait; race
        // the signal instead of riding out the bootstrap bound after an abort.
        match signal {
            None => task.wait().await,
            Some(signal) => {
                if signal.is_aborted() {
                    return Ok(());
                }
                tokio::select! {
                    result = task.wait() => result,
                    _ = signal.cancelled() => Ok(()),
                }
            }
        }
    }

    /// Restore (one-shot, best-effort) then bootstrap the lazily started fresh kernel.
    async fn reprovision_fresh_kernel(self: &Arc<Self>) -> bool {
        if self.options.snapshot.is_some() && lock(&self.guarded).pending_restore {
            self.perform_restore(true).await; // clears pendingRestore on success
                                              // Corrupted during the restore: the spawned repair owns the kernel now.
            if lock(&self.guarded).protocol_repair.is_some()
                || lock(&self.guarded).state != KernelState::Running
            {
                return false;
            }
            // One attempt per discard: a clean restore failure falls back to an
            // empty namespace (ordinary startup semantics), never a retry loop.
            lock(&self.guarded).pending_restore = false;
        }
        let Some(code) = self.options.bootstrap_code.clone() else {
            return true;
        };
        if !lock(&self.guarded).pending_rebootstrap {
            return true;
        }
        let ok = self.bootstrap_repaired_kernel(&code).await;
        if !ok && lock(&self.guarded).state == KernelState::Running {
            self.kill_child_to_idle();
        }
        ok
    }

    /// Kill the current child and settle at clean idle, so the next start spawns fresh.
    fn kill_child_to_idle(self: &Arc<Self>) {
        // The discarded kernel carried the runtime bootstrap and (possibly) the
        // restored namespace; a lazily started replacement must reprovision both.
        {
            let mut g = lock(&self.guarded);
            g.pending_rebootstrap = true;
            g.pending_restore = true;
            g.state = KernelState::Shutdown;
        }
        live_kernels::remove(self);
        self.cleanup_resources(Signal::Kill);
        lock(&self.guarded).state = KernelState::Idle;
    }

    fn finish_failed_protocol_repair(&self, owner: &Arc<RepairOwner>, error: Option<String>) {
        if let Some(error) = error {
            self.append_diagnostic(&format!("protocol repair start failed: {error}"));
        }
        if owner.superseded.load(Ordering::SeqCst) || !self.repair_owner_is(owner) {
            return;
        }
        if lock(&self.guarded).state == KernelState::Shutdown {
            lock(&self.guarded).state = KernelState::Idle;
        }
    }

    fn repair_owner_is(&self, owner: &Arc<RepairOwner>) -> bool {
        let current = lock(&self.guarded).protocol_repair.clone();
        matches!(&current, Some(handle) if Arc::ptr_eq(&handle.owner, owner))
    }

    pub(crate) fn supersede_protocol_repair(&self) {
        if let Some(handle) = &lock(&self.guarded).protocol_repair {
            handle.owner.superseded.store(true, Ordering::SeqCst);
        }
    }

    /// Wait until no protocol repair is pending; resolves early when the signal aborts.
    pub(crate) async fn wait_for_protocol_repair(
        &self,
        signal: Option<&AbortSignal>,
    ) -> anyhow::Result<()> {
        loop {
            let Some(repair) = lock(&self.guarded).protocol_repair.clone() else {
                return Ok(());
            };
            match signal {
                None => repair.slot.wait().await?,
                Some(signal) => {
                    if signal.is_aborted() {
                        return Ok(());
                    }
                    tokio::select! {
                        result = repair.slot.wait() => result?,
                        _ = signal.cancelled() => return Ok(()),
                    }
                }
            }
        }
    }
}
