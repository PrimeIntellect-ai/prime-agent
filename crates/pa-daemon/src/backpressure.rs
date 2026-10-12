//! Bounded backpressure on the supervisor's request path (the Codex
//! `app-server-transport` mirror): [`WORKER_INFLIGHT_CAPACITY`] bounds one
//! worker's in-flight requests (Codex `CHANNEL_CAPACITY = 128`);
//! [`CLIENT_OUTBOUND_CAPACITY`] bounds a client's outbound queue (the 32K
//! mirror). A saturated worker answers requests with the typed
//! `worker_overloaded` refusal; internal routes wait, never refuse.

use pa_types::daemon::DaemonErrorInfo;

use crate::protocol::{response_failure, DaemonResponse};

/// In-flight requests one worker accepts before its route saturates; also the
/// bound of the supervisor-to-worker command channel (admission precedes
/// enqueue). Codex's `CHANNEL_CAPACITY = 128` for its one-process daemon.
pub(crate) const WORKER_INFLIGHT_CAPACITY: usize = 128;

/// Capacity of the supervisor's shared client event broadcast ring: the
/// per-receiver drop on lag is the defined backpressure for a slow reader.
pub(crate) const EVENT_RING_CAPACITY: usize = 4096;

/// Capacity of one client connection's targeted session-event queue: a slow reader fills
/// it, drops are logged, and the supervisor never blocks on one client.
pub(crate) const TARGETED_EVENT_QUEUE_CAPACITY: usize = 4096;

/// Outbound response bundles one client connection may hold before its senders stall: a
/// wedged client stalls only its own dispatch tasks (Codex `WEBSOCKET_OUTBOUND_CHANNEL_CAPACITY`).
pub(crate) const CLIENT_OUTBOUND_CAPACITY: usize = 32 * 1024;
const _: () = assert!(CLIENT_OUTBOUND_CAPACITY > WORKER_INFLIGHT_CAPACITY);

/// Concurrent dispatch tasks one client connection may run: the loop acquires a permit
/// per inbound command BEFORE spawning its dispatch task, so at this bound it stops
/// reading the socket — transport-level flow control.
pub(crate) const CLIENT_DISPATCH_CONCURRENCY: usize = 64;

/// What a route does when its worker is at the in-flight bound: a request
/// answers the explicit overload error immediately, a notification awaits
/// capacity (Codex's split).
#[derive(Clone, Copy)]
pub(crate) enum RouteAdmission {
    /// A client's request-shaped command: answers the typed `worker_overloaded` refusal
    /// the moment the worker saturates (never queued, so the retry cannot duplicate it).
    ClientRequest,
    /// Supervisor-internal traffic (stop/kill, create replay, cleanup, polls): waits
    /// for a slot inside its own timeout budget — never refused.
    SupervisorInternal,
}

