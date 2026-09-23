//! The queue-lane command surface: `mutate_queued_message` and
//! `resume_queue` (TS daemon-mode `case "mutate_queued_message"` /
//! `case "resume_queue"`, over `AgentSession.mutateQueuedMessage` /
//! `resumeQueuedWork`).
//!
//! Wire contract (the queue is the visible projection): `get_queue` and the
//! `session_action_update` events expose each lane's message previews, and a
//! mutation addresses one preview by `lane` + `index` + `expectedText`. The
//! status vocabulary is TS-verbatim - `applied`, `rejected`, `invalid` -
//! where `invalid` (a session-command payload that fails to parse) is
//! unreachable on this build: the worker queues hold prompts only.

use serde_json::Value;

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Lane;
use crate::worker::{parse_prompt_images, Worker};

/// TS `QueuedMessageLane`: wire names `"steering"` and `"followUp"`.
fn wire_lane(value: Option<&Value>) -> Option<Lane> {
    match value.and_then(Value::as_str) {
        Some("steering") => Some(Lane::Steering),
        Some("followUp") => Some(Lane::FollowUp),
        _ => None,
    }
}

impl Worker {
    /// `mutate_queued_message { lane, index, expectedText, mutation }`:
    /// apply one delete/move/replace against the queue preview. Rejections
    /// are statuses, not errors (TS answers every outcome `success` with
    /// `{ status }`); only a malformed request (bad lane/index/mutation
    /// shape) fails the command.
    pub(crate) fn handle_mutate_queued_message(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("mutate_queued_message") {
            return response;
        }
        let Some(lane) = wire_lane(payload.get("lane")) else {
            return response_failure(
                None,
                "mutate_queued_message",
                "mutate_queued_message requires lane \"steering\" or \"followUp\"",
                None,
            );
        };
        let Some(index) = payload.get("index").and_then(Value::as_u64) else {
            return response_failure(
                None,
                "mutate_queued_message",
                "mutate_queued_message requires an index",
                None,
            );
        };
        let expected = payload
            .get("expectedText")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(mutation) = payload.get("mutation") else {
            return response_failure(
                None,
                "mutate_queued_message",
                "mutate_queued_message requires a mutation",
                None,
            );
        };
        let mutation_type = mutation
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(mutation_type, "delete" | "move" | "replace") {
            return response_failure(
                None,
                "mutate_queued_message",
                "mutate_queued_message requires mutation.type \"delete\", \"move\", or \"replace\"",
                None,
            );
        }
        // The delete error the rejected waiter sees (TS
        // `QueuedMessageError`); a prompt_and_wait caller surfaces it as
        // the command failure.
        const DELETED: &str = "Queued prompt was deleted before delivery.";
        let index = index as usize;
        let (status, queue_changed): (&'static str, bool) = {
            let mut core = self.core.lock().unwrap();
            let status = match lane {
                Lane::Steering => mutate_lane(
                    &mut core.steering,
                    index,
                    expected,
                    mutation,
                    mutation_type,
                    DELETED,
                ),
                Lane::FollowUp => mutate_lane(
                    &mut core.follow_up,
                    index,
                    expected,
                    mutation,
                    mutation_type,
                    DELETED,
                ),
            };
            if status != "applied" {
                (status, false)
            } else {
                // A replace onto another lane moves the item to the back of
                // the target lane (TS `moveQueued(item, targetPolicy,
                // ...length)`). The non-overlapping direction pairs only -
                // `target != lane` holds for every reached arm.
                if mutation_type == "replace" {
                    if let Some(target) =
                        wire_lane(mutation.get("lane")).filter(|target| *target != lane)
                    {
                        let item = match (lane, target) {
                            (Lane::Steering, Lane::FollowUp) => core.steering.remove(index),
                            (Lane::FollowUp, Lane::Steering) => core.follow_up.remove(index),
                            _ => None,
                        };
                        if let Some(item) = item {
                            match target {
                                Lane::Steering => core.steering.push_back(item),
                                Lane::FollowUp => core.follow_up.push_back(item),
                            }
                        }
                    }
                }
                (status, true)
            }
        };
        // Every applied mutation resumes the suspension (TS
        // `mutateQueuedMessage` ends with `resumeQueuedWork()`; the delete
        // arm calls it directly).
        if status == "applied" {
            self.resume_queued_input();
        }
        let response = response_success(
            None,
            "mutate_queued_message",
            Some(serde_json::json!({ "status": status })),
        );
        if !queue_changed {
            return response;
        }
        // Same post-mutation flow as the admission paths: persist the lanes
        // to the recovery journal, push the projection, and wake the turn
        // runner (TS `resumeQueuedWork` after delete/replace; move only
        // emits the queue update).
        let core = self.core.lock().unwrap();
        let snapshot = self.snapshot_locked(&core);
        let lanes = crate::worker::queue_lanes(&core);
        let active_session_id = core.active_session_id.clone();
        drop(core);
        self.persist_queue_snapshot(&active_session_id, &lanes);
        let _ = self.emit_action_update(&snapshot);
        if mutation_type != "move" {
            self.work_notify.notify_one();
        }
        response
    }

