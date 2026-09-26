//! Event dispatch: kernel protocol events routed to streams, display updates,
//! and background output buffers.

use super::*;
use std::fmt::Write as _;

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

impl Inner {
    pub(crate) fn handle_event(self: &Arc<Self>, event: Event) {
        match event {
            Event::Display { id, ref data } => {
                if let Some(activity) = data.get(BASH_ACTIVITY_DISPLAY_MIME) {
                    let Some(obj) = activity.as_object() else {
                        return;
                    };
                    let activity_id = obj.get("id").and_then(Value::as_str).unwrap_or_default();
                    let pid = obj.get("pid").and_then(Value::as_i64).unwrap_or_default();
                    let active = obj.get("active").and_then(Value::as_bool);
                    if activity_id.len() == 32
                        && activity_id.chars().all(|c| c.is_ascii_hexdigit())
                        && pid > 0
                        && matches!(active, Some(true | false))
                    {
                        let mut settled = false;
                        {
                            let mut g = lock(&self.guarded);
                            if active == Some(true) {
                                g.background_bash_handles
                                    .entry(activity_id.to_string())
                                    .or_insert(pid as i32);
                            } else if g.background_bash_handles.get(activity_id)
                                == Some(&(pid as i32))
                            {
                                g.background_bash_handles.remove(activity_id);
                                // The last live handle settled: the completion
                                // notice for it is already admitted, so owed
                                // continuations may resume. The settlement is
                                // recorded on the map before the callback runs.
                                settled = g.background_bash_handles.is_empty();
                            }
                        }
                        if settled {
                            self.notify_background_work_settled();
                        }
                    }
                    return;
                }
                self.dispatch_display(id.as_deref(), data);
            }
            Event::Ready { protocol } => {
                if let Some(tx) = lock(&self.guarded).ready_tx.take() {
                    let _ = tx.send(Ok(protocol));
                }
            }
            Event::HostRequest { id, data } => self.start_host_request(&id, data),
            Event::Stdout { id, text } => {
                self.route_stream(id.as_deref(), StreamName::Stdout, &text);
            }
            Event::Stderr { id, text } => {
                self.route_stream(id.as_deref(), StreamName::Stderr, &text);
            }
            Event::Result { id, text } => {
                let execution = lock(&self.guarded).active_execution.clone();
                if let Some(execution) = execution.filter(|e| e.request_id == id) {
                    lock(&execution.buffers).result = Some(text);
                }
            }
            Event::Error {
                id,
                ename,
                evalue,
                traceback,
            } => {
                let execution = lock(&self.guarded).active_execution.clone();
                match (execution.filter(|e| Some(&e.request_id) == id.as_ref()), id) {
                    (Some(execution), _) => {
                        let mut buffers = lock(&execution.buffers);
                        buffers.error = Some(KernelError {
                            ename,
                            evalue,
                            traceback,
                        });
                        buffers.status = ExecuteStatus::Error;
                    }
                    (None, None) => {
                        // A protocol-level error without a cell id is runtime noise.
                        self.append_diagnostic(&format!("protocol error: {evalue}"));
                    }
                    (None, Some(_)) => {}
                }
            }
            Event::Done { id, fields } => {
                if let Some(waiter) = lock(&self.guarded).bash_activity_waiters.remove(&id) {
                    let _ = waiter.send(fields);
                    return;
                }
                let status = fields
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("error");
                let execution = lock(&self.guarded).active_execution.clone();
                if let Some(execution) = execution.filter(|e| e.request_id == id) {
                    {
                        let mut buffers = lock(&execution.buffers);
                        buffers.done_fields = Some(fields.clone());
                        if status != "ok" && buffers.status == ExecuteStatus::Ok {
                            buffers.status = ExecuteStatus::Error;
                            // State requests report failures as a done reason
                            // without an error event.
                            if buffers.error.is_none() {
                                if let Some(reason) = fields.get("reason").and_then(Value::as_str) {
                                    buffers.error = Some(KernelError {
                                        ename: "KernelError".to_string(),
                                        evalue: reason.to_string(),
                                        traceback: Vec::new(),
                                    });
                                }
                            }
                        }
                    }
                    self.finish_active_execution(&execution);
                    return;
                }
                // A done outside the active execution settles its waiter.
                let waiter = lock(&self.guarded).pending_done_waiters.remove(&id);
                if let Some(tx) = waiter {
                    let _ = tx.send(());
                }
            }
        }
    }

