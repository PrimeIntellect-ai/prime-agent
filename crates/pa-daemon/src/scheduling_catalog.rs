//! Supervisor arms for the scheduling catalog: `cron_list`, `heartbeats_list`,
//! `heartbeat_manage`, `cron_add`, `cron_cancel`, `heartbeat_set` — the live workers' catalogs
//! merged with the passive jobs in the session-artifacts tree; passive jobs mutate their
//! durable store, a selector-less cancel searches for the owning worker.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use pa_core::cron::store::{AgentCronJobStore, HeartbeatManagementAction};
use pa_core::cron::{is_heartbeat_cron_job, AgentCronJob, JobStatus};
use pa_types::daemon::DaemonCommand;

use crate::backpressure::RouteAdmission;
use crate::protocol::{
    command_type_name, response_failure, response_line, response_success, DaemonResponse,
};
use crate::registry::ResidentWorker;
use crate::scheduled_jobs::session_artifact_dir;
use crate::session_store::read_session_info;
use crate::supervisor::{client_command_payload, Supervisor};

const CATALOG_FORWARD_TIMEOUT_MS: u64 = 5000;

/// One passive scheduled job: a job in the session-artifacts tree whose session has no live worker.
#[derive(Clone)]
pub(crate) struct PassiveJob {
    pub(crate) job: AgentCronJob,
    pub(crate) info: crate::session_store::SessionInfo,
}

/// The supervisor-side passive snapshot the catalog READ paths serve: the artifacts-tree
/// scan runs once per generation instead of per request; a snapshot older than
/// [`PASSIVE_CATALOG_REFRESH_MS`] re-scans in the background (stale-while-revalidate).
pub(crate) struct PassiveCatalogSnapshot {
    /// Every passive job the scan saw, before the active-status filter:
    /// `include_inactive` callers filter per read, so one snapshot serves both spellings.
    pub(crate) rows: Vec<PassiveJob>,
    pub(crate) scanned_at: std::time::Instant,
}

/// How long a served snapshot may stay served before a background refresh re-scans.
const PASSIVE_CATALOG_REFRESH_MS: u64 = 5_000;

/// By next run time, jobs without one last; the ISO timestamps share one format,
/// so the string compare matches the TS epoch compare.
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

/// The TS vocabulary: pause/stop are explicit, anything else resumes.
fn heartbeat_manage_action(action: &Value) -> HeartbeatManagementAction {
    match action.as_str() {
        Some("pause") => HeartbeatManagementAction::Pause,
        Some("stop") => HeartbeatManagementAction::Stop,
        _ => HeartbeatManagementAction::Resume,
    }
}

impl Supervisor {
    /// Jobs stored under the session-artifacts tree whose session file exists, is
    /// active, and has no live worker: the supervisor only merges what no worker can list.
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

    /// The passive rows a catalog READ serves: the shared snapshot when present
    /// (re-scanning in the background once past the refresh window), or one shared
    /// in-flight scan when cold; mutation arms keep the fresh scan.
    pub(crate) async fn passive_catalog_rows(
        self: &Arc<Self>,
        include_inactive: bool,
    ) -> Vec<PassiveJob> {
        // The snapshot decision and the serve-side filter read under ONE lock:
        // an invalidation between them cannot turn a cached hit into an empty catalog.
        {
            let snapshot = self.passive_catalog.lock().unwrap();
            if let Some(snapshot) = snapshot.as_ref() {
                if snapshot.scanned_at.elapsed()
                    >= std::time::Duration::from_millis(PASSIVE_CATALOG_REFRESH_MS)
                    && !self.shutting_down.load(Ordering::SeqCst)
                {
                    // Stale-while-revalidate: serve the bounded-stale rows now,
                    // refresh in the background; a failure only logs, the next read retries.
                    self.spawn_shared_passive_scan();
                }
                return Self::filter_passive_rows_with(include_inactive, &snapshot.rows);
            }
        }
        let rows = self.shared_passive_scan().await;
        Self::filter_passive_rows_with(include_inactive, &rows)
    }

