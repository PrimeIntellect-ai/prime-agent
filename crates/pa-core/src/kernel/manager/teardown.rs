//! Teardown: graceful shutdown, resource cleanup, and process killing.

use super::*;

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

impl Inner {
    /// Resolves `true` when this call performed the cleanup (false: a
    /// concurrent teardown won; a joiner's options are ignored — the first
    /// caller's policy wins). The memoization joins concurrent callers onto
    /// one in-flight shutdown.
    pub(crate) async fn shutdown_for_cleanup(
        self: &Arc<Self>,
        opts: KernelShutdownOptions,
    ) -> anyhow::Result<bool> {
        let existing = lock(&self.shutdown_memo).as_ref().cloned();
        if let Some(existing) = existing {
            let _ = existing.wait().await;
            return Ok(false);
        }
        let slot = {
            let mut memo = lock(&self.shutdown_memo);
            let slot = MemoSlot::new();
            *memo = Some(slot.clone());
            slot
        };
        lock(&self.guarded).teardown_in_flight += 1;
        self.supersede_protocol_repair();
        let performed = self.perform_shutdown(opts).await;
        lock(&self.guarded).teardown_in_flight -= 1;
        slot.finish(None);
        {
            let mut memo = lock(&self.shutdown_memo);
            if matches!(memo.as_ref(), Some(current) if Arc::ptr_eq(current, &slot)) {
                *memo = None;
            }
        }
        Ok(performed)
    }

    pub(crate) async fn perform_shutdown(self: &Arc<Self>, opts: KernelShutdownOptions) -> bool {
        if lock(&self.guarded).state == KernelState::Shutdown {
            live_kernels::remove(self);
            // Scoped read: re-locking inside the comparison self-deadlocks.
            let graceful_in_flight = {
                let g = lock(&self.guarded);
                g.graceful_shutdown_generation == Some(g.start_generation)
            };
            if graceful_in_flight {
                return false;
            }
            self.cleanup_resources(Signal::Term);
            return true;
        }
        // Captured before any await: teardowns and newer starts bump the counter.
        let generation = lock(&self.guarded).start_generation;
        if opts.snapshot {
            self.flush_snapshot_for_dispose().await;
            if self.start_stale(generation) {
                return false;
            }
        }
        // Protocol shutdown first: the runtime closes MCP servers and kills
        // live bash() process groups a bare hard-kill would leak.
        let protocol_shutdown_available = lock(&self.guarded).state == KernelState::Running;
        {
            let mut g = lock(&self.guarded);
            g.state = KernelState::Shutdown;
            g.graceful_shutdown_generation = Some(generation);
        }
        live_kernels::remove(self);

        let mut performed_cleanup = false;
        let mut request_id: Option<String> = None;
        if opts.drain_host_requests {
            let in_flight = {
                let mut g = lock(&self.guarded);
                std::mem::take(&mut g.host_inflight)
            };
            if !in_flight.is_empty() {
                self.wait_for_host_requests_to_settle(in_flight, HOST_REQUEST_SHUTDOWN_TIMEOUT_MS)
                    .await;
            }
        }
        if protocol_shutdown_available
            && !self.start_stale(generation)
            && lock(&self.child).is_some()
        {
            let id = uuid::Uuid::new_v4().to_string();
            let (done_tx, done_rx) = oneshot::channel::<()>();
            lock(&self.guarded)
                .pending_done_waiters
                .insert(id.clone(), done_tx);
            request_id = Some(id.clone());
            let frame = json!({ "type": "shutdown", "id": id });
            let send_result = self.write_line(&frame).await;
            if let Err(error) = send_result {
                self.append_diagnostic(&format!("failed to send shutdown request: {error:#}"));
            }
            let graceful_reply = async {
                let _ = done_rx.await;
            };
            let deadline = tokio::time::sleep(Duration::from_millis(KERNEL_SHUTDOWN_TIMEOUT_MS));
            let mut failed = false;
            tokio::select! {
                () = graceful_reply => {}
                () = self.wait_for_kernel_exit() => {}
                () = deadline => {
                    failed = true;
                    self.append_diagnostic(&format!(
                        "graceful shutdown failed (killing instead): Kernel did not shut down within {KERNEL_SHUTDOWN_TIMEOUT_MS}ms"
                    ));
                }
            }
            if !failed {
                let deadline =
                    tokio::time::sleep(Duration::from_millis(KERNEL_SHUTDOWN_TIMEOUT_MS));
                tokio::select! {
                    () = self.wait_for_kernel_exit() => {}
                    () = deadline => {}
                }
            }
        }
        if let Some(id) = request_id {
            lock(&self.guarded).pending_done_waiters.remove(&id);
        }
        {
            let mut g = lock(&self.guarded);
            if g.graceful_shutdown_generation == Some(generation) {
                g.graceful_shutdown_generation = None;
            }
        }
        if !self.start_stale(generation) {
            self.cleanup_resources(Signal::Term);
            performed_cleanup = true;
        }
        performed_cleanup
    }

    /// Tear the child down: stop timers, fail pending work, close pipes, kill
    /// the process, and reap any bash() process groups it journaled.
    pub(crate) fn cleanup_resources(&self, kill_signal: Signal) {
        {
            let mut g = lock(&self.guarded);
            // Any teardown invalidates in-flight starts.
            g.start_generation += 1;
            if let Some(timer) = lock(&self.snapshot_timer).take() {
                timer.abort();
            }
            g.late_handlers.clear();
            g.pending_done_waiters.clear();
            g.background_bash_handles.clear();
            // Stale pre-teardown background output must not surface after a restart.
            g.pending_background_output.clear();
            g.pending_background_output_chars = 0;
            g.pending_background_output_truncated = false;
        }
        self.reject_active_execution("Kernel has been shut down");
        *lock(&self.stderr_log) = None;
        let child = lock(&self.child).take();
        lock(&self.guarded).ready_tx.take();
        if let Some(child) = child {
            // Dropping the write pipe signals EOF to the child's stdin reader;
            // closing stdin is equivalent to a shutdown request.
            if let Ok(mut stdin) = child.stdin.try_lock() {
                *stdin = None;
            }
            let pid = child.pid;
            let signaled = kill_process(pid, kill_signal);
            // Inactive only when the signal proved the pid still named our child.
            if pid > 0 && signaled {
                orphan_journal::record_orphan_process_state(pid, false);
            }
            // A killed/crashed kernel cannot run its own shutdown hook, so the
            // host reaps the bash() process groups it journaled under this pid.
            if pid > 0 {
                orphan_journal::reap_kernel_orphan_processes(pid);
            }
        }
        *lock(&self.start_memo) = None;
    }
}

fn kill_process(pid: i32, signal: Signal) -> bool {
    crate::platform::process::kill_pid(pid, signal)
}
