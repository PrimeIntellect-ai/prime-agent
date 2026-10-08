//! The prompt-admission surface: the supervisor's cancellation registry
//! for `prompt` / `prompt_and_wait` and the worker-side admission
//! bookkeeping. A prompt carrying `admissionId` registers at dispatch and
//! clears when the route settles; `cancel_prompt_admission` answers the
//! TS status ladder.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::backpressure::RouteAdmission;
use crate::protocol::{response_failure, response_line, response_success, DaemonResponse};
use crate::supervisor::{
    client_command_payload, client_route_timeout, Supervisor, ROUTE_TIMEOUT_MS,
};
use crate::worker::Worker;

/// The admission status vocabulary (TS `SupervisorPromptAdmission.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AdmissionStatus {
    Waiting,
    Owned,
    Cancelled,
}

/// The TS admission key: session + public admission id.
fn prompt_admission_key(active_session_id: &str, admission_id: &str) -> String {
    format!("{active_session_id}\u{0}{admission_id}")
}

/// One registered admission (the TS supervisor record).
struct PromptAdmission {
    worker_admission_id: String,
    status: AdmissionStatus,
    worker_id: Option<String>,
    worker_active_session_id: Option<String>,
}

/// The per-connection admission registry.
#[derive(Default)]
pub(crate) struct PromptAdmissionTable {
    admissions: Mutex<HashMap<String, PromptAdmission>>,
}

impl PromptAdmissionTable {
    /// The TS parse-time registration: a `prompt/prompt_and_wait` carrying
    /// an `admissionId` reserves it (duplicates answer the TS error).
    pub(crate) fn register(
        &self,
        active_session_id: &str,
        admission_id: &str,
    ) -> Result<(), String> {
        // The TS checks in order: the empty admission id answers its own
        // error, then a missing session selector answers the generic one.
        if admission_id.is_empty() {
            return Err("admissionId must not be empty".to_string());
        }
        // The registry key joins its halves with NUL, so a NUL in either
        // half makes the separator ambiguous (a forged suffix match or a
        // different half-split of the same key).
        if admission_id.contains('\0') {
            return Err("admissionId must not contain NUL".to_string());
        }
        if active_session_id.is_empty() {
            return Err(
                "Prompt admission requires string activeSessionId and admissionId".to_string(),
            );
        }
        if active_session_id.contains('\0') {
            return Err("activeSessionId must not contain NUL".to_string());
        }
        let key = prompt_admission_key(active_session_id, admission_id);
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if admissions.contains_key(&key) {
            return Err(format!(
                "Prompt admission id is already in use: {admission_id}"
            ));
        }
        admissions.insert(
            key,
            PromptAdmission {
                worker_admission_id: format!("supervisor-admission:{}", uuid::Uuid::new_v4()),
                status: AdmissionStatus::Waiting,
                worker_id: None,
                worker_active_session_id: None,
            },
        );
        Ok(())
    }

    fn with<R>(&self, key: &str, f: impl FnOnce(&PromptAdmission) -> R) -> Option<R> {
        let admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        admissions.get(key).map(f)
    }

    fn update<R>(&self, key: &str, f: impl FnOnce(&mut PromptAdmission) -> R) -> Option<R> {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        admissions.get_mut(key).map(f)
    }

    /// Move one admission under a new key: `false` when the source is
    /// settled or the destination is occupied.
    fn rekey(&self, from: &str, to: &str) -> bool {
        if from == to {
            return true;
        }
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if admissions.contains_key(to) {
            return false;
        }
        match admissions.remove(from) {
            Some(admission) => {
                admissions.insert(to.to_string(), admission);
                true
            }
            None => false,
        }
    }

    /// The single admission whose key carries this admission id, when
    /// exactly one does (the admission id is its own idempotency key).
    fn sole_key_for_admission_id(&self, admission_id: &str) -> Option<String> {
        if admission_id.is_empty() {
            return None;
        }
        let suffix = format!("\u{0}{admission_id}");
        let admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut keys = admissions.keys().filter(|key| key.ends_with(&suffix));
        let first = keys.next()?.clone();
        keys.next().is_none().then_some(first)
    }