/// The saturated-route refusal a client command answers: typed `worker_overloaded` on
/// the wire, the worker id so a multi-session client knows what to retry.
pub(crate) fn overloaded_response(command_type: &str, worker_id: &str) -> DaemonResponse {
    response_failure(
        None,
        command_type,
        &format!("Session worker {worker_id} is overloaded; retry later"),
        Some(DaemonErrorInfo::WorkerOverloaded),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::registry::{ResidentWorker, WorkerRequest};
    use crate::supervisor::{Supervisor, SupervisorOptions};
    use pa_types::daemon::{DaemonErrorInfo, DaemonWorkerDescriptor};

    fn resident(worker_id: &str) -> Arc<ResidentWorker> {
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(serde_json::json!({
            "version": 2,
            "workerId": worker_id,
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "test",
            "rootActiveSessionId": "none",
            "createdAt": "2026-09-26T00:00:00Z",
            "updatedAt": "2026-09-26T00:00:00Z",
            "lifecycle": "ready",
            "createCommand": {},
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
        ResidentWorker::new(
            worker_id.to_string(),
            descriptor,
            std::path::PathBuf::from("/tmp/none.descriptor.json"),
        )
    }

    /// Install a live command channel nobody drains: a wedged worker that accepts frames
    /// but never answers (the halves must outlive the routes under test).
    async fn wedged_worker(
        resident: &Arc<ResidentWorker>,
    ) -> (
        tokio::sync::mpsc::Sender<WorkerRequest>,
        tokio::sync::mpsc::Receiver<WorkerRequest>,
    ) {
        let (cmd_tx, cmd_rx) =
            tokio::sync::mpsc::channel::<WorkerRequest>(WORKER_INFLIGHT_CAPACITY);
        *resident.cmd_tx.lock().await = Some(cmd_tx.clone());
        (cmd_tx, cmd_rx)
    }

    fn supervisor(dir: &std::path::Path) -> Supervisor {
        Supervisor::new(SupervisorOptions {
            tcp_port: None,
            tcp_bind_host: None,
            remote_agent_mesh: None,
            socket_path: dir.join("daemon.sock"),
            agent_dir: dir.join("agent"),
        })
        .expect("supervisor")
    }

    #[tokio::test]
    async fn a_saturated_worker_answers_client_requests_with_the_typed_overload_refusal() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = supervisor(dir.path());
        let resident = resident("w-busy");
        let (_cmd_tx, _cmd_rx) = wedged_worker(&resident).await;

        // Saturate: every in-flight slot held by a route awaiting a reply
        // that never comes.
        let inflight = Arc::clone(&resident.inflight);
        let mut held = Vec::new();
        for _ in 0..WORKER_INFLIGHT_CAPACITY {
            held.push(inflight.clone().acquire_owned().await.expect("permit"));
        }

        let refused = supervisor
            .route_command_typed(
                &resident,
                "get_state",
                serde_json::json!({}),
                5_000,
                RouteAdmission::ClientRequest,
            )
            .await
            .expect("saturation answers, never errors");
        assert!(!refused.success);
        assert_eq!(
            refused.error.as_deref(),
            Some("Session worker w-busy is overloaded; retry later")
        );
        assert_eq!(refused.error_info, Some(DaemonErrorInfo::WorkerOverloaded));
        // The wire shape: the typed tag rides `errorInfo` (the Codex
        // `-32001` analog on our wire).
        let line = crate::protocol::response_line(&refused);
        assert_eq!(
            line["errorInfo"]["code"],
            serde_json::json!("worker_overloaded")
        );
        assert!(
            resident.pending.lock().await.is_empty(),
            "the refused request never entered the in-flight set"
        );

        let waited = supervisor
            .route_command_typed(
                &resident,
                "shutdown",
                serde_json::json!({}),
                25,
                RouteAdmission::SupervisorInternal,
            )
            .await;
        assert_eq!(
            waited.unwrap_err().to_string(),
            "Session worker timed out",
            "a saturated route waits out its budget, it never refuses"
        );
        assert!(resident.pending.lock().await.is_empty());

        // One freed slot admits the next client command again.
        held.pop();
        let admitted = supervisor
            .route_command_typed(
                &resident,
                "get_state",
                serde_json::json!({}),
                25,
                RouteAdmission::ClientRequest,
            )
            .await;
        assert_eq!(
            admitted.unwrap_err().to_string(),
            "Session worker timed out",
            "a freed slot admits the request; only the wedged worker's silence fails it"
        );
    }

    #[tokio::test]
    async fn a_saturated_internal_route_admits_once_a_slot_frees() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = supervisor(dir.path());
        let resident = resident("w-busy");
        let (_cmd_tx, _cmd_rx) = wedged_worker(&resident).await;
        let inflight = Arc::clone(&resident.inflight);
        let mut held = Vec::new();
        for _ in 0..WORKER_INFLIGHT_CAPACITY {
            held.push(inflight.clone().acquire_owned().await.expect("permit"));
        }
        let waiting = {
            let supervisor = std::sync::Arc::new(supervisor);
            let resident = Arc::clone(&resident);
            tokio::spawn(async move {
                supervisor
                    .route_command_typed(
                        &resident,
                        "get_state",
                        serde_json::json!({}),
                        5_000,
                        RouteAdmission::SupervisorInternal,
                    )
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            resident.pending.lock().await.is_empty(),
            "the waiting route has not been admitted yet"
        );
        held.pop();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if resident.pending.lock().await.len() == 1 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the freed slot never admitted the internal route"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        waiting.abort();
    }

    #[tokio::test]
    async fn a_full_queue_answers_client_requests_with_the_same_refusal() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = supervisor(dir.path());
        let resident = resident("w-wedged");
        let (cmd_tx, _cmd_rx) = wedged_worker(&resident).await;
        // Fill the queue while every in-flight slot stays free.
        for _ in 0..WORKER_INFLIGHT_CAPACITY {
            let _ = cmd_tx.try_send(WorkerRequest {
                request_id: uuid::Uuid::new_v4().to_string(),
                command_type: "get_state".to_string(),
                payload: serde_json::json!({}),
            });
        }
        let refused = supervisor
            .route_command_typed(
                &resident,
                "get_state",
                serde_json::json!({}),
                5_000,
                RouteAdmission::ClientRequest,
            )
            .await
            .expect("the full queue answers, never parks");
        assert!(!refused.success);
        assert_eq!(
            refused.error.as_deref(),
            Some("Session worker w-wedged is overloaded; retry later")
        );
        assert_eq!(
            refused.error_info,
            Some(pa_types::daemon::DaemonErrorInfo::WorkerOverloaded)
        );
        assert!(
            resident.pending.lock().await.is_empty(),
            "the refused request never entered the in-flight set"
        );
        let waited = supervisor
            .route_command_typed(
                &resident,
                "shutdown",
                serde_json::json!({}),
                25,
                RouteAdmission::SupervisorInternal,
            )
            .await;
        assert_eq!(
            waited.unwrap_err().to_string(),
            "Session worker timed out",
            "a full queue never refuses internal traffic"
        );
    }

    /// The retire-then-release straddle of the idle passivation fence
    /// (a client route whose readiness check preceded the retire): a
    /// retired worker refuses the client route after admission, before
    /// anything is enqueued behind the stop.
    #[tokio::test]
    async fn a_retired_worker_admits_no_client_request() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = supervisor(dir.path());
        let resident = resident("w-retired");
        let (_cmd_tx, mut cmd_rx) = wedged_worker(&resident).await;
        resident.note_retired();
        let error = supervisor
            .route_command_typed(
                &resident,
                "cron_add",
                serde_json::json!({}),
                50,
                RouteAdmission::ClientRequest,
            )
            .await
            .expect_err("a retired worker refuses the client route");
        assert_eq!(error.to_string(), crate::supervisor::WORKER_NOT_CONNECTED);
        assert!(
            cmd_rx.try_recv().is_err(),
            "nothing was enqueued behind the retire"
        );
    }
}
