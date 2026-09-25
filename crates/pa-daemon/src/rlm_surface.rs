//! The RLM child-management surface (protocol breadth wave b6): the
//! worker arms for `cancel_rlm_child`, `delete_rlm_subagent`, and
//! `set_rlm_max_depth` (TS daemon-mode `case "cancel_rlm_child"` ... `case
//! "set_rlm_max_depth"`). Each handler answers the exact TS wire shape; the
//! behavior lives in the engine seams (`SessionEngine::cancel_rlm_child` /
//! `delete_rlm_subagent` / `set_rlm_max_depth`) and the supervisor-backed
//! children registry (`rlm_children.rs`).

use serde_json::{json, Value};

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

impl Worker {
    /// `cancel_rlm_child`: cancel one live child run by id. The TS wire
    /// contract is `{ cancelled: boolean }` - an unknown or already-settled
    /// child id answers `false`, never an error.
    pub(crate) async fn handle_cancel_rlm_child(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("cancel_rlm_child") {
            return response;
        }
        let Some(child_id) = payload.get("childId").and_then(Value::as_str) else {
            return response_failure(
                None,
                "cancel_rlm_child",
                "cancel_rlm_child requires a childId",
                None,
            );
        };
        let cancelled = self.engine.cancel_rlm_child(child_id).await;
        response_success(
            None,
            "cancel_rlm_child",
            Some(json!({ "cancelled": cancelled })),
        )
    }

    /// `delete_rlm_subagent`: delete one inactive child by id. The TS wire
    /// contract is `{ deleted: boolean }`, plus `reason: "running"` when a
    /// live child refused the delete (TS spread: `...(result === "running"
    /// ? { reason: "running" } : {})`); a teardown failure surfaces as the
    /// command failure.
    pub(crate) async fn handle_delete_rlm_subagent(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("delete_rlm_subagent") {
            return response;
        }
        let Some(child_id) = payload.get("childId").and_then(Value::as_str) else {
            return response_failure(
                None,
                "delete_rlm_subagent",
                "delete_rlm_subagent requires a childId",
                None,
            );
        };
        match self.engine.delete_rlm_subagent(child_id).await {
            Ok("deleted") => response_success(
                None,
                "delete_rlm_subagent",
                Some(json!({ "deleted": true })),
            ),
            Ok("running") => response_success(
                None,
                "delete_rlm_subagent",
                Some(json!({ "deleted": false, "reason": "running" })),
            ),
            Ok(_) => response_success(
                None,
                "delete_rlm_subagent",
                Some(json!({ "deleted": false })),
            ),
            Err(error) => response_failure(None, "delete_rlm_subagent", &error.to_string(), None),
        }
    }

    /// `set_rlm_max_depth`: set the session's recursion bound, optionally
    /// persisting it as the global settings default. The response is the TS
    /// `SetRlmMaxDepthResult` wire object (`{ maxDepth, source,
    /// globalSaved }` plus `globalError` when the global write failed).
    pub(crate) async fn handle_set_rlm_max_depth(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("set_rlm_max_depth") {
            return response;
        }
        let Some(max_depth) = payload.get("maxDepth").and_then(Value::as_u64) else {
            return response_failure(
                None,
                "set_rlm_max_depth",
                "RLM max depth must be a non-negative integer.",
                None,
            );
        };
        let global = payload.get("global").and_then(Value::as_bool) == Some(true);
        // The engine call blocks on the engine runtime (the durable
        // `rlm_max_depth_state` write takes the engine session lock), so it
        // runs on a blocking thread like every other engine call — a direct
        // call from this async task would `block_on` from inside the
        // worker's runtime and die.
        let engine = std::sync::Arc::clone(&self.engine);
        let result =
            tokio::task::spawn_blocking(move || engine.set_rlm_max_depth(max_depth, global))
                .await
                .unwrap_or_else(|error| Err(anyhow::anyhow!("RLM max depth task failed: {error}")));
        match result {
            Ok(result) => response_success(None, "set_rlm_max_depth", Some(result)),
            Err(error) => response_failure(None, "set_rlm_max_depth", &error.to_string(), None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    async fn created_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-rlm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "rlm-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "rlm-surface" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// Wire shape: `cancel_rlm_child` answers `{ cancelled }` - false for an
    /// unknown child (TS `cancelRlmChildRun` on an unmatched id).
    #[tokio::test]
    async fn cancel_rlm_child_answers_the_ts_cancelled_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "cancel_rlm_child",
                &json!({ "activeSessionId": "rlm-session", "childId": "ghost-child" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(response.data, Some(json!({ "cancelled": false })));
    }

    /// Wire shape: `delete_rlm_subagent` answers `{ deleted: false }` for an
    /// unknown child (TS `deleteInactiveRlmSubagent` -> "`not_found`").
    #[tokio::test]
    async fn delete_rlm_subagent_answers_the_ts_not_found_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "delete_rlm_subagent",
                &json!({ "activeSessionId": "rlm-session", "childId": "ghost-child" }),
            )
            .await;
        assert!(response.success);
        assert_eq!(response.data, Some(json!({ "deleted": false })));
    }

    /// Wire shape: `set_rlm_max_depth` answers the TS `SetRlmMaxDepthResult`
    /// (`maxDepth`, `source: "chat"`, `globalSaved`), and a global request
    /// writes the settings default.
    #[tokio::test]
    async fn set_rlm_max_depth_answers_the_ts_result_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "set_rlm_max_depth",
                &json!({ "activeSessionId": "rlm-session", "maxDepth": 3 }),
            )
            .await;
        assert!(response.success);
        assert_eq!(
            response.data,
            Some(json!({ "maxDepth": 3, "source": "chat", "globalSaved": false }))
        );

        let status = worker
            .dispatch(
                "get_rlm_max_depth_status",
                &json!({ "activeSessionId": "rlm-session" }),
            )
            .await;
        assert!(status.success);

        // The scripted harness engine owns no settings surface, so a
        // `global: true` request answers `globalSaved: false` (the real
        // agent engine writes the settings default and answers `true`).
        let response = worker
            .dispatch(
                "set_rlm_max_depth",
                &json!({ "activeSessionId": "rlm-session", "maxDepth": 4, "global": true }),
            )
            .await;
        assert!(response.success);
        assert_eq!(
            response.data,
            Some(json!({ "maxDepth": 4, "source": "chat", "globalSaved": false }))
        );
    }

    /// Wire shape: a missing `childId`/`maxDepth` fails the command (the
    /// TS parse of the required wire field).
    #[tokio::test]
    async fn missing_required_fields_fail() {
        let worker = created_worker().await;
        for command_type in ["cancel_rlm_child", "delete_rlm_subagent"] {
            let response = worker
                .dispatch(command_type, &json!({ "activeSessionId": "s" }))
                .await;
            assert!(
                !response.success,
                "{command_type} must fail without childId"
            );
        }
        let response = worker
            .dispatch("set_rlm_max_depth", &json!({ "activeSessionId": "s" }))
            .await;
        assert!(!response.success);
        assert_eq!(
            response.error.as_deref(),
            Some("RLM max depth must be a non-negative integer.")
        );
    }
}
