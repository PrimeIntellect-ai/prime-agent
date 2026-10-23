//! Request plumbing: enqueue/execute state machine, signal enum, and failure
//! description helpers.

use super::{
    anyhow, json, lock, merge_signals, oneshot, AbortSignal, ActiveExecution, Arc, AsyncWriteExt,
    Duration, ExecBuffers, ExecuteOptions, ExecuteResult, ExecuteStatus, Instant,
    InternalExecuteResult, KernelStartOptions, KernelState, Mutex, ReplKernelManager, Request,
    DEFAULT_MAX_OUTPUT_CHARS, KERNEL_ABORT_GRACE_MS,
};

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
        if !text.is_empty() {
            // The buffer filled exactly on an earlier frame; the dropped
            // remainder still counts as truncation.
            *truncated = true;
        }
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

/// A bounded cell-stream buffer that keeps the head AND the tail of its text.
/// Python prints its verdicts last — tracebacks, summaries, exit status — so a
/// failing run loses exactly its outcome to a head-only cap.
///
/// The first three quarters of the stream's cap fill the head; later text
/// rolls through a tail window of the last quarter, and the dropped middle is
/// counted for the marker. Every cut goes through `char_indices`/char counts,
/// so both cut points sit on char boundaries by construction.
#[derive(Default)]
pub(crate) struct HeadTailBuffer {
    head: String,
    head_chars: usize,
    tail: String,
    tail_chars: usize,
    /// Chars dropped from the middle, named by [`Self::finish`].
    omitted: usize,
}

impl HeadTailBuffer {
    /// The stream's head and tail budgets within `max_chars`: the tail gets a
    /// quarter, the head the rest. The one owner of the split.
    fn split_cap(max_chars: usize) -> (usize, usize) {
        let tail_cap = max_chars / 4;
        (max_chars - tail_cap, tail_cap)
    }

    /// Whether any text was kept.
    pub(crate) fn is_empty(&self) -> bool {
        self.head.is_empty() && self.tail.is_empty()
    }

    /// Buffer stream text within `max_chars`: fill the head, then roll the
    /// tail window at its cap, counting the chars that fall out of it.
    pub(crate) fn push(&mut self, text: &str, max_chars: usize) {
        let (head_cap, tail_cap) = Self::split_cap(max_chars);
        if self.head_chars < head_cap {
            let remaining = head_cap - self.head_chars;
            let text_chars = text.chars().count();
            if text_chars <= remaining {
                self.head.push_str(text);
                self.head_chars += text_chars;
                return;
            }
            let end = text
                .char_indices()
                .nth(remaining)
                .map_or(text.len(), |(i, _)| i);
            self.head.push_str(&text[..end]);
            self.head_chars = head_cap;
            self.push_tail(&text[end..], tail_cap);
        } else {
            self.push_tail(text, tail_cap);
        }
    }

    /// Roll text into the tail window. A frame at or over the window's size
    /// displaces the old tail in place — buffering such a frame whole (then
    /// draining it) would keep its allocation resident until settle. Smaller
    /// frames accumulate, compacting the front once the window grows past
    /// twice its cap (amortized linear, bounded memory).
    fn push_tail(&mut self, text: &str, tail_cap: usize) {
        let text_chars = text.chars().count();
        if text_chars == 0 {
            return;
        }
        if text_chars >= tail_cap {
            self.omitted += self.tail_chars + text_chars - tail_cap;
            // Keep the window's worth of the frame's END. The None case is
            // tail_cap == 0: keep nothing.
            let keep_from = text
                .char_indices()
                .nth(text_chars - tail_cap)
                .map_or(text.len(), |(i, _)| i);
            self.tail.clear();
            self.tail.push_str(&text[keep_from..]);
            self.tail_chars = tail_cap;
            return;
        }
        self.tail.push_str(text);
        self.tail_chars += text_chars;
        if self.tail_chars > 2 * tail_cap {
            self.drop_tail_front(self.tail_chars - tail_cap);
        }
    }

    /// Drop the first `chars` chars off the tail, counting them omitted.
    fn drop_tail_front(&mut self, chars: usize) {
        let end = self
            .tail
            .char_indices()
            .nth(chars)
            .map_or(self.tail.len(), |(i, _)| i);
        self.tail.drain(..end);
        self.tail_chars -= chars;
        self.omitted += chars;
    }

