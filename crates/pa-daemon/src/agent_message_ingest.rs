//! The agent-message ingestion surface (protocol breadth wave b7): the
//! worker arms for `agent_messages_status`, `agent_messages_pause`,
//! `agent_messages_resume`, and `agent_messages_clear` (TS daemon-mode
//! `case "agent_messages_status"` ... `case "agent_messages_clear"`, over
//! `getAgentMessageSafetyStatus` / the `agentMessagesPaused` flag /
//! `clearQueuedAgentMessages`), plus the paused gate the delivery path
//! answers ("Agent messaging is paused", TS `sendAgentSessionMessage`).
//!
//! Porting note (rate limiter): the TS worker also paces deliveries through
//! a per-sender token bucket (`AgentSessionMessageRateLimiter`, capacity 3
//! / refill 1s). The status arm reports the TS constants verbatim; this
//! port does not refuse deliveries on the bucket (the daemon's queue
//! capacity bound is the enforced limit), a documented deviation from the
//! TS ingestion behavior.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use pa_core::session_engine::agent_messaging::{
    DEFAULT_AGENT_MESSAGE_MAX_CHARS, DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
    DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY, DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS,
};

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

/// The worker's agent-message ingestion state: the pause flag all four
/// arms read and the delivery gate checks.
pub(crate) struct AgentMessageIngest {
    paused: AtomicBool,
}

impl AgentMessageIngest {
    pub(crate) fn new() -> Self {
        AgentMessageIngest {
            paused: AtomicBool::new(false),
        }
    }

    pub(crate) fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }
}

impl Default for AgentMessageIngest {
    fn default() -> Self {
        Self::new()
    }
}

impl Worker {
    /// The TS `getAgentMessageSafetyStatus` wire object: the pause flag
    /// plus the four ingestion limits (the TS constants; see the module
    /// note for the rate-limiter deviation).
    fn agent_message_safety_status(&self) -> Value {
        json!({
            "paused": self.agent_messages.paused(),
            "maxMessageChars": DEFAULT_AGENT_MESSAGE_MAX_CHARS,
            "maxPendingPerSession": DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
            "rateLimitCapacity": DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY,
            "rateLimitRefillMs": DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS,
        })
    }

    /// `agent_messages_status`: the safety status, no side effects.
    pub(crate) fn handle_agent_messages_status(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("agent_messages_status") {
            return response;
        }
        response_success(
            None,
            "agent_messages_status",
            Some(self.agent_message_safety_status()),
        )
    }

    /// `agent_messages_pause`: set the flag, then drop every queued
    /// agent-message item (TS also clears the rate limiter - see the
    /// module note) and answer the safety status.
    pub(crate) fn handle_agent_messages_pause(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("agent_messages_pause") {
            return response;
        }
        self.agent_messages.set_paused(true);
        let cleared = self.clear_queued_agent_messages();
        let _ = cleared;
        response_success(
            None,
            "agent_messages_pause",
            Some(self.agent_message_safety_status()),
        )
    }

    /// `agent_messages_resume`: clear the flag and answer the safety
    /// status.
    pub(crate) fn handle_agent_messages_resume(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("agent_messages_resume") {
            return response;
        }
        self.agent_messages.set_paused(false);
        response_success(
            None,
            "agent_messages_resume",
            Some(self.agent_message_safety_status()),
        )
    }

    /// `agent_messages_clear`: drop this session's queued agent-message
    /// items and answer the TS `clearQueuedAgentMessages` shape (the
    /// removed prompts per lane).
    pub(crate) fn handle_agent_messages_clear(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("agent_messages_clear") {
            return response;
        }
        let cleared = self.clear_queued_agent_messages();
        response_success(None, "agent_messages_clear", Some(cleared))
    }

    /// The delivery gate (TS `sendAgentSessionMessage`'s paused check):
    /// the exact TS error string, surfaced through the worker's private
    /// `worker_deliver_message` arm so a client's `send_message` fails
    /// with it.
    #[allow(clippy::result_large_err)]
    pub(crate) fn refuse_delivery_if_paused(&self) -> Result<(), DaemonResponse> {
        if self.agent_messages.paused() {
            return Err(response_failure(
                None,
                "worker_deliver_message",
                "Agent messaging is paused",
                None,
            ));
        }
        Ok(())
    }