    fn remove(&self, key: &str) {
        self.admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(key);
    }

    /// The disconnect cleanup (TS `cancelWaitingPromptAdmissionsForClient`):
    /// every waiting admission cancels so its in-flight prompt fails.
    pub(crate) fn cancel_all_waiting(&self) {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for admission in admissions.values_mut() {
            if admission.status == AdmissionStatus::Waiting {
                admission.status = AdmissionStatus::Cancelled;
            }
        }
    }
}

/// The admission id a prompt-family command carries (the registration and
/// route hooks match the same pair). The wire field is the TS
/// `admissionId`: it rides the command's lossless `rest` map.
pub(crate) fn input_admission_id(command: &pa_types::daemon::DaemonCommand) -> Option<&str> {
    use pa_types::daemon::DaemonCommand;
    match command {
        DaemonCommand::Prompt { input, rest, .. }
        | DaemonCommand::PromptAndWait { input, rest, .. } => input
            .admission_id
            .as_deref()
            .or_else(|| rest.get("admissionId").and_then(Value::as_str)),
        _ => None,
    }
}

impl Supervisor {
    /// Route one admitted prompt: the cancellation checks around the worker
    /// round trip, the admission-id rewrite, and the owned commit.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn route_prompt_with_admission(
        self: &Arc<Self>,
        connection: &Arc<crate::input_pause_lease::ClientConnectionState>,
        command: &pa_types::daemon::DaemonCommand,
        client_id: &str,
        attached: &Arc<crate::supervisor::subscribers::ClientSubscriptions>,
        command_id: String,
        type_name: String,
        active_session_id: &str,
    ) -> (Vec<Value>, bool) {
        let mut key = prompt_admission_key(
            active_session_id,
            input_admission_id(command).unwrap_or_default(),
        );
        let cancelled = connection
            .prompt_admissions
            .with(&key, |admission| {
                admission.status == AdmissionStatus::Cancelled
            })
            .unwrap_or(false);
        if cancelled {
            return Self::admission_failure(
                &command_id,
                &type_name,
                "Prompt admission was cancelled.",
            );
        }
        let Some(worker_admission_id) = connection
            .prompt_admissions
            .with(&key, |admission| admission.worker_admission_id.clone())
        else {
            // An admission that vanished before the route: prompt through
            // the generic path.
            return self
                .route_client_command(command, client_id, attached, command_id, type_name, None)
                .await;
        };
        let timeout = client_route_timeout(command);
        // Resolve the session (the generic route's wake-aware resolution).
        let mut rebound_to: Option<String> = None;
        let resident = if let Ok(resident) = self.registry.resolve(active_session_id).await {
            resident
        } else {
            self.await_restore_target(active_session_id).await;
            match self.registry.resolve(active_session_id).await {
                Ok(resident) => resident,
                Err(_) => {
                    // The stale-active-id rebind: the admission id stays the
                    // idempotency key — the prompt never reached a worker,
                    // so routing to the current resident is exactly-once.
                    if let Some(resident) = self.binding_target(active_session_id).await {
                        let current = self
                            .rebind_connection(active_session_id, &resident, attached)
                            .await;
                        // The admission follows the rebind: a cancel by the
                        // advertised current id must find it in flight.
                        let rekeyed = prompt_admission_key(
                            &current,
                            input_admission_id(command).unwrap_or_default(),
                        );
                        if connection.prompt_admissions.rekey(&key, &rekeyed) {
                            key = rekeyed;
                        }
                        rebound_to = Some(current);
                        resident
                    } else {
                        let message =
                            self.restore_failure_for(active_session_id)
                                .unwrap_or_else(|| {
                                    format!("Unknown active session: {active_session_id}")
                                });
                        return Self::admission_failure(&command_id, &type_name, &message);
                    }
                }
            }
        };
        // A cancellation that landed during the resolution fails the
        // prompt first.
        let cancelled = connection
            .prompt_admissions
            .with(&key, |admission| {
                admission.status == AdmissionStatus::Cancelled
            })
            .unwrap_or(false);
        if cancelled {
            return Self::admission_failure(
                &command_id,
                &type_name,
                "Prompt admission was cancelled.",
            );
        }
        connection.prompt_admissions.update(&key, |admission| {
            admission.worker_id = Some(resident.worker_id.clone());
            admission.worker_active_session_id = Some(resident.worker_id.clone());
        });
        let (command_type, mut payload) = match client_command_payload(command, client_id) {
            Ok(payload) => payload,
            Err(error) => {
                return Self::admission_failure(&command_id, &type_name, &error.to_string())
            }
        };
        payload["admissionId"] = json!(worker_admission_id);
        if let Some(current) = &rebound_to {
            payload["activeSessionId"] = json!(current);
        }
        // The replacement-aware route: a prompt aimed at a worker being
        // replaced waits out the replay inside its own budget; the
        // admission id keeps a retried send exactly-once.
        let response = self
            .route_command_ready_typed(
                &resident,
                command_type,
                payload,
                timeout,
                RouteAdmission::ClientRequest,
            )
            .await;
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                // The route failed: the admission clears with it.
                connection.prompt_admissions.remove(&key);
                return Self::admission_failure(&command_id, &type_name, &error.to_string());
            }
        };
        if response.success {
            connection
                .prompt_admissions
                .update(&key, |admission| admission.status = AdmissionStatus::Owned);
        }
        // The prompt settled: the admission clears (TS `finally`).
        connection.prompt_admissions.remove(&key);
        response.id = Some(command_id);
        (vec![response_line(&response)], false)
    }

    /// `cancel_prompt_admission` (the TS supervisor arm): the status
    /// ladder, with the worker forward for a cancellation racing a live
    /// prompt route.
    pub(crate) async fn handle_cancel_prompt_admission(
        self: &Arc<Self>,
        connection: &Arc<crate::input_pause_lease::ClientConnectionState>,
        command: &pa_types::daemon::DaemonCommand,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let pa_types::daemon::DaemonCommand::CancelPromptAdmission {
            active_session_id,
            admission_id,
            cancel_owned,
            ..
        } = command
        else {
            return Self::admission_failure(command_id, type_name, "invalid command");
        };
        let mut key = prompt_admission_key(active_session_id, admission_id);
        if connection.prompt_admissions.with(&key, |_| ()).is_none() {
            // The stale-active-id rebind: a cancel addressed by the
            // superseded id follows the re-keyed admission; when no session
            // half remains, the admission id alone settles it, unambiguous.
            let mut rebound = None;
            if let Some(resident) = self.binding_target(active_session_id).await {
                let candidate = prompt_admission_key(&resident.worker_id, admission_id);
                if connection
                    .prompt_admissions
                    .with(&candidate, |_| ())
                    .is_some()
                {
                    rebound = Some(candidate);
                }
            }
            if rebound.is_none() {
                rebound = connection
                    .prompt_admissions
                    .sole_key_for_admission_id(admission_id);
            }
            if let Some(rebound) = rebound {
                key = rebound;
            }
        }
        // A waiting admission with no worker yet cancels outright (the TS
        // pre-check: the prompt route fails at its next check).
        connection.prompt_admissions.update(&key, |admission| {
            if admission.status == AdmissionStatus::Waiting && admission.worker_id.is_none() {
                admission.status = AdmissionStatus::Cancelled;
            }
        });
        let Some(status) = connection
            .prompt_admissions
            .with(&key, |admission| admission.status)
        else {
            return Self::admission_status(command_id, type_name, "unknown");
        };
        match status {
            AdmissionStatus::Cancelled => {
                Self::admission_status(command_id, type_name, "cancelled")
            }
            AdmissionStatus::Owned => Self::admission_status(command_id, type_name, "owned"),
            AdmissionStatus::Waiting => {
                // The route is in flight: forward the cancellation to the
                // worker and map its status.
                let fields = connection.prompt_admissions.with(&key, |admission| {
                    (
                        admission.worker_admission_id.clone(),
                        admission.worker_active_session_id.clone(),
                        admission.worker_id.clone(),
                    )
                });
                let Some((worker_admission_id, worker_active, worker_id)) = fields else {
                    return Self::admission_status(command_id, type_name, "cancelled");
                };
                let Some(worker_active) = worker_active else {
                    return Self::admission_status(command_id, type_name, "cancelled");
                };
                let Some(worker_id) = worker_id else {
                    return Self::admission_status(command_id, type_name, "cancelled");
                };
                let Some(resident) = self.registry.get(&worker_id).await else {
                    return Self::admission_status(command_id, type_name, "cancelled");
                };
                let mut payload = json!({
                    "activeSessionId": worker_active,
                    "admissionId": worker_admission_id,
                });
                if *cancel_owned == Some(true) {
                    payload["cancelOwned"] = json!(true);
                }
                let mut response = match self
                    .route_command_typed(
                        &resident,
                        "cancel_prompt_admission",
                        payload,
                        ROUTE_TIMEOUT_MS,
                        RouteAdmission::SupervisorInternal,
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        return Self::admission_failure(command_id, type_name, &error.to_string())
                    }
                };
                // The mapped status updates the supervisor record (TS
                // re-reads and downgrades only through waiting).
                let status = response
                    .data
                    .as_ref()
                    .and_then(|data| data.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                connection
                    .prompt_admissions
                    .update(&key, |admission| match status.as_str() {
                        "owned" => admission.status = AdmissionStatus::Owned,
                        "cancelled" => admission.status = AdmissionStatus::Cancelled,
                        _ => {
                            if admission.status != AdmissionStatus::Cancelled {
                                admission.status = AdmissionStatus::Waiting;
                            }
                        }
                    });
                response.id = Some(command_id.to_string());
                (vec![response_line(&response)], false)
            }
        }
    }

    fn admission_failure(command_id: &str, type_name: &str, error: &str) -> (Vec<Value>, bool) {
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

    fn admission_status(command_id: &str, type_name: &str, status: &str) -> (Vec<Value>, bool) {
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                Some(json!({ "status": status })),
            ))],
            false,
        )
    }
}