    /// Resolve the buffered text: trim the tail to its cap, then return head,
    /// marker, and tail. Text that fit the cap passes through unchanged.
    pub(crate) fn finish(mut self, max_chars: usize) -> String {
        let (_, tail_cap) = Self::split_cap(max_chars);
        if self.tail_chars > tail_cap {
            self.drop_tail_front(self.tail_chars - tail_cap);
        }
        if self.omitted == 0 {
            let mut text = self.head;
            text.push_str(&self.tail);
            return text;
        }
        format!(
            "{}\n[... {} chars omitted ...]\n{}",
            self.head, self.omitted, self.tail
        )
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
        // Re-check: a final flush may have started while this request awaited the lazy
        // re-bootstrap; admitting it now would splice it between the flush\'s captured queue
        // and the final snapshot, unbounding the teardown.
        if lock(&self.inner.guarded).flushing_snapshot_for_dispose && !opts.internal {
            return Err(anyhow!("Kernel is shutting down"));
        }

        let queue_guard = self.inner.execution_queue.lock().await;

        // A repair started while this request was queued or busy-waiting: release the slot
        // so the repair\'s own restore can run, then requeue behind it.
        if lock(&self.inner.guarded).protocol_repair.is_some() && !opts.protocol_repair {
            drop(queue_guard);
            self.wait_for_protocol_repair(opts.signal.as_ref()).await?;
            return Box::pin(self.enqueue_request(request, opts, execution_timeout_ms)).await;
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
        let result = self.execute_inner(request, opts, started).await;
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
        let (namespace_code, restores_namespace) = match &request {
            Request::Execute { .. } => (true, false),
            Request::Restore { .. } => (false, true),
            _ => (false, false),
        };
        let execution = Arc::new(ActiveExecution {
            request_id: request_id.clone(),
            started,
            max_chars,
            namespace_code,
            restores_namespace,
            buffers: Mutex::new(buffers),
            result_tx: Mutex::new(Some(result_tx)),
            cell_started: Mutex::new(None),
            opts,
        });
        {
            let mut g = lock(&self.inner.guarded);
            g.active_execution = Some(execution.clone());
        }

        // Abort watcher: interrupts the kernel out-of-band, then force-aborts
        // after the grace window if the runtime did not settle the cell.
        if let Some(signal) = execution.opts.signal.clone() {
            // Weak on both sides: a never-fired signal leaves this watcher pending forever, and a
            // strong manager would pin the kernel past the last manager's drop.
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
                // A blocked request write holds the stdin mutex. Do not let an
                // interrupt queued behind it postpone the force-abort forever.
                // Dropping the interrupt at this deadline cannot tear its
                // frame: the ~60-byte frame is one write on a non-blocking
                // pipe, all-or-nothing below PIPE_BUF.
                let deadline =
                    tokio::time::Instant::now() + Duration::from_millis(KERNEL_ABORT_GRACE_MS);
                tokio::select! {
                    _ = inner.interrupt(Some(&execution.request_id)) => {},
                    () = tokio::time::sleep_until(deadline) => {}
                }
                tokio::time::sleep_until(deadline).await;
                // The execution stays active until its done event arrives;
                // clearing it early would let a new cell race the interrupted
                // one (see busy-after-interrupt).
                inner.force_abort(&execution);
            });
        }

        let mut frame = request.to_json();
        frame["id"] = json!(request_id);

        let (mut send_task, stdin_retire) = {
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
            // The retire handle below must name this exact kernel's stream;
            // re-deriving it from `child` later could reach a restarted
            // kernel's stdin.
            let stdin_retire = stdin.clone();
            let send_task = tokio::spawn(async move {
                let mut guard = stdin.lock().await;
                let Some(stdin) = guard.as_mut() else {
                    return Err(anyhow!("Kernel stdin is not connected"));
                };
                stdin.write_all(line.as_bytes()).await?;
                stdin.flush().await?;
                Ok(())
            });
            (send_task, stdin_retire)
        };

