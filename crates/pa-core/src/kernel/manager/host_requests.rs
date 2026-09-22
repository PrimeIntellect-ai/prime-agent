//! Host request handling: execute-side requests answered by the host
//! (harness/goal/etc.) and their settle/exit waits.

use super::*;

// ---------------------------------------------------------------------------
// Host requests
// ---------------------------------------------------------------------------

impl Inner {
    /// Dispatch one typed request from kernel code to the registered handler
    /// and reply over the protocol. Unhandled requests answer with an error.
    pub(crate) fn start_host_request(self: &Arc<Self>, request_id: &str, data: Value) {
        {
            let mut g = lock(&self.guarded);
            let (seen, order) = &mut g.handled_host_request_ids;
            if seen.contains(request_id) {
                return;
            }
            seen.insert(request_id.to_string());
            order.push_back(request_id.to_string());
            while seen.len() > MAX_HANDLED_HOST_REQUEST_IDS {
                if let Some(oldest) = order.pop_front() {
                    seen.remove(&oldest);
                } else {
                    break;
                }
            }
        }
        let inner = Arc::clone(self);
        let request_id = request_id.to_string();
        let task = tokio::spawn(async move {
            let result = inner.handle_host_request(&data).await;
            let reply = match result {
                Ok(result) => json!({ "status": "ok", "result": result }),
                Err(error) => {
                    inner.append_diagnostic(&format!(
                        "host request failed for {request_id}: {error:#}"
                    ));
                    json!({ "status": "error", "error": format!("{error:#}") })
                }
            };
            let frame = json!({ "type": "host_reply", "id": request_id, "data": reply });
            if let Err(error) = inner.write_line(&frame).await {
                inner.append_diagnostic(&format!(
                    "failed to send host request reply for {request_id}: {error:#}"
                ));
            }
        });
        let mut g = lock(&self.guarded);
        // Completed task handles are dropped so the inflight set stays bounded.
        g.host_inflight.retain(|handle| !handle.is_finished());
        g.host_inflight.push(task);
    }

    async fn handle_host_request(&self, data: &Value) -> anyhow::Result<Value> {
        let Some(obj) = data.as_object() else {
            return Err(anyhow!("host request payload must be an object"));
        };
        let request_type = obj
            .get("type")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| anyhow!("host request payload must have a string type"))?;
        let handler = self
            .options
            .host_handlers
            .get(request_type)
            .ok_or_else(|| {
                anyhow!("host request type \"{request_type}\" is not available in this session")
            })?
            .clone();
        // Tag the request with the cell that triggered it. A blocking call is
        // still the in-flight execution; detached spawns fire after the
        // scheduling cell goes idle, so fall back to that last cell's source.
        let cell_source_code = {
            let g = lock(&self.guarded);
            g.active_execution
                .as_ref()
                .map(|e| e.code.clone())
                .or_else(|| g.last_cell_code.clone())
        };
        let mut payload = obj.clone();
        if let Some(code) = cell_source_code {
            payload.insert("cellSourceCode".to_string(), Value::String(code));
        }
        handler(HostRequestPayload {
            data: Value::Object(payload),
            cell_source_code: None,
        })
        .await
    }

    /// Wait (bounded) for the in-flight host request tasks to settle.
    pub(crate) async fn wait_for_host_requests_to_settle(
        &self,
        tasks: Vec<tokio::task::JoinHandle<()>>,
        timeout_ms: u64,
    ) {
        let all = async {
            for task in tasks {
                let _ = task.await;
            }
        };
        if tokio::time::timeout(Duration::from_millis(timeout_ms), all)
            .await
            .is_err()
        {
            self.append_diagnostic(&format!(
                "timed out waiting {timeout_ms}ms for host request task(s) during shutdown"
            ));
        }
    }

    pub(crate) async fn wait_for_kernel_exit(&self) {
        let exit_rx = match lock(&self.child).as_ref() {
            Some(child) => child.exit_rx.clone(),
            None => return,
        };
        let mut exit_rx = exit_rx;
        if exit_rx.borrow().is_some() {
            return;
        }
        loop {
            if exit_rx.borrow().is_some() {
                return;
            }
            if exit_rx.changed().await.is_err() {
                return;
            }
        }
    }
}