/// The worker's admission registry: admission id -> status (the TS
/// daemon-mode `promptAdmissions` map). Shared with the turn runner,
/// which clears an admitted prompt when its turn settles.
#[derive(Default, Clone)]
pub(crate) struct WorkerAdmissions {
    admissions: Arc<Mutex<HashMap<String, AdmissionStatus>>>,
}

impl WorkerAdmissions {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn register(&self, admission_id: &str) {
        self.admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(admission_id.to_string(), AdmissionStatus::Waiting);
    }

    /// Admission at prompt enqueue: a waiting id becomes owned. A cancelled
    /// or removed id refuses delivery, including cancellation before enqueue.
    pub(crate) fn commit(&self, admission_id: &str) -> bool {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match admissions.get_mut(admission_id) {
            Some(status @ AdmissionStatus::Waiting) => {
                *status = AdmissionStatus::Owned;
                true
            }
            Some(AdmissionStatus::Owned) => true,
            Some(AdmissionStatus::Cancelled) | None => false,
        }
    }

    /// The prompt settled: its admission clears (TS `clearAdmission`).
    pub(crate) fn clear(&self, admission_id: &str) {
        self.admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(admission_id);
    }

    /// Cancel one admission: a waiting one marks cancelled (its queued
    /// prompt never runs), any other status reports as-is, an unknown id
    /// answers `None` (the wire `unknown`).
    pub(crate) fn cancel(&self, admission_id: &str) -> Option<AdmissionStatus> {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match admissions.get_mut(admission_id) {
            None => None,
            Some(status) => {
                if *status == AdmissionStatus::Waiting {
                    *status = AdmissionStatus::Cancelled;
                }
                Some(*status)
            }
        }
    }
}

