//! The session input-pause surface (protocol breadth wave b8): the
//! worker arms for `acquire_session_input_pause` and
//! `release_session_input_pause` (TS daemon-mode `case
//! "acquire_session_input_pause"` / `case "release_session_input_pause"`)
//! plus the pause itself - the input-admission gate the turn runner
//! consults before it admits queued work (TS `acquireSessionInputPause`'s
//! `_sessionInputAdmissionPauses` token set).
//!
//! While any pause is held, the session's queued input (prompts, steering,
//! follow-ups) stays queued; releasing wakes the runner. A pause is leased
//! to one owner identity: reacquiring the same session with the same lease
//! key answers the existing pause id, and releasing a pause another client
//! holds answers the TS ownership error.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::worker::Worker;

/// One held pause: the session it gates, the owning client identity, and
/// the lease key (the supervisor embeds `[connectionId, ownerClientId,
/// leaseKey]`, so a reacquire from the same connection deduplicates).
#[derive(Debug, Clone, PartialEq, Eq)]
struct InputPauseEntry {
    active_session_id: String,
    owner_client_id: String,
    lease_key: String,
}

/// The worker's pause table: pause id -> entry. Cheap to clone: the
/// table is one allocation shared by the worker and its turn runner.
#[derive(Default, Clone)]
pub(crate) struct InputPauseTable {
    pauses: std::sync::Arc<Mutex<HashMap<String, InputPauseEntry>>>,
}

/// The release outcome (TS error strings surface through the arm).
enum ReleaseOutcome {
    Released,
    Unknown,
    /// A foreign owner or session (the TS arm answers the same ownership
    /// error for both).
    OwnedByAnotherClient,
}

impl InputPauseTable {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Whether any pause is held (the runner's admission gate).
    pub(crate) fn paused(&self) -> bool {
        !self
            .pauses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
    }

    /// `acquire_session_input_pause`: dedupe on (owner, session, lease
    /// key) - an identical lease answers its existing pause id (TS
    /// `existing[0]`), otherwise a fresh id is minted and the admission
    /// gate engages.
    fn acquire(&self, active_session_id: &str, owner_client_id: &str, lease_key: &str) -> String {
        let mut pauses = self
            .pauses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (pause_id, entry) in pauses.iter() {
            if entry.active_session_id == active_session_id
                && entry.owner_client_id == owner_client_id
                && entry.lease_key == lease_key
            {
                return pause_id.clone();
            }
        }
        let pause_id = uuid::Uuid::new_v4().to_string();
        pauses.insert(
            pause_id.clone(),
            InputPauseEntry {
                active_session_id: active_session_id.to_string(),
                owner_client_id: owner_client_id.to_string(),
                lease_key: lease_key.to_string(),
            },
        );
        pause_id
    }

    /// `release_session_input_pause`: `Unknown` answers the plain TS
    /// success (an idempotent release), a foreign owner or session
    /// answers the TS ownership error, `Released` lifts the gate.
    fn release(
        &self,
        pause_id: &str,
        owner_client_id: &str,
        active_session_id: &str,
    ) -> ReleaseOutcome {
        let mut pauses = self
            .pauses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(entry) = pauses.get(pause_id) else {
            return ReleaseOutcome::Unknown;
        };
        if entry.owner_client_id != owner_client_id || entry.active_session_id != active_session_id
        {
            return ReleaseOutcome::OwnedByAnotherClient;
        }
        pauses.remove(pause_id);
        ReleaseOutcome::Released
    }

    /// `detach` (and worker shutdown) drops every pause this owner holds
    /// (TS `detach` releases the client's pauses before detaching).
    fn release_all_for_owner(&self, owner_client_id: &str) -> bool {
        let mut pauses = self
            .pauses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = pauses.len();
        pauses.retain(|_, entry| entry.owner_client_id != owner_client_id);
        before != pauses.len()
    }
}

impl Worker {
    /// `acquire_session_input_pause`: the pause id wire object `{ pauseId
    /// }`, with the dedupe on the identical lease.
    pub(crate) fn handle_acquire_session_input_pause(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("acquire_session_input_pause") {
            return response;
        }
        let active_session_id = payload
            .get("activeSessionId")
            .and_then(Value::as_str)
            .unwrap_or(&self.config.active_session_id)
            .to_string();
        let Some(lease_key) = payload.get("leaseKey").and_then(Value::as_str) else {
            return response_failure(
                None,
                "acquire_session_input_pause",
                "acquire_session_input_pause requires a leaseKey",
                None,
            );
        };
        let owner_client_id = payload
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let pause_id = self
            .input_pauses
            .acquire(&active_session_id, &owner_client_id, lease_key);
        response_success(
            None,
            "acquire_session_input_pause",
            Some(json!({ "pauseId": pause_id })),
        )
    }

