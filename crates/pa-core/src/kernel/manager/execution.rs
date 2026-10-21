//! Execution bookkeeping: request writes, interrupts, abort forcing, and
//! active-execution resolution plus late-sent agent message handlers.

use super::{
    anyhow, json, lock, parse_sent_agent_message, AbortSignal, ActiveExecution, Arc, AsyncWriteExt,
    Duration, ExecuteResult, ExecuteStatus, Inner, Instant, InternalExecuteResult, KernelState,
    LateSentAgentMessageCallback, Value, AGENT_MESSAGE_DISPLAY_MIME,
    KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE, KERNEL_BUSY_INTERRUPT_INTERVAL_MS,
    KERNEL_BUSY_REUSE_WAIT_MS, MAX_BACKGROUND_OUTPUT_CHARS, MAX_LATE_SENT_AGENT_MESSAGE_HANDLERS,
};
use std::fmt::Write as _;

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
        {
            let g = lock(&self.guarded);
            let is_active = matches!(g.active_execution.as_ref(), Some(active) if Arc::ptr_eq(active, execution));
            if !is_active {
                return;
            }
        }
        lock(&execution.buffers).status = ExecuteStatus::Aborted;
        self.resolve_execution(execution, false);
    }

    /// Wait until no execution is active, interrupting a busy cell, bounded by
    /// the busy-reuse window.
    pub(crate) async fn wait_for_active_execution_to_clear_for_reuse(
        self: &Arc<Self>,
        signal: Option<&AbortSignal>,
    ) -> anyhow::Result<()> {
        let started = Instant::now();
        loop {
            let notified = self.busy_notify.notified();
            {
                let g = lock(&self.guarded);
                if g.active_execution.is_none() {
                    return Ok(());
                }
                if g.state == KernelState::Shutdown {
                    return Err(anyhow!("Kernel has been shut down"));
                }
            }
            let elapsed = started.elapsed();
            if elapsed >= Duration::from_millis(KERNEL_BUSY_REUSE_WAIT_MS) {
                break;
            }
            let wait_ms = (KERNEL_BUSY_REUSE_WAIT_MS - elapsed.as_millis() as u64)
                .min(KERNEL_BUSY_INTERRUPT_INTERVAL_MS);
            let wait = tokio::time::sleep(Duration::from_millis(wait_ms.max(1)));
            let active_id = lock(&self.guarded)
                .active_execution
                .as_ref()
                .map(|a| a.request_id.clone());
            let interrupt = {
                let inner = Arc::clone(self);
                tokio::spawn(async move {
                    let _ = inner.interrupt(active_id.as_deref()).await;
                })
            };
            tokio::select! {
                () = notified => {}
                () = wait => {}
                () = async {
                    match signal {
                        Some(signal) => signal.cancelled().await,
                        None => std::future::pending().await,
                    }
                } => {
                    interrupt.abort();
                    return Ok(());
                }
            }
        }
        if lock(&self.guarded).active_execution.is_some() {
            return Err(anyhow!("{KERNEL_BUSY_AFTER_INTERRUPT_MESSAGE}"));
        }
        Ok(())
    }

    fn notify_active_execution_idle(&self) {
        self.busy_notify.notify_waiters();
    }

    pub(crate) fn reject_active_execution(&self, message: &str) {
        let execution = {
            let mut g = lock(&self.guarded);
            g.active_execution.take()
        };
        if let Some(execution) = execution {
            if let Some(tx) = lock(&execution.result_tx).take() {
                let _ = tx.send(Err(anyhow!("{message}")));
            }
            self.notify_active_execution_idle();
        }
    }

    pub(crate) fn finish_active_execution(&self, execution: &Arc<ActiveExecution>) {
        let is_active = {
            let g = lock(&self.guarded);
            matches!(g.active_execution.as_ref(), Some(active) if Arc::ptr_eq(active, execution))
        };
        if !is_active {
            return;
        }
        self.resolve_execution(execution, true);
    }

    fn resolve_execution(&self, execution: &Arc<ActiveExecution>, clear_active: bool) {
        let did_clear_active = if clear_active {
            let mut g = lock(&self.guarded);
            matches!(g.active_execution.as_ref(), Some(active) if Arc::ptr_eq(active, execution))
                .then(|| {
                    g.active_execution = None;
                    true
                })
                .unwrap_or(false)
        } else {
            false
        };
        let mut buffers = lock(&execution.buffers);
        if !buffers.settled {
            buffers.settled = true;
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
            if execution
                .opts
                .signal
                .as_ref()
                .is_some_and(AbortSignal::is_aborted)
            {
                status = ExecuteStatus::Aborted;
            }
            // The watchdog teaches instead of killing: a cell that outlived
            // its budget but still settled ok keeps its ok status and its own
            // result; only a stderr note teaches. A completed cell reported
            // as a timeout error invites a duplicate run of finished work and
            // corrupts error-based telemetry, so the overage must not lie. A
            // cell that failed or was aborted keeps its own outcome, no note.
            let mut stderr = stderr;
            if status == ExecuteStatus::Ok {
                if let Some(note) = cell_watchdog_note(execution) {
                    if !stderr.is_empty() {
                        stderr.push('\n');
                    }
                    stderr.push_str(&note);
                }
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
                background_output: (!background_output.is_empty()).then_some(background_output),
                status,
                error: buffers.error.take(),
                duration_ms: execution.started.elapsed().as_millis() as u64,
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

/// The watchdog's teaching note for a cell that outlived its budget, or `None`
/// when the watchdog is off or the cell stayed inside the budget. Measured from
/// the wire write to the settle: queue wait and kernel boot are excluded. The
/// note rides stderr (the kernel lane's degrade-hint precedent) and the cell
/// keeps its ok status: the teaching must not turn a completed cell into a
/// retried timeout.
fn cell_watchdog_note(execution: &ActiveExecution) -> Option<String> {
    let timeout_ms = execution.opts.cell_timeout_ms.filter(|ms| *ms > 0)?;
    let started = (*lock(&execution.cell_started))?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if elapsed_ms <= timeout_ms {
        return None;
    }
    Some(format!(
        "[watchdog] Cell exceeded the {} python_repl budget (ran {}). Move long shell work to \
bash() (it auto-backgrounds past its yield window) and split long python work into smaller \
cells. Intentional long awaits (yield_after, rlm.collect timeouts) can ignore this note.",
        humanize_ms(timeout_ms),
        humanize_ms(elapsed_ms),
    ))
}

/// Milliseconds as one plain reading: whole seconds when the value divides,
/// a decimal otherwise, raw milliseconds under one second.
fn humanize_ms(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else if ms.is_multiple_of(1000) {
        format!("{}s", ms / 1000)
    } else {
        format!("{}.{:03}s", ms / 1000, ms % 1000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanize_ms_pads_the_millisecond_remainder() {
        assert_eq!(humanize_ms(500), "500ms");
        assert_eq!(humanize_ms(2000), "2s");
        assert_eq!(humanize_ms(60_000), "60s");
        assert_eq!(humanize_ms(1500), "1.500s");
        // A sub-100ms remainder must not read as tenths: 60.005s, not 60.5s.
        assert_eq!(humanize_ms(60_005), "60.005s");
    }
}
