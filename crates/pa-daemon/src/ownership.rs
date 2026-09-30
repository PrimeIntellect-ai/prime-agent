//! The owned-session and worker-recovery surface (protocol breadth wave
//! b9): the supervisor arms for `complete_owned_session`,
//! `promote_owned_session`, and `retry_worker` (TS daemon-supervisor
//! `case "complete_owned_session"` / `case "promote_owned_session"` /
//! `case "retry_worker"` + `promoteOwnedWorker` / `retryWorkerRecovery`).
//!
//! A worker is client-owned while its descriptor carries `ownerClientId`
//! (the creating client's id, stamped by `handle_create`). `complete`/`
//! promote` move that ownership: completing stops the owned worker (the
//! TS `stopWorker` cleanup), promoting clears the owner so the session
//! outlives its creating client. `retry_worker` is the supervisor's
//! manual recovery trigger (the audit's fix: the Rust supervisor
//! previously routed it to the worker, which answered the unknown-worker
//! error instead of recovering).

use std::sync::Arc;

use serde_json::{json, Value};

use pa_types::daemon::{DaemonCommand, DaemonWorkerLifecycle};

use crate::backpressure::RouteAdmission;
use crate::descriptor::persist_worker;
use crate::protocol::{response_failure, response_line, response_success};
use crate::registry::ResidentWorker;
use crate::supervisor::{Supervisor, ROUTE_TIMEOUT_MS};

impl Supervisor {
    /// Resolve the resident a `retry_worker` targets: the direct match on
    /// the root active session id or the root persisted session id (TS
    /// `direct`), then the generic selector resolution. This is the ONE
    /// descriptor-scan primitive behind the owned-session arms
    /// (`complete_owned_session`, `promote_owned_session`,
    /// `retry_worker`), so the boot-reconciliation quarantine fences
    /// HERE, by construction: a quarantined resident's descriptor never
    /// matches — a `retry_worker` with a superseded durable id must not
    /// reach the live-but-unreconciled worker (its summary would name the
    /// wrong session, and a disconnected one would RELAUNCH the stale
    /// persisted create path). The refusal reads as the unknown session —
    /// the conservative miss, never a route on the unreconciled identity.
    async fn resolve_retry_target(&self, selector: &str) -> Result<Arc<ResidentWorker>, String> {
        for resident in self.registry.list().await {
            if resident.identity_quarantined() {
                continue;
            }
            let matches = {
                let descriptor = resident.descriptor.lock().await;
                descriptor.root_active_session_id == selector
                    || descriptor.root_session_id.as_deref() == Some(selector)
            };
            if matches {
                return Ok(resident);
            }
        }
        match self.registry.resolve(selector).await {
            Ok(resident) => Ok(resident),
            Err(_) => Err(format!("Unknown active session: {selector}")),
        }
    }

