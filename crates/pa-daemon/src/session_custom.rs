//! The custom-message & session-command surface (protocol breadth wave
//! b4): the worker arms for `append_custom_message`, `restore_next_turn`,
//! `restore_actions`, `refine`, `reload`, and `extension_ui_response`
//! (TS daemon-mode cases). Wire contracts are TS-verbatim; the durable rows
//! and broadcasts go through the same paths the turn runner uses.

use serde_json::{json, Value};

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

/// The session-action recovery snapshot format this port restores (TS
/// `SESSION_ACTION_RECOVERY_FORMAT_VERSION`).
const SESSION_ACTION_RECOVERY_FORMAT_VERSION: u64 = 1;

impl Worker {
    /// `append_custom_message { message }` (TS `session.sendCustomMessage`
    /// default path): append the custom row durably, then broadcast its
    /// `message_start`/`message_end` pair.
    pub(crate) fn handle_append_custom_message(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("append_custom_message") {
            return response;
        }
        let Some(message) = custom_message_value(payload.get("message")) else {
            return response_failure(
                None,
                "append_custom_message",
                "append_custom_message requires a custom message",
                None,
            );
        };
        self.emit_custom_row(message);
        response_success(None, "append_custom_message", None)
    }

    /// `restore_next_turn { messages }` (TS
    /// `restorePendingNextTurnMessages`): park the custom rows; the next
    /// delivered turn replays them as prefix rows, in order, before the
    /// accepted prompt.
    pub(crate) fn handle_restore_next_turn(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("restore_next_turn") {
            return response;
        }
        let Some(messages) = payload.get("messages").and_then(Value::as_array) else {
            return response_failure(
                None,
                "restore_next_turn",
                "restore_next_turn requires a messages array",
                None,
            );
        };
        let mut rows = Vec::with_capacity(messages.len());
        for message in messages {
            let Some(row) = custom_message_value(Some(message)) else {
                return response_failure(
                    None,
                    "restore_next_turn",
                    "restore_next_turn requires custom messages",
                    None,
                );
            };
            rows.push(row);
        }
        self.core.lock().unwrap().pending_next_turn.extend(rows);
        response_success(None, "restore_next_turn", None)
    }

    /// `restore_actions { snapshot }` (TS `restoreSessionActions`): the
    /// crash-recovery snapshot of queued session actions. The TS-verbatim
    /// validation errors fail the command; every restored action lands in
    /// its delivery lane (steering for `next_turn_boundary`, follow-up
    /// for `when_run_idle`) and the response carries the restored count.
    pub(crate) fn handle_restore_actions(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("restore_actions") {
            return response;
        }
        let Some(snapshot) = payload.get("snapshot").and_then(Value::as_object) else {
            return response_failure(
                None,
                "restore_actions",
                "restore_actions requires a snapshot",
                None,
            );
        };
        let format_version = snapshot
            .get("formatVersion")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if format_version != SESSION_ACTION_RECOVERY_FORMAT_VERSION {
            return response_failure(
                None,
                "restore_actions",
                &format!("Unsupported session action recovery format version: {format_version}"),
                None,
            );
        }
        let Some(actions) = snapshot.get("actions").and_then(Value::as_array) else {
            return response_failure(
                None,
                "restore_actions",
                "restore_actions requires a snapshot actions array",
                None,
            );
        };
        // Validation pass first (TS validates every action before
        // admitting any): ids must be unique within the snapshot, and a
        // turn payload's delivery records must correlate to their action.
        let mut seen_ids = std::collections::HashSet::new();
        for action in actions {
            let Some(id) = action.get("id").and_then(Value::as_str) else {
                return response_failure(
                    None,
                    "restore_actions",
                    "restore_actions requires an action id",
                    None,
                );
            };
            if !seen_ids.insert(id.to_string()) {
                return response_failure(
                    None,
                    "restore_actions",
                    &format!("Duplicate session action id: {id}"),
                    None,
                );
            }
            let payload = action.get("payload").unwrap_or(&Value::Null);
            if payload.get("kind").and_then(Value::as_str) == Some("turn") {
                let records = payload
                    .get("records")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let correlated = records
                    .iter()
                    .all(|record| record.get("ownerActionId").and_then(Value::as_str) == Some(id));
                if !correlated {
                    return response_failure(
                        None,
                        "restore_actions",
                        &format!("Session action {id} has invalid delivery correlation"),
                        None,
                    );
                }
            }
        }
        // Restore pass: each action lands in its delivery lane (TS
        // `_deliveryPolicy`: `next_turn_boundary` is the steering
        // schedule, `when_run_idle` the follow-up one).
        let restored = {
            let mut core = self.core.lock().unwrap();
            for action in actions {
                let payload = action.get("payload").unwrap_or(&Value::Null);
                let lane_follow_up =
                    action.get("delivery").and_then(Value::as_str) != Some("next_turn_boundary");
                let item = crate::worker::QueuedItem {
                    preview: None,
                    message: payload
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    custom_message: payload.get("customMessage").cloned(),
                    agent_message: None,
                    queue_key: None,
                    admission_id: None,
                    images: crate::worker::parse_prompt_images(payload),
                    done: None,
                    // TS restores the action's own visibility flag
                    // (`queueVisible: action.payload.queueVisible`);
                    // the stored default is visible.
                    queue_visible: payload
                        .get("queueVisible")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                };
                if lane_follow_up {
                    core.follow_up.push_back(item);
                } else {
                    core.steering.push_back(item);
                }
            }
            actions.len()
        };
        // TS records the worker recovery state once per successful restore.
        if restored > 0 {
            let _ = self.record_recovery(false, "actions_restored");
            self.work_notify.notify_one();
        }
        response_success(
            None,
            "restore_actions",
            Some(json!({ "restored": restored })),
        )
    }

