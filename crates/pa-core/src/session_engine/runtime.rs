//! The session runtime: shared goal-driver + cron-store state with kernel
//! host-handler registration. This is the wiring layer that binds the
//! goal/rlm-heartbeat host requests (kernel bridge) to a live session, the
//! Rust equivalent of the `AgentSession` host-request controllers.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::cron::store::AgentCronJobStore;
use crate::goals::GoalHostResponse;
use crate::kernel::shared::{host_handler, HostRequestHandlers};
use crate::session::manager::SessionManager;

use super::goal_driver::GoalDriver;
use super::host_requests::{
    handle_goal_host_request, handle_rlm_heartbeat_host_request, RlmHeartbeatMutationHook,
    SessionBinding,
};

/// The host-side purge of queued goal-context turns (TS
/// `_clearQueuedGoalContexts` at the `_completeGoalFromHost` site): the
/// queue lanes live in the daemon worker, so the completing kernel host
/// request invokes this seam instead — dropping a continuation queued
/// while the goal was completing.
pub type QueuedGoalContextPurge = Arc<dyn Fn() + Send + Sync>;

/// Session-scoped runtime state the kernel bridge reaches.
pub struct SessionRuntime {
    goal_driver: Arc<Mutex<GoalDriver>>,
    cron_store: Arc<AgentCronJobStore>,
    active_session_id: String,
    binding: SessionBinding,
    /// Invoked after a kernel `goal.complete` settles the goal (TS
    /// `_completeGoalFromHost` -> `_clearQueuedGoalContexts`); `None` when
    /// the embedding owns no queued goal contexts.
    goal_complete_purge: Option<QueuedGoalContextPurge>,
    /// Invoked after a kernel `rlm_heartbeat.*` mutation (TS daemon-mode's
    /// `removeQueuedHeartbeatFollowUp` + `cronScheduler.wake()` inside its
    /// rlm heartbeat controllers); `None` when the embedding owns no
    /// scheduler to re-arm.
    cron_mutation_hook: Option<RlmHeartbeatMutationHook>,
}

impl SessionRuntime {
    /// Build a runtime around a cron store, rehydrating any persisted goal.
    pub fn new(
        session: &SessionManager,
        cron_store: Arc<AgentCronJobStore>,
        active_session_id: String,
        binding: SessionBinding,
    ) -> Self {
        Self {
            goal_driver: Arc::new(Mutex::new(GoalDriver::load_persisted(session))),
            cron_store,
            active_session_id,
            binding,
            goal_complete_purge: None,
            cron_mutation_hook: None,
        }
    }

    /// Set the post-completion purge seam (the daemon worker's queue
    /// purge).
    pub fn set_goal_complete_purge(&mut self, purge: QueuedGoalContextPurge) {
        self.goal_complete_purge = Some(purge);
    }

    /// Set the rlm heartbeat mutation hook (the daemon worker's queued-fire
    /// withdrawal + scheduler re-arm).
    pub fn set_cron_mutation_hook(&mut self, hook: RlmHeartbeatMutationHook) {
        self.cron_mutation_hook = Some(hook);
    }

    pub fn goal_driver(&self) -> &Arc<Mutex<GoalDriver>> {
        &self.goal_driver
    }

    pub fn cron_store(&self) -> &Arc<AgentCronJobStore> {
        &self.cron_store
    }