    /// `release_session_input_pause`: the TS outcome ladder - an unknown
    /// pause id answers the plain success, a foreign owner answers the
    /// ownership error, a correct release lifts the admission gate and
    /// wakes the turn runner.
    pub(crate) fn handle_release_session_input_pause(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("release_session_input_pause") {
            return response;
        }
        let pause_id = payload
            .get("pauseId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let active_session_id = payload
            .get("activeSessionId")
            .and_then(Value::as_str)
            .unwrap_or(&self.config.active_session_id)
            .to_string();
        let owner_client_id = payload
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match self
            .input_pauses
            .release(pause_id, &owner_client_id, &active_session_id)
        {
            ReleaseOutcome::Released => {
                // The gate lifted: queued input admits again, and the
                // release is a TS `_maybeResumeGoalContinuationAfterRlmWork`
                // site (the deferral held while the pause owned admission
                // re-evaluates).
                self.work_notify.notify_one();
                if let Some(engine) = self.agent_engine.as_ref() {
                    engine.retry_owed_goal_continuation();
                }
                response_success(None, "release_session_input_pause", None)
            }
            ReleaseOutcome::Unknown => response_success(None, "release_session_input_pause", None),
            ReleaseOutcome::OwnedByAnotherClient => response_failure(
                None,
                "release_session_input_pause",
                &format!("Session input pause is owned by another client: {pause_id}"),
                None,
            ),
        }
    }

    /// `detach` (TS worker arm): every pause this client holds on the
    /// detaching session goes with the detach.
    pub(crate) fn release_input_pauses_for_detach(&self, owner_client_id: &str) {
        if self.input_pauses.release_all_for_owner(owner_client_id) {
            self.work_notify.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    async fn created_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-pause-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "pause-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "pauses" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// Wire shape: acquire answers `{ pauseId }`, the same lease
    /// deduplicates to the same id, a different lease mints a new one.
    #[tokio::test]
    async fn acquire_dedupes_on_the_lease_key() {
        let worker = created_worker().await;
        let first = worker
            .dispatch(
                "acquire_session_input_pause",
                &json!({
                    "activeSessionId": "pause-session",
                    "leaseKey": "[\"conn-1\",\"owner\",\"lease-1\"]",
                    "clientId": "conn-1",
                }),
            )
            .await;
        assert!(first.success, "{first:?}");
        let pause_id = first.data.unwrap()["pauseId"].clone();
        assert!(pause_id.as_str().is_some_and(|id| !id.is_empty()));

        let again = worker
            .dispatch(
                "acquire_session_input_pause",
                &json!({
                    "activeSessionId": "pause-session",
                    "leaseKey": "[\"conn-1\",\"owner\",\"lease-1\"]",
                    "clientId": "conn-1",
                }),
            )
            .await;
        assert_eq!(again.data.unwrap()["pauseId"], pause_id);

        let other = worker
            .dispatch(
                "acquire_session_input_pause",
                &json!({
                    "activeSessionId": "pause-session",
                    "leaseKey": "[\"conn-1\",\"owner\",\"lease-2\"]",
                    "clientId": "conn-1",
                }),
            )
            .await;
        assert_ne!(other.data.unwrap()["pauseId"], pause_id);
    }

    /// Wire shape: release answers the plain TS success for an unknown
    /// id, the ownership error for a foreign client, and lifts the gate
    /// for the owner.
    #[tokio::test]
    async fn release_answers_the_ts_outcome_ladder() {
        let worker = created_worker().await;
        let acquire = worker
            .dispatch(
                "acquire_session_input_pause",
                &json!({ "activeSessionId": "pause-session", "leaseKey": "k", "clientId": "conn-1" }),
            )
            .await;
        let pause_id = acquire.data.unwrap()["pauseId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(worker.input_pauses.paused());

        // Unknown id: the plain TS success.
        let unknown = worker
            .dispatch(
                "release_session_input_pause",
                &json!({ "activeSessionId": "pause-session", "pauseId": "ghost", "clientId": "conn-1" }),
            )
            .await;
        assert!(unknown.success);
        assert_eq!(unknown.data, None);

        // Foreign owner: the TS ownership error.
        let foreign = worker
            .dispatch(
                "release_session_input_pause",
                &json!({ "activeSessionId": "pause-session", "pauseId": pause_id, "clientId": "conn-2" }),
            )
            .await;
        assert!(!foreign.success);
        assert_eq!(
            foreign.error.as_deref(),
            Some(format!("Session input pause is owned by another client: {pause_id}").as_str())
        );

        // Owner release lifts the gate.
        let released = worker
            .dispatch(
                "release_session_input_pause",
                &json!({ "activeSessionId": "pause-session", "pauseId": pause_id, "clientId": "conn-1" }),
            )
            .await;
        assert!(released.success);
        assert!(!worker.input_pauses.paused());
    }

    /// The admission gate: held pauses keep queued input queued, a release
    /// admits it again.
    #[tokio::test]
    async fn the_gate_holds_queued_input_until_released() {
        let worker = created_worker().await;
        worker
            .dispatch(
                "acquire_session_input_pause",
                &json!({ "activeSessionId": "pause-session", "leaseKey": "k", "clientId": "conn-1" }),
            )
            .await;
        assert!(worker.input_pauses.paused());
        worker.release_input_pauses_for_detach("conn-1");
        assert!(!worker.input_pauses.paused());
        // A foreign client's detach release does not lift the gate.
        worker
            .dispatch(
                "acquire_session_input_pause",
                &json!({ "activeSessionId": "pause-session", "leaseKey": "k", "clientId": "conn-1" }),
            )
            .await;
        worker.release_input_pauses_for_detach("conn-2");
        assert!(worker.input_pauses.paused());
    }
}
