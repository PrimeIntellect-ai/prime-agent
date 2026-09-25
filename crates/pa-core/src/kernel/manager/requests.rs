//! Request plumbing: enqueue/execute state machine, signal enum, and failure
//! description helpers.

use super::*;

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

pub(crate) use crate::platform::process::Signal;

/// Append stream text up to `max_chars` Unicode scalars, keeping the buffered count in sync.
pub(crate) fn append_truncated(
    buffer: &mut String,
    truncated: &mut bool,
    chars: &mut usize,
    text: &str,
    max_chars: usize,
) {
    if *chars >= max_chars {
        return;
    }
    let remaining = max_chars - *chars;
    let text_chars = text.chars().count();
    if text_chars <= remaining {
        buffer.push_str(text);
        *chars += text_chars;
    } else {
        let end = text
            .char_indices()
            .nth(remaining)
            .map_or(text.len(), |(i, _)| i);
        buffer.push_str(&text[..end]);
        *chars = max_chars;
        *truncated = true;
    }
}

pub(crate) fn describe_failure(result: &ExecuteResult) -> String {
    if let Some(error) = &result.error {
        if error.evalue.is_empty() {
            return error.ename.clone();
        }
        return format!("{}: {}", error.ename, error.evalue);
    }
    result.stderr.trim_end().to_string()
}

