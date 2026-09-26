//! Bounded backpressure on the supervisor's request path (the Codex
//! `app-server-transport` mirror, comparison report finding 4).
//!
//! Codex fronts its one `app-server` process with a bounded internal queue
//! (`CHANNEL_CAPACITY = 128`, `app-server-transport/src/transport/mod.rs:21-24`)
//! and answers a request that finds it full with an explicit typed error
//! (`-32001 "Server overloaded; retry later."`, `mod.rs:228-259`) instead of
//! blocking or dropping; non-request traffic awaits (`mod.rs:265`), and each
//! connection drains a deep bounded outbound queue (32K messages with a
//! compile-time headroom assert, `websocket.rs:46-49`).
//!
//! This daemon fronts N per-session worker processes, so the same guarantees
//! adapt per unit: [`WORKER_INFLIGHT_CAPACITY`] bounds the in-flight
//! requests of one worker (128, like Codex's single-process bound — the
//! supervisor's aggregate bound is `128 * N`, and a flooding client
//! exhausts only the session it floods), and
//! [`CLIENT_OUTBOUND_CAPACITY`] bounds one client connection's outbound
//! queue (the 32K mirror). A request-shaped client command that finds its
//! worker saturated is answered with the typed [`DaemonErrorInfo`]
//! `worker_overloaded` refusal (the `-32001` analog): the request never
//! entered the queue, so nothing is dropped silently and a retry cannot
//! duplicate it. Supervisor-internal routes (stop/kill, create replay,
//! disconnect cleanup, polls) are never refused — they wait for a slot
//! inside the route's own timeout budget, the same backpressure split
//! Codex makes between requests and notifications.

use pa_types::daemon::DaemonErrorInfo;

use crate::protocol::{response_failure, DaemonResponse};

/// In-flight requests one worker accepts before its route saturates. Also
/// the bound of the supervisor-to-worker command channel: admission (an
/// in-flight permit) precedes enqueue, so the queue and the in-flight set
/// share this one bound — a wedged writer parks at most this many frames.
///
/// Codex's value for its one-process daemon (`CHANNEL_CAPACITY = 128`):
/// "128 messages should be plenty for an interactive CLI" — the same holds
/// for the one session one of our workers serves.
pub(crate) const WORKER_INFLIGHT_CAPACITY: usize = 128;

/// Capacity of the supervisor's shared client event broadcast ring. The
/// ring's per-receiver drop on lag is the defined backpressure for a slow
/// reader (the supervisor must never block on one client); the connection
/// loop's lag arm makes every drop observable in the daemon log.
pub(crate) const EVENT_RING_CAPACITY: usize = 4096;

/// Outbound response bundles one client connection may hold before its
/// senders stall. A wedged client (reading nothing) stalls only its own
/// dispatch tasks at this bound — worker slots free as replies arrive, so
/// other clients and workers are unaffected.
///
/// The Codex `WEBSOCKET_OUTBOUND_CHANNEL_CAPACITY = 32 * 1024` mirror:
/// "WebSocket clients can briefly lag behind normal turn output bursts
/// while the writer task is healthy, so give them more headroom than
/// internal channels."
pub(crate) const CLIENT_OUTBOUND_CAPACITY: usize = 32 * 1024;
const _: () = assert!(CLIENT_OUTBOUND_CAPACITY > WORKER_INFLIGHT_CAPACITY);

/// Concurrent dispatch tasks one client connection may run. The
/// connection loop acquires a permit per inbound command BEFORE spawning
/// its dispatch task: once this bound is reached the loop stops reading
/// the client's socket, and the client's own send buffer carries any
/// further input — transport-level flow control instead of unbounded
/// daemon-side task spawn. A healthy connection runs a handful of
/// concurrent commands (a turn, a poll, a streaming list); the bound is
/// generous headroom for one client with many sessions.
pub(crate) const CLIENT_DISPATCH_CONCURRENCY: usize = 64;

/// What a route does when its worker is at the in-flight bound. Codex's
/// split: a request answers the explicit overload error immediately
/// (`mod.rs:228-259`), a notification awaits capacity (`mod.rs:265`).
#[derive(Clone, Copy)]
pub(crate) enum RouteAdmission {
    /// A client's request-shaped command: the route answers the typed
    /// `worker_overloaded` refusal the moment the worker saturates. The
    /// caller retries; the request was never queued, so the retry cannot
    /// duplicate it.
    ClientRequest,
    /// Supervisor-internal traffic (stop/kill, create replay, disconnect
    /// cleanup, polls): the route waits for an in-flight slot inside its
    /// own timeout budget and surfaces the existing timeout error if the
    /// budget runs out — control-plane traffic is never refused.
    SupervisorInternal,
}

/// The saturated-route refusal a client command answers: typed
/// `worker_overloaded` on the wire, the worker id in the message so a
/// multi-session client knows which session to retry. The id is stamped by
/// the client-facing seam like every worker response's.
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

    /// Install a live command channel nobody drains (the returned halves
    /// must outlive the routes under test, or the channel would read as a
    /// dead connection): a wedged worker that accepts frames but never
    /// answers.
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
            socket_path: dir.join("daemon.sock"),
            agent_dir: dir.join("agent"),
        })
        .expect("supervisor")
    }

    /// The regression at the heart of the finding: a request-shaped client
    /// command that finds its worker at the in-flight bound is answered
    /// with the explicit typed refusal — never queued, never dropped,
    /// never a silent timeout — while supervisor-internal traffic waits
    /// inside its budget and surfaces the budget error instead.
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

        // The client command answers the overload refusal — an answer, not
        // an error and not a dropped request.
        let refused = supervisor
            .route_command(
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
        // Nothing was queued or held: the refusal was the whole exchange.
        assert!(
            resident.pending.lock().await.is_empty(),
            "the refused request never entered the in-flight set"
        );

        // Internal traffic at the same bound never refuses: it waits out
        // its budget and surfaces the budget error.
        let waited = supervisor
            .route_command(
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

        // One freed slot admits the next client command again (it queues
        // and waits for its reply — bounded, visible, retryable).
        held.pop();
        let admitted = supervisor
            .route_command(
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

    /// The saturated internal route does not hold anything while it waits:
    /// a slot freed mid-budget admits it (control-plane traffic recovers
    /// with the worker instead of refusing).
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
                    .route_command(
                        &resident,
                        "get_state",
                        serde_json::json!({}),
                        5_000,
                        RouteAdmission::SupervisorInternal,
                    )
                    .await
            })
        };
        // Still waiting on admission, nothing queued.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            resident.pending.lock().await.is_empty(),
            "the waiting route has not been admitted yet"
        );
        // Freeing a slot admits the waiting route into the in-flight set.
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

    /// The other saturation seam: a wedged writer whose parked frames
    /// outlived their routes' budgets leaves free in-flight slots behind a
    /// full queue — the client request must still answer the same explicit
    /// refusal (never a silent queue-park), and internal traffic still
    /// only ever waits.
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
            .route_command(
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
            .route_command(
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
}