    /// stdout/stderr events: attributed to the active execution when the id
    /// matches, otherwise buffered as background output.
    fn route_stream(&self, id: Option<&str>, stream: StreamName, text: &str) {
        let execution = lock(&self.guarded).active_execution.clone();
        let Some(execution) = execution.filter(|e| Some(e.request_id.as_str()) == id) else {
            // Unowned output (null id, or another cell's id): never merge it
            // into the active cell's streams; buffer it as background output.
            self.append_background_output(text);
            return;
        };
        let mut buffers = lock(&execution.buffers);
        let ExecBuffers {
            stdout,
            stdout_chars,
            stdout_truncated,
            stderr,
            stderr_chars,
            stderr_truncated,
            ..
        } = &mut *buffers;
        match stream {
            StreamName::Stdout => append_truncated(
                stdout,
                stdout_truncated,
                stdout_chars,
                text,
                execution.max_chars,
            ),
            StreamName::Stderr => append_truncated(
                stderr,
                stderr_truncated,
                stderr_chars,
                text,
                execution.max_chars,
            ),
        }
        drop(buffers);
        if let Some(on_stream) = &execution.opts.on_stream {
            on_stream(text, stream);
        }
    }

    /// display events: diffs, attachments, sent agent messages, late or live.
    fn dispatch_display(&self, id: Option<&str>, data: &Value) {
        let execution = lock(&self.guarded).active_execution.clone();
        let matching = execution
            .as_ref()
            .filter(|e| Some(e.request_id.as_str()) == id);
        // A settled cell keeps receiving late agent messages via its handler.
        if matching.is_none() {
            if self.dispatch_late_sent_agent_message(id, data) {
                return;
            }
            return;
        }
        let execution = matching.expect("filter guarantees presence").clone();
        let settled = lock(&execution.buffers).settled;
        if settled && self.dispatch_late_sent_agent_message(id, data) {
            return;
        }
        let mut buffers = lock(&execution.buffers);
        if let Some(payload) = data.get(DIFF_DISPLAY_MIME) {
            if let Some(diff) = parse_diff_display(payload) {
                buffers.diffs.push(diff);
            }
        }
        match data
            .get(ATTACHMENT_DISPLAY_MIME)
            .and_then(parse_attachment_display)
        {
            Some(Err(_)) => {
                buffers.attachment_oversized = true;
                if !buffers.stderr.is_empty() {
                    buffers.stderr.push('\n');
                }
                let _ = write!(
                    buffers.stderr,
                    "attachment dropped: exceeds {MAX_ATTACHMENT_DATA_CHARS} base64 chars"
                );
                buffers.stderr_chars = buffers.stderr.chars().count();
                buffers.status = ExecuteStatus::Error;
            }
            Some(Ok(attachment)) => buffers.attachments.push(attachment),
            None => {}
        }
        if let Some(payload) = data.get(AGENT_MESSAGE_DISPLAY_MIME) {
            if let Some(message) = parse_sent_agent_message(payload) {
                buffers.sent_agent_messages.push(message);
            }
        }
    }

    /// Unattributed stream text: attached to the active cell's background
    /// buffer, or held for the next cell when the kernel is idle.
    fn append_background_output(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        let execution = lock(&self.guarded).active_execution.clone();
        if let Some(execution) = execution {
            let mut buffers = lock(&execution.buffers);
            if buffers.background_output_chars >= MAX_BACKGROUND_OUTPUT_CHARS {
                buffers.background_output_truncated = true;
                return;
            }
            let ExecBuffers {
                background_output,
                background_output_truncated,
                background_output_chars,
                ..
            } = &mut *buffers;
            append_truncated(
                background_output,
                background_output_truncated,
                background_output_chars,
                text,
                MAX_BACKGROUND_OUTPUT_CHARS,
            );
            return;
        }
        let mut g = lock(&self.guarded);
        if g.pending_background_output_chars >= MAX_BACKGROUND_OUTPUT_CHARS {
            g.pending_background_output_truncated = true;
            return;
        }
        let Guarded {
            pending_background_output,
            pending_background_output_truncated,
            pending_background_output_chars,
            ..
        } = &mut *g;
        append_truncated(
            pending_background_output,
            pending_background_output_truncated,
            pending_background_output_chars,
            text,
            MAX_BACKGROUND_OUTPUT_CHARS,
        );
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    #[test]
    fn teardown_resets_pending_background_count() {
        let manager = ReplKernelManager::new(KernelManagerOptions::default());
        manager
            .inner
            .append_background_output(&"é".repeat(MAX_BACKGROUND_OUTPUT_CHARS));
        manager.inner.cleanup_resources(Signal::Term);
        manager.inner.append_background_output("new🍁");
        let pending = lock(&manager.inner.guarded);
        assert_eq!(pending.pending_background_output, "new🍁");
        assert_eq!(pending.pending_background_output_chars, 4);
        assert!(!pending.pending_background_output_truncated);
    }

    /// Deliver one bash-activity display event into the manager (the
    /// kernel's activity track).
    fn deliver_activity(manager: &ReplKernelManager, activity: serde_json::Value) {
        let mut data = serde_json::Map::new();
        data.insert(BASH_ACTIVITY_DISPLAY_MIME.to_string(), activity);
        manager.inner.handle_event(Event::Display {
            id: None,
            data: Value::Object(data),
        });
    }

    /// One settlement counter wired as the manager's
    /// `on_background_work_settled` callback.
    fn settlement_counter() -> (Arc<AtomicUsize>, BackgroundWorkSettledCallback) {
        let fired = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&fired);
        (
            fired,
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        )
    }

