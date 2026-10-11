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
use crate::registry::{canonical_session_file_string, ResidentWorker};
use crate::scheduled_jobs::session_artifact_dir;
use crate::session_store::read_session_info;
use crate::supervisor::{client_command_payload, Supervisor};

const CATALOG_FORWARD_TIMEOUT_MS: u64 = 5000;

/// One passive scheduled job: a job in the session-artifacts tree whose session has no live worker.
#[derive(Clone)]
pub(crate) struct PassiveJob {
    pub(crate) job: AgentCronJob,
    pub(crate) info: crate::session_store::SessionInfo,
    canonical_session_file: String,
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
        let resident_files = self.registry.session_files().await;
        let agent_dir = self.options.agent_dir.clone();
        let scan = tokio::task::spawn_blocking(move || {
            let resident_files: HashSet<String> = resident_files
                .iter()
                .map(|file| canonical_session_file_string(file))
                .collect();
            let candidates = Self::scan_passive_candidates(&agent_dir, include_inactive);
            (resident_files, candidates)
        });
        let (resident_files, candidates) = scan.await.unwrap();
        self.classify_passive_candidates(candidates, &resident_files)
            .await
    }

    /// Filesystem work stays in the blocking pool; ownership is classified
    /// afterward, when workers registered during the scan are visible.
    fn scan_passive_candidates(agent_dir: &Path, include_inactive: bool) -> Vec<PassiveJob> {
        let mut out = Vec::new();
        for job in crate::update_roster::scan_scheduled_jobs(agent_dir) {
            if !include_inactive && !matches!(job.status, JobStatus::Active | JobStatus::Paused) {
                continue;
            }
            let session_file = Path::new(&job.session_file);
            if !session_file.is_file() {
                continue;
            }
            let Some(info) = read_session_info(session_file) else {
                continue;
            };
            if info.state.as_deref() != Some("active") {
                continue;
            }
            let canonical_file = canonical_session_file_string(&job.session_file);
            out.push(PassiveJob {
                job,
                info,
                canonical_session_file: canonical_file,
            });
        }
        out
    }

    async fn classify_passive_candidates(
        &self,
        candidates: Vec<PassiveJob>,
        resident_files: &HashSet<String>,
    ) -> Vec<PassiveJob> {
        let mut out = Vec::new();
        for passive in candidates {
            if resident_files.contains(&passive.canonical_session_file)
                || self
                    .registry
                    .owns_session_file_path(
                        &passive.job.session_file,
                        &passive.canonical_session_file,
                    )
                    .await
            {
                continue;
            }
            out.push(passive);
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

    /// Warm the passive scheduled-jobs snapshot at daemon boot (the
    /// input-latency lane): the first selector-less catalog read after boot
    /// would otherwise run the whole session-artifacts scan inline — the
    /// operator's 289-partition tree measured ~835ms inside the client's
    /// open, past the interactive surface's dock fold — while the boot
    /// itself has idle time before the first client arrives. The warmup is
    /// the same shared scan a cold read runs (one scan, generation-stamped,
    /// stored by the identical rules); every later invalidation, mutation,
    /// and stale-while-revalidate refresh keeps its semantics. A client
    /// that connects before the scan lands joins it exactly as today.
    pub(crate) fn spawn_passive_catalog_warmup(self: &Arc<Self>) {
        let supervisor = Arc::clone(self);
        tokio::spawn(async move {
            let _ = supervisor.shared_passive_scan().await;
        });
    }

    /// The boot warmup's adopt-pass ordering (serve's watch dance,
    /// lifted here for the pin below): the warmup only starts once the
    /// boot's adopt pass has settled the registry (or its signal sender
    /// is gone — the fail-open path: a degraded boot keeps the
    /// pre-warmup cold-read behavior, never a colder one).
    pub(crate) async fn wait_for_adoption_signal(signal: &mut tokio::sync::watch::Receiver<bool>) {
        loop {
            if *signal.borrow() {
                return;
            }
            if signal.changed().await.is_err() {
                return;
            }
        }
    }

    /// Invalidate the passive snapshot (TS #2487
    /// `invalidatePassiveScheduledJobs`): claim the publish epoch so an
    /// in-flight scan can no longer store, then drop the snapshot — every
    /// daemon-owned scheduled-job mutation, the saved-session
    /// delete/rename paths, and a worker-residency change call this, so
    /// the next read rescans instead of serving pre-mutation rows.
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
            let owned_elsewhere = self
                .registry
                .owns_session_file_path(&passive.job.session_file, &passive.canonical_session_file)
                .await;
            if !owned_elsewhere {
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
            match store.cancel(job_id, crate::util::now_ms()) {
                Ok(Some(job)) => {
                    self.broadcast_heartbeats_changed();
                    return (
                        vec![response_line(&response_success(
                            Some(command_id),
                            type_name,
                            Some(
                                json!({ "job": serde_json::to_value(&job).unwrap_or(Value::Null) }),
                            ),
                        ))],
                        false,
                    );
                }
                Ok(None) => {}
                Err(error) => {
                    return (
                        vec![response_line(&response_failure(
                            Some(command_id),
                            type_name,
                            &error.to_string(),
                            None,
                        ))],
                        false,
                    );
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A worker registering while the blocking artifact scan is in flight
    /// owns its job before the passive path can write to the shared store.
    #[tokio::test(start_paused = true)]
    async fn a_worker_registered_during_the_scan_gets_its_heartbeat_manage() {
        use crate::registry::{ResidentWorker, WorkerReply};
        use crate::supervisor::subscribers::ClientSubscriptions;
        use pa_types::daemon::DaemonWorkerDescriptor;

        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let session_file = sessions_dir.join("mid-scan.jsonl");
        std::fs::write(
            &session_file,
            [
                json!({
                    "type": "session", "version": 3, "id": "mid-scan",
                    "timestamp": "2026-10-04T00:00:00.000Z", "cwd": "/c",
                }),
                json!({
                    "type": "session_state", "id": "mid-scan",
                    "timestamp": "2026-10-04T00:00:01.000Z",
                    "state": { "status": "active" },
                }),
            ]
            .iter()
            .map(std::string::ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
                + "\n",
        )
        .expect("session file");
        let artifacts = agent_dir.join("session-artifacts").join("mid-scan");
        std::fs::create_dir_all(&artifacts).expect("artifacts partition");
        let job_file = artifacts.join("scheduled-jobs.json");
        let artifact = json!({
            "jobs": [{
                "id": "hb-mid", "status": "active",
                "activeSessionId": "mid-scan", "sessionId": "mid-scan",
                "sessionFile": session_file.display().to_string(),
                "cwd": dir.path().display().to_string(), "prompt": "heartbeat",
                "schedule": { "kind": "interval", "expression": "", "intervalMs": 60000 },
                "createdAt": "2026-10-04T00:00:02.000Z",
                "updatedAt": "2026-10-04T00:00:02.000Z",
                "nextRunAt": "2026-10-04T00:01:02.000Z",
            }],
        })
        .to_string();
        std::fs::write(&job_file, &artifact).expect("scheduled jobs");
        let supervisor = Arc::new(
            Supervisor::new(crate::supervisor::SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: agent_dir.clone(),
                tcp_port: None,
                tcp_bind_host: None,
                remote_agent_mesh: None,
            })
            .expect("supervisor"),
        );

        let old_files: HashSet<String> = supervisor
            .registry
            .session_files()
            .await
            .iter()
            .map(|file| canonical_session_file_string(file))
            .collect();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();
        let scan = tokio::task::spawn_blocking(move || {
            started_tx.send(()).expect("scan start");
            continue_rx.recv().expect("resume scan");
            Supervisor::scan_passive_candidates(&agent_dir, /*include_inactive*/ false)
        });
        started_rx.await.expect("scan started");

        let mut descriptor = json!({
            "version": 2, "workerId": "mid-scan", "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": "test", "rootActiveSessionId": "mid-scan",
            "createdAt": "2026-10-04T00:00:00Z",
            "updatedAt": "2026-10-04T00:00:00Z",
            "lifecycle": "ready", "createCommand": {}, "consecutiveFailures": 0,
        });
        descriptor["sessionFile"] = json!(session_file.to_string_lossy());
        let descriptor: DaemonWorkerDescriptor =
            serde_json::from_value(descriptor).expect("descriptor");
        let worker = ResidentWorker::new(
            "mid-scan".to_string(),
            descriptor,
            dir.path().join("worker.json"),
        );
        let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::channel(1);
        *worker.cmd_tx.lock().await = Some(cmd_tx);
        worker.note_connection_live();
        worker.note_session_ready();
        supervisor.registry.insert(Arc::clone(&worker)).await;
        continue_tx.send(()).expect("resume scan");

        let candidates = scan.await.expect("blocking scan");
        assert_eq!(candidates.len(), 1);
        assert!(
            supervisor
                .classify_passive_candidates(candidates, &old_files)
                .await
                .is_empty(),
            "the pre-registration snapshot must not make a live job passive"
        );

        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        let responder = Arc::clone(&worker);
        tokio::spawn(async move {
            let request = cmd_rx.recv().await.expect("forwarded heartbeat_manage");
            seen_tx
                .send(request.command_type.clone())
                .expect("forward observed");
            let reply = responder.pending.lock().await.remove(&request.request_id);
            assert!(
                reply
                    .expect("pending forward")
                    .send(WorkerReply::Typed(response_success(
                        Some(&request.request_id),
                        &request.command_type,
                        None,
                    )))
                    .is_ok(),
                "send worker reply"
            );
        });
        let command: DaemonCommand = serde_json::from_value(json!({
            "type": "heartbeat_manage", "activeSessionId": "mid-scan",
            "jobId": "hb-mid", "action": "pause",
        }))
        .expect("heartbeat_manage command");
        let (queue, _receiver) = tokio::sync::mpsc::channel(1);
        let attached = ClientSubscriptions::new("client".to_string(), queue);
        let (response, _) = supervisor
            .handle_heartbeat_manage_catalog(
                &command,
                "client",
                &attached,
                "manage-1",
                "heartbeat_manage",
            )
            .await;
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), seen_rx)
                .await
                .expect("worker did not receive the forward")
                .expect("worker saw forward"),
            "heartbeat_manage"
        );
        assert_eq!(response[0]["success"], true);
        assert_eq!(
            std::fs::read_to_string(job_file).expect("read artifact"),
            artifact
        );
    }

    /// The passive-catalog warmup (the input-latency lane): the boot's
    /// warm scan stores the snapshot with NO read anywhere, and the first
    /// catalog read serves that stored snapshot instead of scanning the
    /// artifacts tree inline. The second half is the discriminating
    /// observable: after the warm snapshot lands, the fixture's
    /// `scheduled-jobs.json` is deleted behind the daemon's back, and the
    /// first read STILL answers the warm row — a read that scanned inline
    /// at that moment would see the deleted fixture and answer nothing.
    #[tokio::test]
    async fn the_passive_catalog_warms_at_boot_and_the_first_read_serves_the_snapshot() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let session_file = sessions_dir.join("warm-1.jsonl");
        let session_lines = [
            json!({
                "type": "session", "version": 3, "id": "warm-1",
                "timestamp": "2026-10-04T00:00:00.000Z", "cwd": "/c",
            }),
            json!({
                "type": "session_state", "id": "warm-1",
                "timestamp": "2026-10-04T00:00:01.000Z",
                "state": { "status": "active" },
            }),
        ];
        std::fs::write(
            &session_file,
            session_lines
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .expect("session file");
        let artifacts = agent_dir.join("session-artifacts").join("warm-1");
        std::fs::create_dir_all(&artifacts).expect("artifacts partition");
        std::fs::write(
            artifacts.join("scheduled-jobs.json"),
            json!({
                "jobs": [{
                    "id": "hb-1",
                    "status": "active",
                    "activeSessionId": "warm-1",
                    "sessionId": "warm-1",
                    "sessionFile": session_file.display().to_string(),
                    "cwd": dir.path().display().to_string(),
                    "prompt": "the warm heartbeat",
                    "schedule": { "kind": "interval", "expression": "", "intervalMs": 60000 },
                    "createdAt": "2026-10-04T00:00:02.000Z",
                    "updatedAt": "2026-10-04T00:00:02.000Z",
                    "nextRunAt": "2026-10-04T00:01:02.000Z",
                }],
            })
            .to_string(),
        )
        .expect("scheduled jobs");

        let supervisor = Arc::new(
            Supervisor::new(crate::supervisor::SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: agent_dir.clone(),
                tcp_port: None,
                tcp_bind_host: None,
                remote_agent_mesh: None,
            })
            .expect("supervisor"),
        );

        // The boot warmup (what `serve` spawns beside its other boot
        // passes): the scan runs with no catalog read anywhere.
        supervisor.spawn_passive_catalog_warmup();

        // The warm snapshot lands on its own: one row, the fixture's
        // heartbeat. No `heartbeats_list`/`cron_list` was issued.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let warm_rows = supervisor
                .passive_catalog
                .lock()
                .unwrap()
                .as_ref()
                .map(|snapshot| snapshot.rows.len());
            if warm_rows == Some(1) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the boot warmup never stored the passive snapshot"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // The first read must serve the stored snapshot, not a fresh
        // scan: the fixture's artifact vanishes behind the daemon's back
        // (no mutation was issued, so no invalidation owes a re-scan),
        // and the read still answers the warm row.
        std::fs::remove_file(artifacts.join("scheduled-jobs.json")).expect("delete fixture");
        let rows = supervisor.passive_catalog_rows(false).await;
        assert_eq!(
            rows.len(),
            1,
            "the first read must serve the warm snapshot instead of rescanning"
        );
        assert_eq!(rows[0].job.id, "hb-1");
        assert_eq!(rows[0].job.session_file, session_file.display().to_string());
    }

    /// The boot warmup's adopt-pass ordering (the pre-bar review's race
    /// finding): the warmup's scan consults the registry's live-worker
    /// filter, so it must wait out the boot's adopt pass — a scan that
    /// raced adoption would cache the just-adopted worker's artifacts as
    /// a passive row and serve the stale row for the snapshot's refresh
    /// window (adoption never invalidates the catalog). The pin: with the
    /// adopt signal unfired the snapshot never lands; once the signal
    /// fires, it does.
    #[tokio::test]
    async fn the_boot_warmup_waits_out_the_adopt_pass_before_scanning() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
        let supervisor = Arc::new(
            Supervisor::new(crate::supervisor::SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: agent_dir.clone(),
                tcp_port: None,
                tcp_bind_host: None,
                remote_agent_mesh: None,
            })
            .expect("supervisor"),
        );

        let (adoption_tx, adoption_rx) = tokio::sync::watch::channel(false);

        // The negative pin is on the WAITER itself, not on the scan's
        // downstream effect: with the signal unfired the helper must stay
        // pending for the whole window (a helper that returned early
        // would finish in microseconds — the window catches it
        // deterministically; a correct helper can only return on the
        // signal or the sender's death, neither of which happens here).
        let mut waiter = {
            let supervisor = Arc::clone(&supervisor);
            let mut adoption_rx = adoption_rx;
            tokio::spawn(async move {
                Supervisor::wait_for_adoption_signal(&mut adoption_rx).await;
                supervisor.spawn_passive_catalog_warmup();
            })
        };
        let still_waiting =
            tokio::time::timeout(std::time::Duration::from_millis(150), &mut waiter).await;
        assert!(
            still_waiting.is_err(),
            "the warmup helper returned before the adopt pass signaled"
        );

        // The adopt pass settles: the waiter completes and the scan
        // lands (the positive pin is a poll with a real deadline — a
        // failure names the missing snapshot).
        adoption_tx.send(true).expect("signal adoption");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while supervisor.passive_catalog.lock().unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the warmup never scanned after the adopt pass signaled"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
            .await
            .expect("the warmup waiter never completed")
            .expect("the warmup task");
    }
}
