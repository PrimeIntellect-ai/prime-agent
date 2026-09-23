//! The prompt-admission surface (protocol breadth wave b9): the
//! supervisor's cancellation registry for `prompt` / `prompt_and_wait`
//! (TS `SupervisorPromptAdmission` + the `cancel_prompt_admission`
//! supervisor arm) and the worker-side admission bookkeeping the
//! forwarded cancellations read (TS daemon-mode `promptAdmissions`).
//!
//! The lifecycle: a prompt carrying `admissionId` registers at dispatch
//! (the TS parse-time registration; duplicates and empty ids answer the
//! TS parse errors), the route rewrites the admission id to a
//! supervisor-scoped one (`supervisor-admission:<uuid>`) and records the
//! worker, a successful prompt commits the admission (`owned`), and the
//! admission clears once the route settles. `cancel_prompt_admission`
//! answers the TS status ladder - `unknown` for an unregistered id,
//! `cancelled` for a waiting admission (aborting the in-flight prompt
//! with the TS `Prompt admission was cancelled.` failure), `owned` for a
//! committed one, and the worker's status for a cancellation racing a
//! live route.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::protocol::{response_failure, response_line, response_success, DaemonResponse};
use crate::supervisor::{
    client_command_payload, Supervisor, LONG_ROUTE_TIMEOUT_MS, ROUTE_TIMEOUT_MS,
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
    /// The TS parse-time registration: a prompt/prompt_and_wait carrying
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
        if active_session_id.is_empty() {
            return Err(
                "Prompt admission requires string activeSessionId and admissionId".to_string(),
            );
        }
        let key = prompt_admission_key(active_session_id, admission_id);
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        admissions.get(key).map(f)
    }

    fn update<R>(&self, key: &str, f: impl FnOnce(&mut PromptAdmission) -> R) -> Option<R> {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        admissions.get_mut(key).map(f)
    }

    /// Move one admission under a new key (the stale-active-id rebind: a
    /// cancellation addresses the admission by the session id the client
    /// currently holds). A missing source is a settled admission; the
    /// entry stays wherever it is.
    fn rekey(&self, from: &str, to: &str) {
        if from == to {
            return;
        }
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // An occupied destination stays intact: overwriting would lose a
        // concurrent prompt's record and cancel/route the wrong prompt.
        if admissions.contains_key(to) {
            return;
        }
        if let Some(admission) = admissions.remove(from) {
            admissions.insert(to.to_string(), admission);
        }
    }

    /// The single admission whose key carries this admission id, when
    /// exactly one does (the stale-id cancel's last resort: after repeated
    /// replacements the session half of the key is unknowable, but a
    /// connection's admission id is its own idempotency key).
    fn sole_key_for_admission_id(&self, admission_id: &str) -> Option<String> {
        if admission_id.is_empty() {
            return None;
        }
        let suffix = format!("\u{0}{admission_id}");
        let admissions = self
            .admissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut keys = admissions.keys().filter(|key| key.ends_with(&suffix));
        let first = keys.next()?.clone();
        keys.next().is_none().then_some(first)
    }

    fn remove(&self, key: &str) {
        self.admissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(key);
    }

    /// The disconnect cleanup (TS `cancelWaitingPromptAdmissionsForClient`):
    /// every waiting admission cancels so its in-flight prompt fails.
    pub(crate) fn cancel_all_waiting(&self) {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for admission in admissions.values_mut() {
            if admission.status == AdmissionStatus::Waiting {
                admission.status = AdmissionStatus::Cancelled;
            }
        }
    }
}