    /// Register the `goal.*` and `rlm_heartbeat.*` handlers onto a handler map.
    pub fn register_host_handlers(
        &self,
        session: Arc<Mutex<SessionManager>>,
        handlers: &mut HostRequestHandlers,
    ) {
        let driver = self.goal_driver.clone();
        let goal_session = session.clone();
        handlers.register(
            "goal.get",
            host_handler(move |payload| {
                let driver = driver.clone();
                let session = goal_session.clone();
                Box::pin(async move {
                    let mut driver = driver.lock().await;
                    let mut session = session.lock().await;
                    let response = handle_goal_host_request(
                        payload
                            .data
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("goal.get"),
                        &payload.data,
                        &mut driver,
                        &mut session,
                    )?;
                    host_ok(&response)
                })
            }),
        );
        let driver = self.goal_driver.clone();
        let goal_session = session.clone();
        handlers.register(
            "goal.create",
            host_handler(move |payload| {
                let driver = driver.clone();
                let session = goal_session.clone();
                Box::pin(async move {
                    let mut driver = driver.lock().await;
                    let mut session = session.lock().await;
                    let response = handle_goal_host_request(
                        "goal.create",
                        &payload.data,
                        &mut driver,
                        &mut session,
                    )?;
                    host_ok(&response)
                })
            }),
        );
        let driver = self.goal_driver.clone();
        let goal_session = session;
        // TS `_completeGoalFromHost` clears the queued goal contexts: a
        // continuation queued behind the completing turn (e.g. an owed
        // continuation delivered mid-turn) never runs post-completion.
        let goal_complete_purge = self.goal_complete_purge.clone();
        handlers.register(
            "goal.complete",
            host_handler(move |payload| {
                let driver = driver.clone();
                let session = goal_session.clone();
                let purge = goal_complete_purge.clone();
                Box::pin(async move {
                    let response = {
                        let mut driver = driver.lock().await;
                        let mut session = session.lock().await;
                        handle_goal_host_request(
                            "goal.complete",
                            &payload.data,
                            &mut driver,
                            &mut session,
                        )?
                    };
                    if let Some(purge) = purge {
                        purge();
                    }
                    host_ok(&response)
                })
            }),
        );
        let store = self.cron_store.clone();
        let active_session_id = self.active_session_id.clone();
        let binding_session_id = self.binding.session_id.clone();
        let binding_session_file = self.binding.session_file.clone();
        let binding_cwd = self.binding.cwd.clone();
        let cron_mutation_hook = self.cron_mutation_hook.clone();
        for request_type in [
            "rlm_heartbeat.list",
            "rlm_heartbeat.create",
            "rlm_heartbeat.update",
            "rlm_heartbeat.delete",
        ] {
            let store = store.clone();
            let active_session_id = active_session_id.clone();
            let session_id = binding_session_id.clone();
            let session_file = binding_session_file.clone();
            let cwd = binding_cwd.clone();
            let mutation_hook = cron_mutation_hook.clone();
            handlers.register(
                request_type,
                host_handler(move |payload| {
                    let store = store.clone();
                    let active_session_id = active_session_id.clone();
                    let binding = SessionBinding {
                        session_id: session_id.clone(),
                        session_file: session_file.clone(),
                        cwd: cwd.clone(),
                    };
                    let mutation_hook = mutation_hook.clone();
                    Box::pin(async move {
                        let outcome = handle_rlm_heartbeat_host_request(
                            payload
                                .data
                                .get("type")
                                .and_then(Value::as_str)
                                .unwrap_or("rlm_heartbeat.list"),
                            &payload.data,
                            &store,
                            &active_session_id,
                            &binding,
                        )?;
                        // The embedding's post-mutation work (TS daemon-mode
                        // withdraws the queued fire and re-arms its cron
                        // scheduler inside the controller methods).
                        if let Some(mutation) = outcome.mutation {
                            if let Some(hook) = &mutation_hook {
                                hook(mutation).await;
                            }
                        }
                        Ok(outcome.response)
                    })
                }),
            );
        }
    }
}

