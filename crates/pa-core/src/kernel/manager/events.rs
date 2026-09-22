//! Event dispatch: kernel protocol events routed to streams, display updates,
//! and background output buffers.

use super::*;

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

impl Inner {
    pub(crate) fn handle_event(self: &Arc<Self>, event: Event) {
        match event {
            Event::Display { id, ref data } => {
                if let Some(activity) = data.get(BASH_ACTIVITY_DISPLAY_MIME) {
                    let obj = match activity.as_object() {
                        Some(obj) => obj,
                        None => return,
                    };
                    let activity_id = obj.get("id").and_then(Value::as_str).unwrap_or_default();
                    let pid = obj.get("pid").and_then(Value::as_i64).unwrap_or_default();
                    let active = obj.get("active").and_then(Value::as_bool);
                    if activity_id.len() == 32
                        && activity_id.chars().all(|c| c.is_ascii_hexdigit())
                        && pid > 0
                        && matches!(active, Some(true) | Some(false))
                    {
                        let mut g = lock(&self.guarded);
                        if active == Some(true) {
                            g.background_bash_handles
                                .entry(activity_id.to_string())
                                .or_insert(pid as i32);
                        } else if g.background_bash_handles.get(activity_id) == Some(&(pid as i32))
                        {
                            g.background_bash_handles.remove(activity_id);
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
                self.route_stream(id.as_deref(), StreamName::Stdout, &text)
            }
            Event::Stderr { id, text } => {
                self.route_stream(id.as_deref(), StreamName::Stderr, &text)
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
                buffers.stderr.push_str(&format!(
                    "attachment dropped: exceeds {MAX_ATTACHMENT_DATA_CHARS} base64 chars"
                ));
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
}