    /// The active-status cut (the worker's own default `cron_list` rule):
    /// the default keeps active and paused rows, `include_inactive` keeps everything.
    fn filter_cron_rows(include_inactive: bool, jobs: Vec<AgentCronJob>) -> Vec<AgentCronJob> {
        if include_inactive {
            return jobs;
        }
        jobs.into_iter()
            .filter(|job| matches!(job.status, JobStatus::Active | JobStatus::Paused))
            .collect()
    }

    /// The same active-status cut over raw scan rows.
    fn filter_passive_rows_with(include_inactive: bool, rows: &[PassiveJob]) -> Vec<PassiveJob> {
        if include_inactive {
            return rows.to_vec();
        }
        rows.iter()
            .filter(|passive| matches!(passive.job.status, JobStatus::Active | JobStatus::Paused))
            .cloned()
            .collect()
    }

    /// The shared passive scan: one scan at a time; waiters behind the first scan's gate
    /// serve the snapshot it just stored. The scan claims the publish epoch when it starts
    /// and may store only while it still owns the newest epoch.
    async fn shared_passive_scan(self: &Arc<Self>) -> Vec<PassiveJob> {
        let _gate = self.passive_scan_gate.lock().await;
        // Double-check: the scan that finished while this caller waited on the gate refreshed
        // the snapshot already.
        let still_fresh = self
            .passive_catalog
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|snapshot| {
                snapshot.scanned_at.elapsed()
                    < std::time::Duration::from_millis(PASSIVE_CATALOG_REFRESH_MS)
            });
        if still_fresh {
            if let Some(snapshot) = self.passive_catalog.lock().unwrap().as_ref() {
                return snapshot.rows.clone();
            }
        }
        let epoch = self.passive_catalog_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let rows = self.collect_passive_scheduled_jobs(true).await;
        // Compare-and-swap publish: a newer epoch means an invalidation raced the scan —
        // the caller keeps its rows, the snapshot does not republish them. The epoch check
        // runs UNDER the snapshot lock (TS is single-threaded there): outside the lock, a
        // check/store race would republish pre-mutation rows over the cleared snapshot.
        {
            let mut snapshot = self.passive_catalog.lock().unwrap();
            if self.passive_catalog_epoch.load(Ordering::SeqCst) == epoch {
                *snapshot = Some(PassiveCatalogSnapshot {
                    rows: rows.clone(),
                    scanned_at: std::time::Instant::now(),
                });
            }
        }
        rows
    }

    /// Kick the background stale-while-revalidate refresh: a reader arriving
    /// while a refresh is queued shares it; a failure only logs.
    fn spawn_shared_passive_scan(self: &Arc<Self>) {
        if self.passive_scan_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            let _ = supervisor.shared_passive_scan().await;
            supervisor
                .passive_scan_pending
                .store(false, Ordering::SeqCst);
        });
    }

    /// Invalidate the passive snapshot: claim the publish epoch so an in-flight
    /// scan can no longer store, then drop it — the next read rescans.
    pub(crate) fn invalidate_passive_catalog(&self) {
        self.passive_catalog_epoch.fetch_add(1, Ordering::SeqCst);
        *self.passive_catalog.lock().unwrap() = None;
    }

    /// A passive job's artifact store: the same partitioned store the owning worker
    /// uses, so a passive mutation is the durable write a woken worker would have made.
    fn passive_job_store(info: &crate::session_store::SessionInfo) -> AgentCronJobStore {
        let store = AgentCronJobStore::for_session_artifacts();
        if let Some(dir) = session_artifact_dir(&info.path, &info.id) {
            store.register_session_artifact(&info.id, &dir);
        }
        store
    }

    /// Every daemon-owned scheduled-job mutation and a worker-residency change lands
    /// here: the passive snapshot drops (claiming its epoch), and every connected
    /// client re-reads the catalog (keeps a session-scoped view fresh too).
    pub(crate) fn broadcast_heartbeats_changed(&self) {
        self.invalidate_passive_catalog();
        let _ = self.events.send((
            crate::supervisor::ClientRouting::Broadcast,
            std::sync::Arc::new(json!({ "type": "heartbeats_changed" })),
        ));
    }

    /// Forward one command to a resident with the catalog timeout.
    pub(crate) async fn forward_with_catalog_timeout(
        &self,
        resident: &Arc<ResidentWorker>,
        command: &DaemonCommand,
        client_id: &str,
    ) -> DaemonResponse {
        match client_command_payload(command, client_id) {
            Ok((command_type, payload)) => {
                match self
                    .route_command_typed(
                        resident,
                        command_type,
                        payload,
                        CATALOG_FORWARD_TIMEOUT_MS,
                        RouteAdmission::ClientRequest,
                    )
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

    /// Selector-less `cron_list`: merge every live worker's jobs with the passive ones, sorted.
    pub(crate) async fn handle_cron_list_catalog(
        self: &Arc<Self>,
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
        // The slice stores the worker's UNFILTERED answer (one row set serves every
        // caller's filter), so the listing forward opens the inactive cut and the
        // serve-side filter below applies the request's `include_inactive`.
        let listing_command = DaemonCommand::CronList {
            id: None,
            active_session_id: None,
            include_inactive: Some(true),
            rest: Map::default(),
        };
        for resident in self.live_workers_in_creation_order().await {
            // The supervisor serves each worker's own catalog slice while it is
            // current, so a `cron_list` consults a worker at most once per generation.
            let generation = resident
                .heartbeat_snapshot_generation
                .load(Ordering::Relaxed);
            let served_slice = {
                let snapshot = resident.cron_snapshot.lock().await;
                snapshot
                    .as_ref()
                    // The freshness test re-reads the generation while the snapshot lock
                    // is held: an invalidation between capture and lock never serves as current.
                    .filter(|snapshot| {
                        snapshot.generation
                            == resident
                                .heartbeat_snapshot_generation
                                .load(Ordering::Relaxed)
                    })
                    .map(|snapshot| snapshot.jobs.clone())
            };
            let worker_jobs: Option<Vec<AgentCronJob>> = if let Some(jobs) = served_slice {
                Some(jobs)
            } else {
                let response = self
                    .forward_with_catalog_timeout(&resident, &listing_command, client_id)
                    .await;
                if response.success {
                    let list = response
                        .data
                        .as_ref()
                        .and_then(|data| data.get("jobs"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let mut parsed = Vec::new();
                    for job in list {
                        let Ok(job) = serde_json::from_value::<AgentCronJob>(job) else {
                            continue;
                        };
                        parsed.push(job);
                    }
                    resident
                        .store_cron_snapshot(parsed.clone(), generation)
                        .await;
                    Some(parsed)
                } else {
                    self.log_line(&format!(
                        "Could not list scheduled jobs from a worker: {}",
                        response.error.unwrap_or_default()
                    ));
                    None
                }
            };
            let worker_jobs =
                worker_jobs.map(|jobs| Self::filter_cron_rows(include_inactive, jobs));
            for job in worker_jobs.unwrap_or_default() {
                if seen.insert(job.id.clone()) {
                    jobs.push(job);
                }
            }
        }
        for passive in self.passive_catalog_rows(include_inactive).await {
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

    /// Selector-less `heartbeats_list`: merge every live worker's heartbeats with the
    /// passive heartbeat jobs. Each worker serves its last-good snapshot when busy; a
    /// worker with no usable snapshot fails the whole response, so the client keeps its
    /// last catalog instead of reading a partial merge as an emptied one.
    pub(crate) async fn handle_heartbeats_list_catalog(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let mut heartbeats: Vec<Value> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut failed: Option<DaemonResponse> = None;
        for resident in self.live_workers_in_creation_order().await {
            // The generation this read captures: a stored snapshot is only fresh
            // while its generation is current.
            let generation = resident
                .heartbeat_snapshot_generation
                .load(Ordering::Relaxed);
            // The supervisor serves the worker's own slice while its generation is
            // current, so a `heartbeats_list` consults a worker at most once per generation.
            let served_slice = {
                let snapshot = resident.heartbeat_snapshot.lock().await;
                snapshot
                    .as_ref()
                    .filter(|snapshot| {
                        snapshot.generation
                            == resident
                                .heartbeat_snapshot_generation
                                .load(Ordering::Relaxed)
                    })
                    .map(|snapshot| snapshot.rows.clone())
            };
            let list = if let Some(rows) = served_slice {
                rows
            } else {
                let response = self
                    .forward_with_catalog_timeout(&resident, command, client_id)
                    .await;
                // A success without a rows array is an empty catalog (a good
                // snapshot), not a failure.
                let list = if response.success {
                    Some(
                        response
                            .data
                            .as_ref()
                            .and_then(|data| data.get("heartbeats"))
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                    )
                } else {
                    self.log_line(&format!(
                        "Could not list heartbeats from a worker: {}",
                        response.error.clone().unwrap_or_default()
                    ));
                    None
                };
                if let Some(list) = list {
                    list
                } else {
                    let snapshot = resident.heartbeat_snapshot.lock().await;
                    if let Some(snapshot) = snapshot.as_ref().filter(|snapshot| {
                        snapshot.generation
                            == resident
                                .heartbeat_snapshot_generation
                                .load(Ordering::Relaxed)
                    }) {
                        snapshot.rows.clone()
                    } else {
                        failed.get_or_insert(response);
                        continue;
                    }
                }
            };
            // The stored snapshot carries the generation captured before the forward:
            // an invalidation during the read makes the store land already stale, and an
            // older in-flight read never replaces a newer stored snapshot.
            resident
                .store_heartbeat_snapshot(list.clone(), generation)
                .await;
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
        if let Some(mut response) = failed {
            response.id = Some(command_id.to_string());
            return (vec![response_line(&response)], false);
        }
        // Passivated sessions keep their armed heartbeats; no worker can list them (the
        // snapshot-served passive rows).
        for passive in self.passive_catalog_rows(false).await {
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

    /// `heartbeat_manage`: a passive job is managed against its durable store — no
    /// worker wake just to flip a status; anything else forwards to the live worker.
    pub(crate) async fn handle_heartbeat_manage_catalog(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<crate::supervisor::subscribers::ClientSubscriptions>,
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
            // A passive row that cannot be managed falls through to the live-worker route.
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
            None,
        )
        .await
    }

    /// `cron_add`: forward to the resolved worker and promote the owned session
    /// when the command asks for it.
    pub(crate) async fn handle_cron_add_catalog(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<crate::supervisor::subscribers::ClientSubscriptions>,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        self.route_scheduled_add(command, client_id, attached, command_id, type_name)
            .await
    }

    /// `heartbeat_set`: the same forward-plus-promote path as `cron_add`.
    pub(crate) async fn handle_heartbeat_set_catalog(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<crate::supervisor::subscribers::ClientSubscriptions>,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        self.route_scheduled_add(command, client_id, attached, command_id, type_name)
            .await
    }

    /// The shared `cron_add`/`heartbeat_set` path: resolve and forward, then promote the
    /// owner when the command carried `promoteOwnedSession` and the worker answered success.
    async fn route_scheduled_add(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: &str,
        attached: &Arc<crate::supervisor::subscribers::ClientSubscriptions>,
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
                None,
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

    /// Clear this client's ownership, persist the descriptor, and stamp the
    /// promotion marker.
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

    /// Selector-less `cron_cancel`: find the live worker that owns the job (listing its
    /// catalog, inactive included), else cancel the passive job, else the unknown-job error.
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
        // The owner search lists each worker's catalog with the inactive cut open.
        let listing_command = DaemonCommand::CronList {
            id: None,
            active_session_id: None,
            include_inactive: Some(true),
            rest: Map::default(),
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
                .is_some_and(|jobs| {
                    jobs.iter()
                        .any(|job| job.get("id").and_then(Value::as_str) == Some(job_id))
                });
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