fn host_ok(response: &GoalHostResponse) -> anyhow::Result<Value> {
    serde_json::to_value(response).map_err(anyhow::Error::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::HostRequestPayload;

    fn persisted_session() -> SessionManager {
        let dir = tempfile::TempDir::new().unwrap();
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut session = SessionManager::in_memory(dir.path());
        session.materialize_session_file(Some(session_dir));
        session
    }

    fn payload(data: Value) -> HostRequestPayload {
        HostRequestPayload {
            data,
            cell_source_code: None,
        }
    }

    #[tokio::test]
    async fn goal_handlers_round_trip_through_the_registry() {
        let session = Arc::new(Mutex::new(persisted_session()));
        let dir = tempfile::TempDir::new().unwrap();
        let runtime = SessionRuntime::new(
            &*session.lock().await,
            Arc::new(AgentCronJobStore::new(dir.path().join("jobs.json"))),
            "live-1".to_string(),
            SessionBinding {
                session_id: "session-1".to_string(),
                session_file: "/w/s.jsonl".to_string(),
                cwd: "/w".to_string(),
            },
        );
        let mut handlers = HostRequestHandlers::default();
        runtime.register_host_handlers(session.clone(), &mut handlers);

        // goal.create via the registry.
        let create = handlers.get("goal.create").unwrap().clone();
        let response = create(payload(serde_json::json!({
            "type": "goal.create",
            "objective": "finish the port",
            "token_budget": 1000
        })))
        .await
        .unwrap();
        assert_eq!(response["goal"]["status"], "active");
        assert_eq!(response["goal"]["objective"], "finish the port");
        // The goal state persisted to the session.
        let persisted = session.lock().await;
        let goal_entries: Vec<&pa_types::session::FileEntry> = persisted
            .get_all_entries()
            .iter()
            .filter(|entry| {
                matches!(entry, pa_types::session::FileEntry::Custom { payload, .. }
                if payload.custom_type == crate::goals::GOAL_STATE_CUSTOM_TYPE)
            })
            .collect();
        assert_eq!(goal_entries.len(), 1);
        drop(persisted);

        // goal.get sees the same driver state.
        let get = handlers.get("goal.get").unwrap().clone();
        let response = get(payload(serde_json::json!({ "type": "goal.get" })))
            .await
            .unwrap();
        assert_eq!(response["goal"]["objective"], "finish the port");
        assert_eq!(response["remaining_tokens"], 1000);

        // goal.complete carries the budget report.
        let complete = handlers.get("goal.complete").unwrap().clone();
        let response = complete(payload(serde_json::json!({ "type": "goal.complete" })))
            .await
            .unwrap();
        assert_eq!(response["goal"]["status"], "complete");
        assert!(response["completion_budget_report"].is_string());
    }

    #[tokio::test]
    async fn heartbeat_handlers_round_trip_through_the_registry() {
        let session = Arc::new(Mutex::new(persisted_session()));
        let dir = tempfile::TempDir::new().unwrap();
        let runtime = SessionRuntime::new(
            &*session.lock().await,
            Arc::new(AgentCronJobStore::new(dir.path().join("jobs.json"))),
            "live-1".to_string(),
            SessionBinding {
                session_id: "session-1".to_string(),
                session_file: "/w/s.jsonl".to_string(),
                cwd: "/w".to_string(),
            },
        );
        let mut handlers = HostRequestHandlers::default();
        runtime.register_host_handlers(session, &mut handlers);

        let create = handlers.get("rlm_heartbeat.create").unwrap().clone();
        let response = create(payload(serde_json::json!({
            "type": "rlm_heartbeat.create",
            "instruction": "watch the mission",
            "interval": "every 15m"
        })))
        .await
        .unwrap();
        assert_eq!(response["heartbeat"]["status"], "active");
        assert_eq!(response["heartbeat"]["instruction"], "watch the mission");
        let id = response["heartbeat"]["id"].as_str().unwrap().to_string();

        // update pauses it.
        let update = handlers.get("rlm_heartbeat.update").unwrap().clone();
        let response = update(payload(serde_json::json!({
            "type": "rlm_heartbeat.update",
            "id": id,
            "status": "pause"
        })))
        .await
        .unwrap();
        assert_eq!(response["heartbeat"]["status"], "paused");
        // The heartbeat file holds the job.
        let jobs = runtime.cron_store().list_rlm_heartbeats("live-1", true);
        assert_eq!(jobs.len(), 1);
    }

    /// The kernel `rlm_heartbeat.*` handlers invoke the mutation hook with
    /// the changed job (the daemon worker's queued-fire withdrawal +
    /// scheduler re-arm, TS daemon-mode's controller call sites); catalog
    /// reads announce nothing.
    #[tokio::test]
    async fn rlm_heartbeat_mutations_invoke_the_cron_mutation_hook() {
        let session = Arc::new(Mutex::new(persisted_session()));
        let dir = tempfile::TempDir::new().unwrap();
        let mut runtime = SessionRuntime::new(
            &*session.lock().await,
            Arc::new(AgentCronJobStore::new(dir.path().join("jobs.json"))),
            "live-1".to_string(),
            SessionBinding {
                session_id: "session-1".to_string(),
                session_file: "/w/s.jsonl".to_string(),
                cwd: "/w".to_string(),
            },
        );
        let mutations: Arc<Mutex<Vec<super::super::host_requests::RlmHeartbeatMutation>>> =
            Arc::new(Mutex::new(Vec::new()));
        let sink = mutations.clone();
        runtime.set_cron_mutation_hook(Arc::new(move |mutation| {
            let sink = sink.clone();
            Box::pin(async move {
                sink.lock().await.push(mutation);
            })
        }));
        let mut handlers = HostRequestHandlers::default();
        runtime.register_host_handlers(session, &mut handlers);

        // Create announces the job (never withdrawing a queued fire).
        let create = handlers.get("rlm_heartbeat.create").unwrap().clone();
        let response = create(payload(serde_json::json!({
            "type": "rlm_heartbeat.create",
            "instruction": "watch the mission",
            "interval": "every 15m"
        })))
        .await
        .unwrap();
        let id = response["heartbeat"]["id"].as_str().unwrap().to_string();
        let seen = mutations.lock().await;
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].job.id, id);
        assert_eq!(seen[0].job.source.as_deref(), Some("rlm_heartbeat"));
        assert!(!seen[0].drop_queued);
        drop(seen);

        // A catalog read announces nothing.
        let list = handlers.get("rlm_heartbeat.list").unwrap().clone();
        let response = list(payload(serde_json::json!({ "type": "rlm_heartbeat.list" })))
            .await
            .unwrap();
        assert_eq!(response["heartbeats"].as_array().unwrap().len(), 1);
        assert_eq!(mutations.lock().await.len(), 1);

        // A pause withdraws the queued fire (TS `updateRlmHeartbeatForState`).
        let update = handlers.get("rlm_heartbeat.update").unwrap().clone();
        update(payload(serde_json::json!({
            "type": "rlm_heartbeat.update",
            "id": id,
            "status": "pause"
        })))
        .await
        .unwrap();
        let seen = mutations.lock().await;
        assert_eq!(seen.len(), 2);
        assert!(seen[1].drop_queued);
        drop(seen);

        // A delete always withdraws it.
        let delete = handlers.get("rlm_heartbeat.delete").unwrap().clone();
        delete(payload(serde_json::json!({
            "type": "rlm_heartbeat.delete",
            "id": id
        })))
        .await
        .unwrap();
        let seen = mutations.lock().await;
        assert_eq!(seen.len(), 3);
        assert!(seen[2].drop_queued);
    }
}