    /// `refine { instructions?, rollbackId?, global? }` (TS
    /// `session.refine`): run the refinement (plan, apply, persist the
    /// harness state), emit the durable outcome and notice rows, and
    /// answer the `RefinementResult`.
    pub(crate) async fn handle_refine(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("refine") {
            return response;
        }
        let options = pa_core::session_engine::refine::RefineOptions {
            instructions: payload
                .get("instructions")
                .and_then(Value::as_str)
                .map(str::to_string),
            rollback_id: payload
                .get("rollbackId")
                .and_then(Value::as_str)
                .map(str::to_string),
            global: payload
                .get("global")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        let engine = std::sync::Arc::clone(&self.engine);
        let result = tokio::task::spawn_blocking(move || engine.run_refinement(options))
            .await
            .unwrap_or_else(|error| Err(anyhow::anyhow!("refinement task failed: {error}")));
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                return response_failure(None, "refine", &format!("{error:#}"), None);
            }
        };
        // The refinement's durable rows: the TUI outcome, plus the
        // model-facing notice when edits applied (TS emits both through
        // the session's row flow).
        if let Ok(typed) =
            serde_json::from_value::<pa_core::refinement::RefinementResult>(result.clone())
        {
            let outcome =
                pa_core::session_engine::refine::create_refinement_outcome_message(&typed);
            if let Ok(value) =
                serde_json::to_value(pa_types::session::AgentMessage::Custom(outcome))
            {
                self.emit_custom_row(value);
            }
            if typed.applied_edits.iter().any(|edit| edit.applied) {
                let notice = pa_core::session_engine::refine::create_refinement_notice_message(
                    &typed,
                    pa_core::session_engine::refine::RefinementSource::User,
                );
                if let Ok(value) =
                    serde_json::to_value(pa_types::session::AgentMessage::Custom(notice))
                {
                    self.emit_custom_row(value);
                }
            }
        }
        response_success(None, "refine", Some(result))
    }

    /// `reload` (TS `session.reload`): re-read the session's live inputs —
    /// settings, provider auth, and the MCP user-server config. This port
    /// resolves each of those per use (settings on every read, auth on
    /// every model resolution, MCP user servers on every store resolve), so
    /// the reload's observable state is already fresh and the command is
    /// the TS success with no extra work to perform.
    pub(crate) async fn handle_reload(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("reload") {
            return response;
        }
        response_success(None, "reload", None)
    }

    /// `extension_ui_response { requestId, response }` (TS
    /// `extensionUiRequests`): resolve one pending extension UI request.
    /// This port's worker hosts no extension UI requests (the extension
    /// runner surfaces tool registrations, not UI flows), so every request
    /// id answers the TS unknown-request error.
    pub(crate) fn handle_extension_ui_response(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("extension_ui_response") {
            return response;
        }
        let Some(request_id) = payload.get("requestId").and_then(Value::as_str) else {
            return response_failure(
                None,
                "extension_ui_response",
                "extension_ui_response requires a requestId",
                None,
            );
        };
        response_failure(
            None,
            "extension_ui_response",
            &format!("Unknown extension UI request: {request_id}"),
            None,
        )
    }
}

