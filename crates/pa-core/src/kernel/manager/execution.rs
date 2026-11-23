//! Execution bookkeeping: request writes, interrupts, abort forcing, and
//! active-execution resolution plus late-sent agent message handlers.

use std::fmt::Write as _;
use std::sync::atomic::Ordering;

use super::{
    anyhow, json, live_kernels, lock, parse_sent_agent_message, AbortSignal, ActiveExecution,
    Admission, Arc, AsyncWriteExt, Duration, ExecuteResult, ExecuteStatus, Inner, Instant,
    InternalExecuteResult, LateSentAgentMessageCallback, Lifecycle, Signal, Value,
    AGENT_MESSAGE_DISPLAY_MIME, KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE,
    KERNEL_BUSY_BACKGROUND_CELL_MESSAGE, KERNEL_BUSY_INTERRUPT_INTERVAL_MS,
    KERNEL_BUSY_REUSE_WAIT_MS, MAX_BACKGROUND_OUTPUT_CHARS, MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS,
};

impl Inner {
    /// Write one JSON-lines request frame; completes when the OS accepted the bytes.
    pub(crate) async fn write_line(&self, frame: &Value) -> anyhow::Result<()> {
        let stdin = {
            let child = lock(&self.child);
            child
                .as_ref()
                .map(|c| c.stdin.clone())
                .ok_or_else(|| anyhow!("Kernel stdin is not connected"))?
        };
        let mut guard = stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err(anyhow!("Kernel stdin is not connected"));
        };
        let mut line = frame.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub(crate) async fn interrupt(&self, id: Option<&str>) -> anyhow::Result<()> {
        let mut frame = json!({ "type": "interrupt" });
        if let Some(id) = id {
            frame["id"] = json!(id);
        }
        self.write_line(&frame).await
    }

    pub(crate) fn force_abort(&self, execution: &Arc<ActiveExecution>) {
        if !lock(&self.guarded).holds(execution) {
            return;
        }
        lock(&execution.buffers).status = ExecuteStatus::Aborted;
        self.resolve_execution(execution, false);
    }

    /// Whether `execution` is still the physically active, unsettled
    /// execution: the fence every out-of-band stop re-checks after an
    /// await, so a settled execution's late watcher can never signal or
    /// retire the next cell.
    pub(crate) fn execution_is_live(&self, execution: &Arc<ActiveExecution>) -> bool {
        let is_active = lock(&self.guarded).holds(execution);
        is_active && !lock(&execution.buffers).settled
    }

    /// Retire the kernel of an execution that ignored its stop interrupt:
    /// claim the manager terminal (the provisioner lazily revives a fresh
    /// kernel on the next use), kill the process, and only then publish the
    /// captured execution's forced-stop completion — the "work ended" claim
    /// follows the kill, so no code keeps running unchecked behind it. The
    /// single delivery owner is the result channel: taking the sender first
    /// keeps the teardown's reject from racing the typed completion.
    pub(crate) fn retire_for_ignored_interrupt(&self, execution: &Arc<ActiveExecution>) {
        // Claim ATOMICALLY, under the settle path's lock order (the
        // execution's buffers, then the manager guard): only the still
        // active, unsettled captured execution may retire the kernel. A
        // `done` that lands in any gap settles and clears the slot before
        // a new admission can start, and the Shutdown state this claim
        // sets blocks admission outright — so a stale watcher can never
        // kill a replacement cell's kernel.
        let claimed = {
            let buffers = lock(&execution.buffers);
            let mut g = lock(&self.guarded);
            if !g.holds(execution) || buffers.settled {
                false
            } else {
                g.lifecycle.transition(Lifecycle::Defunct);
                true
            }
        };
        if !claimed {
            return;
        }
        self.retired_for_ignored_interrupt
            .store(true, std::sync::atomic::Ordering::SeqCst);
        live_kernels::remove(self);
        let sender = lock(&execution.result_tx).take();
        self.cleanup_resources(Signal::Kill);
        // The captured execution ends here: its watchers exit.
        execution.notify_terminated();
        if let Some(sender) = sender {
            let _ = sender.send(Ok(InternalExecuteResult::forced_stop(execution)));
        }
    }

