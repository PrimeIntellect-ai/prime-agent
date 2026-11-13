//! Request plumbing: enqueue/execute state machine, signal enum, and failure
//! description helpers.

use std::sync::atomic::Ordering;

use super::{
    anyhow, json, lock, merge_signals, oneshot, AbortSignal, ActiveExecution, Arc, AsyncWriteExt,
    AtomicBool, Duration, ExecBuffers, ExecuteOptions, ExecuteResult, ExecuteStatus, Instant,
    InternalExecuteResult, KernelStartOptions, Mutex, ReplKernelManager, Request,
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

    /// A non-consuming copy of [`Self::finish`]: the head, marker, and tail a
    /// finish would produce right now, leaving the buffer untouched (the
    /// detach path reads the partial output while the cell keeps writing).
    pub(crate) fn snapshot(&self, max_chars: usize) -> String {
        let (_, tail_cap) = Self::split_cap(max_chars);
        let mut omitted = self.omitted;
        let tail = if self.tail_chars > tail_cap {
            let drop = self.tail_chars - tail_cap;
            omitted += drop;
            let end = self
                .tail
                .char_indices()
                .nth(drop)
                .map_or(self.tail.len(), |(i, _)| i);
            &self.tail[end..]
        } else {
            self.tail.as_str()
        };
        if omitted == 0 {
            let mut text = self.head.clone();
            text.push_str(tail);
            return text;
        }
        format!(
            "{}\n[... {} chars omitted ...]\n{}",
            self.head, omitted, tail
        )
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
        if lock(&self.inner.guarded).lifecycle.is_shut_down() {
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
        if lock(&self.inner.guarded).lifecycle.is_shut_down() {
            return Err(anyhow!("Kernel has been shut down"));
        }

        // The hard bound (internal ops: bootstrap/state captures) merges into
        // the abort signal: an unfinished op must fail, not detach. The
        // model-facing wait budget in `opts.cell_timeout_ms` is separate: its
        // clock arms in `execute_inner` and it detaches instead.
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
        // The hard bound fails the op (the base `execute_bounded` contract):
        // it never arms the kill-on-ignored-interrupt — a bound write or
        // state capture keeps its kernel alive for the next op.
        let result = self
            .execute_inner(request, opts, started, execution_timeout_ms.is_some())
            .await;
        if let Some(signal) = &timeout_signal {
            signal.abort();
        }
        result
    }

    #[allow(clippy::too_many_lines)]
    async fn execute_inner(
        &self,
        request: Request,
        opts: ExecuteOptions,
        started: Instant,
        hard_bounded: bool,
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
        // The execution-local stop signal: a child of the caller's token, so
        // a run abort cancels this execution without cancelling the provider
        // run's later cells, and a manager-targeted cancel or the hard cap
        // can reach it after the caller's run is gone. Internal ops keep the
        // merged signal directly (their bound must fail the op, not stop a
        // user cell), and so does a hard-bounded user op
        // (`execute_bounded`): its bound aborts the op, never the kernel.
        let stop_signal = if opts.internal || hard_bounded {
            opts.signal.clone().unwrap_or_default()
        } else {
            opts.signal
                .as_ref()
                .map(|signal| {
                    crate::kernel::cancellation::AbortSignal::from_token(
                        signal.token().child_token(),
                    )
                })
                .unwrap_or_default()
        };
        let execution = Arc::new(ActiveExecution {
            request_id: request_id.clone(),
            started,
            max_chars,
            namespace_code,
            restores_namespace,
            buffers: Mutex::new(buffers),
            result_tx: Mutex::new(Some(result_tx)),
            opts,
            detached: AtomicBool::new(false),
            stop_signal,
            stop_cause: Mutex::new(None),
            settled_tx: tokio::sync::watch::channel(false).0,
        });
        {
            let mut g = lock(&self.inner.guarded);
            g.active_execution = Some(execution.clone());
        }

        // The stop watcher and the wait clocks. The wait budget's deadline
        // and the session wake's subscription arm BEFORE the request goes on
        // the wire: a wake or a budget that lands while the frame is still
        // being written is retained, not lost (queue wait and kernel boot
        // stay excluded — both clocks start at the write).
        let cell_timeout_ms = execution.opts.cell_timeout_ms.filter(|ms| *ms > 0);
        let budget_deadline =
            cell_timeout_ms.map(|ms| tokio::time::Instant::now() + Duration::from_millis(ms));
        let mut wake_rx = execution.opts.wake.as_ref().map(|wake| wake.subscribe());
        let wake_pending = execution.opts.wake.as_ref().and_then(|wake| wake.pending());
        if execution.opts.internal || hard_bounded {
            // A bounded op's watcher: interrupt, grace, force-abort. Its
            // hard bound must fail the op, never retire a kernel behind a
            // user cell (the base `execute_bounded` contract; the bound is
            // not a user cancel). The settle watch ends the watcher when
            // the op settles, so no successful op leaves a task behind.
            if let Some(signal) = execution.opts.signal.clone() {
                let inner = Arc::downgrade(&self.inner);
                let weak_exec = Arc::downgrade(&execution);
                let settled_rx = execution.settled_tx.subscribe();
                tokio::spawn(async move {
                    let mut settled_rx = settled_rx;
                    if *settled_rx.borrow() {
                        return;
                    }
                    tokio::select! {
                        () = signal.cancelled() => {}
                        _ = settled_rx.changed() => return,
                    }
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
                    inner.force_abort(&execution);
                });
            }
        } else {
            // A user cell's stop is execution-owned: the run's abort (the
            // parent token) or a manager-targeted user cancel fires the
            // execution-local signal. Weak on both sides: a never-fired
            // signal leaves the watcher pending forever, and a strong
            // manager would pin the kernel past the last manager's drop.
            let stop_signal = execution.stop_signal.clone();
            let inner = Arc::downgrade(&self.inner);
            let weak_exec = Arc::downgrade(&execution);
            let settled_rx = execution.settled_tx.subscribe();
            tokio::spawn(async move {
                let mut settled_rx = settled_rx;
                // A settled, rejected, or retired execution ends its
                // watcher: the task exits instead of awaiting a stop
                // signal that will never fire.
                if *settled_rx.borrow() {
                    return;
                }
                tokio::select! {
                    () = stop_signal.cancelled() => {}
                    _ = settled_rx.changed() => return,
                }
                let Some(execution) = weak_exec.upgrade() else {
                    return;
                };
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                // The parent token fired (a run abort): a user stop, unless
                // a trigger already recorded its own typed cause.
                if execution.stop_cause().is_none() {
                    execution
                        .stop_with_cause(crate::kernel::shared::ExecutionStopCause::UserCancel);
                }
                // Fence: only the still-active, unsettled execution gets the
                // out-of-band interrupt — a settled execution's late watcher
                // must never signal the next cell.
                if inner.execution_is_live(&execution) {
                    // A blocked request write holds the stdin mutex. Do not let an
                    // interrupt queued behind it postpone the stop forever.
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
                }
                // The kill-on-ignored-interrupt, restored in the detached
                // context: an execution still physically active at grace
                // expiry retires its kernel, and the forced-stop completion
                // publishes only after the kill. The retirement claims its
                // execution atomically, so a cell that settled while the
                // grace ran out (and a replacement that started behind it)
                // is never touched.
                inner.retire_for_ignored_interrupt(&execution);
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

        let mut settled_result: Option<anyhow::Result<InternalExecuteResult>> = None;
        let send_outcome: anyhow::Result<()> = {
            // The write-phase ceiling: a wake or the wait budget that
            // fires while the frame is still unwritten cannot detach the
            // cell (the kernel never received it — the cannot-yield class
            // of the steer handoff), so it starts a short ceiling instead.
            // On expiry the execution stops with a typed cause, the stop
            // watcher retires the kernel, and the settled arm below runs
            // the existing early-settle retirement of the blocked writer
            // and its stdin. The write carries its own wake subscription,
            // so the wait's retained-wake contract is untouched.
            let ceiling_ms = Duration::from_millis(crate::kernel::shared::KERNEL_WRITE_CEILING_MS);
            let mut write_wake_rx = execution.opts.wake.as_ref().map(|wake| wake.subscribe());
            // A wake level already pending at the write is a failed steer
            // handoff too: the ceiling starts with the write.
            let mut write_ceiling: Option<tokio::time::Instant> = wake_pending
                .as_ref()
                .filter(|pending| pending())
                .map(|_| tokio::time::Instant::now() + ceiling_ms);
            let mut budget_started_ceiling = false;
            loop {
                let write_budget = async {
                    match budget_deadline {
                        Some(deadline) if !budget_started_ceiling => {
                            tokio::time::sleep_until(deadline).await;
                        }
                        _ => std::future::pending().await,
                    }
                };
                let write_ceiling_wait = async {
                    match write_ceiling {
                        Some(at) => tokio::time::sleep_until(at).await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    biased;
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
                        break Ok(());
                    }
                    r = &mut send_task => {
                        break r.unwrap_or_else(|e| Err(anyhow!("{e}")));
                    }
                    () = awakened(write_wake_rx.as_mut()) => {
                        write_ceiling
                            .get_or_insert_with(|| tokio::time::Instant::now() + ceiling_ms);
                    }
                    () = write_budget => {
                        // The budget that fires mid-write starts the ceiling
                        // once; the wait's own budget arm keeps its detach
                        // reason when the write completes inside the ceiling.
                        budget_started_ceiling = true;
                        write_ceiling
                            .get_or_insert_with(|| tokio::time::Instant::now() + ceiling_ms);
                    }
                    () = write_ceiling_wait => {
                        // Fires once: the ceiling never re-arms, and the typed
                        // stop is idempotent. The stop watcher's retirement
                        // lands on the result channel, whose early-settle arm
                        // retires the blocked writer and its stdin.
                        write_ceiling = None;
                        execution.stop_with_cause(
                            crate::kernel::shared::ExecutionStopCause::WriteCeiling,
                        );
                    }
                }
            }
        };

        if let Some(result) = settled_result.take() {
            return result;
        }
        if let Err(error) = send_outcome {
            {
                let mut g = lock(&self.inner.guarded);
                if matches!(g.active_execution.as_ref(), Some(active) if Arc::ptr_eq(active, &execution))
                {
                    g.active_execution = None;
                }
            }
            Err(error)
        } else {
            // The wait: the cell's settlement, or a detach (the session
            // wake or the budget deadline firing while the cell runs). A
            // settled cell wins a tie: the work is done, so there is
            // nothing to background. A wake with a pending predicate is a
            // LEVEL signal: an arrival that predates the subscription ends
            // the wait only after a short settle window — a cell that is
            // about to answer keeps its own tool result instead of paying
            // a completion-notice model turn, while a long cell still
            // detaches promptly — and a notification whose input was
            // consumed or cleared rechecks the level instead of detaching
            // a later cell. Without a predicate the wake keeps its
            // standalone edge-triggered contract.
            let wait = loop {
                let budget = || async {
                    match budget_deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                };
                if let Some(pending) = &wake_pending {
                    if pending() {
                        // The settle window: the arrival predates the
                        // subscription, so let a quick result win inline;
                        // a cell still running at the window's end
                        // detaches (the wait budget keeps its own reason).
                        let settle = tokio::time::sleep(Duration::from_millis(
                            crate::kernel::shared::KERNEL_LEVEL_WAKE_SETTLE_MS,
                        ));
                        tokio::select! {
                            biased;
                            settled = &mut result_rx => {
                                break Wait::Settled(Box::new(
                                    settled.unwrap_or_else(|_| Err(anyhow!("Kernel has been shut down"))),
                                ));
                            }
                            () = budget() => {
                                break Wait::Detach(
                                    crate::kernel::shared::DetachReason::WaitBudget(
                                        cell_timeout_ms.unwrap_or(0),
                                    ),
                                );
                            }
                            () = settle => {
                                if pending() {
                                    break Wait::Detach(
                                        crate::kernel::shared::DetachReason::Interrupted,
                                    );
                                }
                                // The level cleared inside the window: the
                                // wait keeps going under the normal arms.
                            }
                        }
                    }
                }
                tokio::select! {
                    biased;
                    settled = &mut result_rx => {
                        break Wait::Settled(Box::new(
                            settled.unwrap_or_else(|_| Err(anyhow!("Kernel has been shut down"))),
                        ));
                    }
                    () = awakened(wake_rx.as_mut()) => {
                        if wake_pending.is_none() {
                            break Wait::Detach(
                                crate::kernel::shared::DetachReason::Interrupted,
                            );
                        }
                        // With a level predicate, the loop top rechecks it
                        // (through the settle window).
                    }
                    () = budget() => {
                        break Wait::Detach(
                            crate::kernel::shared::DetachReason::WaitBudget(
                                cell_timeout_ms.unwrap_or(0),
                            ),
                        );
                    }
                }
            };
            match wait {
                Wait::Settled(settled) => *settled,
                Wait::Detach(reason) => {
                    // The call stops waiting; the cell does not. Its
                    // completion resolves through the same channel and
                    // goes to the background sink.
                    execution.detached.store(true, Ordering::SeqCst);
                    // The residency hold: from the caller's return until
                    // the terminal outcome is admitted, the cell is live
                    // background work the passivation gates must see.
                    let hold = self.inner.pending_detached_completions.acquire();
                    let (stdout, stderr) = {
                        let buffers = lock(&execution.buffers);
                        (
                            buffers.stdout.snapshot(max_chars),
                            buffers.stderr.snapshot(max_chars),
                        )
                    };
                    let cell_id = execution.request_id.clone();
                    let completion = execution.opts.on_background_cell.clone();
                    let detached_execution = Arc::clone(&execution);
                    let inner = Arc::downgrade(&self.inner);
                    tokio::spawn(async move {
                        // Every host-observed exit delivers exactly one
                        // terminal outcome: a normal settle, a forced stop,
                        // a teardown's reject, or a dropped channel (the
                        // manager died with its kernel) — never silence.
                        let settled: anyhow::Result<InternalExecuteResult> = match result_rx.await {
                            Ok(settled) => settled,
                            Err(_) => Err(anyhow!("Kernel has been shut down")),
                        };
                        let mut result = match settled {
                            Ok(settled) => settled.result,
                            Err(error) => {
                                // The kernel ended without settling the cell
                                // (teardown, crash, restart): the terminal
                                // outcome is an error naming the cause, with
                                // the cell's partial output retained.
                                let max_chars = detached_execution.max_chars;
                                let (stdout, stderr) = {
                                    let buffers = lock(&detached_execution.buffers);
                                    (
                                        buffers.stdout.snapshot(max_chars),
                                        buffers.stderr.snapshot(max_chars),
                                    )
                                };
                                ExecuteResult {
                                    stdout,
                                    stderr,
                                    result: None,
                                    diffs: None,
                                    attachments: None,
                                    sent_agent_messages: None,
                                    bash_commands: None,
                                    transcript_reads: None,
                                    inbox_messages: None,
                                    background_output: None,
                                    ended_turn: false,
                                    status: ExecuteStatus::Error,
                                    error: Some(crate::kernel::shared::KernelError {
                                        ename: "KernelShutdown".to_string(),
                                        evalue: format!("{error:#}"),
                                        traceback: Vec::new(),
                                    }),
                                    duration_ms: detached_execution.started.elapsed().as_millis()
                                        as u64,
                                    // The marker below stamps the detach on
                                    // every arm.
                                    detached: None,
                                }
                            }
                        };
                        if result.status == ExecuteStatus::Ok && result.detached.is_none() {
                            if let Some(inner) = inner.upgrade() {
                                inner.schedule_snapshot();
                            }
                        } else if let Some(inner) = inner.upgrade() {
                            // The capture this cell kept owed retries at its
                            // settle: any status (an error outcome can still
                            // have moved the namespace before it failed), but
                            // only with the kernel still alive.
                            if inner.snapshot_owed.swap(false, Ordering::SeqCst)
                                && inner.is_running_state()
                            {
                                inner.schedule_snapshot();
                            }
                        }
                        result.detached = Some(crate::kernel::shared::DetachedCell {
                            reason,
                            cell_id: detached_execution.request_id.clone(),
                        });
                        if let Some(callback) = completion {
                            callback(crate::kernel::shared::BackgroundCellOutcome {
                                cell_id: detached_execution.request_id.clone(),
                                reason,
                                result,
                            });
                        }
                        // The terminal outcome is admitted: drop the
                        // residency hold (exactly once), then fire the
                        // settled callback so owed continuations resume
                        // behind the queued notice.
                        drop(hold);
                        if let Some(inner) = inner.upgrade() {
                            inner.notify_background_work_settled();
                        }
                    });
                    Ok(InternalExecuteResult::detached(
                        started, reason, cell_id, stdout, stderr,
                    ))
                }
            }
        }
    }
}

/// What one cell wait resolved to: the cell's settlement, or a detach (the
/// call stops waiting; the cell keeps running).
enum Wait {
    Settled(Box<anyhow::Result<InternalExecuteResult>>),
    Detach(crate::kernel::shared::DetachReason),
}

/// Resolve when the optional wake receiver fires; never when absent.
async fn awakened(receiver: Option<&mut crate::kernel::cell_wake::CellWakeReceiver>) {
    match receiver {
        Some(receiver) => receiver.awakened().await,
        None => std::future::pending().await,
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

    /// The write ceiling: a wake that fires while the frame is still
    /// unwritten (the steer cannot detach a frame the kernel never
    /// received) starts a short ceiling; on expiry the execution stops
    /// with the typed cause, the watcher retires the kernel, and the
    /// early-settle arm retires the blocked writer and its stdin. The
    /// revert (no ceiling arm) hangs the call past the test's timeout.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_wake_caught_by_a_blocked_write_stops_the_cell_at_the_write_ceiling() {
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
        // A wake fires while the oversized frame is still unwritten: the
        // steer handoff cannot yield, so the write ceiling owns the stop.
        let wake = std::sync::Arc::new(crate::kernel::cell_wake::CellWake::new());
        {
            let wake = std::sync::Arc::clone(&wake);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                wake.request();
            });
        }
        // Larger than the stdin pipe: the request writer blocks on the
        // non-reading kernel, holding stdin's mutex.
        let code = "x".repeat(1024 * 1024);
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            manager.execute(
                &code,
                ExecuteOptions {
                    wake: Some(wake),
                    ..Default::default()
                },
            ),
        )
        .await
        .expect("the blocked write must settle at the write ceiling")
        .expect("execute returns a result");
        assert_eq!(result.status, ExecuteStatus::Aborted);
        let error = result
            .error
            .expect("the typed cause names the blocked write's retirement");
        assert_eq!(error.ename, "CellWriteCeilingRetired");
        assert!(
            manager.retired_for_ignored_interrupt(),
            "the stopped write retires the kernel"
        );
        assert!(
            manager.is_defunct(),
            "the retired kernel is terminal: only a fresh manager serves again"
        );
        manager.kill();
    }

    /// The debounced snapshot behind a detached cell stays owed and runs
    /// at the cell's settle, at any status: a successful cell A's capture
    /// must not stay dropped behind a detached cell B that ends in an
    /// error. The revert fails it — zero snapshot frames reach the kernel
    /// and the busy diagnostic logs — the probe evidence's shape.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_owed_snapshot_runs_when_a_detached_cell_settles_in_error() {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        const SNAPSHOT_COUNTING_KERNEL: &str = r#"#!/usr/bin/env python3
import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    rid = req.get("id")
    kind = req.get("type")
    if kind == "execute":
        if "slow" in line:
            time.sleep(7.0)
            print(json.dumps({"event": "done", "id": rid, "status": "error", "reason": "boom"}), flush=True)
        else:
            print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
    elif kind == "snapshot":
        with open(os.path.join(here, "snapshot-frames"), "a") as f:
            f.write("frame\n")
        print(json.dumps({"event": "done", "id": rid, "status": "ok", "saved": [], "skipped": [], "bytes": 0}), flush=True)
"#;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = dir.path().join("snapshot-counting-kernel");
        std::fs::write(&python, SNAPSHOT_COUNTING_KERNEL).expect("write fake kernel");
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake kernel");
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            snapshot: Some(crate::kernel::shared::KernelSnapshotConfig {
                path: dir.path().join("ns.dill"),
                manifest_path: dir.path().join("ns.json"),
                max_bytes: None,
                max_variable_bytes: None,
                debounce_ms: Some(800),
            }),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        // Cell A settles ok and schedules the debounced capture (800 ms).
        let a = manager
            .execute("fast", ExecuteOptions::default())
            .await
            .expect("cell A");
        assert_eq!(a.status, ExecuteStatus::Ok);
        // Cell B detaches at a 200 ms budget and settles in error at 7 s
        // — before the retry's own debounce fires again.
        let (outcomes, callback) = background_cell_outcomes();
        let b = manager
            .execute(
                "slow",
                ExecuteOptions {
                    cell_timeout_ms: Some(200),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
            .expect("cell B");
        assert!(b.detached.is_some(), "cell B must detach at its budget");
        // Past B's settle (7 s) plus the retry's own debounce (800 ms).
        tokio::time::sleep(Duration::from_millis(8_500)).await;
        let frames =
            std::fs::read_to_string(dir.path().join("snapshot-frames")).unwrap_or_default();
        assert!(
            frames.lines().count() >= 1,
            "the owed snapshot must run at the detached cell's settle: frames={frames:?}"
        );
        let outcomes = outcomes.lock().unwrap();
        let [outcome] = outcomes.as_slice() else {
            panic!("cell B's terminal outcome must deliver: {outcomes:?}");
        };
        assert_eq!(outcome.result.status, ExecuteStatus::Error);
        assert!(
            !manager
                .kernel_stderr()
                .contains(crate::kernel::shared::KERNEL_BUSY_BACKGROUND_CELL_MESSAGE),
            "the owed capture must not burn the busy window behind the cell"
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

    /// A cooperative kernel: an interrupt settles the running cell at once
    /// (the real runtime's `KeyboardInterrupt`), and a plain cell runs
    /// `3s` — past the stop watcher's `1s` grace window.
    #[cfg(unix)]
    fn cooperative_kernel(dir: &std::path::Path) -> std::path::PathBuf {
        const COOPERATIVE_KERNEL: &str = r#"#!/usr/bin/env python3
import json, os, queue, sys, threading, time
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
cells = queue.Queue()
def reader():
    # The real runtime's shape: stdin parses on a daemon thread, so the
    # interrupt lands MID-CELL and settles it (a caught KeyboardInterrupt).
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get("type") == "interrupt":
            if running and running[0]:
                rid = running[0]
                running[0] = None
                print(json.dumps({"event": "stdout", "id": rid, "text": "interrupted\n"}), flush=True)
                print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
        elif req.get("type") == "execute":
            cells.put(req)
    cells.put(None)
running = []
threading.Thread(target=reader, daemon=True).start()
while True:
    req = cells.get()
    if req is None:
        break
    rid = req.get("id")
    running.append(rid)
    print(json.dumps({"event": "stdout", "id": rid, "text": "starting\n"}), flush=True)
    time.sleep(3.0)
    if running.pop() == rid:
        print(json.dumps({"event": "stdout", "id": rid, "text": "finished\n"}), flush=True)
        print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
"#;
        let python = dir.join("cooperative-kernel");
        std::fs::write(&python, COOPERATIVE_KERNEL).expect("write fake kernel");
        std::fs::set_permissions(&python, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .expect("chmod fake kernel");
        python
    }

    /// A kernel whose cells answer at once: the settle-window pin's quick
    /// cell (a result well inside [`KERNEL_LEVEL_WAKE_SETTLE_MS`]).
    fn quick_cell_kernel(dir: &std::path::Path) -> std::path::PathBuf {
        let python = dir.join("quick-cell-kernel");
        std::fs::write(
            &python,
            r#"#!/usr/bin/env python3
import json, sys
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("type") == "execute":
        rid = req.get("id")
        print(json.dumps({"event": "stdout", "id": rid, "text": "quick answer\n"}), flush=True)
        print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
"#,
        )
        .expect("write fake kernel");
        std::fs::set_permissions(&python, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .expect("chmod fake kernel");
        python
    }

    /// The fake kernel behind the detach tests: ready, then every execute
    /// streams a start line, sleeps a second, streams its finish line, and
    /// settles. Interrupt frames are counted in a sidecar file so a test can
    /// prove a detached cell was never signalled.
    #[cfg(unix)]
    fn background_cell_kernel(dir: &std::path::Path) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let python = dir.join("background-cell-kernel");
        std::fs::write(
            &python,
            r#"#!/usr/bin/env python3
import json, os, sys, time
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("type") == "interrupt":
        with open(os.path.abspath(__file__) + ".interrupts", "a") as fh:
            fh.write("x")
        continue
    if req.get("type") == "execute":
        rid = req.get("id")
        print(json.dumps({"event": "stdout", "id": rid, "text": "starting\n"}), flush=True)
        time.sleep(1.0)
        print(json.dumps({"event": "stdout", "id": rid, "text": "finished\n"}), flush=True)
        print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
"#,
        )
        .expect("write fake kernel");
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake kernel");
        python
    }

    #[cfg(unix)]
    fn background_cell_outcomes() -> (
        std::sync::Arc<std::sync::Mutex<Vec<crate::kernel::shared::BackgroundCellOutcome>>>,
        crate::kernel::shared::BackgroundCellCallback,
    ) {
        use std::sync::Arc;
        let outcomes: Arc<std::sync::Mutex<Vec<crate::kernel::shared::BackgroundCellOutcome>>> =
            Arc::default();
        let sink = Arc::clone(&outcomes);
        let callback: crate::kernel::shared::BackgroundCellCallback =
            Arc::new(move |outcome| sink.lock().unwrap().push(outcome));
        (outcomes, callback)
    }

    /// A wake lands mid-cell: the call returns early with the partial output
    /// and a detach marker, the cell is never signalled, and its completion
    /// arrives through the background sink with the full output.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_wake_returns_early_and_the_cell_completes_in_background() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python.clone()),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let wake = Arc::new(crate::kernel::cell_wake::CellWake::new());
        let (outcomes, callback) = background_cell_outcomes();
        let runner = manager.clone();
        let wake_for_call = Arc::clone(&wake);
        let call = tokio::spawn(async move {
            runner
                .execute(
                    "cell",
                    ExecuteOptions {
                        wake: Some(wake_for_call),
                        on_background_cell: Some(callback),
                        ..Default::default()
                    },
                )
                .await
        });
        // The wake lands mid-cell (the fake kernel sleeps a second after its
        // start line).
        tokio::time::sleep(Duration::from_millis(250)).await;
        wake.request();
        let result = tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .expect("the detached call returns early")
            .expect("the call task joins")
            .expect("the execute settles");
        let detached = result.detached.as_ref().expect("detach marker");
        assert_eq!(
            detached.reason,
            crate::kernel::shared::DetachReason::Interrupted
        );
        assert!(
            result.stdout.contains("starting"),
            "the partial output rides the early return: {result:?}"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(outcome) = outcomes.lock().unwrap().pop() {
                assert_eq!(
                    outcome.reason,
                    crate::kernel::shared::DetachReason::Interrupted
                );
                assert_eq!(outcome.cell_id, detached.cell_id);
                assert!(
                    outcome.result.stdout.contains("finished"),
                    "the late completion carries the full output: {outcome:?}"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the background completion never fired"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            !python.with_extension("interrupts").exists(),
            "the detached cell must never be signalled"
        );
        manager.kill();
    }

    /// The wait budget backgrounds the cell instead of interrupting it: the
    /// call returns early with the budget reason, the cell settles ok, and the
    /// reuse wait drains quietly without ever signalling it.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_wait_budget_backgrounds_instead_of_interrupting() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python.clone()),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let (outcomes, callback) = background_cell_outcomes();
        let result = manager
            .execute(
                "cell",
                ExecuteOptions {
                    cell_timeout_ms: Some(200),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
            .expect("the bounded call settles");
        let detached = result.detached.as_ref().expect("detach marker");
        assert_eq!(
            detached.reason,
            crate::kernel::shared::DetachReason::WaitBudget(200)
        );
        assert!(
            result.stdout.contains("starting"),
            "the partial output rides the early return: {result:?}"
        );
        // The reuse wait (a later cell's contention path) drains once the
        // background cell settles, and it never interrupts a detached cell.
        let runner = manager.clone();
        let drained = tokio::time::timeout(
            Duration::from_secs(6),
            runner.wait_for_active_execution_to_clear_for_reuse(None),
        )
        .await
        .expect("the reuse wait settles");
        drained.expect("a detached cell is waited out, not interrupted");
        let outcome = outcomes.lock().unwrap().pop().expect("completion fired");
        assert!(
            outcome.result.stdout.contains("finished"),
            "the cell completed in the background: {outcome:?}"
        );
        assert!(
            !python.with_extension("interrupts").exists(),
            "no interrupt may be sent to a backgrounded cell"
        );
        manager.kill();
    }

    /// A cell that settles inside its budget never detaches: the normal
    /// result rides the call and the background sink stays empty.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cell_inside_its_budget_never_detaches() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let (outcomes, callback) = background_cell_outcomes();
        let result = manager
            .execute(
                "cell",
                ExecuteOptions {
                    cell_timeout_ms: Some(5_000),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
            .expect("the cell settles");
        assert!(
            result.detached.is_none(),
            "no detach inside the budget: {result:?}"
        );
        assert!(result.stdout.contains("finished"));
        assert!(outcomes.lock().unwrap().is_empty(), "no completion fires");
        manager.kill();
    }

    /// The fake kernel behind the stop tests: an execute cell that hangs
    /// forever and IGNORES interrupts (they are only counted), so the
    /// stop watcher's grace expires and the kernel must be retired.
    #[cfg(unix)]
    fn runaway_cell_kernel(dir: &std::path::Path) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let python = dir.join("runaway-cell-kernel");
        std::fs::write(
            &python,
            r#"#!/usr/bin/env python3
import json, os, queue, sys, threading, time
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
cells = queue.Queue()
def reader():
    # The real runtime's shape: stdin is parsed on a daemon thread, so an
    # interrupt frame lands MID-CELL. This kernel ignores it (the marks
    # file proves it arrived) and the cell runs on.
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get("type") == "interrupt":
            with open(os.path.abspath(__file__) + ".interrupts", "a") as fh:
                fh.write("x")
        elif req.get("type") == "execute":
            cells.put(req)
    cells.put(None)
threading.Thread(target=reader, daemon=True).start()
while True:
    req = cells.get()
    if req is None:
        break
    rid = req.get("id")
    print(json.dumps({"event": "stdout", "id": rid, "text": "starting\n"}), flush=True)
    while True:
        time.sleep(0.1)
"#,
        )
        .expect("write fake kernel");
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake kernel");
        python
    }

    /// A user cancel retires a cell that ignores its interrupt (attached
    /// or detached alike): the aborted result names the kernel retirement
    /// and the possible state loss, the interrupt was really sent, and the
    /// manager is defunct (a fresh manager serves the next cell).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_user_cancel_retires_an_attached_ignoring_cell() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = runaway_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python.clone()),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let started = Instant::now();
        let executing = manager.execute("hang", ExecuteOptions::default());
        tokio::pin!(executing);
        // The user cancel fires while the attached cell runs (the Esc
        // path): a cell that ignores the interrupt is retired.
        let cancel_manager = manager.clone();
        let cancel = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel_manager.abort_user_execution()
        });
        let result = tokio::time::timeout(Duration::from_secs(6), &mut executing)
            .await
            .expect("the cancelled call settles")
            .expect("the execute returns");
        assert!(cancel.await.unwrap_or(false), "a user execution was live");
        assert_eq!(result.status, ExecuteStatus::Aborted, "{result:?}");
        let error = result.error.as_ref().expect("the retirement error");
        assert_eq!(error.ename, "CellUserCancelRetired", "{result:?}");
        assert!(error.evalue.contains("kernel was retired"), "{result:?}");
        assert!(error.evalue.contains("unsnapshotted state"), "{result:?}");
        // The interrupt really reached the kernel before the retirement.
        assert!(
            std::fs::read_to_string(python.with_extension("interrupts"))
                .is_ok_and(|marks| !marks.is_empty()),
            "the cancelled cell was interrupted before its kernel was retired"
        );
        assert!(manager.is_defunct(), "the ignoring cell's kernel retired");
        assert!(
            manager.retired_for_ignored_interrupt(),
            "the retirement is observable for the restart note"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the stop is bounded: {:?}",
            started.elapsed()
        );
    }

    /// A manager-targeted user cancel reaches a DETACHED cell: the
    /// backgrounded execution is interrupted, and its ignored interrupt
    /// retires the kernel; the continuation delivers the aborted outcome.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_user_cancel_stops_a_detached_cell() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = runaway_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python.clone()),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let (outcomes, callback) = background_cell_outcomes();
        let result = manager
            .execute(
                "hang",
                ExecuteOptions {
                    cell_timeout_ms: Some(200),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
            .expect("the bounded call detaches");
        let detached = result.detached.as_ref().expect("detach marker");
        assert_eq!(
            detached.reason,
            crate::kernel::shared::DetachReason::WaitBudget(200)
        );
        // The run is gone; only the manager-targeted cancel can reach the cell.
        assert!(manager.abort_user_execution(), "a user execution is live");
        let deadline = Instant::now() + Duration::from_secs(5);
        let outcome = loop {
            if let Some(outcome) = outcomes.lock().unwrap().pop() {
                break outcome;
            }
            assert!(
                Instant::now() < deadline,
                "the cancel never delivered a terminal outcome"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(outcome.cell_id, detached.cell_id, "{outcome:?}");
        assert_eq!(outcome.reason, detached.reason, "{outcome:?}");
        assert_eq!(outcome.result.status, ExecuteStatus::Aborted, "{outcome:?}");
        assert!(manager.is_defunct(), "the ignoring cell's kernel retired");
        assert!(
            std::fs::read_to_string(python.with_extension("interrupts"))
                .is_ok_and(|marks| !marks.is_empty()),
            "the cancel really interrupted the detached cell"
        );
    }

    /// The scoped idle cancel targets only a detached execution: an
    /// attached cell is untouched by `abort_detached_execution`.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_scoped_cancel_skips_an_attached_cell() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python.clone()),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let attached = manager
            .execute(
                "cell",
                ExecuteOptions {
                    on_background_cell: Some(background_cell_outcomes().1),
                    ..Default::default()
                },
            )
            .await
            .expect("the attached call waits for its cell");
        assert!(attached.detached.is_none());
        assert!(
            !manager.abort_detached_execution(),
            "no detached execution is running"
        );
        assert!(
            !python.with_extension("interrupts").exists(),
            "the scoped cancel never signalled the attached cell"
        );
        assert!(!manager.is_defunct());
        manager.kill();
    }

    /// Every host-observed exit reports once: a teardown after the detach
    /// (kernel killed under the cell) delivers one terminal error outcome
    /// with the cell's identity and partial output — never silence.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_teardown_after_the_detach_reports_the_terminal_error() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let (outcomes, callback) = background_cell_outcomes();
        let result = manager
            .execute(
                "cell",
                ExecuteOptions {
                    cell_timeout_ms: Some(200),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
            .expect("the bounded call detaches");
        let detached = result.detached.as_ref().expect("detach marker");
        manager.kill();
        let deadline = Instant::now() + Duration::from_secs(5);
        let outcome = loop {
            if let Some(outcome) = outcomes.lock().unwrap().pop() {
                break outcome;
            }
            assert!(
                Instant::now() < deadline,
                "the teardown never delivered a terminal outcome"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(outcome.cell_id, detached.cell_id, "{outcome:?}");
        assert_eq!(outcome.result.status, ExecuteStatus::Error, "{outcome:?}");
        let error = outcome.result.error.as_ref().expect("the terminal error");
        assert!(!error.evalue.is_empty(), "the outcome names its cause");
        assert!(
            outcome.result.stdout.contains("starting"),
            "the partial output rides the terminal outcome: {outcome:?}"
        );
    }

    /// A stop that outlives its own execution cannot reach the next
    /// cell: the user cancel fires a detached cell's watcher, the cell
    /// settles cooperatively on the interrupt, a fresh cell starts, and
    /// the watcher's post-grace re-check (the execution match) must find
    /// its execution gone — the retirement never touches the fresh cell.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stale_stop_cannot_reach_the_next_cell() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = cooperative_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        // The first cell detaches at its 200 ms wait budget and keeps running.
        let (outcomes, callback) = background_cell_outcomes();
        let result = manager
            .execute(
                "cell",
                ExecuteOptions {
                    cell_timeout_ms: Some(200),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
            .expect("the bounded call detaches");
        assert!(result.detached.is_some(), "{result:?}");
        // The user cancel fires the detached cell's stop watcher: the
        // interrupt goes out, and the watcher waits out its grace.
        assert!(manager.abort_user_execution());
        // The detached cell settles cooperatively on the interrupt; its
        // terminal outcome (a user stop aborts) admits quickly.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(outcome) = outcomes.lock().unwrap().pop() {
                assert_eq!(
                    outcome.result.status,
                    ExecuteStatus::Aborted,
                    "a user stop aborts: {outcome:?}"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the cancelled cell never settled on its interrupt"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // A fresh cell starts well inside the old watcher's grace window
        // and runs past its expiry: the stale stop must not reach it.
        let second = tokio::time::timeout(
            Duration::from_secs(8),
            manager.execute(
                "cell",
                ExecuteOptions {
                    ..Default::default()
                },
            ),
        )
        .await
        .expect("the second cell settles")
        .expect("the second execute returns");
        assert!(second.detached.is_none(), "{second:?}");
        assert!(
            second.stdout.contains("finished"),
            "the second cell completed on its own generation: {second:?}"
        );
        assert!(!manager.is_defunct(), "a stale stop retired the kernel");
        manager.kill();
    }

    /// A wake whose level is already pending ends the wait at once: the
    /// predicate consults the live queue, so an arrival that landed while
    /// the model was still streaming the tool call cannot be lost to the
    /// subscription.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_pending_wake_before_the_wait_detaches_immediately() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        // The arrival lands before the call (the model is still streaming).
        let pending = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let pending_wake = Arc::clone(&pending);
        let wake = Arc::new(crate::kernel::cell_wake::CellWake::with_pending(
            std::sync::Arc::new(move || pending_wake.load(Ordering::SeqCst)),
        ));
        let (outcomes, callback) = background_cell_outcomes();
        let started = Instant::now();
        let result = manager
            .execute(
                "cell",
                ExecuteOptions {
                    wake: Some(Arc::clone(&wake)),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
            .expect("the call detaches");
        let detached = result.detached.as_ref().expect("detach marker");
        assert_eq!(
            detached.reason,
            crate::kernel::shared::DetachReason::Interrupted
        );
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "the retained wake detached the wait at once: {:?}",
            started.elapsed()
        );
        // The arrival was consumed while the cell ran: the level is false
        // now, and the completion still arrives through the sink.
        pending.store(false, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if outcomes.lock().unwrap().pop().is_some() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the background completion never fired"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        manager.kill();
    }

    /// A wake notification whose input was consumed or cleared does not
    /// detach a later cell: the level predicate rechecks the queue after
    /// every notification.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cleared_wake_does_not_detach_a_later_cell() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let pending = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pending_wake = Arc::clone(&pending);
        let wake = Arc::new(crate::kernel::cell_wake::CellWake::with_pending(
            std::sync::Arc::new(move || pending_wake.load(Ordering::SeqCst)),
        ));
        // A stale request fires with the level false: the notification must
        // be rechecked, not obeyed.
        wake.request();
        let result = manager
            .execute(
                "cell",
                ExecuteOptions {
                    wake: Some(Arc::clone(&wake)),
                    on_background_cell: Some(background_cell_outcomes().1),
                    ..Default::default()
                },
            )
            .await
            .expect("the call settles");
        assert!(
            result.detached.is_none(),
            "a cleared wake never detaches a later cell: {result:?}"
        );
        manager.kill();
    }

    /// The ignored-interrupt retirement claims its execution atomically:
    /// a watcher whose cell settled and whose replacement started before
    /// the grace expired retires NOTHING — the replacement cell keeps its
    /// kernel (the claim refuses, so no teardown, kill, or reject reaches
    /// the replacement).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stale_retirement_never_touches_the_replacement_cell() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = cooperative_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        // The first cell runs; capture ITS execution while it is the
        // active one, then cancel it — it settles on the interrupt, while
        // its watcher keeps running out its grace.
        let _first = {
            let manager = manager.clone();
            tokio::spawn(async move {
                let _ = manager.execute("cell", ExecuteOptions::default()).await;
            })
        };
        let stale = loop {
            let active = lock(&manager.inner.guarded).active_execution.clone();
            if let Some(active) = active {
                break active;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(manager.abort_user_execution(), "the first cell is live");
        // The first cell settled on its interrupt; admit the replacement
        // INSIDE the old watcher's grace window (the watcher is still
        // running out its 1s).
        let (outcomes, callback) = background_cell_outcomes();
        let second = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .execute(
                        "cell",
                        ExecuteOptions {
                            on_background_cell: Some(callback),
                            ..Default::default()
                        },
                    )
                    .await
            })
        };
        // Wait for the replacement's admission INSIDE the stale watcher's
        // grace window (the watcher is still running out its 1s).
        loop {
            let active = lock(&manager.inner.guarded).active_execution.clone();
            // The first cell's execution may still be draining; the
            // replacement is the fresh one that follows it.
            if active.is_some_and(|active| !std::sync::Arc::ptr_eq(&active, &stale)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // The stale watcher's grace expires with the replacement live:
        // the atomic claim refuses, so the kernel survives and the
        // replacement completes on its own generation.
        tokio::time::sleep(Duration::from_millis(1_400)).await;
        assert!(
            !manager.is_defunct(),
            "the stale retirement must not claim the manager terminal"
        );
        let second = tokio::time::timeout(Duration::from_secs(6), second)
            .await
            .expect("the replacement settles")
            .expect("the second execute returns")
            .expect("the replacement completed");
        assert!(
            second.stdout.contains("finished"),
            "the replacement cell completed on its own generation: {second:?}"
        );
        assert!(outcomes.lock().unwrap().is_empty());
        manager.kill();
    }

    /// A quick cell answers its own tool result even when the wake level
    /// was already pending at the write: the settle window lets the
    /// result win, so the model never pays a completion-notice turn for
    /// work that was about to finish.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_quick_cell_answers_inline_under_a_pending_level() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = quick_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        // The level reads pending for the whole wait (a user steer that
        // landed while the tool call streamed).
        let wake = Arc::new(crate::kernel::cell_wake::CellWake::with_pending(Arc::new(
            || true,
        )));
        let (outcomes, callback) = background_cell_outcomes();
        let result = manager
            .execute(
                "cell",
                ExecuteOptions {
                    wake: Some(wake),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
            .expect("the quick call returns");
        assert!(
            result.detached.is_none(),
            "the quick cell answered inline under the pending level: {result:?}"
        );
        assert!(
            result.stdout.contains("quick answer"),
            "the inline answer keeps its own output: {result:?}"
        );
        assert!(
            outcomes.lock().unwrap().is_empty(),
            "no completion notice ever fired"
        );
        manager.kill();
    }

    /// The wait budget's deadline is absolute from the write: a budget
    /// that elapses while the frame is still being written detaches the
    /// call the moment the complete frame lands, instead of being lost.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_budget_survives_a_slow_frame_write() {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        // Ready, then idles until the go file appears (the write blocks on a
        // full pipe), then reads and settles every execute in ~0.4s.
        const SLOW_READER: &str = r#"#!/usr/bin/env python3
import json, os, sys, time
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
        rid = req.get("id")
        time.sleep(0.4)
        print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
"#;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = dir.path().join("slow-reader-kernel");
        std::fs::write(&python, SLOW_READER).expect("write fake kernel");
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
        let (_outcomes, callback) = background_cell_outcomes();
        let call = {
            let manager = manager.clone();
            let callback = callback;
            tokio::spawn(async move {
                manager
                    .execute(
                        &"x".repeat(256 * 1024),
                        ExecuteOptions {
                            cell_timeout_ms: Some(150),
                            on_background_cell: Some(callback),
                            ..Default::default()
                        },
                    )
                    .await
            })
        };
        // The write blocks on the full pipe past the 150ms budget...
        tokio::time::sleep(Duration::from_millis(400)).await;
        std::fs::write(dir.path().join("go"), b"").expect("write go file");
        let result = tokio::time::timeout(Duration::from_secs(4), call)
            .await
            .expect("the call returns once the frame lands")
            .expect("the call task joins")
            .expect("the execute settles");
        let detached = result.detached.as_ref().expect("detach marker");
        assert_eq!(
            detached.reason,
            crate::kernel::shared::DetachReason::WaitBudget(150),
            "the elapsed budget detached the call after the write: {result:?}"
        );
        manager.kill();
    }

    /// The residency test's admission latch: the drop guard releases the
    /// latch on unwind, so an assertion that fires while the callback parks
    /// does not strand the runtime worker at teardown (a red pin stays a
    /// clean assertion failure, never a timeout kill).
    struct ReleaseAdmission(std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>);
    impl Drop for ReleaseAdmission {
        fn drop(&mut self) {
            let (go, notified) = &*self.0;
            *go.lock().expect("admission lock") = true;
            notified.notify_all();
        }
    }

    /// The residency hold: a detached cell counts as live background work
    /// until its terminal outcome is admitted (the sink call returns), and
    /// the teardown's error arm releases it too.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_detached_cell_holds_residency_until_admission() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        // A sink that blocks inside the callback: physical done arrived, but
        // the terminal admission is held. The callback is synchronous and
        // blocks one runtime worker, so the test waits on std primitives —
        // its own waits never depend on the blocked worker's timers.
        // The admission latch with its panic-safe drop guard (the module
        // level `ReleaseAdmission`): an assertion that fires while the
        // callback parks on the latch would strand that runtime worker and
        // hang the test's teardown, turning a red pin into a timeout
        // kill — the guard releases the latch on unwind, so every failing
        // path stays a clean assertion failure.
        let admission =
            std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let _release = ReleaseAdmission(Arc::clone(&admission));
        let hold_seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let callback: crate::kernel::shared::BackgroundCellCallback = {
            let admission = Arc::clone(&admission);
            let hold_seen = Arc::clone(&hold_seen);
            Arc::new(move |_outcome| {
                hold_seen.store(1, Ordering::SeqCst);
                let (go, notified) = &*admission;
                let mut go = go.lock().expect("admission lock");
                while !*go {
                    go = notified.wait(go).expect("admission wait");
                }
            })
        };
        let result = manager
            .execute(
                "cell",
                ExecuteOptions {
                    cell_timeout_ms: Some(200),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
            .expect("the bounded call detaches");
        assert!(result.detached.is_some());
        // While the admission is held (the physical done already arrived,
        // the sink has not returned), the cell still counts as live work.
        let called = Instant::now() + Duration::from_secs(5);
        while hold_seen.load(Ordering::SeqCst) == 0 {
            assert!(Instant::now() < called, "the sink was never called");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            manager.has_background_work(),
            "a cell whose outcome is unadmitted stays live background work"
        );
        assert_eq!(manager.pending_detached_completions(), 1);
        // Release the admission: the hold releases, the aggregate clears.
        {
            let (go, notified) = &*admission;
            *go.lock().expect("admission lock") = true;
            notified.notify_all();
        }
        let cleared = Instant::now() + Duration::from_secs(5);
        while manager.pending_detached_completions() > 0 {
            assert!(Instant::now() < cleared, "the hold never released");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(manager.background_bash_handle_count(), 0);
        assert!(!manager.has_background_work());
        manager.kill();
    }

    /// A settled execution releases its stop watchers: the terminal watch
    /// ends the watcher task, so the settled execution's channel loses its
    /// last receiver (a watcher that never exits is one leaked task per
    /// successful cell).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_settled_execution_releases_its_stop_watcher() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let call = {
            let manager = manager.clone();
            tokio::spawn(async move { manager.execute("cell", ExecuteOptions::default()).await })
        };
        // Capture the running execution: its watcher holds a terminal-watch
        // receiver while the cell runs.
        let execution = loop {
            let active = lock(&manager.inner.guarded).active_execution.clone();
            if let Some(active) = active {
                break active;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if execution.settled_tx.receiver_count() > 0 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the running cell's watcher never subscribed to the terminal watch"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let settled = tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .expect("the cell settles")
            .expect("the task joins")
            .expect("the execute returns");
        assert!(settled.detached.is_none(), "{settled:?}");
        // The watcher exits on the settle: the terminal watch loses its last
        // receiver. A watcher that awaits the never-fired stop signal instead
        // keeps it forever.
        loop {
            if execution.settled_tx.receiver_count() == 0 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the settled execution's watcher never exited"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        manager.kill();
    }

    /// A panic inside the background completion sink still releases the
    /// residency hold: the drop guard refunds the session-wide count, so
    /// later cells' residency gates are not blocked forever.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_panicking_sink_still_releases_the_residency_hold() {
        use super::*;
        let dir = tempfile::TempDir::new().expect("temp dir");
        let python = background_cell_kernel(dir.path());
        let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
            python: Some(python),
            ..Default::default()
        });
        manager
            .start(KernelStartOptions::default())
            .await
            .expect("ready handshake");
        let panicking: std::sync::Arc<
            dyn Fn(crate::kernel::shared::BackgroundCellOutcome) + Send + Sync,
        > = std::sync::Arc::new(|_outcome| panic!("the sink breaks"));
        let result = manager
            .execute(
                "cell",
                ExecuteOptions {
                    cell_timeout_ms: Some(200),
                    on_background_cell: Some(panicking),
                    ..Default::default()
                },
            )
            .await
            .expect("the bounded call detaches");
        assert!(result.detached.is_some(), "{result:?}");
        assert_eq!(
            manager.pending_detached_completions(),
            1,
            "the hold is live while the terminal outcome pends"
        );
        // The cell finishes; the spawned continuation panics inside the
        // sink. The unwound task still drops the hold: the count returns to
        // zero, so a later cell's gates read a clean lane.
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            if manager.pending_detached_completions() == 0 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the panicking sink stranded the residency hold"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        manager.kill();
    }
}