/// The wire `CustomMessage` form (TS `Pick<CustomMessage, "customType" |
/// "content" | "display" | "details">` plus the row's timestamp): the
/// durable row the session appends and broadcasts.
fn custom_message_value(message: Option<&Value>) -> Option<Value> {
    let message = message?.as_object()?;
    let custom_type = message.get("customType")?;
    custom_type.as_str()?;
    let content = message.get("content")?;
    if !matches!(content, Value::String(_) | Value::Array(_)) {
        return None;
    }
    let display = message
        .get("display")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut row = json!({
        "role": "custom",
        "customType": custom_type,
        "content": content,
        "display": display,
        "timestamp": crate::util::now_ms(),
    });
    if let Some(details) = message.get("details").filter(|details| !details.is_null()) {
        row["details"] = details.clone();
    }
    Some(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    async fn created_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-sc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "custom-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "custom" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    fn custom_entries(worker: &Worker) -> Vec<(String, Value)> {
        let core = worker.core.lock().unwrap();
        core.store
            .as_ref()
            .map(|store| {
                store
                    .entries()
                    .iter()
                    .filter(|entry| entry.type_ == "custom_message")
                    .map(|entry| {
                        (
                            entry
                                .fields
                                .get("customType")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            entry.fields.get("content").cloned().unwrap_or(Value::Null),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `append_custom_message` records the durable custom row (the TS
    /// `sendCustomMessage` default path) and rejects malformed messages.
    #[tokio::test]
    async fn append_custom_message_records_the_row() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "append_custom_message",
                &json!({
                    "activeSessionId": "custom-session",
                    "message": {
                        "customType": "notice",
                        "content": "hello row",
                        "display": true,
                        "details": { "why": "test" },
                    },
                }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        let rows = custom_entries(&worker);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "notice");
        assert_eq!(rows[0].1, json!("hello row"));

        for bad in [
            json!({ "activeSessionId": "custom-session" }),
            json!({ "activeSessionId": "custom-session", "message": { "customType": 3 } }),
            json!({ "activeSessionId": "custom-session", "message": { "customType": "x" } }),
        ] {
            let response = worker.dispatch("append_custom_message", &bad).await;
            assert!(!response.success, "must reject: {bad}");
        }
    }

    /// `restore_next_turn` parks the rows and the next delivered turn
    /// replays them first (TS `prefixMessages` order).
    #[tokio::test]
    async fn restore_next_turn_replays_before_the_next_prompt() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "restore_next_turn",
                &json!({
                    "activeSessionId": "custom-session",
                    "messages": [
                        { "customType": "pending", "content": "first", "display": true },
                        { "customType": "pending", "content": "second", "display": true },
                    ],
                }),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        assert_eq!(custom_entries(&worker).len(), 0, "parked, not appended");

        let _ = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": "custom-session", "message": "go" }),
            )
            .await;
        let rows = custom_entries(&worker);
        assert_eq!(
            rows,
            vec![
                ("pending".to_string(), json!("first")),
                ("pending".to_string(), json!("second")),
            ],
            "parked rows replay with the next turn"
        );

        let response = worker
            .dispatch(
                "restore_next_turn",
                &json!({ "activeSessionId": "custom-session" }),
            )
            .await;
        assert!(!response.success);
    }

    /// `restore_actions` restores each action into its delivery lane and
    /// answers the restored count; the TS-verbatim validation errors fail
    /// the command without touching the lanes.
    #[tokio::test]
    async fn restore_actions_restores_and_validates() {
        let worker = created_worker().await;
        let snapshot = |actions: Value| {
            json!({
                "activeSessionId": "custom-session",
                "snapshot": { "formatVersion": 1, "actions": actions },
            })
        };
        let turn = |id: &str, delivery: &str, text: &str| {
            json!({
                "id": id,
                "source": "user",
                "delivery": delivery,
                "wake": "wake",
                "payload": {
                    "kind": "turn",
                    "text": text,
                    "records": [
                        { "id": format!("{id}-r1"), "role": "primary", "message": { "role": "user", "content": text }, "ownerActionId": id },
                    ],
                    "executionPolicy": { "preparation": {} },
                    "queueVisible": true,
                    "acceptedAgentMessage": false,
                    "acceptedBeforeCompletion": false,
                },
            })
        };
        let response = worker
            .dispatch(
                "restore_actions",
                &snapshot(json!([
                    turn("a1", "when_run_idle", "one"),
                    turn("a2", "next_turn_boundary", "two")
                ])),
            )
            .await;
        assert!(response.success, "failed: {response:?}");
        assert_eq!(response.data, Some(json!({ "restored": 2 })));

        // Validation failures leave the lanes alone.
        let lanes_before = {
            let core = worker.core.lock().unwrap();
            (
                core.steering
                    .iter()
                    .map(|item| item.message.clone())
                    .collect::<Vec<_>>(),
                core.follow_up
                    .iter()
                    .map(|item| item.message.clone())
                    .collect::<Vec<_>>(),
            )
        };
        for (label, bad) in [
            (
                "format version",
                snapshot(json!({ "formatVersion": 2, "actions": [] })),
            ),
            (
                "duplicate id",
                snapshot(json!([
                    turn("a1", "when_run_idle", "x"),
                    turn("a1", "when_run_idle", "y")
                ])),
            ),
            (
                "correlation",
                snapshot(json!([turn("b1", "when_run_idle", "z")])),
            ),
        ] {
            // The correlation failure needs a record with a foreign owner.
            let bad = match label {
                "correlation" => {
                    let mut value = snapshot(json!([turn("b1", "when_run_idle", "z")]));
                    value["snapshot"]["actions"][0]["payload"]["records"][0]["ownerActionId"] =
                        json!("someone-else");
                    value
                }
                "format version" => json!({
                    "activeSessionId": "custom-session",
                    "snapshot": { "formatVersion": 2, "actions": [] },
                }),
                _ => bad,
            };
            let response = worker.dispatch("restore_actions", &bad).await;
            assert!(!response.success, "{label} must fail: {response:?}");
        }
        let lanes_after = {
            let core = worker.core.lock().unwrap();
            (
                core.steering
                    .iter()
                    .map(|item| item.message.clone())
                    .collect::<Vec<_>>(),
                core.follow_up
                    .iter()
                    .map(|item| item.message.clone())
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(lanes_before, lanes_after, "failed restores change nothing");
        let expected_error = worker
            .dispatch(
                "restore_actions",
                &json!({
                    "activeSessionId": "custom-session",
                    "snapshot": { "formatVersion": 2, "actions": [] },
                }),
            )
            .await;
        assert_eq!(
            expected_error.error.as_deref(),
            Some("Unsupported session action recovery format version: 2")
        );
    }

    /// `refine` on a session without refinement support answers the
    /// failure the engine seam carries (the scripted harness has no
    /// refiner).
    #[tokio::test]
    async fn refine_surfaces_the_engine_failure() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "refine",
                &json!({ "activeSessionId": "custom-session", "instructions": "tidy up" }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(
            response.error.as_deref(),
            Some("This session does not support refinement")
        );
    }

    /// `reload` answers the TS success (the live inputs this port
    /// re-reads are already fresh).
    #[tokio::test]
    async fn reload_answers_success() {
        let worker = created_worker().await;
        let response = worker
            .dispatch("reload", &json!({ "activeSessionId": "custom-session" }))
            .await;
        assert!(response.success, "failed: {response:?}");
        assert!(response.data.is_none());
    }

    /// `extension_ui_response` answers the TS unknown-request error for
    /// every id (this worker hosts no extension UI requests) and requires
    /// the id.
    #[tokio::test]
    async fn extension_ui_response_matches_the_unknown_request_error() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "extension_ui_response",
                &json!({ "activeSessionId": "custom-session", "requestId": "ui-1", "response": { "confirmed": true } }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(
            response.error.as_deref(),
            Some("Unknown extension UI request: ui-1")
        );
        let response = worker
            .dispatch(
                "extension_ui_response",
                &json!({ "activeSessionId": "custom-session" }),
            )
            .await;
        assert!(!response.success);
    }
}
