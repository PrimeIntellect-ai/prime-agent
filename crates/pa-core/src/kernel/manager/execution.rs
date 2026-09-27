//! Execution bookkeeping: request writes, interrupts, abort forcing, and
//! active-execution resolution plus late-sent agent message handlers.

use super::*;
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
            if let Some(callback) = execution.opts.on_late_sent_agent_message.clone() {
                self.register_late_sent_agent_message_handler(&execution.request_id, callback);
            }

            let mut stdout = std::mem::take(&mut buffers.stdout);
            buffers.stdout_chars = 0;
            let mut stderr = std::mem::take(&mut buffers.stderr);
            buffers.stderr_chars = 0;
            let mut result = buffers.result.take();
            let mut status = buffers.status;
            if buffers.stdout_truncated {
                let _ = write!(
                    stdout,
                    "\n[... output truncated at {} chars ...]",
                    execution.max_chars
                );
            }
            if buffers.stderr_truncated {
                let _ = write!(
                    stderr,
                    "\n[... output truncated at {} chars ...]",
                    execution.max_chars
                );
            }
            if let Some(text) = &result {
                if text.len() > execution.max_chars {
                    let mut clipped = text[..execution.max_chars.clamp(0, text.len())].to_string();
                    // Trim at a char boundary when max_chars split a multi-byte char.
                    while !clipped.is_char_boundary(clipped.len()) {
                        clipped.pop();
                    }
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