        // The cell's own window starts as its frame goes on the wire: boot and
        // queue wait are excluded so a cold kernel cannot trip the watchdog.
        *lock(&execution.cell_started) = Some(Instant::now());
        let mut settled_result: Option<anyhow::Result<InternalExecuteResult>> = None;
        let send_outcome: anyhow::Result<()> = {
            let send_promise = &mut send_task;
            tokio::select! {
                r = send_promise => r.unwrap_or_else(|e| Err(anyhow!("{e}"))),
                settled = &mut result_rx => {
                    // The cell settled before the write completed (fast runtime). Only an aborted
                    // status may skip waiting for the write; a failed write on a successful cell
                    // must surface.
                    let settled: anyhow::Result<InternalExecuteResult> = match settled {
                        Ok(result) => result,
                        Err(_) => Err(anyhow!("Kernel has been shut down")),
                    };
                    let early_settle = matches!(&settled, Ok(result) if result.result.status == ExecuteStatus::Aborted);
                    if early_settle {
                        // A blocked request writer would otherwise retain stdin's
                        // mutex after the caller returned, wedging shutdown too.
                        send_task.abort();
                        // A cancelled write leaves the request unsent or
                        // torn: the runtime never sees it, its execution never
                        // settles, and every later request fails as busy.
                        // Retire stdin so the kernel is replaced.
                        if matches!(send_task.await, Err(e) if e.is_cancelled()) {
                            // Detached: a queued stdin writer must not park this request.
                            tokio::spawn(async move {
                                *stdin_retire.lock().await = None;
                            });
                        }
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
    use super::{append_truncated, HeadTailBuffer};

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_execute_settles_when_kernel_stops_reading_stdin() {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = dir.path().join("ready-but-not-reading");
        std::fs::write(
            &python,
            "#!/usr/bin/env python3\nimport json, time\nprint(json.dumps({'event': 'ready', 'protocol': 3, 'python': '3.13.0'}), flush=True)\ntime.sleep(30)\n",
        )
        .expect("write fake kernel");
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake kernel");
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        // Larger than the stdin pipe: the request writer holds its mutex while
        // waiting for this non-reader, so the interrupt write cannot acquire it.
        let code = "x".repeat(1024 * 1024);
        let result = tokio::time::timeout(
            Duration::from_secs(4),
            manager.execute_bounded(&code, ExecuteOptions::default(), Some(100)),
        )
        .await;
        let result = result
            .expect("timeout must settle even when the interrupt cannot write")
            .expect("bounded execute returns a result");
        assert_eq!(result.status, ExecuteStatus::Aborted);
        let stdin = manager
            .inner
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .expect("child exists")
            .stdin
            .clone();
        assert!(
            stdin.try_lock().is_ok(),
            "the aborted request must release the stdin writer lock"
        );
        manager.kill();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_request_write_retires_the_kernel() {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        // Protocol v3: ready, then idles without reading stdin until the
        // sibling "go" file appears, then answers execute frames, ignores
        // glued garbage (a torn prefix makes any next line invalid), and
        // never answers interrupts (that would settle the aborted execution).
        const TORN_FRAME_RUNTIME: &str = r#"#!/usr/bin/env python3
import json
import os
import sys
import time

print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
go = os.path.join(os.path.dirname(os.path.abspath(__file__)), "go")
while not os.path.exists(go):
    time.sleep(0.01)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("type") == "execute":
        print(json.dumps({"event": "done", "id": req.get("id"), "status": "ok"}), flush=True)
"#;

        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = dir.path().join("torn-frame-kernel");
        std::fs::write(&python, TORN_FRAME_RUNTIME).expect("write fake kernel");
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake kernel");
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        // Larger than the stdin pipe, so the 100ms bound force-aborts while
        // the request write is still mid-flight and tears the frame.
        let code = "x".repeat(1024 * 1024);
        let first = tokio::time::timeout(
            Duration::from_secs(4),
            manager.execute_bounded(&code, ExecuteOptions::default(), Some(100)),
        )
        .await
        .expect("the bounded execute must settle")
        .expect("bounded execute returns a result");
        assert_eq!(first.status, ExecuteStatus::Aborted);
        // Let the fake kernel read: EOF (retired stream) exits it, while
        // glued garbage keeps the unfixed kernel Running. The request below
        // observes the outcome: shutdown error or busy after the 5s window.
        std::fs::write(dir.path().join("go"), b"").expect("write go file");
        // Only the wait matters here; is_defunct() below discriminates.
        let _ = tokio::time::timeout(
            Duration::from_secs(10),
            manager.execute_bounded("1+1", ExecuteOptions::default(), None),
        )
        .await
        .expect("the next request must settle");
        assert!(
            manager.is_defunct(),
            "a cancelled request write must retire the kernel"
        );
        manager.kill();
    }

    /// A cell's streamed output past the cap keeps the head and the tail: a
    /// long run's printed verdict (tracebacks, summaries, exit status arrive
    /// last) must survive the buffer, not just the first `max_chars` chars.
    #[cfg(unix)]
    #[tokio::test]
    async fn long_cell_output_keeps_head_and_tail() {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        // Protocol v3: ready, then one execute answered by stdout frames of
        // filler past the cap (multi-byte text, so cut points can land inside
        // a char run) with a printed traceback LAST, then done.
        const TRACEBACK_RUNTIME: &str = r#"#!/usr/bin/env python3
import json
import sys

print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("type") == "execute":
        rid = req.get("id")
        filler = "é🍁xyz" * 20_000
        for start in range(0, len(filler), 4_096):
            chunk = filler[start:start + 4_096]
            print(json.dumps({"event": "stdout", "id": rid, "text": chunk}), flush=True)
        traceback = "Traceback (most recent call last):\n ...\nAssertionError: t1-traceback-sentinel\n"
        print(json.dumps({"event": "stdout", "id": rid, "text": traceback}), flush=True)
        print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
"#;

        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = dir.path().join("traceback-kernel");
        std::fs::write(&python, TRACEBACK_RUNTIME).expect("write fake kernel");
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake kernel");
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            manager.execute_bounded("1+1", ExecuteOptions::default(), None),
        )
        .await
        .expect("the execute must settle")
        .expect("execute returns a result");
        assert_eq!(result.status, ExecuteStatus::Ok);
        let stdout = result.stdout;
        let filler = "é🍁xyz".repeat(20_000);
        let traceback =
            "Traceback (most recent call last):\n ...\nAssertionError: t1-traceback-sentinel\n";
        assert!(
            stdout.starts_with("é🍁xyz"),
            "the head must keep the stream's first chars"
        );
        assert!(
            stdout.ends_with(traceback),
            "the tail must keep the verdict printed last"
        );
        let omitted = filler.chars().count() + traceback.chars().count() - DEFAULT_MAX_OUTPUT_CHARS;
        let marker = format!("\n[... {omitted} chars omitted ...]\n");
        let marker_at = stdout
            .find(&marker)
            .expect("the dropped middle must be named by a marker");
        assert!(
            marker_at + marker.len() <= stdout.len() - traceback.len(),
            "the marker must sit between head and tail"
        );
        assert!(stdout.chars().count() <= DEFAULT_MAX_OUTPUT_CHARS + marker.chars().count());
        manager.kill();
    }

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
                } else if !text.is_empty() {
                    // The buffer filled exactly on an earlier frame; the dropped
                    // remainder still counts as truncation (TS #2423).
                    expected_truncated = true;
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

    #[test]
    fn exact_fill_remainder_counts_as_truncation() {
        // The buffer filled exactly on an earlier frame; a later non-empty
        // frame is dropped but still marks the stream truncated (TS #2423).
        let mut buffer = String::from("abcd");
        let mut truncated = false;
        let mut count = 4;
        append_truncated(&mut buffer, &mut truncated, &mut count, "ef", 4);
        assert!(truncated);
        assert_eq!(buffer, "abcd");
        assert_eq!(count, 4);

        // Empty frames never flip the flag.
        let mut empty = String::new();
        let mut never = false;
        let mut zero = 0;
        append_truncated(&mut empty, &mut never, &mut zero, "", 4);
        assert!(!never);
    }

    #[test]
    fn head_tail_buffer_matches_oracle() {
        let long_z = "z".repeat(40);
        let long_multi = "é🍁".repeat(30);
        // Multi-byte frames long enough to roll the tail window several times.
        let frames = [
            "",
            "a",
            "é",
            "🍁",
            "xy",
            "é🍁abc",
            long_z.as_str(),
            "",
            "tail",
            long_multi.as_str(),
        ];
        for cap in [0usize, 1, 2, 3, 4, 7, 8, 16] {
            let mut buffer = HeadTailBuffer::default();
            let mut all = String::new();
            for text in frames {
                buffer.push(text, cap);
                all.push_str(text);
            }
            let expected = oracle(&all, cap);
            assert_eq!(buffer.finish(cap), expected, "cap {cap}");
        }
    }

    /// The oracle: verbatim when everything fits, else the first
    /// `head_cap` chars, the named elision, and the last `tail_cap` chars.
    /// The ratio itself comes from `split_cap`, its one owner.
    fn oracle(all: &str, cap: usize) -> String {
        let (head_cap, tail_cap) = HeadTailBuffer::split_cap(cap);
        let chars: Vec<char> = all.chars().collect();
        if chars.len() <= cap {
            return all.to_string();
        }
        let head: String = chars[..head_cap].iter().collect();
        let tail: String = chars[chars.len() - tail_cap..].iter().collect();
        let omitted = chars.len() - head_cap - tail_cap;
        format!("{head}\n[... {omitted} chars omitted ...]\n{tail}")
    }

    #[test]
    fn one_oversized_frame_keeps_the_tail_window_small() {
        // `print(big_string)` arrives as ONE stdout frame; buffering it whole
        // would keep the frame's allocation resident until settle.
        let frame = "é".repeat(1_000_000);
        let mut buffer = HeadTailBuffer::default();
        buffer.push(&frame, 16);
        assert!(
            buffer.tail.capacity() < 1_024,
            "the tail window must not retain the frame's allocation"
        );
        assert_eq!(buffer.finish(16), oracle(&frame, 16));
    }
}