    /// `complete_owned_session`: the owner stops its session worker (the
    /// TS ownership check, then `stopWorker`).
    pub(crate) async fn handle_complete_owned_session(
        self: &Arc<Self>,
        command: &DaemonCommand,
        effective_client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let DaemonCommand::CompleteOwnedSession {
            active_session_id, ..
        } = command
        else {
            return Self::owned_failure(command_id, type_name, "invalid command");
        };
        let resident = match self.resolve_retry_target(active_session_id).await {
            Ok(resident) => resident,
            Err(error) => return Self::owned_failure(command_id, type_name, &error),
        };
        let owner = resident.descriptor.lock().await.owner_client_id.clone();
        if owner.as_deref() != Some(effective_client_id) {
            return Self::owned_failure(
                command_id,
                type_name,
                "Session is not owned by this client",
            );
        }
        // TS `stopWorker`: the owned stop tears the worker down; the
        // ephemeral schedule cancel (`cancelEphemeralWorkerScheduledJobs`)
        // rides `stop_worker` itself, keyed on the descriptor's owner. The
        // stop's durable intent persists before the worker is told, and a
        // persist failure fails the owned stop (TS throws) instead of
        // stopping an untombstoned worker.
        if let Err(error) = self.stop_worker(&resident).await {
            return Self::owned_failure(
                command_id,
                type_name,
                &format!("Failed to persist the session stop: {error:#}"),
            );
        }
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                None,
            ))],
            false,
        )
    }

    /// `promote_owned_session`: the owner clears the ownership so the
    /// session outlives its creating client (TS `promoteOwnedWorker`).
    /// The response carries the session's public summary.
    pub(crate) async fn handle_promote_owned_session(
        self: &Arc<Self>,
        command: &DaemonCommand,
        effective_client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let DaemonCommand::PromoteOwnedSession {
            active_session_id, ..
        } = command
        else {
            return Self::owned_failure(command_id, type_name, "invalid command");
        };
        let resident = match self.resolve_retry_target(active_session_id).await {
            Ok(resident) => resident,
            Err(error) => return Self::owned_failure(command_id, type_name, &error),
        };
        let previous_owner = {
            let mut descriptor = resident.descriptor.lock().await;
            match descriptor.owner_client_id.clone() {
                Some(owner) if owner == effective_client_id => {
                    descriptor.owner_client_id = None;
                    // The promotion marker (TS `promotedOwnerClientId`): a
                    // repeat promote by the same client stays a no-op.
                    descriptor
                        .rest
                        .insert("promotedOwnerClientId".to_string(), json!(owner));
                    if let Err(error) = persist_worker(&resident.descriptor_path, &descriptor) {
                        return Self::owned_failure(command_id, type_name, &error.to_string());
                    }
                    true
                }
                None => {
                    // Already promoted: a repeat by the promoting client is
                    // a no-op, anyone else never owned it.
                    descriptor
                        .rest
                        .get("promotedOwnerClientId")
                        .and_then(Value::as_str)
                        == Some(effective_client_id)
                }
                Some(_) => false,
            }
        };
        if !previous_owner {
            return Self::owned_failure(
                command_id,
                type_name,
                "Session is not owned by this client",
            );
        }
        // The fresh public summary (TS `publicSummary`).
        let summary = self.retry_summary(&resident).await;
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                summary,
            ))],
            false,
        )
    }

    /// `retry_worker`: the supervisor's manual recovery trigger (TS
    /// supervisor arm - the worker never sees it): clear the stop
    /// markers, reconnect or relaunch the worker, and answer the
    /// session's summary (`data: null` when none can be read).
    pub(crate) async fn handle_retry_worker(
        self: &Arc<Self>,
        command: &DaemonCommand,
        effective_client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let DaemonCommand::RetryWorker {
            active_session_id, ..
        } = command
        else {
            return Self::owned_failure(command_id, type_name, "invalid command");
        };
        let resident = match self.resolve_retry_target(active_session_id).await {
            Ok(resident) => resident,
            Err(error) => return Self::owned_failure(command_id, type_name, &error),
        };
        // The client access gate (TS `assertWorkerAccessibleToClient`): a
        // worker another client owns is invisible through this selector.
        {
            let descriptor = resident.descriptor.lock().await;
            if let Some(owner) = descriptor.owner_client_id.as_deref() {
                if owner != effective_client_id {
                    return Self::owned_failure(
                        command_id,
                        type_name,
                        &format!("Unknown active session: {active_session_id}"),
                    );
                }
            }
        }
        if self.is_stopping(&resident) {
            return Self::owned_failure(
                command_id,
                type_name,
                "Session worker is stopping; retry after it finishes",
            );
        }
        // The recovery reset (TS `retryWorkerRecovery`): the intentional-stop
        // marker and the persisted stop flags go, the lifecycle reports
        // recovering until the relaunch lands.
        resident
            .intentional_stop
            .store(false, std::sync::atomic::Ordering::SeqCst);
        resident
            .consecutive_failures
            .store(0, std::sync::atomic::Ordering::SeqCst);
        let last_error = {
            let mut descriptor = resident.descriptor.lock().await;
            descriptor.stop_requested_at = None;
            descriptor.archive_on_stop = None;
            descriptor.lifecycle = DaemonWorkerLifecycle::Recovering;
            let last_error = descriptor.last_error.clone();
            let _ = persist_worker(&resident.descriptor_path, &descriptor);
            last_error
        };
        let connected = resident.cmd_tx.lock().await.is_some();
        if connected {
            // A live worker's recovery is the marker reset itself: the
            // connection answers the lifecycle (TS `effectiveWorkerState`
            // reports a ready, connected worker as ready).
            let mut descriptor = resident.descriptor.lock().await;
            descriptor.lifecycle = DaemonWorkerLifecycle::Ready;
            let _ = persist_worker(&resident.descriptor_path, &descriptor);
        } else if let Err(error) = self.relaunch_worker(&resident).await {
            return Self::owned_failure(
                command_id,
                type_name,
                &last_error.unwrap_or_else(|| error.to_string()),
            );
        }
        let lifecycle = resident.descriptor.lock().await.lifecycle;
        if lifecycle != DaemonWorkerLifecycle::Ready {
            return Self::owned_failure(
                command_id,
                type_name,
                &last_error.unwrap_or_else(|| "Session worker recovery failed".to_string()),
            );
        }
        let summary = self.retry_summary(&resident).await;
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                summary,
            ))],
            false,
        )
    }

    /// The worker's current summary via `get_state` (`None` when the
    /// worker cannot answer - the TS arm answers `data: null` then).
    async fn retry_summary(&self, resident: &Arc<ResidentWorker>) -> Option<Value> {
        match self
            .route_command_typed(
                resident,
                "get_state",
                json!({}),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await
        {
            Ok(response) if response.success => response.data,
            _ => None,
        }
    }

    fn owned_failure(command_id: &str, type_name: &str, error: &str) -> (Vec<Value>, bool) {
        (
            vec![response_line(&response_failure(
                Some(command_id),
                type_name,
                error,
                None,
            ))],
            false,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pa_types::daemon::DaemonWorkerDescriptor;
    use serde_json::json;

    use crate::registry::ResidentWorker;
    use crate::supervisor::Supervisor;
    use crate::supervisor_roster::WorkerRosterDelta;

    /// One supervisor with one registered resident whose persisted identity
    /// (`s0` / `s0.jsonl`) the quarantine fence must never serve.
    async fn supervisor_with_stale_identity(dir: &std::path::Path) -> Arc<Supervisor> {
        let supervisor = Arc::new(
            Supervisor::new(crate::supervisor::SupervisorOptions {
                socket_path: dir.join("daemon.sock"),
                agent_dir: dir.join("agent"),
            })
            .expect("supervisor"),
        );
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
            "version": 2,
            "workerId": "w-a",
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "token-a",
            "rootActiveSessionId": "w-a",
            "rootSessionId": "s0",
            "sessionFile": dir.join("s0.jsonl").to_string_lossy(),
            "createdAt": "2026-09-30T00:00:00Z",
            "updatedAt": "2026-09-30T00:00:00Z",
            "lifecycle": "ready",
            "createCommand": { "sessionPath": dir.join("s0.jsonl").to_string_lossy() },
            "consecutiveFailures": 0,
        }))
        .expect("descriptor");
        supervisor
            .registry
            .insert(ResidentWorker::new(
                "w-a".to_string(),
                descriptor,
                dir.join("w-a.json"),
            ))
            .await;
        supervisor
    }

    /// The boot-reconciliation quarantine fences the owned-session scan:
    /// a `retry_worker`/`complete`/`promote` selector — the address OR the
    /// OLD durable id — never reaches a live-but-unreconciled worker
    /// (whose summary would name the wrong session, or whose relaunch
    /// would replay the stale persisted create path). The live word
    /// (the worker's own roster push) reconciles the identity and the
    /// scan serves again — on the reconciled identity only.
    #[tokio::test]
    async fn the_owned_session_scan_refuses_a_quarantined_identity() {
        let dir = std::env::temp_dir().join(format!("pa-own-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let supervisor = supervisor_with_stale_identity(&dir).await;
        let resident = supervisor.registry.get("w-a").await.expect("resident");

        // The quarantined boot outcome: every owned-session selector
        // refuses — the address AND the stale persisted durable id.
        resident.mark_identity_quarantined();
        assert!(
            supervisor.resolve_retry_target("w-a").await.is_err(),
            "the quarantined address never serves the owned-session arms"
        );
        assert!(
            supervisor.resolve_retry_target("s0").await.is_err(),
            "the stale persisted durable id never reaches the worker"
        );

        // The live word: the worker's own roster push (no command
        // channel involved) reconciles the identity onto sA.
        let summary = json!({
            "id": "w-a",
            "lifecycle": "live",
            "activity": "idle",
            "isSessionActive": false,
            "activeSessionId": "w-a",
            "sessionId": "sA",
            "sessionFile": dir.join("a.jsonl").to_string_lossy(),
            "sessionName": "owned",
            "cwd": dir.to_string_lossy(),
            "rlmDepth": 0,
            "runtimeKind": "top-level",
            "messageCount": 1,
            "attachedClients": 0,
            "thinkingLevel": "default",
            "workerState": "ready",
        });
        let response = supervisor
            .handle_worker_roster_delta(
                "d",
                "worker_roster_delta",
                WorkerRosterDelta {
                    worker_token: "token-a".to_string(),
                    summary,
                    removed: Vec::new(),
                    sequence: Some(1),
                    worker_instance_id: Some("i1".to_string()),
                },
            )
            .await;
        assert!(response.success, "the delta applied: {response:?}");

        // The scan serves again — the address resolves, and the OLD
        // durable id stays unresolvable (the identity moved; the stale
        // persisted id must never reach the worker again).
        let resolved = supervisor
            .resolve_retry_target("w-a")
            .await
            .expect("the address serves once reconciled");
        assert_eq!(
            resolved.descriptor.lock().await.root_session_id.as_deref(),
            Some("sA"),
            "the served identity is the reconciled one"
        );
        assert!(
            supervisor.resolve_retry_target("s0").await.is_err(),
            "the superseded durable id never resolves again"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