    /// Wait until no running request blocks `admission`, bounded by the
    /// busy-reuse window. A blocking attached cell is interrupted while it
    /// waits — a detached (backgrounded) one never is: nobody awaits that
    /// work any more, so the wait answers the background-cell message instead.
    pub(crate) async fn wait_for_active_execution_to_clear_for_reuse(
        self: &Arc<Self>,
        admission: Admission,
        signal: Option<&AbortSignal>,
    ) -> anyhow::Result<()> {
        let blocking = |g: &super::Guarded| -> Vec<Arc<ActiveExecution>> {
            g.active_executions
                .iter()
                .filter(|active| match admission {
                    Admission::Exclusive => true,
                    Admission::BesideDetached => !active.detached.load(Ordering::SeqCst),
                })
                .cloned()
                .collect()
        };
        let started = Instant::now();
        loop {
            let notified = self.busy_notify.notified();
            let attached_ids: Vec<String> = {
                let g = lock(&self.guarded);
                let blocking = blocking(&g);
                if blocking.is_empty() {
                    return Ok(());
                }
                if g.lifecycle.is_shut_down() {
                    return Err(anyhow!("Kernel has been shut down"));
                }
                blocking
                    .iter()
                    .filter(|active| !active.detached.load(Ordering::SeqCst))
                    .map(|active| active.request_id.clone())
                    .collect()
            };
            let elapsed = started.elapsed();
            if elapsed >= Duration::from_millis(KERNEL_BUSY_REUSE_WAIT_MS) {
                break;
            }
            let wait_ms = (KERNEL_BUSY_REUSE_WAIT_MS - elapsed.as_millis() as u64)
                .min(KERNEL_BUSY_INTERRUPT_INTERVAL_MS);
            let wait = tokio::time::sleep(Duration::from_millis(wait_ms.max(1)));
            let interrupt = (!attached_ids.is_empty()).then(|| {
                let inner = Arc::clone(self);
                tokio::spawn(async move {
                    for id in attached_ids {
                        let _ = inner.interrupt(Some(&id)).await;
                    }
                })
            });
            tokio::select! {
                () = notified => {}
                () = wait => {}
                () = async {
                    match signal {
                        Some(signal) => signal.cancelled().await,
                        None => std::future::pending().await,
                    }
                } => {
                    if let Some(interrupt) = interrupt {
                        interrupt.abort();
                    }
                    return Ok(());
                }
            }
        }
        let blocking = blocking(&lock(&self.guarded));
        if blocking.is_empty() {
            return Ok(());
        }
        Err(
            if blocking
                .iter()
                .all(|active| active.detached.load(Ordering::SeqCst))
            {
                anyhow!("{KERNEL_BUSY_BACKGROUND_CELL_MESSAGE}")
            } else {
                anyhow!("{KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE}")
            },
        )
    }

    fn notify_active_execution_idle(&self) {
        self.busy_notify.notify_waiters();
    }

    pub(crate) fn reject_active_executions(&self, message: &str) {
        let executions = std::mem::take(&mut lock(&self.guarded).active_executions);
        if executions.is_empty() {
            return;
        }
        for execution in executions {
            if let Some(tx) = lock(&execution.result_tx).take() {
                let _ = tx.send(Err(anyhow!("{message}")));
            }
            // The teardown rejected the execution: its watchers exit.
            execution.notify_terminated();
        }
        self.notify_active_execution_idle();
    }

    pub(crate) fn finish_active_execution(&self, execution: &Arc<ActiveExecution>) {
        if !lock(&self.guarded).holds(execution) {
            return;
        }
        self.resolve_execution(execution, true);
    }

    /// Drop `execution` from the running requests; `true` when it was there.
    pub(crate) fn remove_active_execution(&self, execution: &Arc<ActiveExecution>) -> bool {
        let mut g = lock(&self.guarded);
        let before = g.active_executions.len();
        g.active_executions
            .retain(|active| !Arc::ptr_eq(active, execution));
        g.active_executions.len() != before
    }