    #[test]
    fn background_work_settlement_fires_once_and_ignores_malformed_releases() {
        let (fired, on_settled) = settlement_counter();
        let manager = ReplKernelManager::new(KernelManagerOptions {
            on_background_work_settled: Some(on_settled),
            ..Default::default()
        });
        let activity = json!({ "id": "a".repeat(32), "pid": 42, "active": true });
        deliver_activity(&manager, activity);
        assert!(manager.has_background_work());
        assert_eq!(fired.load(Ordering::SeqCst), 0);
        // Malformed or mismatched releases never settle the track (the
        // TS validation rows): a zero/negative pid, a missing active flag,
        // an unknown id, and an unrelated display payload all leave the
        // handle live.
        for release in [
            json!({ "id": "a".repeat(32), "pid": 0, "active": false }),
            json!({ "id": "a".repeat(32), "pid": -1, "active": false }),
            json!({ "id": "a".repeat(32), "pid": 42 }),
            json!({ "id": "b".repeat(32), "pid": 42, "active": false }),
            json!({ "id": "a".repeat(32), "pid": 7, "active": false }),
        ] {
            deliver_activity(&manager, release);
            assert!(manager.has_background_work());
            assert_eq!(fired.load(Ordering::SeqCst), 0);
        }
        manager.inner.handle_event(Event::Display {
            id: None,
            data: json!({ "application/vnd.prime-agent.diff+json": { "path": "p" } }),
        });
        assert!(manager.has_background_work());
        // The matching release settles the track exactly once.
        deliver_activity(
            &manager,
            json!({ "id": "a".repeat(32), "pid": 42, "active": false }),
        );
        assert!(!manager.has_background_work());
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        // An already-empty track never re-fires, teardown included.
        deliver_activity(
            &manager,
            json!({ "id": "a".repeat(32), "pid": 42, "active": false }),
        );
        manager.inner.cleanup_resources(Signal::Term);
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn teardown_with_live_handles_settles_once() {
        let (fired, on_settled) = settlement_counter();
        let manager = ReplKernelManager::new(KernelManagerOptions {
            on_background_work_settled: Some(on_settled),
            ..Default::default()
        });
        for (id, pid) in [("a", 42), ("b", 43)] {
            deliver_activity(
                &manager,
                json!({ "id": id.repeat(32), "pid": pid, "active": true }),
            );
        }
        assert!(manager.has_background_work());
        // Teardown kills the handles with the kernel, so owed continuations
        // waiting on them must hear the settlement once before it is lost.
        manager.inner.cleanup_resources(Signal::Term);
        assert!(!manager.has_background_work());
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        // A second teardown over the already-empty track fires nothing.
        manager.inner.cleanup_resources(Signal::Kill);
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_panic_in_the_settlement_callback_neither_breaks_the_event_path_nor_the_teardown() {
        let manager = ReplKernelManager::new(KernelManagerOptions {
            on_background_work_settled: Some(Arc::new(|| panic!("settlement callback failed"))),
            ..Default::default()
        });
        deliver_activity(
            &manager,
            json!({ "id": "a".repeat(32), "pid": 42, "active": true }),
        );
        assert!(manager.has_background_work());
        // The settlement is recorded on the map either way; the callback's
        // panic lands in the diagnostics tail instead of unwinding through
        // the event path or the teardown.
        deliver_activity(
            &manager,
            json!({ "id": "a".repeat(32), "pid": 42, "active": false }),
        );
        assert!(!manager.has_background_work());
        deliver_activity(
            &manager,
            json!({ "id": "b".repeat(32), "pid": 43, "active": true }),
        );
        manager.inner.cleanup_resources(Signal::Term);
        assert!(manager
            .kernel_stderr()
            .contains("background work settled callback failed"));
    }
}
