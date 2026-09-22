//! The supervisor's session input-pause lease bookkeeping (protocol
//! breadth wave b8): the supervisor arms for `acquire_session_input_pause`
//! and `release_session_input_pause` (TS daemon-supervisor `case
//! "acquire_session_input_pause"` / `case "release_session_input_pause"`),
//! the per-connection state those leases live against (the TS
//! `sessionInputPauseEpochs` / `detachingInputPauseSessions` maps), and
//! the detach/reattach/disconnect bookkeeping around them.
//!
//! The supervisor owns the lease table; the worker owns the pause itself
//! (the admission gate in [`crate::session_input_pause`]). The supervisor
//! rewrite makes the worker's lease key connection-unique -
//! `JSON.stringify([connectionId, ownerClientId, leaseKey])` - so two
//! connections of the same protocol client id never share a pause, and it
//! records the lease so a `detach`, a `reattach`, or a disconnect releases
//! the worker-side pause with the client.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::protocol::{response_failure, response_line, response_success};
use crate::supervisor::{Supervisor, ROUTE_TIMEOUT_MS};

/// Per-client-connection state the pause leases read (TS
/// `DaemonSocketClient` bookkeeping): the connection identity the lease
/// keys embed, the epoch a detach bumps (an in-flight acquire invalidates
/// instead of recording), and the sessions the client is detaching.
pub(crate) struct ClientConnectionState {
    /// Connection-unique id (the TS `connectionIds` entry): one per socket,
    /// distinct from the protocol client id the client may override.
    connection_id: String,
    pause_epoch: AtomicU64,
    detaching_sessions: std::sync::Mutex<HashSet<String>>,
    /// The connection's prompt-admission registry (wave b9, TS
    /// `promptAdmissions` per client): the `prompt`/`prompt_and_wait`
    /// admissions and their cancellation states.
    pub(crate) prompt_admissions: crate::prompt_admission::PromptAdmissionTable,
}

impl ClientConnectionState {
    pub(crate) fn new() -> Self {
        ClientConnectionState {
            connection_id: uuid::Uuid::new_v4().to_string(),
            pause_epoch: AtomicU64::new(0),
            detaching_sessions: std::sync::Mutex::new(HashSet::new()),
            prompt_admissions: crate::prompt_admission::PromptAdmissionTable::default(),
        }
    }

    pub(crate) fn connection_id(&self) -> &str {
        &self.connection_id
    }

    fn pause_epoch(&self) -> u64 {
        self.pause_epoch.load(Ordering::SeqCst)
    }

    fn bump_pause_epoch(&self) {
        self.pause_epoch.fetch_add(1, Ordering::SeqCst);
    }

    fn is_detaching(&self, active_session_id: &str) -> bool {
        self.detaching_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(active_session_id)
    }

    /// The detach mark (TS `detachingInputPauseSessions.add`): a session in
    /// the set answers every later acquire with the TS detaching error
    /// until a reattach clears it.
    fn mark_detaching(&self, sessions: impl IntoIterator<Item = String>) {
        let mut detaching = self
            .detaching_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for session in sessions {
            detaching.insert(session);
        }
    }

    /// The reattach clear (TS `detachingSessions?.delete`): a reattached
    /// session may acquire pauses again.
    fn clear_detaching(&self, sessions: impl IntoIterator<Item = String>) {
        let mut detaching = self
            .detaching_sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for session in sessions {
            detaching.remove(&session);
        }
    }
}

impl Default for ClientConnectionState {
    fn default() -> Self {
        Self::new()
    }
}

/// One recorded lease (TS `SupervisorSessionInputPause`).
#[derive(Debug, Clone)]
pub(crate) struct SupervisorPauseEntry {
    /// The connection that holds the lease (the TS `owner` client object).
    owner_connection_id: String,
    worker_id: String,
    /// The resolved session the worker pauses (the lease's release
    /// targets).
    active_session_id: String,
    /// The selector the client originally sent (a release may address
    /// either form).
    requested_active_session_id: String,
    /// The client's raw lease key (the dedupe key).
    lease_key: String,
}

