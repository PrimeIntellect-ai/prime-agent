//! Supervisor arms for the scheduling catalog (protocol breadth wave b10):
//! the TS daemon-supervisor cases `cron_list`, `heartbeats_list`,
//! `heartbeat_manage`, `cron_add`, `cron_cancel`, and `heartbeat_set`
//! (the pure forwards `heartbeat_get` / `heartbeat_update` stay on the
//! generic route). The TS arms merge the live workers' catalogs with the
//! passive jobs stored in the session-artifacts tree (TS
//! `collectPassiveScheduledJobs`), manage passive jobs against their
//! durable store (no worker wake just to flip a status), search for a
//! job's owning worker when a cancel carries no selector, and promote an
//! owned session when a `cron_add`/`heartbeat_set` asks for it.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use pa_core::cron::store::{AgentCronJobStore, HeartbeatManagementAction};
use pa_core::cron::{is_heartbeat_cron_job, AgentCronJob, JobStatus};
use pa_types::daemon::DaemonCommand;

use crate::protocol::{
    command_type_name, response_failure, response_line, response_success, DaemonResponse,
};
use crate::registry::ResidentWorker;
use crate::scheduled_jobs::session_artifact_dir;
use crate::session_store::read_session_info;
use crate::supervisor::{client_command_payload, Supervisor};

/// The catalog merge forwards (TS `forwardToWorker(worker, command, 5000)`).
const CATALOG_FORWARD_TIMEOUT_MS: u64 = 5000;

/// One passive scheduled job: a job in the session-artifacts tree whose
/// session has no live worker (TS `{ rootSessionFile, job, info }`; the
/// root-session walk feeds the TS wake timers, which this port keeps out
/// of the protocol arms).
struct PassiveJob {
    job: AgentCronJob,
    info: crate::session_store::SessionInfo,
}