impl ReplKernelManager {
    /// Queue one protocol request (execute or state op) behind every other request.
    #[allow(clippy::too_many_lines)]
    pub(crate) async fn enqueue_request(
        &self,
        request: Request,
        code: &str,
        opts: ExecuteOptions,
        execution_timeout_ms: Option<u64>,
    ) -> anyhow::Result<InternalExecuteResult> {
        let started = Instant::now();
        if let Some(signal) = &opts.signal {
            if signal.is_aborted() {
                return Ok(InternalExecuteResult::aborted(started));
            }
        }
        self.start(KernelStartOptions {
            signal: opts.signal.clone(),
            on_bootstrap_progress: None,
        })
        .await?;
        if self.state() == KernelState::Shutdown {
            return Err(anyhow!("Kernel has been shut down"));
        }
        if lock(&self.inner.guarded).flushing_snapshot_for_dispose && !opts.internal {
            return Err(anyhow!("Kernel is shutting down"));
        }
        if !opts.protocol_repair {
            self.ensure_kernel_rebootstrapped(opts.signal.as_ref())
                .await?;
        }
        // Aborted while waiting on the re-bootstrap: settle now instead of
        // parking on the queue slot behind the still-running bootstrap.
        if let Some(signal) = &opts.signal {
            if signal.is_aborted() {
                return Ok(InternalExecuteResult::aborted(started));
            }
        }
        // Re-check: a final flush may have started while this request awaited
        // the lazy re-bootstrap; admitting it now would splice it between the
        // flush\'s captured queue and the final snapshot, unbounding the teardown.
        if lock(&self.inner.guarded).flushing_snapshot_for_dispose && !opts.internal {
            return Err(anyhow!("Kernel is shutting down"));
        }

        let queue_guard = self.inner.execution_queue.lock().await;

        // A repair started while this request was queued or busy-waiting:
        // release the slot so the repair\'s own restore can run, then requeue
        // behind it.
        if lock(&self.inner.guarded).protocol_repair.is_some() && !opts.protocol_repair {
            drop(queue_guard);
            self.wait_for_protocol_repair(opts.signal.as_ref()).await?;
            return Box::pin(self.enqueue_request(request, code, opts, execution_timeout_ms)).await;
        }

        self.wait_for_active_execution_to_clear_for_reuse(opts.signal.as_ref())
            .await?;
        if let Some(signal) = &opts.signal {
            if signal.is_aborted() {
                return Ok(InternalExecuteResult::aborted(started));
            }
        }
        if self.state() == KernelState::Shutdown {
            return Err(anyhow!("Kernel has been shut down"));
        }

        // Bound the execution with an out-of-band abort (interrupt + grace).
        let timeout_signal = execution_timeout_ms.map(|ms| {
            let signal = AbortSignal::new();
            let timer_signal = signal.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                timer_signal.abort();
            });
            signal
        });
        let merged = merge_signals(opts.signal.as_ref(), timeout_signal.clone());
        let mut opts = opts;
        opts.signal = merged;
        let result = self.execute_inner(request, code, opts, started).await;
        if let Some(signal) = &timeout_signal {
            signal.abort();
        }
        result
    }

    fn state(&self) -> KernelState {
        lock(&self.inner.guarded).state
    }

    #[allow(clippy::too_many_lines)]
    async fn execute_inner(
        &self,
        request: Request,
        code: &str,
        opts: ExecuteOptions,
        started: Instant,
    ) -> anyhow::Result<InternalExecuteResult> {
        let max_chars = opts.max_output_chars.unwrap_or(DEFAULT_MAX_OUTPUT_CHARS);
        let request_id = uuid::Uuid::new_v4().to_string();

        if let Some(signal) = &opts.signal {
            if signal.is_aborted() {
                return Ok(InternalExecuteResult::aborted(started));
            }
        }
        if lock(&self.inner.guarded).active_execution.is_some() {
            return Err(anyhow!("Kernel already has an active execution"));
        }

        let (result_tx, mut result_rx) =
            oneshot::channel::<anyhow::Result<InternalExecuteResult>>();
        let mut buffers = ExecBuffers {
            status: ExecuteStatus::Ok,
            ..ExecBuffers::default()
        };
        {
            let mut g = lock(&self.inner.guarded);
            buffers.background_output = std::mem::take(&mut g.pending_background_output);
            buffers.background_output_chars =
                std::mem::take(&mut g.pending_background_output_chars);
            buffers.background_output_truncated =
                std::mem::replace(&mut g.pending_background_output_truncated, false);
            g.active_execution = None; // reset below with the execution in hand
        }
        let execution = Arc::new(ActiveExecution {
            request_id: request_id.clone(),
            code: code.to_string(),
            started,
            max_chars,
            buffers: Mutex::new(buffers),
            result_tx: Mutex::new(Some(result_tx)),
            opts,
        });
        {
            let mut g = lock(&self.inner.guarded);
            g.active_execution = Some(execution.clone());
        }

        // Abort watcher: interrupts the kernel out-of-band, then force-aborts
        // after the grace window if the runtime did not settle the cell.
        if let Some(signal) = execution.opts.signal.clone() {
            // Weak on both sides: a never-fired signal leaves this watcher
            // pending forever, and a strong manager would pin the kernel
            // past the last manager's drop (the reader-retention class).
            let inner = Arc::downgrade(&self.inner);
            let weak_exec = Arc::downgrade(&execution);
            tokio::spawn(async move {
                signal.cancelled().await;
                let Some(execution) = weak_exec.upgrade() else {
                    return;
                };
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                let _ = inner.interrupt(Some(&execution.request_id)).await;
                tokio::time::sleep(Duration::from_millis(KERNEL_ABORT_GRACE_MS)).await;
                // The execution stays active until its done event arrives;
                // clearing it early would let a new cell race the interrupted
                // one (see busy-after-interrupt).
                inner.force_abort(&execution);
            });
        }

        if !execution.opts.internal {
            lock(&self.inner.guarded).last_cell_code = Some(code.to_string());
        }

        let mut frame = request.to_json();
        frame["id"] = json!(request_id);

        let mut send_task = {
            let writer = lock(&self.inner.child).as_ref().map(|c| c.stdin.clone());
            let Some(stdin) = writer else {
                {
                    let mut g = lock(&self.inner.guarded);
                    g.active_execution = None;
                }
                return Err(anyhow!("Kernel stdin is not connected"));
            };
            let mut line = frame.to_string();
            line.push('\n');
            tokio::spawn(async move {
                let mut guard = stdin.lock().await;
                let Some(stdin) = guard.as_mut() else {
                    return Err(anyhow!("Kernel stdin is not connected"));
                };
                stdin.write_all(line.as_bytes()).await?;
                stdin.flush().await?;
                Ok(())
            })
        };

        let mut settled_result: Option<anyhow::Result<InternalExecuteResult>> = None;
        let send_outcome: anyhow::Result<()> = {
            let send_promise = &mut send_task;
            tokio::select! {
                r = send_promise => r.unwrap_or_else(|e| Err(anyhow!("{e}"))),
                settled = &mut result_rx => {
                    // The cell settled before the write completed (fast runtime).
                    // Only an aborted status may skip waiting for the write; a
                    // failed write on a successful cell must surface.
                    let settled: anyhow::Result<InternalExecuteResult> = match settled {
                        Ok(result) => result,
                        Err(_) => Err(anyhow!("Kernel has been shut down")),
                    };
                    let early_settle = matches!(&settled, Ok(result) if result.result.status == ExecuteStatus::Aborted);
                    if early_settle {
                        settled_result = Some(settled);
                    } else {
                        // Surfacing a failed write outranks the settled cell.
                        if let Err(error) = (&mut send_task).await.unwrap_or_else(|e| Err(anyhow!("{e}"))) {
                            settled_result = Some(Err(error));
                        } else {
                            settled_result = Some(settled);
                        }
                    }
                    Ok(())
                }
            }
        };

        match settled_result.take() {
            Some(result) => result,
            None => match send_outcome {
                Err(error) => {
                    {
                        let mut g = lock(&self.inner.guarded);
                        if matches!(g.active_execution.as_ref(), Some(active) if Arc::ptr_eq(active, &execution))
                        {
                            g.active_execution = None;
                        }
                    }
                    Err(error)
                }
                Ok(()) => match result_rx.await {
                    Ok(result) => result,
                    Err(_) => Err(anyhow!("Kernel has been shut down")),
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::append_truncated;

    #[test]
    fn capped_stream_matches_original_unicode_and_frame_semantics() {
        let frames = ["", "a", "é", "🍁", "xy", "é🍁abc", "", "tail"];
        for cap in [0, 1, 2, 3, 4, 7, 65_536] {
            let mut actual = String::new();
            let mut count = 0;
            let mut truncated = false;
            let mut expected = String::new();
            let mut expected_truncated = false;
            for text in frames {
                append_truncated(&mut actual, &mut truncated, &mut count, text, cap);
                if expected.chars().count() < cap {
                    expected.push_str(text);
                    if expected.chars().count() > cap {
                        expected = expected.chars().take(cap).collect();
                        expected_truncated = true;
                    }
                }
                assert_eq!(
                    (actual.as_str(), truncated, count),
                    (
                        expected.as_str(),
                        expected_truncated,
                        expected.chars().count()
                    )
                );
            }
        }
    }
}