impl Supervisor {
    /// `acquire_session_input_pause`: resolve the session, rewrite the
    /// lease key, forward to the worker, and record the lease. The TS
    /// outcome ladder: a detaching session answers the TS error, an
    /// identical lease answers its existing pause id, a worker failure
    /// passes through, and an epoch change during the round trip
    /// invalidates the acquisition.
    pub(crate) async fn handle_acquire_session_input_pause(
        self: &Arc<Self>,
        connection: &Arc<ClientConnectionState>,
        command: &pa_types::daemon::DaemonCommand,
        effective_client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let pa_types::daemon::DaemonCommand::AcquireSessionInputPause {
            active_session_id,
            lease_key,
            ..
        } = command
        else {
            return self.pause_failure(command_id, type_name, "invalid command");
        };
        if connection.is_detaching(active_session_id) {
            return self.pause_failure(
                command_id,
                type_name,
                &format!("Session is detaching: {active_session_id}"),
            );
        }
        let resident = match self.registry.resolve(active_session_id).await {
            Ok(resident) => resident,
            Err(_) => {
                // The wake-aware resolution of the generic route: a
                // restore pass may still be bringing the session up.
                self.await_restore_target(active_session_id).await;
                match self.registry.resolve(active_session_id).await {
                    Ok(resident) => resident,
                    Err(_) => {
                        let message =
                            self.restore_failure_for(active_session_id)
                                .unwrap_or_else(|| {
                                    format!("Unknown active session: {active_session_id}")
                                });
                        return self.pause_failure(command_id, type_name, &message);
                    }
                }
            }
        };
        let resolved = resident.worker_id.clone();
        if connection.is_detaching(active_session_id) || connection.is_detaching(&resolved) {
            return self.pause_failure(
                command_id,
                type_name,
                &format!("Session is detaching: {active_session_id}"),
            );
        }
        let owner_connection = connection.connection_id().to_string();
        let owner_client = effective_client_id.to_string();
        // The identical-lease dedupe (TS `existing`): the same connection,
        // worker, session, and lease key answers the recorded pause id.
        {
            let pauses = self.input_pauses.leases.lock().await;
            for (pause_id, entry) in pauses.iter() {
                if entry.owner_connection_id == owner_connection
                    && entry.worker_id == resident.worker_id
                    && entry.active_session_id == resolved
                    && entry.lease_key == *lease_key
                {
                    return self.pause_success(command_id, type_name, pause_id);
                }
            }
        }
        let epoch = connection.pause_epoch();
        let rewritten_lease =
            serde_json::to_string(&json!([owner_connection, owner_client, lease_key]))
                .expect("lease key serializes");
        let payload = json!({
            "activeSessionId": resolved,
            "leaseKey": rewritten_lease,
            "clientId": owner_connection,
        });
        let mut response = match self
            .route_command(
                &resident,
                "acquire_session_input_pause",
                payload,
                ROUTE_TIMEOUT_MS,
            )
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return self.pause_failure(command_id, type_name, &error.to_string());
            }
        };
        response.id = Some(command_id.to_string());
        if !response.success {
            return (vec![response_line(&response)], false);
        }
        let Some(pause_id) = response
            .data
            .as_ref()
            .and_then(|data| data.get("pauseId"))
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return self.pause_failure(
                command_id,
                type_name,
                "Worker returned an invalid session input pause id",
            );
        };
        let invalidated = connection.pause_epoch() != epoch;
        self.input_pauses.leases.lock().await.insert(
            pause_id.clone(),
            SupervisorPauseEntry {
                owner_connection_id: owner_connection,
                worker_id: resident.worker_id.clone(),
                active_session_id: resolved,
                requested_active_session_id: active_session_id.clone(),
                lease_key: lease_key.clone(),
            },
        );
        if invalidated {
            // The lease is recorded so the disconnect cleanup releases
            // it, but the client sees the TS invalidation error (the
            // supervisor re-keyed its connection bookkeeping under the
            // acquiring round trip).
            return self.pause_failure(
                command_id,
                type_name,
                "Session input pause acquisition was invalidated before completion",
            );
        }
        (vec![response_line(&response)], false)
    }

    /// `release_session_input_pause`: the TS outcome ladder - an unknown
    /// pause id answers the plain success, a lease another connection
    /// holds answers the ownership error, a lease for another session
    /// answers the session error, and the owner's release forwards to the
    /// worker and drops the lease. Concurrent releases coalesce on the
    /// table lock (the wire outcome matches the TS `releaseTask` share).
    pub(crate) async fn handle_release_session_input_pause(
        self: &Arc<Self>,
        connection: &Arc<ClientConnectionState>,
        command: &pa_types::daemon::DaemonCommand,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let pa_types::daemon::DaemonCommand::ReleaseSessionInputPause {
            active_session_id,
            pause_id,
            ..
        } = command
        else {
            return self.pause_failure(command_id, type_name, "invalid command");
        };
        let mut pauses = self.input_pauses.leases.lock().await;
        let Some(entry) = pauses.get(pause_id).cloned() else {
            drop(pauses);
            return self.pause_plain_success(command_id, type_name);
        };
        if entry.owner_connection_id != connection.connection_id() {
            drop(pauses);
            return self.pause_failure(
                command_id,
                type_name,
                &format!("Session input pause is owned by another client: {pause_id}"),
            );
        }
        if *active_session_id != entry.active_session_id
            && *active_session_id != entry.requested_active_session_id
        {
            drop(pauses);
            return self.pause_failure(
                command_id,
                type_name,
                &format!("Session input pause belongs to another session: {pause_id}"),
            );
        }
        // A worker that left the registry takes its lease with it (the TS
        // gone-worker cleanup deletes the entry).
        let Some(resident) = self.registry.get(&entry.worker_id).await else {
            pauses.remove(pause_id);
            drop(pauses);
            return self.pause_plain_success(command_id, type_name);
        };
        let payload = json!({
            "activeSessionId": entry.active_session_id,
            "pauseId": pause_id,
            "clientId": entry.owner_connection_id,
        });
        let response = self
            .route_command(
                &resident,
                "release_session_input_pause",
                payload,
                ROUTE_TIMEOUT_MS,
            )
            .await;
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                drop(pauses);
                return self.pause_failure(command_id, type_name, &error.to_string());
            }
        };
        response.id = Some(command_id.to_string());
        if response.success {
            pauses.remove(pause_id);
        }
        drop(pauses);
        (vec![response_line(&response)], false)
    }

    /// The detach bookkeeping around a client `detach` (TS supervisor
    /// detach arm): mark the detaching sessions, bump the connection epoch,
    /// then (after the routed detach answered) release the client's leases
    /// for those sessions.
    pub(crate) async fn begin_detach_pause_bookkeeping(
        &self,
        connection: &Arc<ClientConnectionState>,
        active_session_id: Option<&str>,
        attached: &[String],
    ) -> Vec<String> {
        let sessions: Vec<String> = match active_session_id {
            Some(selector) => vec![selector.to_string()],
            None => attached.to_vec(),
        };
        connection.mark_detaching(sessions.clone());
        connection.bump_pause_epoch();
        sessions
    }

    /// Release the leases the detaching client holds for the marked
    /// sessions (TS `releaseClientSessionInputPauses` with the session
    /// filter); best-effort - a worker that cannot be reached keeps its
    /// lease entry for the disconnect cleanup.
    pub(crate) async fn release_client_pauses_for_sessions(
        &self,
        connection: &Arc<ClientConnectionState>,
        sessions: &[String],
    ) {
        let entries: Vec<(String, SupervisorPauseEntry)> = self
            .input_pauses
            .leases
            .lock()
            .await
            .iter()
            .filter(|(_, entry)| {
                entry.owner_connection_id == connection.connection_id()
                    && (sessions.is_empty()
                        || sessions.contains(&entry.active_session_id)
                        || sessions.contains(&entry.requested_active_session_id))
            })
            .map(|(pause_id, entry)| (pause_id.clone(), entry.clone()))
            .collect();
        for (pause_id, entry) in entries {
            if let Some(resident) = self.registry.get(&entry.worker_id).await {
                let payload = json!({
                    "activeSessionId": entry.active_session_id,
                    "pauseId": pause_id,
                    "clientId": entry.owner_connection_id,
                });
                let released = self
                    .route_command(
                        &resident,
                        "release_session_input_pause",
                        payload,
                        ROUTE_TIMEOUT_MS,
                    )
                    .await
                    .map(|response| response.success)
                    .unwrap_or(false);
                if released {
                    self.input_pauses.leases.lock().await.remove(&pause_id);
                    continue;
                }
            }
            // The worker is gone or refused: the lease cannot be released
            // remotely, so drop the record (TS deletes the entry when the
            // worker left).
            self.input_pauses.leases.lock().await.remove(&pause_id);
        }
    }

    /// The reattach clear (TS reattach arm): reattached sessions may
    /// acquire pauses again.
    pub(crate) fn clear_detaching_after_reattach(
        &self,
        connection: &Arc<ClientConnectionState>,
        sessions: &[String],
    ) {
        connection.clear_detaching(sessions.iter().cloned());
    }

    /// The disconnect cleanup (TS socket `cleanup`): bump the epoch so
    /// in-flight acquisitions invalidate, then release every lease the
    /// connection held (all sessions - the connection is going away).
    pub(crate) async fn release_all_client_pauses(&self, connection: &Arc<ClientConnectionState>) {
        connection.bump_pause_epoch();
        self.release_client_pauses_for_sessions(connection, &[])
            .await;
    }

    fn pause_failure(&self, command_id: &str, type_name: &str, error: &str) -> (Vec<Value>, bool) {
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

    fn pause_success(
        &self,
        command_id: &str,
        type_name: &str,
        pause_id: &str,
    ) -> (Vec<Value>, bool) {
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                Some(json!({ "pauseId": pause_id })),
            ))],
            false,
        )
    }

    fn pause_plain_success(&self, command_id: &str, type_name: &str) -> (Vec<Value>, bool) {
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                None,
            ))],
            false,
        )
    }
}

/// The pause-lease table the supervisor owns (pause id -> lease).
#[derive(Debug, Default)]
pub(crate) struct SupervisorPauseTable {
    pub(crate) leases: tokio::sync::Mutex<HashMap<String, SupervisorPauseEntry>>,
}