/// TS `sortCronJobs`: by next run time, jobs without one last. The ISO
/// timestamps share one format, so the string compare matches the TS
/// epoch compare.
fn sort_cron_jobs(jobs: &mut [AgentCronJob]) {
    jobs.sort_by(
        |left, right| match (&left.next_run_at, &right.next_run_at) {
            (Some(left), Some(right)) => left.cmp(right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        },
    );
}

/// The TS heartbeat-management action vocabulary: pause/stop are explicit,
/// anything else resumes.
fn heartbeat_manage_action(action: &Value) -> HeartbeatManagementAction {
    match action.as_str() {
        Some("pause") => HeartbeatManagementAction::Pause,
        Some("stop") => HeartbeatManagementAction::Stop,
        _ => HeartbeatManagementAction::Resume,
    }
}

impl Supervisor {
    /// `collectPassiveScheduledJobs`: the scheduled jobs stored under the
    /// session-artifacts tree whose session file still exists, is still
    /// active, and has no live worker. Live workers own their jobs; the
    /// supervisor only merges what no worker can list.
    async fn collect_passive_scheduled_jobs(&self, include_inactive: bool) -> Vec<PassiveJob> {
        let mut out = Vec::new();
        for job in crate::update_roster::scan_scheduled_jobs(&self.options.agent_dir) {
            if !include_inactive && !matches!(job.status, JobStatus::Active | JobStatus::Paused) {
                continue;
            }
            let session_file = Path::new(&job.session_file);
            if !session_file.is_file() {
                continue;
            }
            if self
                .registry
                .find_by_session_file(&job.session_file)
                .await
                .is_some()
            {
                continue;
            }
            let Some(info) = read_session_info(session_file) else {
                continue;
            };
            if info.state.as_deref() != Some("active") {
                continue;
            }
            out.push(PassiveJob { job, info });
        }
        out
    }

    /// A passive job's artifact store (TS `AgentCronJobStore
    /// .forSessionArtifacts()` + `registerSessionArtifact`): the same
    /// partitioned store the owning worker uses, so a passive mutation is
    /// the durable write a woken worker would have made.
    fn passive_job_store(info: &crate::session_store::SessionInfo) -> AgentCronJobStore {
        let store = AgentCronJobStore::for_session_artifacts();
        if let Some(dir) = session_artifact_dir(&info.path, &info.id) {
            store.register_session_artifact(&info.id, &dir);
        }
        store
    }

    /// `broadcastHeartbeatsChanged`: the daemon-global event every client
    /// sees when a heartbeat catalog changes (TS `broadcastGlobal`).
    fn broadcast_heartbeats_changed(&self) {
        let _ = self.events.send((
            crate::supervisor::ClientRouting::Broadcast,
            json!({ "type": "heartbeats_changed" }),
        ));
    }

    /// Forward one command to a resident with the catalog timeout,
    /// answering its response (TS `forwardToWorker(worker, command, 5000)`).
    pub(crate) async fn forward_with_catalog_timeout(
        &self,
        resident: &Arc<ResidentWorker>,
        command: &DaemonCommand,
        client_id: &str,
    ) -> DaemonResponse {
        match client_command_payload(command, client_id) {
            Ok((command_type, payload)) => {
                match self
                    .route_command(resident, command_type, payload, CATALOG_FORWARD_TIMEOUT_MS)
                    .await
                {
                    Ok(response) => response,
                    Err(error) => response_failure(None, command_type, &error.to_string(), None),
                }
            }
            Err(error) => {
                response_failure(None, command_type_name(command), &error.to_string(), None)
            }
        }
    }

    /// Selector-less `cron_list` (TS supervisor arm): merge every live
    /// worker's jobs with the passive ones and answer the sorted catalog.
    pub(crate) async fn handle_cron_list_catalog(
        &self,
        command: &DaemonCommand,
        client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let include_inactive = match command {
            DaemonCommand::CronList {
                include_inactive, ..
            } => *include_inactive == Some(true),
            _ => false,
        };
        let mut jobs: Vec<AgentCronJob> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for resident in self.live_workers_in_creation_order().await {
            let response = self
                .forward_with_catalog_timeout(&resident, command, client_id)
                .await;
            if !response.success {
                self.log_line(&format!(
                    "Could not list scheduled jobs from a worker: {}",
                    response.error.unwrap_or_default()
                ));
                continue;
            }
            let Some(list) = response
                .data
                .as_ref()
                .and_then(|data| data.get("jobs"))
                .and_then(Value::as_array)
                .cloned()
            else {
                continue;
            };
            for job in list {
                let Ok(job) = serde_json::from_value::<AgentCronJob>(job) else {
                    continue;
                };
                if seen.insert(job.id.clone()) {
                    jobs.push(job);
                }
            }
        }
        for passive in self.collect_passive_scheduled_jobs(include_inactive).await {
            if seen.insert(passive.job.id.clone()) {
                jobs.push(passive.job);
            }
        }
        sort_cron_jobs(&mut jobs);
        let jobs: Vec<Value> = jobs
            .into_iter()
            .map(|job| serde_json::to_value(&job).unwrap_or(Value::Null))
            .collect();
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                Some(json!({ "jobs": jobs })),
            ))],
            false,
        )
    }

    /// Selector-less `heartbeats_list` (TS supervisor arm): merge every
    /// live worker's heartbeats with the passive heartbeat jobs; the
    /// passive rows carry the saved session's name and first message.
    pub(crate) async fn handle_heartbeats_list_catalog(
        &self,
        command: &DaemonCommand,
        client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let mut heartbeats: Vec<Value> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for resident in self.live_workers_in_creation_order().await {
            let response = self
                .forward_with_catalog_timeout(&resident, command, client_id)
                .await;
            if !response.success {
                self.log_line(&format!(
                    "Could not list heartbeats from a worker: {}",
                    response.error.unwrap_or_default()
                ));
                continue;
            }
            let Some(list) = response
                .data
                .as_ref()
                .and_then(|data| data.get("heartbeats"))
                .and_then(Value::as_array)
                .cloned()
            else {
                continue;
            };
            for heartbeat in list {
                let Some(id) = heartbeat
                    .get("job")
                    .and_then(|job| job.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                else {
                    continue;
                };
                if seen.insert(id) {
                    heartbeats.push(heartbeat);
                }
            }
        }
        // Passivated sessions keep their armed heartbeats; no worker can
        // list them.
        for passive in self.collect_passive_scheduled_jobs(false).await {
            if !is_heartbeat_cron_job(&passive.job) || !seen.insert(passive.job.id.clone()) {
                continue;
            }
            let mut heartbeat = json!({
                "job": serde_json::to_value(&passive.job).unwrap_or(Value::Null),
            });
            if let Some(name) = passive.info.name.as_deref() {
                heartbeat["sessionName"] = json!(name);
            }
            if !passive.info.first_message.is_empty() {
                heartbeat["firstMessage"] = json!(passive.info.first_message);
            }
            heartbeats.push(heartbeat);
        }
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                Some(json!({ "heartbeats": heartbeats })),
            ))],
            false,
        )
    }

    /// `heartbeat_manage` (TS supervisor arm): a passive job is managed
    /// against its durable store - no worker wake just to flip a status;
    /// anything else resolves the live worker and forwards.
    pub(crate) async fn handle_heartbeat_manage_catalog(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let DaemonCommand::HeartbeatManage {
            active_session_id,
            job_id,
            action,
            ..
        } = command
        else {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "invalid command",
                    None,
                ))],
                false,
            );
        };
        let passive = self
            .collect_passive_scheduled_jobs(false)
            .await
            .into_iter()
            .find(|passive| {
                passive.job.id == *job_id && passive.job.active_session_id == *active_session_id
            });
        if let Some(passive) = passive {
            let store = Self::passive_job_store(&passive.info);
            // A passive row that cannot be managed falls through to the
            // live-worker route (TS: the same `if (heartbeat)` guard).
            if let Ok(Some(heartbeat)) = store.manage_heartbeat(
                active_session_id,
                job_id,
                heartbeat_manage_action(action),
                crate::util::now_ms(),
            ) {
                self.broadcast_heartbeats_changed();
                return (
                    vec![response_line(&response_success(
                        Some(command_id),
                        type_name,
                        Some(json!({
                            "heartbeat": serde_json::to_value(&heartbeat)
                                .unwrap_or(Value::Null),
                        })),
                    ))],
                    false,
                );
            }
        }
        // No passive job managed: the live worker owns the heartbeat.
        self.route_client_command(
            command,
            client_id,
            attached,
            command_id.to_string(),
            type_name.to_string(),
        )
        .await
    }

    /// `cron_add` (TS supervisor arm): forward to the resolved worker and
    /// promote the owned session when the command asks for it (TS
    /// `promoteOwnedWorker` after a successful add).
    pub(crate) async fn handle_cron_add_catalog(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        self.route_scheduled_add(command, client_id, attached, command_id, type_name)
            .await
    }

    /// `heartbeat_set` (TS supervisor arm): the same forward-plus-promote
    /// path as `cron_add`.
    pub(crate) async fn handle_heartbeat_set_catalog(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        self.route_scheduled_add(command, client_id, attached, command_id, type_name)
            .await
    }

    /// The shared `cron_add`/`heartbeat_set` supervisor path: resolve and
    /// forward, then promote the owner when the command carried
    /// `promoteOwnedSession` and the worker answered success.
    async fn route_scheduled_add(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let promote = matches!(
            command,
            DaemonCommand::CronAdd {
                promote_owned_session: Some(true),
                ..
            } | DaemonCommand::HeartbeatSet {
                promote_owned_session: Some(true),
                ..
            }
        );
        let outcome = self
            .route_client_command(
                command,
                client_id,
                attached,
                command_id.to_string(),
                type_name.to_string(),
            )
            .await;
        if !promote {
            return outcome;
        }
        let succeeded = outcome
            .0
            .first()
            .is_some_and(|line| line.get("success").and_then(Value::as_bool) == Some(true));
        if !succeeded {
            return outcome;
        }
        let selector = crate::protocol::command_active_session_id(command)
            .map(str::to_string)
            .unwrap_or_default();
        let promoted = match self.registry.resolve(&selector).await {
            Ok(resident) => self.promote_owned_worker(&resident, client_id).await,
            Err(_) => Ok(()), // the worker it answered for is gone; nothing to promote
        };
        if let Err(error) = promoted {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    &error,
                    None,
                ))],
                false,
            );
        }
        outcome
    }

    /// `promoteOwnedWorker` (TS supervisor helper): clear this client's
    /// ownership, persist the descriptor, and stamp the promotion marker.
    async fn promote_owned_worker(
        self: &Arc<Self>,
        resident: &Arc<ResidentWorker>,
        client_id: &str,
    ) -> Result<(), String> {
        let mut descriptor = resident.descriptor.lock().await;
        match descriptor.owner_client_id.clone() {
            Some(owner) if owner == client_id => {
                descriptor.owner_client_id = None;
                descriptor
                    .rest
                    .insert("promotedOwnerClientId".to_string(), json!(owner));
                crate::descriptor::persist_worker(&resident.descriptor_path, &descriptor)
                    .map_err(|error| error.to_string())?;
                Ok(())
            }
            // An already-promoted session stays promoted; a foreign owner
            // was never this client's to promote.
            None if descriptor
                .rest
                .get("promotedOwnerClientId")
                .and_then(Value::as_str)
                == Some(client_id) =>
            {
                Ok(())
            }
            _ => Err("Session is not owned by this client".to_string()),
        }
    }

    /// Selector-less `cron_cancel` (TS supervisor arm): find the live
    /// worker that owns the job (by listing its catalog, inactive
    /// included), else cancel the passive job in its durable store, else
    /// answer the TS unknown-job error.
    pub(crate) async fn handle_cron_cancel_catalog(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let DaemonCommand::CronCancel { job_id, .. } = command else {
            return (
                vec![response_line(&response_failure(
                    Some(command_id),
                    type_name,
                    "invalid command",
                    None,
                ))],
                false,
            );
        };
        // The owner search lists each worker's catalog with the inactive
        // cut open (TS forwards `{ type: "cron_list", includeInactive: true }`).
        let listing_command = DaemonCommand::CronList {
            id: None,
            active_session_id: None,
            include_inactive: Some(true),
            rest: Default::default(),
        };
        for resident in self.live_workers_in_creation_order().await {
            let listing = self
                .forward_with_catalog_timeout(&resident, &listing_command, client_id)
                .await;
            if !listing.success {
                continue;
            }
            let owns_job = listing
                .data
                .as_ref()
                .and_then(|data| data.get("jobs"))
                .and_then(Value::as_array)
                .map(|jobs| {
                    jobs.iter()
                        .any(|job| job.get("id").and_then(Value::as_str) == Some(job_id))
                })
                .unwrap_or(false);
            if !owns_job {
                continue;
            }
            let mut response = self
                .forward_with_catalog_timeout(&resident, command, client_id)
                .await;
            response.id = Some(command_id.to_string());
            return (vec![response_line(&response)], false);
        }
        let passive = self
            .collect_passive_scheduled_jobs(true)
            .await
            .into_iter()
            .find(|passive| passive.job.id == *job_id);
        if let Some(passive) = passive {
            let store = Self::passive_job_store(&passive.info);
            if let Some(job) = store.cancel(job_id, crate::util::now_ms()) {
                self.broadcast_heartbeats_changed();
                return (
                    vec![response_line(&response_success(
                        Some(command_id),
                        type_name,
                        Some(json!({ "job": serde_json::to_value(&job).unwrap_or(Value::Null) })),
                    ))],
                    false,
                );
            }
        }
        (
            vec![response_line(&response_failure(
                Some(command_id),
                type_name,
                &format!("No cron job found: {job_id}"),
                None,
            ))],
            false,
        )
    }
}