/// The admission id a prompt-family command carries (the registration
/// and route hooks match the same pair). The wire field is the TS
/// `admissionId`: it rides the command's lossless `rest` map (the
/// pa-types `PromptInput` predates the camelCase wire spelling).
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
    /// Route one admitted prompt (the TS `forward()` closure in
    /// `routeClientCommand`): the cancellation checks around the worker
    /// round trip, the admission-id rewrite, and the owned commit.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn route_prompt_with_admission(
        self: &Arc<Self>,
        connection: &Arc<crate::input_pause_lease::ClientConnectionState>,
        command: &pa_types::daemon::DaemonCommand,
        client_id: &str,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
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
            return self.admission_failure(
                &command_id,
                &type_name,
                "Prompt admission was cancelled.",
            );
        }
        let (worker_admission_id, timeout) =
            match connection.prompt_admissions.with(&key, |admission| {
                (
                    admission.worker_admission_id.clone(),
                    if matches!(
                        command,
                        pa_types::daemon::DaemonCommand::PromptAndWait { .. }
                    ) {
                        LONG_ROUTE_TIMEOUT_MS
                    } else {
                        ROUTE_TIMEOUT_MS
                    },
                )
            }) {
                Some(fields) => fields,
                // An admission that vanished before the route: the prompt
                // routes through the generic path (TS `admission undefined`).
                None => {
                    return self
                        .route_client_command(command, client_id, attached, command_id, type_name)
                        .await
                }
            };
        // Resolve the session (the generic route's wake-aware resolution).
        let mut rebound_to: Option<String> = None;
        let resident = match self.registry.resolve(active_session_id).await {
            Ok(resident) => resident,
            Err(_) => {
                self.await_restore_target(active_session_id).await;
                match self.registry.resolve(active_session_id).await {
                    Ok(resident) => resident,
                    Err(_) => {
                        // The stale-active-id rebind (the generic route's
                        // seam): the admission id stays the client's
                        // idempotency key across the rebind - the prompt
                        // failed before it reached any worker, so routing it
                        // once to the session's current resident delivers
                        // it exactly once.
                        match self.binding_target(active_session_id).await {
                            Some(resident) => {
                                let current = self
                                    .rebind_connection(active_session_id, &resident, attached)
                                    .await;
                                // The admission follows the rebind: a
                                // cancellation by the advertised current id
                                // must find the in-flight admission.
                                let rekeyed = prompt_admission_key(
                                    &current,
                                    input_admission_id(command).unwrap_or_default(),
                                );
                                connection.prompt_admissions.rekey(&key, &rekeyed);
                                key = rekeyed;
                                rebound_to = Some(current);
                                resident
                            }
                            None => {
                                let message =
                                    self.restore_failure_for(active_session_id).unwrap_or_else(
                                        || format!("Unknown active session: {active_session_id}"),
                                    );
                                return self.admission_failure(&command_id, &type_name, &message);
                            }
                        }
                    }
                }
            }
        };
        // A cancellation that landed during the resolution fails the
        // prompt before it reaches the worker.
        let cancelled = connection
            .prompt_admissions
            .with(&key, |admission| {
                admission.status == AdmissionStatus::Cancelled
            })
            .unwrap_or(false);
        if cancelled {
            return self.admission_failure(
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
                return self.admission_failure(&command_id, &type_name, &error.to_string())
            }
        };
        payload["admissionId"] = json!(worker_admission_id);
        // A rebind retargets the routed frame to the session's current id.
        if let Some(current) = &rebound_to {
            payload["activeSessionId"] = json!(current);
        }
        let response = self
            .route_command(&resident, command_type, payload, timeout)
            .await;
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                // The route failed: the admission clears with it (TS
                // deletes in the finally).
                connection.prompt_admissions.remove(&key);
                return self.admission_failure(&command_id, &type_name, &error.to_string());
            }
        };
        if response.success {
            connection
                .prompt_admissions
                .update(&key, |admission| admission.status = AdmissionStatus::Owned);
        }
        // The prompt settled: the admission clears (TS `finally`);
        // a cancel that raced it already recorded its own outcome.
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
            return self.admission_failure(command_id, type_name, "invalid command");
        };
        let mut key = prompt_admission_key(active_session_id, admission_id);
        if connection.prompt_admissions.with(&key, |_| ()).is_none() {
            // The stale-active-id rebind: a rebound prompt's admission
            // moved under the session's current resident id (the same
            // source the rebind seam re-keyed with), so a cancel still
            // addressed by the superseded id follows it there. A resident
            // replaced again mid-flight leaves no resolvable session half;
            // the admission id alone settles it when it is unambiguous.
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
        // `handleLine` pre-check: the prompt route fails with the TS
        // cancellation error at its next check).
        connection.prompt_admissions.update(&key, |admission| {
            if admission.status == AdmissionStatus::Waiting && admission.worker_id.is_none() {
                admission.status = AdmissionStatus::Cancelled;
            }
        });
        let Some(status) = connection
            .prompt_admissions
            .with(&key, |admission| admission.status)
        else {
            return self.admission_status(command_id, type_name, "unknown");
        };
        match status {
            AdmissionStatus::Cancelled => self.admission_status(command_id, type_name, "cancelled"),
            AdmissionStatus::Owned => self.admission_status(command_id, type_name, "owned"),
            AdmissionStatus::Waiting => {
                // The route is in flight: forward the cancellation to the
                // worker with the rewritten ids and map its status.
                let fields = connection.prompt_admissions.with(&key, |admission| {
                    (
                        admission.worker_admission_id.clone(),
                        admission.worker_active_session_id.clone(),
                        admission.worker_id.clone(),
                    )
                });
                let Some((worker_admission_id, worker_active, worker_id)) = fields else {
                    return self.admission_status(command_id, type_name, "cancelled");
                };
                let Some(worker_active) = worker_active else {
                    return self.admission_status(command_id, type_name, "cancelled");
                };
                let Some(worker_id) = worker_id else {
                    return self.admission_status(command_id, type_name, "cancelled");
                };
                let Some(resident) = self.registry.get(&worker_id).await else {
                    return self.admission_status(command_id, type_name, "cancelled");
                };
                let mut payload = json!({
                    "activeSessionId": worker_active,
                    "admissionId": worker_admission_id,
                });
                if *cancel_owned == Some(true) {
                    payload["cancelOwned"] = json!(true);
                }
                let mut response = match self
                    .route_command(
                        &resident,
                        "cancel_prompt_admission",
                        payload,
                        ROUTE_TIMEOUT_MS,
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        return self.admission_failure(command_id, type_name, &error.to_string())
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

    fn admission_failure(
        &self,
        command_id: &str,
        type_name: &str,
        error: &str,
    ) -> (Vec<Value>, bool) {
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

    fn admission_status(
        &self,
        command_id: &str,
        type_name: &str,
        status: &str,
    ) -> (Vec<Value>, bool) {
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

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

/// The worker's admission registry: admission id -> status (the TS
/// daemon-mode `promptAdmissions` map). Shared with the turn runner,
/// which commits a queued admission when its turn starts.
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
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(admission_id.to_string(), AdmissionStatus::Waiting);
    }

    /// The queued prompt's turn started: a waiting admission commits.
    pub(crate) fn commit(&self, admission_id: &str) {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(status) = admissions.get_mut(admission_id) {
            if *status == AdmissionStatus::Waiting {
                *status = AdmissionStatus::Owned;
            }
        }
    }

    /// The prompt settled: its admission clears (TS `clearAdmission`).
    pub(crate) fn clear(&self, admission_id: &str) {
        self.admissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(admission_id);
    }

    /// Cancel one admission: a waiting one marks cancelled (its queued
    /// prompt never runs), any other status reports as-is, an unknown id
    /// answers `None` (the wire `unknown`).
    pub(crate) fn cancel(&self, admission_id: &str) -> Option<AdmissionStatus> {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    /// Register a prompt's admission (the worker-side bookkeeping the
    /// forwarded cancellations read); the queued item carries the id so
    /// the turn runner can commit it.
    pub(crate) fn register_prompt_admission(&self, admission_id: &str) {
        self.prompt_admissions.register(admission_id);
    }

    /// Drop the queued prompt a cancelled admission was holding (the TS
    /// controller aborts before the admission commits, so the prompt never
    /// runs).
    pub(crate) fn drop_queued_admitted_prompt(&self, admission_id: &str) {
        let mut core = self.core.lock().unwrap();
        core.steering
            .retain(|item| item.admission_id.as_deref() != Some(admission_id));
        core.follow_up
            .retain(|item| item.admission_id.as_deref() != Some(admission_id));
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
        match self.prompt_admissions.cancel(admission_id) {
            None => response_success(
                None,
                "cancel_prompt_admission",
                Some(json!({ "status": "unknown" })),
            ),
            Some(AdmissionStatus::Owned) => {
                // A committed prompt with `cancelOwned` aborts its running
                // turn (the TS controller abort).
                if cancel_owned {
                    let mut core = self.core.lock().unwrap();
                    core.abort_requested = true;
                    drop(core);
                    // The TS controller abort cancels the committed turn's
                    // in-flight fetch immediately (`requestAbort` ->
                    // `agent.abort()`).
                    self.engine.abort_in_flight_turn();
                }
                response_success(
                    None,
                    "cancel_prompt_admission",
                    Some(json!({ "status": "owned" })),
                )
            }
            // A waiting or already-cancelled admission: the queued prompt
            // (if any) never runs.
            Some(_) => {
                self.drop_queued_admitted_prompt(admission_id);
                response_success(
                    None,
                    "cancel_prompt_admission",
                    Some(json!({ "status": "cancelled" })),
                )
            }
        }
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
        table.rekey(&old_key, &new_key);
        assert!(table.with(&old_key, |_| ()).is_none());
        assert!(table.with(&new_key, |_| ()).is_some());
        // A settled (already-removed) admission stays absent.
        table.remove(&new_key);
        table.rekey(&new_key, &old_key);
        assert!(table.with(&old_key, |_| ()).is_none());
    }

    #[test]
    fn rekey_never_overwrites_an_occupied_destination() {
        let table = PromptAdmissionTable::default();
        table.register("stale-id", "adm-1").expect("register");
        table.register("current-id", "adm-1").expect("register");
        let from = prompt_admission_key("stale-id", "adm-1");
        let to = prompt_admission_key("current-id", "adm-1");
        table.rekey(&from, &to);
        // Both records survive: the occupied destination stays, the
        // source stays where it was.
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
        // The same admission id under a second session is ambiguous: no
        // last-resort match.
        table.register("sess-b", "adm-1").expect("register");
        assert_eq!(table.sole_key_for_admission_id("adm-1"), None);
        assert_eq!(table.sole_key_for_admission_id(""), None);
    }
}
