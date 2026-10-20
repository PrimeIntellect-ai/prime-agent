//! One-shot auth-change notification: refresh serving credentials in all
//! live session workers, including RLM children.

use serde_json::json;

use crate::backpressure::RouteAdmission;
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::supervisor::{Supervisor, ROUTE_TIMEOUT_MS};

impl Supervisor {
    /// Notify every live connected worker (including RLM children) after a
    /// saved provider credential changes. In-flight creates finish publishing
    /// Ready before the snapshot; later creates read the saved credential.
    /// No credential material crosses this boundary.
    pub(crate) async fn handle_auth_changed_broadcast(
        &self,
        command_id: &str,
        type_name: &str,
        provider_id: &str,
    ) -> DaemonResponse {
        let _create_barrier = self.auth_refresh_barrier.write().await;
        let residents = self.live_workers_in_creation_order().await;
        let responses = futures::future::join_all(residents.iter().map(|resident| async move {
            self.route_command_typed(
                resident,
                "auth_changed",
                json!({ "providerId": provider_id }),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await
        }))
        .await;
        let failures = responses
            .iter()
            .filter(|reply| !matches!(reply, Ok(response) if response.success))
            .count();
        if failures > 0 {
            return response_failure(
                Some(command_id),
                type_name,
                &format!("Could not update {failures} of {} running sessions. Shut down and restart Prime Agent to update running sessions.", residents.len()),
                None,
            );
        }
        response_success(Some(command_id), type_name, None)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use crate::protocol::response_success;
    use crate::registry::{ResidentWorker, WorkerReply, WorkerRequest};
    use crate::supervisor::{Supervisor, SupervisorOptions};
    use pa_types::daemon::{DaemonWorkerDescriptor, DaemonWorkerLifecycle};

    /// A worker that built its target before Ready cannot miss a login.
    #[tokio::test]
    async fn an_auth_fanout_waits_out_an_in_flight_create_and_covers_the_newly_ready_worker() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: dir.path().join("agent"),
            })
            .expect("supervisor"),
        );
        // A resident mid-create: the channel is wired (the create route
        // needs it) but the lifecycle is still `Starting` — the create has
        // not published Ready yet.
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
            "version": 2,
            "workerId": "w-inflight",
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "test",
            "rootActiveSessionId": "w-inflight",
            "createdAt": "t",
            "updatedAt": "t",
            "lifecycle": "starting",
            "createCommand": {},
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
        let resident = ResidentWorker::new(
            "w-inflight".to_string(),
            descriptor,
            dir.path().join("w-inflight.descriptor.json"),
        );
        let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::channel::<WorkerRequest>(1);
        *resident.cmd_tx.lock().await = Some(cmd_tx);
        supervisor.registry.insert(Arc::clone(&resident)).await;
        // The fake worker: the one routed command is recorded and answered
        // with success.
        let (routed_tx, routed_rx) = tokio::sync::oneshot::channel::<(String, String)>();
        let pump_resident = Arc::clone(&resident);
        tokio::spawn(async move {
            let request = cmd_rx.recv().await.expect("the fanout routes a command");
            let provider_id = request
                .payload
                .get("providerId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            let _ = routed_tx.send((request.command_type.clone(), provider_id));
            let reply = pump_resident
                .pending
                .lock()
                .await
                .remove(&request.request_id)
                .expect("the routed auth_changed holds a reply slot");
            let _ = reply.send(WorkerReply::Typed(response_success(
                None,
                "auth_changed",
                None,
            )));
        });
        // The create path's read guard: held from before the create route
        // through Ready publication. The fanout must wait behind it.
        let create_guard = supervisor.auth_refresh_barrier.read().await;
        let mut broadcast = Box::pin(supervisor.handle_auth_changed_broadcast(
            "c-auth",
            "auth_changed",
            "test-provider",
        ));
        assert!(
            futures::poll!(&mut broadcast).is_pending(),
            "the fanout must wait out the in-flight create"
        );
        // The create completes: the Ready publication and route readiness
        // land while the guard is still held (the launch order), then the
        // guard releases and the waiting fanout proceeds.
        {
            let mut descriptor = resident.descriptor.lock().await;
            descriptor.lifecycle = DaemonWorkerLifecycle::Ready;
        }
        resident.note_connection_live();
        resident.note_session_ready();
        drop(create_guard);
        let response = broadcast.await;
        assert!(response.success, "the settled fanout: {response:?}");
        let (command_type, provider_id) = routed_rx.await.expect("the fanout routed to the worker");
        assert_eq!(command_type, "auth_changed");
        assert_eq!(provider_id, "test-provider");
    }
}