    /// `resume_queue`: the queue's queued work resumes (the turn runner
    /// drains the lanes when idle); the failure string is TS-verbatim for
    /// the empty queue.
    pub(crate) fn handle_resume_queue(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("resume_queue") {
            return response;
        }
        // TS `resumeQueuedWork()` clears the queued-input suspension first
        // and only then reports the empty queue, so `resume_queue` is a
        // resume site even when it answers "No queued work to resume".
        self.resume_queued_input();
        let has_queued_work = {
            let core = self.core.lock().unwrap();
            !core.steering.is_empty() || !core.follow_up.is_empty()
        };
        if !has_queued_work {
            return response_failure(None, "resume_queue", "No queued work to resume", None);
        }
        self.work_notify.notify_one();
        response_success(None, "resume_queue", None)
    }
}

/// Apply one mutation to a lane. The status vocabulary is the TS
/// `QueuedMessageMutationStatus`; the caller owns the cross-lane move a
/// replace-with-lane-change implies.
fn mutate_lane(
    lane: &mut std::collections::VecDeque<crate::worker::QueuedItem>,
    index: usize,
    expected: &str,
    mutation: &Value,
    mutation_type: &str,
    deleted_message: &str,
) -> &'static str {
    let Some(item) = lane.get_mut(index) else {
        return "rejected";
    };
    // The visible preview (TS `queuedAgentMessagePreview`) is the row the
    // client saw in `get_queue`/`session_action_update`: the labeled
    // preview when the delivery carries one, else the message text.
    if item.preview.as_deref().unwrap_or(item.message.as_str()) != expected {
        return "rejected";
    }
    match mutation_type {
        "delete" => {
            if let Some(mut item) = lane.remove(index) {
                if let Some(done) = item.done.take() {
                    let _ = done.send(Err(deleted_message.to_string()));
                }
            }
        }
        "move" => {
            let direction = mutation
                .get("direction")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let target = index as i64 + direction;
            if target < 0 || target as usize >= lane.len() || direction == 0 {
                return "rejected";
            }
            lane.swap(index, target as usize);
        }
        "replace" => {
            // TS `mutateQueuedMessage` rejects the edit before its replace
            // arms when the turn's primary delivery record is not a plain
            // user message — an injected custom row (`payload.customMessage`,
            // e.g. a parked heartbeat prompt) or an accepted agent message.
            // Editing only `message` would leave the turn still delivering
            // and persisting the old injected row, so the parked heartbeat
            // (and every other injected component) answers `rejected`
            // instead of reporting `applied` while delivering stale content.
            if item.custom_message.is_some() || item.agent_message.is_some() {
                return "rejected";
            }
            let Some(text) = mutation.get("text").and_then(Value::as_str) else {
                return "rejected";
            };
            item.message = text.to_string();
            // The edited row loses its labeled preview (TS clears
            // `payload.preview` on edit): the client's own text becomes
            // the preview.
            item.preview = None;
            // `images` present clears or replaces the attachments; absent
            // keeps them (TS `images?.length ? images : undefined`).
            if mutation.get("images").is_some() {
                item.images = parse_prompt_images(mutation);
            }
        }
        _ => return "rejected",
    }
    "applied"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    async fn created_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-qc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "queue-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "queued" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    fn lane_texts(worker: &Worker, lane: Lane) -> Vec<String> {
        let core = worker.core.lock().unwrap();
        match lane {
            Lane::Steering => &core.steering,
            Lane::FollowUp => &core.follow_up,
        }
        .iter()
        .map(|item| item.message.clone())
        .collect()
    }

    /// A labeled row (TS `queuedAgentMessagePreview`): `get_queue` and the
    /// mutation `expectedText` address the preview, not the message text,
    /// and a replace clears the label (TS clears `payload.preview`).
    #[tokio::test]
    async fn a_labeled_preview_row_is_addressed_and_edited_by_its_preview() {
        let worker = created_worker().await;
        {
            let mut core = worker.core.lock().unwrap();
            core.steering.push_back(crate::worker::QueuedItem {
                message: "[heartbeat: every 10m run#0]\n\nnudge the mission".to_string(),
                preview: Some(
                    "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge the mission"
                        .to_string(),
                ),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: crate::worker::TurnPolicy::Injected,
                forced_batch: false,
            });
        }
        let queue = worker.dispatch("get_queue", &json!({})).await;
        assert!(queue.success);
        let data = queue.data.expect("queue data");
        assert_eq!(
            data["steering"][0],
            "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge the mission"
        );
        // The preview text addresses the row; the edited text becomes the
        // message and the label drops (the next get_queue row is the
        // client's own text).
        let mutate = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "lane": "steering",
                    "index": 0,
                    "expectedText": "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge the mission",
                    "mutation": { "type": "replace", "text": "edited while parked" },
                }),
            )
            .await;
        assert!(mutate.success, "mutate failed: {mutate:?}");
        assert_eq!(mutate.data.expect("mutate data")["status"], "applied");
        assert_eq!(lane_texts(&worker, Lane::Steering), ["edited while parked"]);
        let queue = worker.dispatch("get_queue", &json!({})).await;
        let data = queue.data.expect("queue data");
        assert_eq!(data["steering"][0], "edited while parked");
    }

    /// TS `mutateQueuedMessage` rejects the replace on an injected row
    /// (the turn's primary delivery record is not a plain user message):
    /// a parked heartbeat (labeled preview + injected custom row + queue
    /// key) answers `rejected`, so an edit can never report `applied`
    /// while the turn would still deliver and persist the old injected
    /// content. Delete still applies (TS allows delete/move on every
    /// queued row).
    #[tokio::test]
    async fn an_injected_heartbeat_row_rejects_replace_but_deletes() {
        let worker = created_worker().await;
        {
            let mut core = worker.core.lock().unwrap();
            core.steering.push_back(crate::worker::QueuedItem {
                message: "[heartbeat: every 10m run#0]\n\nnudge the mission".to_string(),
                preview: Some(
                    "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge the mission"
                        .to_string(),
                ),
                custom_message: Some(json!({
                    "role": "custom",
                    "customType": "heartbeat_prompt",
                    "content": "[heartbeat: every 10m run#0]\n\nnudge the mission",
                    "display": true,
                    "details": { "jobId": "hb-1" },
                })),
                agent_message: None,
                queue_key: Some("heartbeat:hb-1".to_string()),
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: crate::worker::TurnPolicy::Injected,
                forced_batch: false,
            });
        }
        let expected = "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge the mission";
        let replace = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "lane": "steering",
                    "index": 0,
                    "expectedText": expected,
                    "mutation": { "type": "replace", "text": "edited while parked" },
                }),
            )
            .await;
        assert!(replace.success, "mutate failed: {replace:?}");
        assert_eq!(replace.data.expect("replace data")["status"], "rejected");
        // The row is untouched: the parked heartbeat keeps its injected
        // delivery and its labeled preview.
        {
            let core = worker.core.lock().unwrap();
            let item = core.steering.front().expect("the parked row");
            assert!(item.custom_message.is_some());
            assert!(item.preview.is_some());
        }
        // Delete applies: the injected row leaves the lane.
        let delete = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "lane": "steering",
                    "index": 0,
                    "expectedText": expected,
                    "mutation": { "type": "delete" },
                }),
            )
            .await;
        assert!(delete.success, "delete failed: {delete:?}");
        assert_eq!(delete.data.expect("delete data")["status"], "applied");
        assert_eq!(lane_texts(&worker, Lane::Steering), Vec::<String>::new());
    }

    /// Wire shape: every outcome answers `success` with `{ status }`; the
    /// status vocabulary is TS-verbatim.
    #[tokio::test]
    async fn mutate_delete_moves_and_replaces_match_ts_status_wire() {
        let worker = created_worker().await;
        worker
            .dispatch(
                "steer",
                &json!({ "activeSessionId": "queue-session", "message": "one" }),
            )
            .await;
        worker
            .dispatch(
                "steer",
                &json!({ "activeSessionId": "queue-session", "message": "two" }),
            )
            .await;

        // Mismatched preview rejects.
        let response = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 0,
                    "expectedText": "not the preview",
                    "mutation": { "type": "delete" },
                }),
            )
            .await;
        assert!(response.success);
        assert_eq!(response.data, Some(json!({ "status": "rejected" })));

        // Delete applies and empties the lane.
        let response = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 0,
                    "expectedText": "one",
                    "mutation": { "type": "delete" },
                }),
            )
            .await;
        assert_eq!(response.data, Some(json!({ "status": "applied" })));
        assert_eq!(lane_texts(&worker, Lane::Steering), vec!["two"]);

        // Move swaps with the neighbor; a missing neighbor rejects.
        worker
            .dispatch(
                "steer",
                &json!({ "activeSessionId": "queue-session", "message": "three" }),
            )
            .await;
        let response = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 0,
                    "expectedText": "two",
                    "mutation": { "type": "move", "direction": 1 },
                }),
            )
            .await;
        assert_eq!(response.data, Some(json!({ "status": "applied" })));
        assert_eq!(lane_texts(&worker, Lane::Steering), vec!["three", "two"]);
        let response = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 1,
                    "expectedText": "two",
                    "mutation": { "type": "move", "direction": 1 },
                }),
            )
            .await;
        assert_eq!(response.data, Some(json!({ "status": "rejected" })));

        // Replace edits the text; a lane change moves it to the back of
        // the target lane.
        let response = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 0,
                    "expectedText": "three",
                    "mutation": { "type": "replace", "text": "edited", "lane": "followUp" },
                }),
            )
            .await;
        assert_eq!(response.data, Some(json!({ "status": "applied" })));
        assert_eq!(lane_texts(&worker, Lane::Steering), vec!["two"]);
        assert_eq!(lane_texts(&worker, Lane::FollowUp), vec!["edited"]);

        // An out-of-range index rejects.
        let response = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 9,
                    "expectedText": "two",
                    "mutation": { "type": "delete" },
                }),
            )
            .await;
        assert_eq!(response.data, Some(json!({ "status": "rejected" })));

        // A malformed lane or mutation shape fails the command.
        let response = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "bogus",
                    "index": 0,
                    "expectedText": "two",
                    "mutation": { "type": "delete" },
                }),
            )
            .await;
        assert!(!response.success);
        assert_eq!(response.command, "mutate_queued_message");
    }

    /// `resume_queue` answers success for queued work and the TS-verbatim
    /// failure for an empty queue.
    #[tokio::test]
    async fn resume_queue_matches_the_ts_wire_shapes() {
        let worker = created_worker().await;
        let response = worker.dispatch("resume_queue", &json!({})).await;
        assert!(!response.success);
        assert_eq!(response.error.as_deref(), Some("No queued work to resume"));
        assert_eq!(response.command, "resume_queue");

        worker
            .dispatch(
                "follow_up",
                &json!({ "activeSessionId": "queue-session", "message": "queued work" }),
            )
            .await;
        let response = worker.dispatch("resume_queue", &json!({})).await;
        assert!(response.success, "resume failed: {response:?}");
        assert_eq!(response.command, "resume_queue");
        assert!(response.data.is_none());
    }

    /// A deleted queued prompt rejects its waiting caller (the `prompt_and_wait`
    /// `done` channel) with the TS delete error string.
    #[tokio::test]
    async fn delete_rejects_the_waiting_caller() {
        let worker = created_worker().await;
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        {
            let mut core = worker.core.lock().unwrap();
            core.steering.push_back(crate::worker::QueuedItem {
                message: "waiting prompt".to_string(),
                preview: None,
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: Some(done_tx),
                queue_visible: true,
                policy: crate::worker::TurnPolicy::Queued,
                forced_batch: false,
            });
        }
        let response = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 0,
                    "expectedText": "waiting prompt",
                    "mutation": { "type": "delete" },
                }),
            )
            .await;
        assert_eq!(response.data, Some(json!({ "status": "applied" })));
        let settled = done_rx.await.expect("deleted waiter settles");
        assert_eq!(
            settled,
            Err("Queued prompt was deleted before delivery.".to_string())
        );
    }

    /// TS `mutateQueuedMessage` rejects a `replace` on an accepted
    /// agent-message delivery (`payload.acceptedAgentMessage` guard): the
    /// delivery rides the `agent_message` custom row, whose content must
    /// stay byte-identical to the prompt the turn runs on. Move and delete
    /// stay applicable.
    #[tokio::test]
    async fn replace_rejects_a_queued_agent_message_delivery() {
        let worker = created_worker().await;
        let delivered = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "queue-session",
                    "message": "the research is done",
                    "sender": {
                        "activeSessionId": "source-session",
                        "sessionName": "research-lane",
                        "runtimeKind": "subagent",
                    },
                }),
            )
            .await;
        assert!(delivered.success, "deliver failed: {delivered:?}");
        // The queue strip addresses the delivery by its labeled preview
        // (TS `queuedAgentMessagePreview`), not the rendered prompt.
        let expected = "Agent message received: the research is done";
        // A second queued prompt gives the delivery a move neighbor.
        worker
            .core
            .lock()
            .unwrap()
            .steering
            .push_back(crate::worker::QueuedItem {
                preview: None,
                message: "plain prompt".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: crate::worker::TurnPolicy::Queued,
                forced_batch: false,
            });

        let replaced = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 0,
                    "expectedText": expected,
                    "mutation": { "type": "replace", "text": "edited" },
                }),
            )
            .await;
        assert_eq!(replaced.data, Some(json!({ "status": "rejected" })));

        let moved = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 0,
                    "expectedText": expected,
                    "mutation": { "type": "move", "direction": 1 },
                }),
            )
            .await;
        assert_eq!(moved.data, Some(json!({ "status": "applied" })));

        let deleted = worker
            .dispatch(
                "mutate_queued_message",
                &json!({
                    "activeSessionId": "queue-session",
                    "lane": "steering",
                    "index": 1,
                    "expectedText": expected,
                    "mutation": { "type": "delete" },
                }),
            )
            .await;
        assert_eq!(deleted.data, Some(json!({ "status": "applied" })));
        let remaining = worker
            .core
            .lock()
            .unwrap()
            .steering
            .front()
            .map(|item| item.message.clone());
        assert_eq!(remaining.as_deref(), Some("plain prompt"));
    }
}