    /// Remove the queued agent-message items from both lanes (TS
    /// `clearQueuedAgentMessages`: only `agent_message`-sourced turns,
    /// never client-queued prompts) and answer the removed prompts per
    /// lane, exactly the TS `{ steering, followUp }` shape.
    fn clear_queued_agent_messages(&self) -> Value {
        let mut core = self.core.lock().unwrap();
        let mut steering = Vec::new();
        let mut follow_up = Vec::new();
        let mut retained_steering = std::collections::VecDeque::new();
        while let Some(item) = core.steering.pop_front() {
            match item.agent_message {
                Some(_) => steering.push(item.message),
                None => retained_steering.push_back(item),
            }
        }
        core.steering = retained_steering;
        let mut retained_follow_up = std::collections::VecDeque::new();
        while let Some(item) = core.follow_up.pop_front() {
            match item.agent_message {
                Some(_) => follow_up.push(item.message),
                None => retained_follow_up.push_back(item),
            }
        }
        core.follow_up = retained_follow_up;
        let snapshot = self.snapshot_locked(&core);
        let lanes = crate::worker::queue_lanes(&core);
        let active_session_id = core.active_session_id.clone();
        drop(core);
        self.persist_queue_snapshot(&active_session_id, &lanes);
        let _ = self.emit_action_update(&snapshot);
        json!({ "steering": steering, "followUp": follow_up })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    async fn created_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-ami-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "ami-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "ami" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// The paused safety status answers the TS five-field shape with the
    /// TS constants, and a pause clears queued agent messages but keeps
    /// client-queued prompts.
    #[tokio::test]
    async fn status_pause_resume_and_clear_match_ts_shapes() {
        let worker = created_worker().await;

        let status = worker.dispatch("agent_messages_status", &json!({})).await;
        assert!(status.success);
        assert_eq!(
            status.data,
            Some(json!({
                "paused": false,
                "maxMessageChars": 16384,
                "maxPendingPerSession": 20,
                "rateLimitCapacity": 3,
                "rateLimitRefillMs": 1000,
            }))
        );

        // One agent-message delivery and one client steer queue items on
        // the steering lane.
        let delivered = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "ami-session",
                    "message": "from a peer",
                    "sender": { "activeSessionId": "peer-1" },
                }),
            )
            .await;
        assert!(delivered.success, "delivery failed: {delivered:?}");
        worker
            .dispatch(
                "steer",
                &json!({ "activeSessionId": "ami-session", "message": "client text" }),
            )
            .await;

        // Pause: the flag flips and the queued agent message is dropped
        // (the client prompt stays - TS clears only agent messages).
        let paused = worker.dispatch("agent_messages_pause", &json!({})).await;
        assert!(paused.success);
        assert_eq!(paused.data.as_ref().unwrap()["paused"], json!(true));
        {
            let core = worker.core.lock().unwrap();
            let texts: Vec<&str> = core
                .steering
                .iter()
                .map(|item| item.message.as_str())
                .collect();
            assert_eq!(texts, vec!["client text"]);
        }

        // A delivery while paused answers the TS gate error.
        let refused = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "ami-session",
                    "message": "while paused",
                    "sender": { "activeSessionId": "peer-1" },
                }),
            )
            .await;
        assert!(!refused.success);
        assert_eq!(refused.error.as_deref(), Some("Agent messaging is paused"));

        // Resume flips the flag back.
        let resumed = worker.dispatch("agent_messages_resume", &json!({})).await;
        assert_eq!(resumed.data.as_ref().unwrap()["paused"], json!(false));

        // Clear answers the TS removed-prompts shape - only agent
        // messages go, so the lane is already empty of them after the
        // pause and the client prompt stays queued (TS
        // `clearQueuedAgentMessages` never removes client prompts).
        let cleared = worker.dispatch("agent_messages_clear", &json!({})).await;
        assert!(cleared.success);
        assert_eq!(
            cleared.data,
            Some(json!({ "steering": [], "followUp": [] }))
        );
        {
            let core = worker.core.lock().unwrap();
            let texts: Vec<&str> = core
                .steering
                .iter()
                .map(|item| item.message.as_str())
                .collect();
            assert_eq!(texts, vec!["client text"]);
        }
    }

    /// A queue behind current work (`followUp` delivery mode) is cleared
    /// from the follow-up lane with its own removed texts.
    #[tokio::test]
    async fn clear_reports_the_follow_up_lane() {
        let worker = created_worker().await;
        let delivered = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": "ami-session",
                    "message": "queued for later",
                    "sender": { "activeSessionId": "peer-1" },
                    "deliveryMode": "follow_up",
                }),
            )
            .await;
        assert!(delivered.success, "delivery failed: {delivered:?}");
        let cleared = worker.dispatch("agent_messages_clear", &json!({})).await;
        // The removed text is the queued turn's prompt (TS reports
        // `payload.text`, the created agent-message prompt).
        assert_eq!(
            cleared.data,
            Some(json!({
                "steering": [],
                "followUp": ["[agent-message from peer-1]\n\nqueued for later"],
            }))
        );
    }
}