    fn resolve_execution(&self, execution: &Arc<ActiveExecution>, clear_active: bool) {
        let did_clear_active = clear_active && self.remove_active_execution(execution);
        let mut buffers = lock(&execution.buffers);
        if !buffers.settled {
            buffers.settled = true;
            // The execution settled: its watchers exit rather than await a
            // stop signal that will never fire.
            execution.notify_terminated();
            {
                let mut g = lock(&self.guarded);
                g.completed_executions += 1;
                if !execution.opts.internal {
                    g.user_executions += 1;
                }
                // The freshness memo describes the namespace as of its commit. A settled request
                // that runs user-namespace code or replaces the namespace ends that description.
                if execution.namespace_code || execution.restores_namespace {
                    g.capture_freshness = None;
                    g.freshness_epoch += 1;
                }
            }
            if let Some(callback) = execution.opts.on_late_sent_agent_message.clone() {
                self.register_late_sent_agent_message_handler(&execution.request_id, callback);
            }

            let stdout = std::mem::take(&mut buffers.stdout).finish(execution.max_chars);
            let stderr = std::mem::take(&mut buffers.stderr).finish(execution.max_chars);
            let mut result = buffers.result.take();
            let mut status = buffers.status;
            if let Some(text) = &result {
                if let Some((end, _)) = text.char_indices().nth(execution.max_chars) {
                    // Match the Unicode-scalar limit used for stdout and stderr.
                    let mut clipped = text[..end].to_string();
                    let _ = write!(
                        clipped,
                        "\n[... output truncated at {} chars ...]",
                        execution.max_chars
                    );
                    result = Some(clipped);
                }
            }
            // The out-of-band stop: a stopped cell reports the abort, even
            // one that settled cooperatively on its interrupt. A cell whose
            // `done` settled before any stop fired keeps its own outcome.
            if execution.stop_signal.is_aborted() {
                status = ExecuteStatus::Aborted;
            }

            let mut background_output = std::mem::take(&mut buffers.background_output);
            buffers.background_output_chars = 0;
            if buffers.background_output_truncated {
                let _ = write!(background_output,
                    "\n[... background output truncated at {MAX_BACKGROUND_OUTPUT_CHARS} chars ...]",
                );
            }
            let done_fields = buffers.done_fields.take();
            let result = ExecuteResult {
                stdout,
                stderr,
                result,
                diffs: (!buffers.diffs.is_empty()).then(|| std::mem::take(&mut buffers.diffs)),
                attachments: (!buffers.attachments.is_empty())
                    .then(|| std::mem::take(&mut buffers.attachments)),
                sent_agent_messages: (!buffers.sent_agent_messages.is_empty())
                    .then(|| std::mem::take(&mut buffers.sent_agent_messages)),
                bash_commands: buffers.bash_commands.take(),
                transcript_reads: (!buffers.transcript_reads.is_empty())
                    .then(|| std::mem::take(&mut buffers.transcript_reads)),
                inbox_messages: (!buffers.inbox_messages.is_empty())
                    .then(|| std::mem::take(&mut buffers.inbox_messages)),
                background_output: (!background_output.is_empty()).then_some(background_output),
                ended_turn: buffers.ended_turn,
                status,
                error: buffers.error.take(),
                duration_ms: execution.started.elapsed().as_millis() as u64,
                // A detached execution's marker is stamped on the outcome by
                // its continuation; a settled call waits, so it never detaches.
                detached: None,
            };
            drop(buffers);
            if let Some(tx) = lock(&execution.result_tx).take() {
                let _ = tx.send(Ok(InternalExecuteResult {
                    result,
                    done_fields,
                }));
            }
        }
        if did_clear_active {
            self.notify_active_execution_idle();
        }
    }

    fn register_late_sent_agent_message_handler(
        &self,
        request_id: &str,
        callback: LateSentAgentMessageCallback,
    ) {
        let mut g = lock(&self.guarded);
        g.late_handlers
            .retain(|(existing, _)| existing != request_id);
        g.late_handlers
            .push_back((request_id.to_string(), callback));
        while g.late_handlers.len() > MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS {
            g.late_handlers.pop_front();
        }
    }

    pub(crate) fn dispatch_late_sent_agent_message(
        &self,
        request_id: Option<&str>,
        data: &Value,
    ) -> bool {
        let Some(request_id) = request_id else {
            return false;
        };
        let Some(payload) = data.get(AGENT_MESSAGE_DISPLAY_MIME) else {
            return false;
        };
        let Some(message) = parse_sent_agent_message(payload) else {
            return false;
        };
        let callback = {
            let mut g = lock(&self.guarded);
            let Some(position) = g.late_handlers.iter().position(|(id, _)| id == request_id) else {
                return false;
            };
            let callback = g
                .late_handlers
                .remove(position)
                .expect("position checked")
                .1;
            // Refresh recency, matching the TS map delete+set.
            g.late_handlers
                .push_back((request_id.to_string(), callback.clone()));
            callback
        };
        callback(message);
        true
    }
}