impl Worker {
    /// Register a prompt's admission; the queued item carries the id so
    /// the turn runner can commit it.
    pub(crate) fn register_prompt_admission(&self, admission_id: &str) {
        self.prompt_admissions.register(admission_id);
    }

    /// `cancel_prompt_admission` (the worker arm the supervisor forwards
    /// to): the TS status ladder over the worker's registry.
    pub(crate) fn handle_cancel_prompt_admission(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("cancel_prompt_admission") {
            return response;
        }
        let admission_id = payload
            .get("admissionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let cancel_owned = payload.get("cancelOwned").and_then(Value::as_bool) == Some(true);
        let (status, dropped_queued, abort_running) = {
            // The enqueue/commit transition holds this same lock. Decide
            // whether the owned admission is still queued atomically with
            // removing it; never abort a different in-flight turn.
            let mut core = self.core.lock().unwrap();
            let status = self.prompt_admissions.cancel(admission_id);
            let queued = core
                .steering
                .iter()
                .chain(&core.follow_up)
                .any(|item| item.admission_id.as_deref() == Some(admission_id));
            let dropped_queued = matches!(status, Some(AdmissionStatus::Cancelled))
                || (cancel_owned && status == Some(AdmissionStatus::Owned) && queued);
            if dropped_queued {
                core.steering
                    .retain(|item| item.admission_id.as_deref() != Some(admission_id));
                core.follow_up
                    .retain(|item| item.admission_id.as_deref() != Some(admission_id));
                self.prompt_admissions.clear(admission_id);
            }
            let abort_running = cancel_owned
                && status == Some(AdmissionStatus::Owned)
                && core.running_admission_ids.contains(admission_id);
            if abort_running {
                core.abort_requested = true;
            }
            (status, dropped_queued, abort_running)
        };
        if dropped_queued {
            self.checkpoint_queue(crate::worker::QueueCheckpoint::Settle {
                operation: "queue_dropped",
            });
        }
        if abort_running {
            self.engine.abort_in_flight_turn();
        }
        let status = match status {
            None => "unknown",
            Some(AdmissionStatus::Owned) => "owned",
            Some(AdmissionStatus::Waiting | AdmissionStatus::Cancelled) => "cancelled",
        };
        response_success(
            None,
            "cancel_prompt_admission",
            Some(json!({ "status": status })),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rekey_moves_a_live_admission_under_the_new_session_id() {
        let table = PromptAdmissionTable::default();
        table
            .register("stale-id", "adm-1")
            .expect("register admission");
        let old_key = prompt_admission_key("stale-id", "adm-1");
        let new_key = prompt_admission_key("current-id", "adm-1");
        assert!(table.rekey(&old_key, &new_key));
        assert!(table.with(&old_key, |_| ()).is_none());
        assert!(table.with(&new_key, |_| ()).is_some());
        table.remove(&new_key);
        assert!(!table.rekey(&new_key, &old_key));
        assert!(table.with(&old_key, |_| ()).is_none());
    }

    #[test]
    fn rekey_never_overwrites_an_occupied_destination() {
        let table = PromptAdmissionTable::default();
        table.register("stale-id", "adm-1").expect("register");
        table.register("current-id", "adm-1").expect("register");
        let from = prompt_admission_key("stale-id", "adm-1");
        let to = prompt_admission_key("current-id", "adm-1");
        assert!(!table.rekey(&from, &to));
        assert!(table.with(&from, |_| ()).is_some());
        assert!(table.with(&to, |_| ()).is_some());
    }

    #[test]
    fn sole_admission_id_match_resolves_but_ambiguity_stays_unknown() {
        let table = PromptAdmissionTable::default();
        table.register("sess-a", "adm-1").expect("register");
        assert_eq!(
            table.sole_key_for_admission_id("adm-1"),
            Some(prompt_admission_key("sess-a", "adm-1"))
        );
        table.register("sess-b", "adm-1").expect("register");
        assert_eq!(table.sole_key_for_admission_id("adm-1"), None);
        assert_eq!(table.sole_key_for_admission_id(""), None);
    }

    #[test]
    fn a_nul_in_either_key_half_is_refused_at_registration() {
        let table = PromptAdmissionTable::default();
        // A NUL in the admission id forges the stale-id cancel's
        // NUL-prefixed suffix match.
        assert_eq!(
            table.register("sess-a", "prefix\0target"),
            Err("admissionId must not contain NUL".to_string())
        );
        // A NUL in the session id forges a different half-split of the
        // same exact key.
        assert_eq!(
            table.register("s\0t", "u"),
            Err("activeSessionId must not contain NUL".to_string())
        );
        assert!(table.sole_key_for_admission_id("target").is_none());
        assert!(table.sole_key_for_admission_id("t\0u").is_none());
    }
}
