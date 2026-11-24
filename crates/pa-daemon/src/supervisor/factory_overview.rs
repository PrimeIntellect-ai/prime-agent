//! The supervisor's `factory_activity` `overview` arm: the read-only,
//! all-session assembly behind the factory page's consolidated view.
//!
//! The supervisor owns the `overview` command: the request itself is
//! never forwarded to a worker or a kernel. Its live half reads every
//! owner's kernel through the non-arming `peek` action — the unscoped
//! graph minus the rehydration re-arm, an additive executor read (the
//! one executor seam this feature touches: `activity()` skips the
//! re-arm for `peek` alone), so a display refresh in one session never
//! completes another owner's interrupted flows and never boots or wakes
//! an owner. Every owner the daemon knows contributes those live runs
//! and its durable run records (the executor's registry under the
//! owner's artifact dir), both projected into the same snapshot shape
//! the scoped lane answers, keyed by owner identity, and filtered by the
//! live predicate AFTER the overlay. No registry, ownership, or control
//! behavior changes.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

use super::known_sessions::{scan_known_sessions, KnownSessionRoots, ResidentFile};
use super::{
    paths, response_failure, response_success, Arc, DaemonResponse, ResidentWorker, RouteAdmission,
    Supervisor, SUMMARY_TIMEOUT_MS, WORKER_READ_TIMED_OUT,
};
use pa_core::session_engine::harness_digest::session_artifact_dir_for_log;
use pa_types::daemon::ACTIVITY_POLL_INTERVAL;

/// The executor's run-registry directory under a session's artifact dir
/// (`RUNS_DIR_NAME` in `prime-agent-runtime/src/rlm/factory.py`): one
/// `<run id>.json` per durable run, retired when the run goes terminal,
/// so the archive on disk holds only runs that are not finished.
const FACTORY_RUNS_DIR_NAME: &str = "factory-runs";

/// The run states the page keeps (the kernel's own live states and the
/// TUI's `FactoryRunSnapshot::is_live`): a live state, or children still
/// in flight.
const LIVE_RUN_STATES: [&str; 3] = ["running", "stopping", "paused"];

/// How long a durable run record of an owner with no resident worker
/// still lists on the page: the executor retires a record only when its
/// run goes terminal, so a run whose session ended, crashed, or was
/// abandoned keeps its record — and its persisted running or paused
/// state — forever, and nothing else bounds the rows the page folds. The
/// page is the view of ACTIVE machines: a record nothing has written
/// for this long belongs to a run no live kernel drives, so its row
/// stops listing (the record itself stays on disk — nothing retires or
/// resumes it). Owners with a resident worker keep every record: their
/// kernel reads the runs live, so the page routes their rows to the
/// run page and its guidance.
pub(crate) const FACTORY_SAVED_RECORD_RETENTION: Duration = Duration::from_hours(24);

/// One resident worker the overview reads live: the worker, its active
/// id (the `peek` route), and its durable owner id once the catalog scan
/// resolved it.
#[derive(Clone)]
struct ResidentOwner {
    id: String,
    active_session_id: String,
    name: Option<String>,
    session_file: Option<PathBuf>,
    resident: Arc<ResidentWorker>,
}

/// One catalog owner: its identity, its display name, and its
/// conversation log (the artifact-dir derivation's input; memory-only
/// owners carry none, so they hold no durable records).
struct CatalogOwner {
    id: String,
    name: Option<String>,
    log: Option<PathBuf>,
}

/// The overview's live-half cache, keyed by worker id: the last rows each
/// resident worker's kernel answered through the non-arming `peek` read,
/// each stamped with its read time, plus each worker's last real read
/// failure. A worker id is fresh per launched worker, so a read from a
/// worker that is gone has no slot and drops, and a re-admitted session's
/// new worker starts empty. The request path serves this snapshot;
/// guarded per-worker background refreshes, never awaited by a request,
/// keep each worker at most one read behind. A busy worker keeps its last
/// rows (served with the saved marker once they age past the freshness
/// bound) until its read lands again.
#[derive(Debug, Default)]
pub(crate) struct FactoryLiveCache {
    /// The last good live rows per worker.
    pub(crate) rows: BTreeMap<String, Vec<Value>>,
    /// When each worker's rows were last read: rows older than two page
    /// poll windows ([`FACTORY_LIVE_FRESH_WINDOW`]) serve with the saved
    /// marker, never as unqualified live.
    pub(crate) read_at: BTreeMap<String, Instant>,
    /// A real read failure's reason per worker (a busy, successful, or
    /// skipped read clears it).
    pub(crate) warnings: BTreeMap<String, String>,
    /// The workers with a background read in flight: at most one each.
    pub(crate) in_flight: BTreeSet<String>,
    /// The workers of the latest refresh.
    pub(crate) resident: BTreeSet<String>,
}

/// Two activity-poll windows ([`ACTIVITY_POLL_INTERVAL`] in pa-types,
/// the cadence the page's own overview poll fires at): the age beyond
/// which cached live rows can no longer be served as unqualified live.
/// Serving runs one read behind the page's cadence — the refresh a
/// poll spawns lands after that poll's reply served the cache, so a
/// healthy owner's stamp is already one window old at the next poll —
/// so the bound needs the second window of slack or healthy rows flip
/// to saved at cadence. Two windows still sit under the 5 s read budget
/// (`SUMMARY_TIMEOUT_MS`), so a read that times out leaves its rows
/// past the bound at the next serve: a busy or timed-out owner's
/// snapshot serves saved, never as unqualified live, until a later read
/// restamps it.
pub(crate) const FACTORY_LIVE_FRESH_WINDOW: Duration = ACTIVITY_POLL_INTERVAL.saturating_mul(2);

impl Supervisor {
    /// `factory_activity` action `overview`: every daemon-known session's
    /// active factory runs, machines, states, and progress, read-only.
    /// The catalog scan (saved sessions, passive RLM children, roster-
    /// known passivated owners, durable records) answers from the
    /// filesystem; the live half serves the last rows the guarded
    /// background refresh read, so no kernel read ever sits on the
    /// reply's path.
    pub(crate) async fn factory_overview(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
    ) -> DaemonResponse {
        let sessions_dir = match paths::sessions_dir(&self.options.agent_dir) {
            Ok(dir) => dir,
            Err(error) => {
                return response_failure(Some(command_id), type_name, &error.to_string(), None)
            }
        };
        // Every resident is read live, file or not (the catalog alone
        // omits memory-only owners). A quarantined identity or a retired
        // route is not the session's live worker: during a replacement it
        // is the one going away.
        let mut resident_owners: Vec<ResidentOwner> = Vec::new();
        for resident in self.registry.list().await {
            if resident.identity_quarantined() || resident.route_state().retired() {
                continue;
            }
            let descriptor = resident.descriptor.lock().await;
            if descriptor.root_active_session_id.is_empty() {
                continue;
            }
            resident_owners.push(ResidentOwner {
                id: descriptor
                    .root_session_id
                    .clone()
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| descriptor.root_active_session_id.clone()),
                active_session_id: descriptor.root_active_session_id.clone(),
                name: None,
                session_file: descriptor.session_file.as_ref().map(PathBuf::from),
                resident: Arc::clone(&resident),
            });
        }
        {
            let roster = self.roster.lock().unwrap();
            for owner in &mut resident_owners {
                owner.name = roster
                    .by_active_session_id(&owner.active_session_id)
                    .and_then(|entry| {
                        entry
                            .summary
                            .get("sessionName")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
            }
        }
        // The live half is a CACHE SERVE, never an awaited read: one busy
        // owner never stalls the reply. The guarded refresh keeps the cache
        // at most one read behind the page's cadence; a cold cache answers
        // the durable rows alone.
        self.spawn_factory_live_refresh(&resident_owners);
        let resident_files: Vec<ResidentFile> = resident_owners
            .iter()
            .filter_map(|owner| {
                Some(ResidentFile {
                    session_file: owner.session_file.clone()?,
                    active_session_id: owner.active_session_id.clone(),
                })
            })
            .collect();
        let roots = match self.known_session_roots(sessions_dir, resident_files).await {
            Ok(roots) => roots,
            Err(error) => {
                return response_failure(Some(command_id), type_name, &error.to_string(), None)
            }
        };
        let records_cache = Arc::clone(&self.factory_records);
        let scan_owners = resident_owners.clone();
        let catalog_task = tokio::task::spawn_blocking(move || {
            catalog_and_records(&roots, &scan_owners, &records_cache)
        });
        let (owners, live_owner_ids, records, mut warnings) = match catalog_task.await {
            Ok(catalog) => catalog,
            Err(error) => {
                return response_failure(
                    Some(command_id),
                    type_name,
                    &format!("the factory overview catalog scan failed: {error}"),
                    None,
                )
            }
        };
        // Each owner's live worker: the first resident the scan resolved to
        // that owner.
        let mut live_worker: BTreeMap<&str, &str> = BTreeMap::new();
        for (owner, id) in resident_owners.iter().zip(&live_owner_ids) {
            live_worker
                .entry(id.as_str())
                .or_insert(owner.resident.worker_id.as_str());
        }
        let (mut live_rows, live_read_at, live_warnings) = {
            let cache = self.factory_live.lock().unwrap();
            (
                cache.rows.clone(),
                cache.read_at.clone(),
                cache.warnings.values().cloned().collect::<Vec<String>>(),
            )
        };
        warnings.extend(live_warnings);
        let mut rows: Vec<Value> = Vec::new();
        for owner in owners.values() {
            // Live rows win over durable rows for the same run id; the
            // live predicate runs AFTER that overlay, so a live terminal
            // result removes an older saved running row instead of
            // resurrecting it from disk. Cached rows older than the
            // freshness bound carry the saved marker: the page never paints
            // a ticking live claim off a snapshot with no confirmed read
            // behind it.
            let worker = live_worker.get(owner.id.as_str()).copied();
            let stale = !live_rows_are_fresh(worker.and_then(|worker| live_read_at.get(worker)));
            let mut live: Vec<Value> = worker
                .and_then(|worker| live_rows.remove(worker))
                .unwrap_or_default();
            live.reverse();
            let live_ids: Vec<String> = live
                .iter()
                .map(|row| {
                    row.get("runId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                })
                .collect();
            let durable = records.get(&owner.id).cloned().unwrap_or_default();
            let merged: Vec<(bool, Value)> = live
                .into_iter()
                .map(|row| {
                    // A live row still queued for its re-arm (`armed:
                    // false`) is listed but not executing: it reports
                    // saved, like an aged row. The marker stays on the row,
                    // since the page routes by it.
                    let saved = stale || row.get("armed") == Some(&json!(false));
                    (saved, row)
                })
                .chain(durable.into_iter().filter_map(|row| {
                    let run_id = row.get("runId").and_then(Value::as_str).unwrap_or_default();
                    (!live_ids.iter().any(|id| id == run_id)).then_some((true, row))
                }))
                .collect();
            let name = owner.name.clone().unwrap_or_default();
            for (saved, mut row) in merged {
                if let Some(object) = row.as_object_mut() {
                    object.insert("ownerId".to_string(), json!(owner.id));
                    object.insert("ownerName".to_string(), json!(name));
                    object.insert("saved".to_string(), json!(saved));
                }
                if row_is_live(&row) {
                    rows.push(row);
                }
            }
        }
        response_success(
            Some(command_id),
            type_name,
            Some(json!({ "runs": rows, "warnings": warnings })),
        )
    }

    /// Spawn the live-half refresh: one guarded background read per
    /// resident (never only the owners with durable records — a terminal
    /// run whose children still run has no record), each folding into the
    /// cache the moment it lands. The overview request never awaits any
    /// of them — the reply stays bounded by the catalog scan, a busy
    /// owner keeps its last rows until its read lands, and one owner's
    /// pending read never delays another owner's fold.
    fn spawn_factory_live_refresh(self: &Arc<Self>, owners: &[ResidentOwner]) {
        let mut guard = self.factory_live.lock().unwrap();
        let cache = &mut *guard;
        // A worker that left the resident list took its kernel with it:
        // its rows go (the session's durable records still answer).
        cache.resident = owners
            .iter()
            .map(|owner| owner.resident.worker_id.clone())
            .collect();
        let resident = &cache.resident;
        cache.rows.retain(|worker, _| resident.contains(worker));
        cache.read_at.retain(|worker, _| resident.contains(worker));
        cache.warnings.retain(|worker, _| resident.contains(worker));
        for owner in owners {
            if !cache.in_flight.insert(owner.resident.worker_id.clone()) {
                continue; // this worker's read is still pending: never stack a second
            }
            let supervisor = Arc::clone(self);
            let owner = owner.clone();
            tokio::spawn(async move {
                let outcome = supervisor.read_factory_live(&owner).await;
                supervisor.fold_factory_live(&owner.resident.worker_id, &owner.id, outcome);
            });
        }
    }

    /// One owner's live read: the non-arming `peek` through its resident.
    /// A resident that is still booting (its worker socket not yet wired,
    /// its create not yet complete) has no live rows to read yet: `None`
    /// skips it without a warning — the same silent empty the no-kernel
    /// peek answers, never a boot-window "unavailable" flash on the page.
    async fn read_factory_live(
        self: &Arc<Self>,
        owner: &ResidentOwner,
    ) -> Option<anyhow::Result<DaemonResponse>> {
        let route = owner.resident.route_state();
        if !route.connected || !route.session_ready || route.retired() {
            return None;
        }
        Some(
            self.route_command_typed(
                &owner.resident,
                "factory_activity",
                json!({
                    "activeSessionId": owner.active_session_id,
                    "action": "peek",
                }),
                SUMMARY_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await,
        )
    }

    /// Fold one owner's read into the live cache: a successful read
    /// replaces its rows and stamps their read time; a timed-out read
    /// keeps them with their OLD stamp (a busy owner is not a broken one
    /// — its kernel holds the peek frame in a synchronous cell, and the
    /// rows' AGE at serve time is what bounds the live claim, so the
    /// next read that lands restores it); a real failure keeps them and
    /// carries its reason; a skipped (booting) owner keeps them through
    /// its boot window. The read's in-flight slot frees either way.
    fn fold_factory_live(
        &self,
        worker: &str,
        owner: &str,
        outcome: Option<anyhow::Result<DaemonResponse>>,
    ) {
        let mut cache = self.factory_live.lock().unwrap();
        cache.in_flight.remove(worker);
        // The worker left the resident list while its read was out: its
        // rows, timeout, or failure belong to nobody now.
        if !cache.resident.contains(worker) {
            return;
        }
        match outcome {
            // Not route-ready yet: no live rows, no warning.
            None => {
                cache.warnings.remove(worker);
            }
            Some(reply) => match live_read_outcome(&reply) {
                LiveRead::Rows(rows) => {
                    cache.rows.insert(worker.to_string(), rows);
                    cache.read_at.insert(worker.to_string(), Instant::now());
                    cache.warnings.remove(worker);
                }
                LiveRead::Busy => {
                    cache.warnings.remove(worker);
                }
                LiveRead::Failed(reason) => {
                    cache.warnings.insert(
                        worker.to_string(),
                        format!("session {owner}: live factory graph unavailable: {reason}"),
                    );
                }
            },
        }
    }
}

/// Whether an owner's cached rows are still FRESH enough to serve as
/// unqualified live: read within the freshness bound (two page poll
/// windows — serving runs one read behind the page's cadence). Rows
/// without a read time are never fresh — an unqualified live claim
/// needs a live read behind it.
fn live_rows_are_fresh(read_at: Option<&Instant>) -> bool {
    read_at.is_some_and(|read_at| read_at.elapsed() <= FACTORY_LIVE_FRESH_WINDOW)
}

/// The catalog scan's result: every known owner, each resident's durable
/// owner id (in the order the residents were passed), the owners' durable
/// run rows, and the partial-failure warnings.
type CatalogScan = (
    BTreeMap<String, CatalogOwner>,
    Vec<String>,
    BTreeMap<String, Vec<Value>>,
    Vec<String>,
);

/// One cached durable-record projection: the record file's last-seen
/// modification time and the projected row (`None` when the record
/// does not project — the malformed shape, which warns at every scan
/// exactly as a fresh parse would). An unreadable file never caches:
/// its read failure may be transient, so the next scan re-reads it.
pub(crate) struct CachedRecord {
    modified: SystemTime,
    row: Option<Value>,
}

/// The overview's durable-record cache: the last projection of every
/// record file the scan read, keyed by the file's path. The scan stats
/// a record before reading it — an unchanged file (the same
/// modification time) reuses its cached projection instead of
/// re-reading and re-parsing on every overview poll, and a changed one
/// re-reads. The scan prunes entries for records it no longer projects
/// (a retired record, an aged-out row, a gone archive), so the cache
/// holds exactly the records the page still lists.
pub(crate) type FactoryRecordsCache = std::sync::Mutex<BTreeMap<PathBuf, CachedRecord>>;

/// The catalog half of the overview: every owner the shared session
/// catalog knows (the one `list --all` reads) plus every resident, each
/// with its durable run records read and projected into the page's row
/// shape. Pure filesystem reads: no kernel, no worker, no boot.
fn catalog_and_records(
    roots: &KnownSessionRoots,
    residents: &[ResidentOwner],
    records_cache: &FactoryRecordsCache,
) -> CatalogScan {
    let known = scan_known_sessions(roots, None);
    let mut warnings = known.warnings;
    let mut owners: BTreeMap<String, CatalogOwner> = BTreeMap::new();
    // A resident hosting a saved session is that session's owner (a
    // booting worker has no persisted id yet, and its file's records must
    // not list under a second id); any other resident owns itself.
    let file_residents: Vec<usize> = residents
        .iter()
        .enumerate()
        .filter(|(_, resident)| resident.session_file.is_some())
        .map(|(index, _)| index)
        .collect();
    let mut live_owner_ids: Vec<String> = residents
        .iter()
        .map(|resident| resident.id.clone())
        .collect();
    for (info, hosted) in &known.saved {
        let resident = hosted.map(|index| file_residents[index]);
        if let Some(index) = resident {
            live_owner_ids[index].clone_from(&info.id);
        }
        owners
            .entry(info.id.clone())
            .or_insert_with(|| CatalogOwner {
                id: info.id.clone(),
                name: info
                    .name
                    .clone()
                    .or_else(|| resident.and_then(|index| residents[index].name.clone())),
                log: Some(info.path.clone()),
            });
    }
    for child in &known.children {
        owners
            .entry(child.info.id.clone())
            .or_insert_with(|| CatalogOwner {
                id: child.info.id.clone(),
                name: child.info.name.clone(),
                log: Some(child.info.path.clone()),
            });
    }
    for (resident, id) in residents.iter().zip(&live_owner_ids) {
        owners.entry(id.clone()).or_insert_with(|| CatalogOwner {
            id: id.clone(),
            name: resident.name.clone(),
            log: resident.session_file.clone(),
        });
    }
    // The retention bound's gate: an owner with a resident worker reads its
    // runs live, so its records are reachable rows, never ghosts that age
    // out.
    let resident_ids: BTreeSet<&str> = live_owner_ids.iter().map(String::as_str).collect();
    let mut records: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    // The record paths the scan projects this pass: the cache prunes to
    // them at the end, so entries for retired or aged-out records drop
    // and the cache holds exactly the rows the page still lists.
    let mut projected: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for owner in owners.values() {
        let Some(log) = &owner.log else { continue };
        let Some(artifact_dir) = session_artifact_dir_for_log(log) else {
            continue;
        };
        let runs_dir = artifact_dir.join(FACTORY_RUNS_DIR_NAME);
        let entries = match std::fs::read_dir(&runs_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                warnings.push(format!(
                    "session {}: factory run records unreadable: {error}",
                    owner.id
                ));
                continue;
            }
        };
        let mut rows = Vec::new();
        // The retention bound's gate: an owner with a resident worker
        // reads its runs live, so its records are reachable rows, never
        // ghosts that age out.
        let resident = resident_ids.contains(owner.id.as_str());
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(modified) = std::fs::metadata(&path).and_then(|metadata| metadata.modified())
            else {
                warnings.push(format!(
                    "session {}: unreadable run record {}",
                    owner.id,
                    path.display()
                ));
                continue;
            };
            // The retention bound: a durable-only row of an owner with
            // no resident worker lists only while its record is younger
            // than the window. An abandoned run's persisted running or
            // paused state is the page's only claim for it, and a
            // record nothing has written for this long has no live
            // kernel behind it — the row stops listing; the record
            // stays on disk.
            if !resident
                && modified
                    .elapsed()
                    .is_ok_and(|age| age > FACTORY_SAVED_RECORD_RETENTION)
            {
                continue;
            }
            projected.insert(path.clone());
            // The mtime-keyed cache: an unchanged record reuses its
            // last projection instead of re-reading and re-parsing on
            // every poll; a changed one re-reads below. The guard drops
            // before the read, so the miss path never re-locks against
            // itself.
            let cached = {
                let cache = records_cache.lock().unwrap();
                cache
                    .get(&path)
                    .filter(|cached| cached.modified == modified)
                    .map(|cached| cached.row.clone())
            };
            let row = if let Some(cached) = cached {
                // A cache hit re-serves the last projection, malformed
                // included: the CachedRecord contract warns the
                // malformed shape at every scan exactly as a fresh
                // parse would, so a hit whose cached row is None warns
                // again — the record's partial failure stays visible on
                // every poll, never only the scan that first read it.
                if cached.is_none() {
                    warnings.push(format!(
                        "session {}: malformed run record {}",
                        owner.id,
                        path.display()
                    ));
                }
                cached
            } else {
                let record = std::fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                let Some(record) = record else {
                    warnings.push(format!(
                        "session {}: unreadable run record {}",
                        owner.id,
                        path.display()
                    ));
                    continue;
                };
                let row = saved_row(&record);
                if row.is_none() {
                    warnings.push(format!(
                        "session {}: malformed run record {}",
                        owner.id,
                        path.display()
                    ));
                }
                records_cache.lock().unwrap().insert(
                    path,
                    CachedRecord {
                        modified,
                        row: row.clone(),
                    },
                );
                row
            };
            if let Some(row) = row {
                rows.push(row);
            }
        }
        // A stable order for disk-only rows: run ids, never a monotonic
        // clock (the record's `started_at` is kernel-monotonic, not
        // comparable across boots).
        rows.sort_by(|left, right| {
            left.get("runId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .cmp(
                    right
                        .get("runId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
        });
        records.insert(owner.id.clone(), rows);
    }
    records_cache
        .lock()
        .unwrap()
        .retain(|path, _| projected.contains(path));
    (owners, live_owner_ids, records, warnings)
}

/// Whether a merged row is LIVE in the page's sense — the exact rule the
/// TUI's `FactoryRunSnapshot::is_live` reads: a live state, or children
/// still in flight (a terminal run whose residents still run stays).
fn row_is_live(row: &Value) -> bool {
    LIVE_RUN_STATES.contains(&row.get("state").and_then(Value::as_str).unwrap_or_default())
        || row
            .get("usage")
            .and_then(|usage| usage.get("running"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
}

/// The live half's fold of one successful `peek` reply: its run
/// rows, each through the display-only allowlist. `None` marks a
/// malformed reply (no `runs` list) — the warning path, never a
/// silent zero.
fn live_rows_from_snapshot(data: Option<&Value>) -> Option<Vec<Value>> {
    data.and_then(|data| data.get("runs"))
        .and_then(Value::as_array)
        .map(|runs| runs.iter().map(live_row).collect())
}

/// One owner's live-read outcome: the rows when the lane answered,
/// busy when the read outlived its budget (the route's own timeout
/// wording at `routing.rs`/`backpressure.rs`), and the real reason
/// when the read actually failed.
#[derive(Debug)]
enum LiveRead {
    Rows(Vec<Value>),
    Busy,
    Failed(String),
}

/// Classify one owner's `peek` reply: a successful reply folds its rows
/// (a malformed one fails with the reason); the read budget elapsing is
/// BUSY, never broken — a kernel whose event loop runs a synchronous
/// cell holds the frame, and the owner keeps its last rows with no
/// warning until a later poll answers; every other failure (a refused
/// reply, a gone socket) carries its real reason into the warning.
fn live_read_outcome(reply: &anyhow::Result<DaemonResponse>) -> LiveRead {
    match reply {
        Ok(response) if response.success => live_rows_from_snapshot(response.data.as_ref()).map_or(
            LiveRead::Failed("live factory graph reply malformed".to_string()),
            LiveRead::Rows,
        ),
        Ok(response) => LiveRead::Failed(
            response
                .error
                .clone()
                .unwrap_or_else(|| "the worker refused the read".to_string()),
        ),
        Err(error) if error.to_string() == WORKER_READ_TIMED_OUT => LiveRead::Busy,
        Err(error) => LiveRead::Failed(error.to_string()),
    }
}

/// The fields a live snapshot row carries into the overview: the
/// page's own row fields — the same cut the saved projection makes, so
/// no declared run block, transition guards, milestone tail, pause
/// reason, or budget ever travels to another session's page — plus
/// the live lane's own `elapsedMs` age and the peek lane's `armed`
/// marker (false only while the run still awaits its re-arm).
/// `machine` and `nodes` project one level deeper; every other key
/// drops. `usage` rides whole, so the kernel report's integer
/// counters travel inside it — the saved projection's six counters
/// plus `maxChildren`, a live-only limit the page never reads; what
/// the cut removes is the run block's own copy under `machine.run`,
/// never the counters.
const LIVE_ROW_FIELDS: &[&str] = &[
    "runId",
    "specId",
    "name",
    "state",
    "elapsedMs",
    "armed",
    "usage",
];

/// One live node row's fields: the state report's status, counters,
/// occupancy, and error — never the state-level `answerPreview` or
/// `needsVerify` hint.
const LIVE_NODE_FIELDS: &[&str] = &[
    "id",
    "status",
    "lifecycle",
    "attempts",
    "entriesUsed",
    "maxEntries",
    "running",
    "queued",
    "error",
];

/// One live entry row's fields: index, status, error. The needs-verify
/// pair — the boolean and its `provisionalAnswer`, child answer text —
/// never travels; the entry's owner reads it through its own scoped
/// surfaces.
const LIVE_ENTRY_FIELDS: &[&str] = &["index", "status", "error"];

/// One live instance row's fields: identity, status, and the live
/// child id the page's node parser reads.
const LIVE_INSTANCE_FIELDS: &[&str] = &[
    "index",
    "entry",
    "status",
    "attempt",
    "child",
    "durationMs",
    "error",
];

/// Copy one object row field by field through a key allowlist; any
/// other key drops. A non-object row projects to the empty object
/// (the page's parser drops it, the same way the scoped lane's parser
/// drops a malformed row).
fn allowed_fields(row: &Value, keys: &[&str]) -> serde_json::Map<String, Value> {
    let mut projected = serde_json::Map::new();
    if let Some(object) = row.as_object() {
        for key in keys {
            projected.insert(
                (*key).to_string(),
                object.get(*key).cloned().unwrap_or(Value::Null),
            );
        }
    }
    projected
}

/// One live snapshot row through the page's own field set — the saved
/// projection's cut (the machine's state ids alone) plus the live
/// lane's own `elapsedMs` and `armed`, with `nodes` one level deeper.
/// The scoped `graph` lane keeps its own reply contract; the overview's
/// copy never carries answer text (a paused needs-verify entry's
/// `provisionalAnswer` stays with its owner's own surfaces) — the
/// same privacy rule the saved projection applies to records, and the
/// same field cut: the run page never mounts an overview row (owned
/// rows open it over the scoped graph, foreign rows report their
/// owner), so the page's row fields are all this copy ever needs.
fn live_row(row: &Value) -> Value {
    let mut projected = allowed_fields(row, LIVE_ROW_FIELDS);
    projected.insert("machine".to_string(), saved_machine(row));
    projected.insert(
        "nodes".to_string(),
        json!(row
            .get("nodes")
            .and_then(Value::as_array)
            .map(|nodes| nodes.iter().map(live_node).collect::<Vec<_>>())
            .unwrap_or_default()),
    );
    Value::Object(projected)
}

/// One live node row through the display-only allowlist, its entries
/// and instances one level deeper.
fn live_node(node: &Value) -> Value {
    let mut projected = allowed_fields(node, LIVE_NODE_FIELDS);
    projected.insert(
        "entries".to_string(),
        json!(allowed_rows(node.get("entries"), LIVE_ENTRY_FIELDS)),
    );
    projected.insert(
        "instances".to_string(),
        json!(allowed_rows(node.get("instances"), LIVE_INSTANCE_FIELDS)),
    );
    Value::Object(projected)
}

/// The rows of one node array, each through its own allowlist.
fn allowed_rows(rows: Option<&Value>, keys: &[&str]) -> Vec<Value> {
    rows.and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| Value::Object(allowed_fields(row, keys)))
                .collect()
        })
        .unwrap_or_default()
}

/// Project one durable registry record into the page's row shape: the
/// fields an overview row needs — identity, name, state, the machine's
/// state ids, the node statuses, and the usage counters — derived from
/// the persisted fields. The raw record never travels, and neither does
/// the persisted machine's declared shape: prompts, params, answers,
/// events, budgets, and pause reasons stay on disk (the page reads a
/// saved row's machine for its state ids alone, and paints the saved
/// marker, never a live elapsed age).
fn saved_row(record: &Value) -> Option<Value> {
    let run_id = record.get("run_id").and_then(Value::as_str)?;
    if run_id.is_empty() {
        return None;
    }
    Some(json!({
        "runId": run_id,
        "specId": record.get("spec_id").and_then(Value::as_str).unwrap_or_default(),
        "name": record.get("name"),
        "state": record.get("state").and_then(Value::as_str),
        "machine": saved_machine(record),
        "nodes": saved_nodes(record),
        "usage": saved_usage(record),
    }))
}

/// The machine's state ids alone — the cut BOTH halves make: the saved
/// projection reads the persisted record, the live allowlist the
/// kernel's own snapshot. The page's run parser reads
/// `machine.states[].id` (`FactoryState::parse` needs only the id), so
/// the declared rows — the run block with its copied defaults, the
/// transitions and their guards, the order, and every state's callable,
/// model, or subagent declaration — never travel to the page.
fn saved_machine(record: &Value) -> Value {
    json!({
        "states": record
            .get("machine")
            .and_then(Value::as_object)
            .and_then(|machine| machine.get("states"))
            .and_then(Value::as_array)
            .map(|states| {
                states
                    .iter()
                    .map(|state| json!({ "id": state.get("id") }))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    })
}

/// One run's node rows from the persisted state map, in the run's own
/// order: the status the executor derives (the last entry's status, or
/// pending/cancelled), the entry statuses, the per-stage agent occupancy,
/// and the error — never the prompts or answers the entries carry.
fn saved_nodes(record: &Value) -> Vec<Value> {
    let Some(states) = record.get("states").and_then(Value::as_object) else {
        return Vec::new();
    };
    let declared_order: Vec<&str> = record
        .get("order")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut ids: Vec<&str> = Vec::new();
    for id in declared_order {
        if states.contains_key(id) && !ids.contains(&id) {
            ids.push(id);
        }
    }
    for id in states.keys() {
        if !ids.contains(&id.as_str()) {
            ids.push(id);
        }
    }
    ids.iter()
        .filter_map(|id| states.get(*id))
        .map(saved_node)
        .collect()
}

/// One persisted state's node row.
fn saved_node(state: &Value) -> Value {
    let entries = state.get("entries").and_then(Value::as_array);
    // The executor's derived status: the last entry's status, else
    // cancelled/pending (`_StateRun.status` in rlm/factory.py).
    let last_entry_status = entries
        .and_then(|entries| entries.last())
        .and_then(|entry| entry.get("status").and_then(Value::as_str));
    let status = last_entry_status.unwrap_or(if state.get("cancelled") == Some(&json!(true)) {
        "cancelled"
    } else {
        "pending"
    });
    let instances: Vec<&Value> = entries
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("instances").and_then(Value::as_array))
        .flatten()
        .collect();
    json!({
        "id": state.get("state_id"),
        "status": status,
        "entriesUsed": state.get("entries_used"),
        "maxEntries": state.get("max_entries"),
        "entries": entries
            .map(|rows| {
                rows.iter()
                    .map(|entry| json!({ "status": entry.get("status") }))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        "instances": instances
            .iter()
            .map(|instance| json!({ "status": instance.get("status") }))
            .collect::<Vec<_>>(),
        "running": instances
            .iter()
            .filter(|instance| instance.get("status").and_then(Value::as_str) == Some("running"))
            .count(),
        "queued": instances
            .iter()
            .filter(|instance| instance.get("status").and_then(Value::as_str) == Some("pending"))
            .count(),
        "error": state.get("error"),
    })
}

/// The usage block derived from the persisted counters and the state map —
/// the same counts the live `_usage_report` reads.
fn saved_usage(record: &Value) -> Value {
    let running = record
        .get("states")
        .and_then(Value::as_object)
        .map_or(0, |states| {
            states
                .values()
                .filter_map(|state| state.get("entries").and_then(Value::as_array))
                .flatten()
                .filter_map(|entry| entry.get("instances").and_then(Value::as_array))
                .flatten()
                .filter(|instance| {
                    instance.get("status").and_then(Value::as_str) == Some("running")
                })
                .count()
        });
    json!({
        "spawns": record.get("spawn_count").and_then(Value::as_u64),
        "settled": record.get("settle_count").and_then(Value::as_u64),
        "toolUses": record.get("tool_use_total").and_then(Value::as_u64),
        "maxParallel": record.get("max_parallel").and_then(Value::as_u64),
        "running": running,
        "transitionsFired": record.get("transitions_fired").and_then(Value::as_u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::SupervisorOptions;
    use crate::test_support::KernelEnvOverride;
    use pa_types::daemon::DaemonWorkerDescriptor;

    /// The overview resolves its saved catalog through `paths::sessions_dir`,
    /// which honors `PRIME_AGENT_SESSION_DIR`: a test run from a session that
    /// exports it would read that folder instead of the temp agent dir. The
    /// guard clears it under the crate-wide env lock for the test's whole body.
    fn without_session_dir_override() -> KernelEnvOverride {
        KernelEnvOverride::apply(&[(paths::SESSION_DIR_ENV, None)])
    }

    /// One durable record in the executor's registry serialization shape
    /// (`_run_json` in rlm/factory.py): the fields the projection reads,
    /// with an inline subagent prompt and bound params — the private
    /// material that must never travel in a saved row.
    fn durable_record() -> Value {
        json!({
            "run_id": "run-9",
            "spec_id": "hold",
            "name": "nightly hold",
            "machine": {
                "run": {"max_parallel": 2},
                "states": [
                    {"id": "hold", "entry": true, "python": {"import": "h", "callable": "hold"}},
                    {"id": "review", "max_entries": 4, "subagent": {
                        "name": "reviewer", "model": "internal/glm",
                        "prompt": "secret review prompt text"
                    }},
                ],
                "transitions": [{"from": "hold", "to": "review", "on": "settle"}],
                "order": ["hold", "review"],
                "params": {"task": "secret param value"},
            },
            "state": "running",
            "pause_reason": null,
            "started_at": 12.5,
            "max_parallel": 2,
            "spawn_count": 1,
            "settle_count": 0,
            "transitions_fired": 0,
            "tool_use_total": 0,
            "run_budget_ms": 600_000,
            "order": ["hold"],
            "states": {
                "hold": {
                    "state_id": "hold",
                    "spec": {"id": "hold"},
                    "position": 0,
                    "max_entries": 1,
                    "entries_used": 1,
                    "error": null,
                    "cancelled": false,
                    "entries": [
                        {
                            "index": 1,
                            "status": "running",
                            "error": null,
                            "answer": "secret answer text",
                            "instances": [
                                {"index": 1, "prompt": "secret prompt", "status": "running", "attempt": 1}
                            ],
                        }
                    ],
                }
            },
            "events": [
                {"seq": 1, "kind": "milestone", "milestone": "run_started", "stage": "recorded"},
                {"seq": 2, "kind": "spawned", "node": "hold", "stage": "recorded"},
            ],
            "milestones": ["run_started"],
            "revision": 3,
        })
    }

    /// The saved projection carries exactly the fields an overview row
    /// needs — identity, name, state, the machine's state ids, the node
    /// statuses, and the usage counters — and nothing else: the run
    /// block, transitions, order, pause reasons, budgets, and milestone
    /// events stay on disk with the prompts and answers.
    #[test]
    fn a_durable_record_projects_into_the_graph_row_shape() {
        let row = saved_row(&durable_record()).expect("the record projects");
        assert_eq!(row["runId"], "run-9");
        assert_eq!(row["specId"], "hold");
        assert_eq!(row["state"], "running");
        assert_eq!(row["machine"]["states"][0]["id"], "hold");
        assert_eq!(row["machine"]["states"][1]["id"], "review");
        assert_eq!(row["nodes"][0]["id"], "hold");
        assert_eq!(row["nodes"][0]["status"], "running");
        assert_eq!(row["nodes"][0]["running"], 1);
        assert_eq!(row["usage"]["spawns"], 1);
        assert_eq!(row["usage"]["running"], 1);
        let serialized = serde_json::to_string(&row).expect("serialize row");
        assert!(
            !serialized.contains("secret"),
            "no prompt, param, or answer text travels:\n{serialized}"
        );
        assert!(
            !serialized.contains("params"),
            "the machine's bound params stay on disk:\n{serialized}"
        );
        // The declared machine shape never travels: no run block (and
        // none of its copied kernel defaults), no transitions, no order,
        // no callable, no subagent name or model, no pause reason, no
        // budget, and no milestone events — the page reads a saved row's
        // machine for its state ids alone and paints the saved marker.
        // The machine's key set pins the run block's absence exactly:
        // `maxParallel` rides the usage block alone (the live lane's own
        // `_usage_report` counter), never the machine's run block.
        let machine_keys: Vec<&str> = row["machine"]
            .as_object()
            .map(|machine| machine.keys().map(String::as_str).collect())
            .unwrap_or_default();
        assert_eq!(
            machine_keys,
            vec!["states"],
            "the saved machine carries only its states:
{serialized}"
        );
        // (`transitionsFired` is the usage counter, so the substring
        // pins live in the machine key set above, not the list below.)
        for absent in [
            "maxTransitions",
            "failurePolicy",
            "maxChildren",
            "budgetMs",
            "pauseReason",
            "limitMs",
            "python",
            "subagent",
            "reviewer",
            "model",
            "milestone",
            "run_started",
        ] {
            assert!(
                !serialized.contains(absent),
                "the saved row ships {absent}, a field the page never reads:\n{serialized}"
            );
        }
        // A record without a run id is not a row.
        let identity_less = json!({"spec_id": "hold", "state": "running", "machine": {}});
        assert!(saved_row(&identity_less).is_none());
    }

    /// The live half classifies a timed-out read as busy, not broken: a
    /// kernel whose event loop runs a synchronous cell holds the peek
    /// frame past the read budget, and the overview answers without the
    /// "unavailable" warning (the owner keeps its durable rows; the next
    /// poll re-reads). Every other failure carries its real reason.
    #[test]
    fn a_timed_out_live_read_is_busy_not_broken() {
        // The route builds this wording from the one shared constant
        // (`routing::WORKER_READ_TIMED_OUT`), so the classifier reads
        // the same binding the route writes — a wording change cannot
        // strand a busy owner as broken with this test green.
        let timeout: anyhow::Result<DaemonResponse> = Err(anyhow::anyhow!(WORKER_READ_TIMED_OUT));
        match live_read_outcome(&timeout) {
            LiveRead::Busy => {}
            other => panic!("the read budget elapsing is busy, not broken: {other:?}"),
        }
        let refused = Ok(DaemonResponse {
            id: None,
            command: "factory_activity".to_string(),
            success: false,
            error: Some("Kernel is not running".to_string()),
            data: None,
            error_info: None,
        });
        match live_read_outcome(&refused) {
            LiveRead::Failed(reason) => assert!(
                reason.contains("Kernel is not running"),
                "the refusal carries its real reason: {reason}"
            ),
            other => panic!("a refused read fails with its reason: {other:?}"),
        }
        let gone: anyhow::Result<DaemonResponse> =
            Err(anyhow::anyhow!("Session worker is not connected"));
        match live_read_outcome(&gone) {
            LiveRead::Failed(reason) => assert!(
                reason.contains("not connected"),
                "the route error carries its real reason: {reason}"
            ),
            other => panic!("a gone socket fails with its reason: {other:?}"),
        }
        let malformed = Ok(DaemonResponse {
            id: None,
            command: "factory_activity".to_string(),
            success: true,
            error: None,
            data: Some(json!({})),
            error_info: None,
        });
        match live_read_outcome(&malformed) {
            LiveRead::Failed(reason) => assert!(
                reason.contains("malformed"),
                "a malformed reply names the malformation: {reason}"
            ),
            other => panic!("a malformed reply fails with its reason: {other:?}"),
        }
        let healthy = Ok(DaemonResponse {
            id: None,
            command: "factory_activity".to_string(),
            success: true,
            error: None,
            data: Some(json!({ "runs": [live_snapshot_row()] })),
            error_info: None,
        });
        match live_read_outcome(&healthy) {
            LiveRead::Rows(rows) => assert_eq!(rows.len(), 1, "the rows fold"),
            other => panic!("a healthy reply folds its rows: {other:?}"),
        }
    }

    /// One owner's read folds into the live cache by outcome: a
    /// successful read replaces its rows and stamps their read time; a
    /// timed-out read keeps the rows with their OLD stamp and no warning
    /// (the busy owner's live claim is bounded by the stamp's age at
    /// serve time, and the next read that lands restores it); a real
    /// failure keeps them and carries its reason; a skipped (booting)
    /// owner keeps them with no warning. Every fold frees the owner's
    /// in-flight slot.
    #[tokio::test]
    async fn one_owners_read_folds_into_the_live_cache() {
        let dir = tempfile::tempdir().expect("temp dir");
        let supervisor = Supervisor::new(SupervisorOptions {
            socket_path: dir.path().join("daemon.sock"),
            agent_dir: dir.path().join("agent"),
        })
        .expect("supervisor");
        let healthy = Ok(DaemonResponse {
            id: None,
            command: "factory_activity".to_string(),
            success: true,
            error: None,
            data: Some(json!({ "runs": [{ "runId": "run-ok" }] })),
            error_info: None,
        });
        let timeout: anyhow::Result<DaemonResponse> = Err(anyhow::anyhow!(WORKER_READ_TIMED_OUT));
        let refused = Ok(DaemonResponse {
            id: None,
            command: "factory_activity".to_string(),
            success: false,
            error: Some("Kernel is not running".to_string()),
            data: None,
            error_info: None,
        });
        // The fold gate: production only folds a read the refresh spawned
        // for a resident owner, so seed the resident set the refresh owns.
        supervisor
            .factory_live
            .lock()
            .unwrap()
            .resident
            .insert("w-busy".to_string());
        // A successful read replaces the owner's rows and stamps them.
        supervisor.fold_factory_live("w-busy", "busy", Some(healthy));
        {
            let cache = supervisor.factory_live.lock().unwrap();
            assert_eq!(cache.rows["w-busy"][0]["runId"], "run-ok");
            assert!(
                live_rows_are_fresh(cache.read_at.get("w-busy")),
                "the fresh stamp qualifies the rows as live"
            );
            assert!(cache.warnings.is_empty());
            assert!(!cache.in_flight.contains("w-busy"));
        }
        // A timed-out read keeps the rows and their OLD stamp: the busy
        // owner's claim ages into the saved marker at serve time instead
        // of staying an unqualified live row forever.
        let stamped = supervisor.factory_live.lock().unwrap().read_at["w-busy"];
        supervisor.fold_factory_live("w-busy", "busy", Some(timeout));
        {
            let cache = supervisor.factory_live.lock().unwrap();
            assert_eq!(
                cache.rows["w-busy"][0]["runId"], "run-ok",
                "the busy owner keeps its last rows, never a drop"
            );
            assert_eq!(
                cache.read_at["w-busy"], stamped,
                "a timed-out read never restamps the rows it kept"
            );
            assert!(cache.warnings.is_empty(), "a busy owner is not a failure");
            assert!(!cache.in_flight.contains("w-busy"));
        }
        // A real failure keeps them and carries its reason.
        supervisor.fold_factory_live("w-busy", "busy", Some(refused));
        {
            let cache = supervisor.factory_live.lock().unwrap();
            assert_eq!(cache.rows["w-busy"][0]["runId"], "run-ok");
            assert_eq!(
                cache.warnings["w-busy"],
                "session busy: live factory graph unavailable: Kernel is not running"
            );
        }
        // A skipped (booting) owner keeps its rows through the boot
        // window and clears the owner's warning slot.
        supervisor.fold_factory_live("w-busy", "busy", None);
        {
            let cache = supervisor.factory_live.lock().unwrap();
            assert_eq!(cache.rows["w-busy"][0]["runId"], "run-ok");
            assert_eq!(
                cache.read_at["w-busy"], stamped,
                "the boot window never restamps the rows it kept"
            );
            assert!(cache.warnings.is_empty());
            assert!(!cache.in_flight.contains("w-busy"));
        }
    }

    /// The live cache is keyed by worker: a worker that left the resident
    /// list loses its rows at the next refresh, and its read that lands
    /// afterwards (the session passivated, or came back on a new worker)
    /// restamps and warns nothing, while a worker that stays keeps its rows.
    #[tokio::test]
    async fn a_gone_workers_rows_drop_and_its_late_read_never_lands() {
        let dir = tempfile::tempdir().expect("temp dir");
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: dir.path().join("agent"),
            })
            .expect("supervisor"),
        );
        {
            let mut cache = supervisor.factory_live.lock().unwrap();
            for worker in ["w-gone", "w-stays"] {
                cache
                    .rows
                    .insert(worker.to_string(), vec![json!({ "runId": worker })]);
                cache.read_at.insert(worker.to_string(), Instant::now());
                cache.resident.insert(worker.to_string());
            }
            cache.in_flight.insert("w-gone".to_string());
        }
        let stays = memory_only_resident("w-stays", "owner");
        supervisor.spawn_factory_live_refresh(&[ResidentOwner {
            id: "owner".to_string(),
            active_session_id: "owner".to_string(),
            name: None,
            session_file: None,
            resident: stays,
        }]);
        {
            let cache = supervisor.factory_live.lock().unwrap();
            assert!(
                !cache.rows.contains_key("w-gone"),
                "the gone worker's rows drop"
            );
            assert!(!cache.read_at.contains_key("w-gone"));
            assert_eq!(cache.rows["w-stays"][0]["runId"], "w-stays");
        }
        for late in [
            Ok(DaemonResponse {
                id: None,
                command: "factory_activity".to_string(),
                success: true,
                error: None,
                data: Some(json!({ "runs": [{ "runId": "late" }] })),
                error_info: None,
            }),
            Err(anyhow::anyhow!("Kernel is not running")),
        ] {
            supervisor.fold_factory_live("w-gone", "owner", Some(late));
        }
        let cache = supervisor.factory_live.lock().unwrap();
        assert!(
            !cache.rows.contains_key("w-gone"),
            "the late fold adds no rows"
        );
        assert!(!cache.read_at.contains_key("w-gone"));
        assert!(
            cache.warnings.is_empty(),
            "the late failure is never published"
        );
        assert!(!cache.in_flight.contains("w-gone"));
    }

    /// An owner re-admitted under a different worker starts a new
    /// residency with an empty live half: the first overview after the
    /// re-admission serves none of the previous worker's cached rows
    /// (not as saved, not as live) before the new worker's read lands.
    #[allow(clippy::await_holding_lock)] // the env guard must span the async overview read
    #[tokio::test]
    async fn a_readmitted_owner_serves_no_rows_from_its_previous_residency() {
        let _env = without_session_dir_override();
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir,
            })
            .expect("supervisor"),
        );
        // The previous worker `w-old` cached one fresh live run.
        {
            let mut cache = supervisor.factory_live.lock().unwrap();
            cache.resident.insert("w-old".to_string());
            cache.rows.insert(
                "w-old".to_string(),
                live_rows_from_snapshot(Some(&json!({ "runs": [live_snapshot_row()] })))
                    .expect("the snapshot reply folds"),
            );
            cache.read_at.insert("w-old".to_string(), Instant::now());
        }
        // The owner is re-admitted on `w-new`.
        supervisor
            .registry
            .insert(memory_only_resident("w-new", "owner"))
            .await;
        let response = supervisor.factory_overview("c1", "factory_activity").await;
        assert!(response.success, "the overview answered: {response:?}");
        assert_eq!(
            response.data,
            Some(json!({ "runs": [], "warnings": [] })),
            "the previous worker's cached rows never reach the overview"
        );
    }

    /// A memory-only resident (no session file: the saved catalog never
    /// lists it, no ledger edge reaches it) joins the overview through
    /// the resident push alone, and its cached live rows — the
    /// background refresh's last successful read — reach the reply with
    /// their owner/run identity and progress, marked live while fresh.
    #[allow(clippy::await_holding_lock)] // the env guard must span the async overview read
    #[tokio::test]
    async fn a_memory_only_residents_cached_live_rows_reach_the_overview() {
        let _env = without_session_dir_override();
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir,
            })
            .expect("supervisor"),
        );
        let resident = memory_only_resident("w-mem", "mem-owner");
        supervisor.registry.insert(Arc::clone(&resident)).await;
        // The background refresh's last successful read cached one live
        // run for it — through the fold's projection, the production
        // cache shape — stamped now.
        {
            let mut cache = supervisor.factory_live.lock().unwrap();
            cache.rows.insert(
                "w-mem".to_string(),
                live_rows_from_snapshot(Some(&json!({ "runs": [live_snapshot_row()] })))
                    .expect("the snapshot reply folds"),
            );
            cache.read_at.insert("w-mem".to_string(), Instant::now());
            cache.resident.insert("w-mem".to_string());
        }
        let response = supervisor.factory_overview("c1", "factory_activity").await;
        assert!(response.success, "the overview answered: {response:?}");
        let runs = response
            .data
            .as_ref()
            .and_then(|data| data.get("runs"))
            .and_then(Value::as_array)
            .expect("the overview rows")
            .clone();
        let row = runs
            .iter()
            .find(|row| row["ownerId"] == "mem-owner" && row["runId"] == "run-live")
            .cloned()
            .unwrap_or_else(|| {
                panic!(
                    "the memory-only resident's cached run never listed \
                     (the resident push is its only owner path): {runs:#?}"
                )
            });
        assert_eq!(row["saved"], false, "a fresh cached row serves live");
        assert_eq!(row["state"], "paused", "the run's state rides the row");
        // The peek lane omits the marker on a fresh run; the served row
        // carries it explicit null — the key's presence is the page's
        // live-backing provenance, so the fill must survive the merge.
        assert_eq!(
            row.get("armed"),
            Some(&Value::Null),
            "the served row carries the lane's absent marker as explicit null"
        );
        assert_eq!(
            row["usage"]["spawns"], 1,
            "the run's progress rides the row"
        );
        assert_eq!(
            row["nodes"][0]["id"], "hold",
            "the run's machine structure rides the row"
        );
    }

    /// Cached live rows older than the freshness bound (two page poll
    /// windows) never serve as unqualified live: the saved marker rides
    /// them until a later read restamps them. This is the busy-owner and
    /// closed-page bound — a snapshot with no confirmed read behind it
    /// must not paint a ticking live claim, even while the run it holds
    /// may still be executing behind its owner's pending read.
    #[allow(clippy::await_holding_lock)] // the env guard must span the async overview read
    #[tokio::test]
    async fn stale_cached_live_rows_serve_saved_not_live() {
        let _env = without_session_dir_override();
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir,
            })
            .expect("supervisor"),
        );
        let resident = memory_only_resident("w-stale", "stale-owner");
        supervisor.registry.insert(Arc::clone(&resident)).await;
        {
            let mut cache = supervisor.factory_live.lock().unwrap();
            // The cached rows are the fold's projection output — the
            // production cache shape, never the raw lane wire.
            cache.rows.insert(
                "w-stale".to_string(),
                live_rows_from_snapshot(Some(&json!({ "runs": [live_snapshot_row()] })))
                    .expect("the snapshot reply folds"),
            );
            cache.read_at.insert(
                "w-stale".to_string(),
                Instant::now()
                    .checked_sub(FACTORY_LIVE_FRESH_WINDOW + Duration::from_millis(500))
                    .expect("a read stamp past the fresh window"),
            );
            cache.resident.insert("w-stale".to_string());
        }
        let response = supervisor.factory_overview("c1", "factory_activity").await;
        assert!(response.success, "the overview answered: {response:?}");
        let runs = response
            .data
            .as_ref()
            .and_then(|data| data.get("runs"))
            .and_then(Value::as_array)
            .expect("the overview rows")
            .clone();
        let row = runs
            .iter()
            .find(|row| row["ownerId"] == "stale-owner" && row["runId"] == "run-live")
            .cloned()
            .unwrap_or_else(|| panic!("the stale cached row never listed: {runs:#?}"));
        assert_eq!(
            row["saved"], true,
            "a cached row older than the freshness bound never claims live"
        );
        assert_eq!(
            row["state"], "paused",
            "the last-seen snapshot still rides the row, saved — never dropped"
        );
    }

    /// One busy owner never delays another owner's refresh: each
    /// resident's read folds into the cache the moment it lands, so a
    /// healthy owner's rows reach the overview while the busy owner's
    /// read is still pending — never behind an all-owner completion
    /// barrier — and the reply itself stays nonblocking. At most one
    /// read per owner is in flight: a poll that returns while a read is
    /// pending never stacks a second one.
    #[allow(clippy::await_holding_lock)] // the env guard must span the async overview read
    #[tokio::test]
    async fn a_busy_owner_never_delays_a_healthy_owners_refresh() {
        let _env = without_session_dir_override();
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir,
            })
            .expect("supervisor"),
        );
        // The busy owner: route-ready, its command channel wired to a
        // receiver the test never answers — the read holds until its
        // 5 s budget elapses, exactly a kernel whose event loop runs a
        // synchronous cell.
        let busy = memory_only_resident("w-busy", "busy-owner");
        let (busy_tx, mut busy_rx) = tokio::sync::mpsc::channel(8);
        let epoch = busy.begin_connection();
        busy.install_command_channel(epoch, busy_tx).await;
        busy.transition(crate::registry::WorkerTransition::SessionReady);
        supervisor.registry.insert(Arc::clone(&busy)).await;
        // The healthy owner: route-ready, and the test answers its peek
        // at once with one live run.
        let healthy = memory_only_resident("w-ok", "ok-owner");
        let (ok_tx, mut ok_rx) = tokio::sync::mpsc::channel(8);
        let epoch = healthy.begin_connection();
        healthy.install_command_channel(epoch, ok_tx).await;
        healthy.transition(crate::registry::WorkerTransition::SessionReady);
        supervisor.registry.insert(Arc::clone(&healthy)).await;
        let healthy_resident = Arc::clone(&healthy);
        tokio::spawn(async move {
            while let Some(request) = ok_rx.recv().await {
                let reply = healthy_resident
                    .pending
                    .lock()
                    .await
                    .remove(&request.request_id);
                if let Some(reply) = reply {
                    let _ = reply.send(crate::registry::WorkerReply::Typed(DaemonResponse {
                        id: None,
                        command: "factory_activity".to_string(),
                        success: true,
                        error: None,
                        data: Some(json!({ "runs": [live_snapshot_row()] })),
                        error_info: None,
                    }));
                }
            }
        });
        // Poll the overview until the healthy owner's run reads live —
        // the deadline sits UNDER the busy owner's 5 s read budget, so
        // the test fails on any design that folds only after every
        // owner's read lands.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let started = Instant::now();
            let response = supervisor.factory_overview("c1", "factory_activity").await;
            assert!(response.success, "the overview answered: {response:?}");
            assert!(
                started.elapsed() < Duration::from_secs(1),
                "the overview reply stayed nonblocking: the request never awaits a kernel read"
            );
            let runs = response
                .data
                .as_ref()
                .and_then(|data| data.get("runs"))
                .and_then(Value::as_array)
                .expect("the overview rows");
            if let Some(row) = runs
                .iter()
                .find(|row| row["ownerId"] == "ok-owner" && row["runId"] == "run-live")
            {
                assert_eq!(
                    row["saved"], false,
                    "the healthy owner's fresh read serves live"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the healthy owner's rows never reached the overview while the busy owner's read was pending: {runs:#?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // A second refresh pass while the busy read is still pending:
        // the healthy row landed inside the first pass, so the busy
        // owner's read has barely started its 5 s budget — the pass must
        // not stack a second read on it, and its reply still serves the
        // healthy owner's row.
        let response = supervisor.factory_overview("c2", "factory_activity").await;
        assert!(
            response.success,
            "the second overview answered: {response:?}"
        );
        let second_runs = response
            .data
            .as_ref()
            .and_then(|data| data.get("runs"))
            .and_then(Value::as_array)
            .expect("the overview rows")
            .clone();
        assert!(
            second_runs.iter().any(|row| {
                row["ownerId"] == "ok-owner" && row["runId"] == "run-live" && row["saved"] == false
            }),
            "the healthy owner's row still serves live on the second pass: {second_runs:#?}"
        );
        // At most one read per owner in flight: the busy owner's channel
        // saw exactly one peek across both passes (a pass that stacks
        // reads would stack requests).
        let mut busy_requests = 0;
        while busy_rx.try_recv().is_ok() {
            busy_requests += 1;
        }
        // The window sits far under the busy read's 5 s budget, so a
        // guarded pass has nothing left to send; a stacked read would
        // land inside it.
        let stacked = tokio::time::timeout(Duration::from_millis(100), busy_rx.recv()).await;
        assert!(
            stacked.is_err(),
            "at most one read per owner may be in flight (a second read stacked while the first was still pending)"
        );
        assert_eq!(
            busy_requests, 1,
            "at most one read per owner may be in flight"
        );
    }

    /// One memory-only resident: a worker descriptor with no session
    /// file, its durable identity the active id alone.
    fn memory_only_resident(worker_id: &str, active_session_id: &str) -> Arc<ResidentWorker> {
        let descriptor: DaemonWorkerDescriptor = serde_json::from_value(json!({
            "version": 2,
            "workerId": worker_id,
            "pid": 4242,
            "socketPath": "/nonexistent/worker.sock",
            "recoveryJournalPath": "/nonexistent/recovery.jsonl",
            "supervisorSocketPath": "/nonexistent/supervisor.sock",
            "authenticationToken": "test-token",
            "rootActiveSessionId": active_session_id,
            "createdAt": "2026-11-06T00:00:00Z",
            "updatedAt": "2026-11-06T00:00:00Z",
            "lifecycle": "ready",
            "createCommand": {},
            "consecutiveFailures": 0,
        }))
        .expect("memory-only descriptor");
        ResidentWorker::new(
            worker_id.to_string(),
            descriptor,
            PathBuf::from("/nonexistent/descriptor.json"),
        )
    }

    /// The live predicate keeps live states and terminal runs with running
    /// children, and drops fully terminal rows — the exact rule the
    /// kernel's unscoped list and the TUI's `is_live` share.
    #[test]
    fn the_live_predicate_matches_the_pages_own_rule() {
        let live =
            |state: &str, running: u64| json!({ "state": state, "usage": {"running": running} });
        assert!(row_is_live(&live("running", 0)));
        assert!(row_is_live(&live("paused", 0)));
        assert!(row_is_live(&live("done", 2)));
        assert!(!row_is_live(&live("done", 0)));
        assert!(!row_is_live(&live("failed", 0)));
        // A running row without a usage block is live: `LIVE_RUN_STATES`
        // keeps every live state before the usage read, the same rule the
        // TUI's `FactoryRunSnapshot::is_live` applies.
        assert!(row_is_live(&json!({ "state": "running" })));
        assert!(!row_is_live(&json!({})));
    }

    /// Catalog inputs with no residents, roster roots, or ledgers.
    fn no_roots(sessions: &std::path::Path) -> KnownSessionRoots {
        KnownSessionRoots {
            catalog_dir: sessions.to_path_buf(),
            residents: Vec::new(),
            roster_files: Vec::new(),
            ledgers: BTreeMap::new(),
        }
    }

    /// One minimal saved session file (the scan's exact shapes), written
    /// wherever the caller needs it.
    fn write_saved_session(dir: &std::path::Path, id: &str, name: &str) -> PathBuf {
        let path = dir.join(format!("{id}.jsonl"));
        std::fs::create_dir_all(dir).expect("sessions dir");
        std::fs::write(
            &path,
            format!(
                "{{\"type\":\"session\",\"version\":1,\"id\":\"{id}\",\"timestamp\":\"2026-11-06T00:00:00Z\",\"cwd\":\"/tmp\"}}\n{{\"type\":\"session_info\",\"id\":\"info-{id}\",\"parentId\":null,\"timestamp\":\"2026-11-06T00:00:00Z\",\"name\":\"{name}\"}}\n"
            ),
        )
        .expect("write saved session");
        path
    }

    /// One owner's durable run record under its artifact dir (the
    /// executor's own layout under the log's implied artifact root).
    fn write_run_record(log: &std::path::Path, record: &Value) {
        let artifact_dir = session_artifact_dir_for_log(log).expect("artifact dir for log");
        let dir = artifact_dir.join(FACTORY_RUNS_DIR_NAME);
        std::fs::create_dir_all(&dir).expect("factory-runs dir");
        std::fs::write(
            dir.join(format!(
                "{}.json",
                record["run_id"].as_str().unwrap_or_default()
            )),
            serde_json::to_string(record).expect("serialize record"),
        )
        .expect("write run record");
    }

    /// An unreadable sessions catalog warns instead of answering a
    /// successful empty overview, while a missing directory stays an
    /// empty catalog: the difference the shared `list_sessions` fold
    /// erases.
    #[test]
    fn an_unreadable_catalog_warns_but_a_missing_one_stays_empty() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        // A missing sessions directory: no owners, no warnings.
        let missing = agent_dir.join("sessions-missing");
        let (owners, _, records, warnings) =
            catalog_and_records(&no_roots(&missing), &[], &FactoryRecordsCache::default());
        assert!(owners.is_empty() && records.is_empty() && warnings.is_empty());
        // A sessions path that is a regular file (ENOTDIR, the probe's
        // shape): the read failure warns — never a silent empty catalog.
        let unreadable = agent_dir.join("sessions");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        std::fs::write(&unreadable, "not a directory").expect("regular file");
        let (owners, _, records, warnings) =
            catalog_and_records(&no_roots(&unreadable), &[], &FactoryRecordsCache::default());
        assert!(owners.is_empty() && records.is_empty());
        assert!(
            warnings
                .iter()
                .any(|warning| warning.contains("the sessions catalog is unreadable")),
            "the unreadable catalog warns: {warnings:?}"
        );
    }

    /// A passive child of a custom session directory's resident joins the
    /// overview through that directory's own ledger: the parent root
    /// walks against the custom dir's spawn edges (a passive child's log
    /// sits outside the default catalog, so the ledger edge is the only
    /// route to it).
    #[test]
    fn a_custom_directory_root_walks_its_own_ledger() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let custom = dir.path().join("custom-sessions");
        let parent_log = write_saved_session(&custom, "custom-parent", "custom parent");
        let child_log = write_saved_session(&custom, "custom-child", "custom child");
        write_run_record(
            &child_log,
            &json!({
                "run_id": "run-nested", "spec_id": "hold", "state": "running",
                "machine": {"states": [], "transitions": [], "order": []},
            }),
        );
        let ledger = crate::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &custom, |_log| {});
        ledger
            .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
                child_id: "custom-child".to_string(),
                parent: parent_log.to_string_lossy().to_string(),
                child: child_log.to_string_lossy().to_string(),
                depth: 1,
                name: "custom child".to_string(),
                factory: None,
                decision_child: false,
            })
            .expect("append ledger spawn");
        // The child is outside the default sessions catalog; the custom
        // dir's ledger edge is the only route to it.
        let default_sessions = agent_dir.join("sessions");
        std::fs::create_dir_all(&default_sessions).expect("default sessions dir");
        let mut ledgers = BTreeMap::new();
        ledgers.insert(custom, Arc::new(ledger));
        ledgers.insert(
            default_sessions.clone(),
            Arc::new(crate::rlm_ledger::RlmSpawnLedger::new(
                &agent_dir,
                &default_sessions,
                |_log| {},
            )),
        );
        let roots = KnownSessionRoots {
            catalog_dir: default_sessions,
            residents: vec![ResidentFile {
                session_file: parent_log,
                active_session_id: "active-a".to_string(),
            }],
            roster_files: Vec::new(),
            ledgers,
        };
        let (owners, _, records, warnings) =
            catalog_and_records(&roots, &[], &FactoryRecordsCache::default());
        assert!(warnings.is_empty(), "no partial failures: {warnings:?}");
        let child = owners
            .get("custom-child")
            .expect("the custom dir's passive child is an owner");
        assert_eq!(child.name.as_deref(), Some("custom child"));
        assert_eq!(
            records.get("custom-child").map(std::vec::Vec::len),
            Some(1),
            "the child's durable record read through its own artifact dir"
        );
    }

    /// An old durable record of an owner with no resident worker does
    /// not list: the executor retires a record only when its run goes
    /// terminal, so an abandoned run keeps its persisted running or
    /// paused state forever — without the record-age bound the page
    /// folds every ghost a session ever left, and the live runs the
    /// page exists for drown in them. A fresh record of the same owner
    /// lists, marked saved: the bound is the record's age, never the
    /// owner's erasure (the record stays on disk).
    #[allow(clippy::await_holding_lock)] // the env guard must span the async overview read
    #[tokio::test]
    async fn an_old_durable_record_of_a_non_resident_owner_does_not_list() {
        let _env = without_session_dir_override();
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        let sessions = agent_dir.join("sessions");
        let owner_log = write_saved_session(&sessions, "ghost-owner", "ghost owner");
        let record = json!({
            "run_id": "run-ghost", "spec_id": "hold", "state": "running",
            "machine": {"states": [], "transitions": [], "order": []},
        });
        write_run_record(&owner_log, &record);
        // The abandoned run's shape: nothing has written its record for
        // longer than the retention window.
        let record_path = session_artifact_dir_for_log(&owner_log)
            .expect("artifact dir")
            .join(FACTORY_RUNS_DIR_NAME)
            .join("run-ghost.json");
        std::fs::File::options()
            .write(true)
            .open(&record_path)
            .expect("open the record")
            .set_modified(
                SystemTime::now() - FACTORY_SAVED_RECORD_RETENTION - Duration::from_secs(1),
            )
            .expect("age the record");
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir,
            })
            .expect("supervisor"),
        );
        // No resident owns the run, so the aged record does not list.
        let response = supervisor.factory_overview("c1", "factory_activity").await;
        assert!(response.success, "the overview answered: {response:?}");
        let runs = response
            .data
            .as_ref()
            .and_then(|data| data.get("runs"))
            .and_then(Value::as_array)
            .expect("the overview rows")
            .clone();
        assert!(
            !runs
                .iter()
                .any(|row| row["ownerId"] == "ghost-owner" && row["runId"] == "run-ghost"),
            "an aged durable record of a non-resident owner never lists:
{runs:#?}"
        );
        // A fresh record of the same owner lists, marked saved: the
        // bound gates the record's age, not the owner's rows.
        write_run_record(
            &owner_log,
            &json!({
                "run_id": "run-fresh", "spec_id": "hold", "state": "paused",
                "machine": {"states": [], "transitions": [], "order": []},
            }),
        );
        let response = supervisor.factory_overview("c2", "factory_activity").await;
        assert!(response.success, "the overview answered: {response:?}");
        let runs = response
            .data
            .as_ref()
            .and_then(|data| data.get("runs"))
            .and_then(Value::as_array)
            .expect("the overview rows")
            .clone();
        let row = runs
            .iter()
            .find(|row| row["ownerId"] == "ghost-owner" && row["runId"] == "run-fresh")
            .cloned()
            .unwrap_or_else(|| panic!("the fresh record lists: {runs:#?}"));
        assert_eq!(row["saved"], true, "a durable-only row serves saved");
    }

    /// The scan reads a record once per change, not once per poll: the
    /// mtime-keyed cache reuses an unchanged record's last projection
    /// (a rewrite that leaves the file's modification time alone is not
    /// re-read), a touched record re-reads, and a record the scan stops
    /// projecting — an aged-out ghost — prunes its entry, so the cache
    /// holds exactly the rows the page still lists. The same aged
    /// record under a RESIDENT owner lists: the retention bound gates
    /// non-resident ghosts alone, never a live owner's records. A
    /// malformed record's warning fires on EVERY scan — its cached
    /// None projection warns again on a hit, never only the scan that
    /// first read it, so the page's partial-failure contract stays
    /// visible on every poll.
    #[test]
    fn unchanged_records_reuse_their_last_projection_and_prune_when_they_leave() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        let sessions = agent_dir.join("sessions");
        let owner_log = write_saved_session(&sessions, "cache-owner", "cache owner");
        let record = |run_id: &str| {
            json!({
                "run_id": run_id, "spec_id": "hold", "state": "running",
                "machine": {"states": [], "transitions": [], "order": []},
            })
        };
        // The record's FILE is the cache key, so the rewrite below keeps
        // the same path with a different run id inside it.
        let record_path = session_artifact_dir_for_log(&owner_log)
            .expect("artifact dir")
            .join(FACTORY_RUNS_DIR_NAME)
            .join("run-c1.json");
        write_run_record(&owner_log, &record("run-c1"));
        let set_mtime = |at: SystemTime| {
            std::fs::File::options()
                .write(true)
                .open(&record_path)
                .expect("open the record")
                .set_modified(at)
                .expect("set the record's modification time");
        };
        let mut ledgers = BTreeMap::new();
        ledgers.insert(
            sessions.clone(),
            Arc::new(crate::rlm_ledger::RlmSpawnLedger::new(
                &agent_dir,
                &sessions,
                |_log| {},
            )),
        );
        let roots = KnownSessionRoots {
            catalog_dir: sessions,
            residents: Vec::new(),
            roster_files: Vec::new(),
            ledgers,
        };
        let cache = FactoryRecordsCache::default();
        let scan = |residents: &[ResidentOwner], cache: &FactoryRecordsCache| {
            let (owners, _, records, warnings) = catalog_and_records(&roots, residents, cache);
            (owners, records, warnings)
        };
        let gone: Vec<ResidentOwner> = Vec::new();
        // The first scan reads and caches the record.
        let (owners, records, warnings) = scan(&gone, &cache);
        assert_eq!(owners.len(), 1, "the saved session is the one owner");
        assert!(warnings.is_empty(), "no partial failures: {warnings:?}");
        assert_eq!(records["cache-owner"][0]["runId"], "run-c1");
        // A rewrite that leaves the modification time alone is not
        // re-read: the cached projection still answers.
        let stamped = std::fs::metadata(&record_path)
            .expect("stat the record")
            .modified()
            .expect("the record's modification time");
        std::fs::write(
            &record_path,
            serde_json::to_string(&record("run-c2")).expect("serialize the rewrite"),
        )
        .expect("rewrite the record");
        set_mtime(stamped);
        let (_, records, _) = scan(&gone, &cache);
        assert_eq!(
            records["cache-owner"][0]["runId"], "run-c1",
            "an unchanged record reuses its last projection instead of re-reading"
        );
        // A touched record re-reads: the modification time moved.
        set_mtime(SystemTime::now());
        let (_, records, _) = scan(&gone, &cache);
        assert_eq!(
            records["cache-owner"][0]["runId"], "run-c2",
            "a changed record re-reads"
        );
        // An aged-out record stops listing and its cache entry prunes,
        // so the cache holds exactly the rows the page still lists.
        set_mtime(SystemTime::now() - FACTORY_SAVED_RECORD_RETENTION - Duration::from_secs(1));
        let (_, records, _) = scan(&gone, &cache);
        assert!(
            records
                .get("cache-owner")
                .is_some_and(std::vec::Vec::is_empty),
            "the aged record stops listing: {records:#?}"
        );
        assert!(
            cache.lock().unwrap().is_empty(),
            "the scan prunes entries it no longer projects"
        );
        // The retention bound gates ghosts alone: the same aged record
        // under a resident owner lists — its kernel reads the runs live.
        let residents = vec![ResidentOwner {
            id: "cache-owner".to_string(),
            active_session_id: "cache-owner".to_string(),
            name: None,
            session_file: None,
            resident: memory_only_resident("w-cache", "cache-owner"),
        }];
        let (_, records, _) = scan(&residents, &cache);
        assert_eq!(
            records["cache-owner"][0]["runId"], "run-c2",
            "a resident owner's record lists unaged"
        );
        // A malformed record's warning fires on EVERY scan, its cached
        // None projection included — never only the scan that first
        // read it: the page's partial-failure contract stays visible on
        // every poll, exactly as a fresh parse would.
        let bad_record = session_artifact_dir_for_log(&owner_log)
            .expect("artifact dir")
            .join(FACTORY_RUNS_DIR_NAME)
            .join("run-bad.json");
        std::fs::write(
            &bad_record,
            serde_json::to_string(&json!({
                "spec_id": "hold", "state": "running",
                "machine": {"states": [], "transitions": [], "order": []},
            }))
            .expect("serialize the malformed record"),
        )
        .expect("write the malformed record");
        let (_, records, warnings) = scan(&residents, &cache);
        assert_eq!(
            records["cache-owner"][0]["runId"], "run-c2",
            "the good row lists beside the malformed record's warning: {records:#?}"
        );
        assert!(
            warnings
                .iter()
                .any(|warning| warning.contains("malformed run record")),
            "the first scan warns the malformed record: {warnings:?}"
        );
        let (_, _, warnings) = scan(&residents, &cache);
        assert!(
            warnings
                .iter()
                .any(|warning| warning.contains("malformed run record")),
            "an unchanged malformed record warns again on its cached projection: {warnings:?}"
        );
    }

    /// One live snapshot row in the lane's wire shape (`_wire_payload`'s
    /// camelCase of the compact `_graph_snapshot`), with a paused
    /// needs-verify entry — the child answer text that must never
    /// travel — and a state-level `answerPreview`, an unparsed extra
    /// the allowlist must drop too. The peek lane omits `armed` on a
    /// fresh executing run (it marks only a rehydrated one false), so
    /// the row omits the key too. The `usage` block carries the
    /// kernel report's real keys (`_usage_report`'s camelCase,
    /// `maxParallel`/`maxChildren` included) — the block rides whole,
    /// so a fixture without them would pass cuts the real row never
    /// makes.
    fn live_snapshot_row() -> Value {
        json!({
            "runId": "run-live",
            "specId": "hold",
            "name": "live hold",
            "state": "paused",
            "pauseReason": "escalate: hold review",
            "elapsedMs": 4_000,
            "machine": {
                "run": {"maxParallel": 8},
                "states": [{"id": "hold", "entry": true}],
                "transitions": [],
                "order": ["hold"],
            },
            "activeNodes": [],
            "lastFired": [],
            "events": [{"seq": 1, "kind": "milestone", "milestone": "run_started", "stage": "recorded"}],
            "nodes": [{
                "id": "hold",
                "status": "error",
                "lifecycle": "task",
                "attempts": 1,
                "entriesUsed": 1,
                "maxEntries": 1,
                "needsVerify": true,
                "entries": [{
                    "index": 0,
                    "status": "error",
                    "needsVerify": true,
                    "provisionalAnswer": "CHILD ANSWER SENTINEL",
                }],
                "instances": [{
                    "index": 0,
                    "entry": 0,
                    "status": "error",
                    "attempt": 1,
                    "child": "child-1",
                    "durationMs": 900,
                    "error": "exit 1",
                }],
                "running": 0,
                "queued": 0,
                "error": null,
            }],
            "usage": {"spawns": 1, "settled": 0, "toolUses": 0, "maxParallel": 8, "maxChildren": 10_000, "running": 0, "transitionsFired": 0},
            "budget": {"limitMs": null, "consumedMs": 4_000},
            "answerPreview": "STATE ANSWER SENTINEL",
        })
    }

    /// The live half folds the snapshot reply's rows through the page's
    /// own field set — the saved projection's cut plus the live lane's
    /// `elapsedMs` and `armed`: the page's row fields survive, while the
    /// declared run block, transitions, milestone events, budget, pause
    /// reason, and a needs-verify entry's provisional answer (child
    /// answer text) never travel — the live half of the saved
    /// projection's privacy AND field rules.
    #[test]
    fn the_live_half_sheds_answer_text_and_keeps_the_page_fields() {
        let reply = json!({ "runs": [live_snapshot_row()] });
        let rows = live_rows_from_snapshot(Some(&reply)).expect("the snapshot reply folds");
        let row = rows.first().expect("one row");
        assert_eq!(row["runId"], "run-live");
        assert_eq!(row["state"], "paused");
        assert_eq!(row["elapsedMs"], 4_000);
        assert_eq!(row["machine"]["states"][0]["id"], "hold");
        assert_eq!(row["nodes"][0]["id"], "hold");
        assert_eq!(row["nodes"][0]["entries"][0]["status"], "error");
        assert_eq!(row["nodes"][0]["instances"][0]["child"], "child-1");
        assert_eq!(row["usage"]["spawns"], 1);
        // The peek lane omits `armed` on a fresh run (it marks only a
        // rehydrated one false) and the page routes by the marker's
        // PRESENCE: the allowlist fills the absent key with null, so a
        // live-cached row always carries the marker the router reads —
        // a projection that dropped absent keys would strand every
        // fresh run on the page's saved report.
        assert_eq!(
            row.get("armed"),
            Some(&Value::Null),
            "the absent armed marker folds to explicit null on the served row"
        );
        // The peek lane marks a still-unarmed rehydrated run false: the
        // marker rides the allowlist untouched, so the merge can paint
        // the saved marker for a run no loop drives.
        let mut unarmed = live_snapshot_row();
        unarmed["armed"] = json!(false);
        let rows = live_rows_from_snapshot(Some(&json!({ "runs": [unarmed] })))
            .expect("the unarmed row folds");
        assert_eq!(rows[0]["armed"], false, "the unarmed marker survives");
        let serialized = serde_json::to_string(row).expect("serialize row");
        assert!(
            !serialized.contains("SENTINEL"),
            "no child answer or unparsed preview travels:\n{serialized}"
        );
        // The machine's key set pins the run block's absence exactly,
        // the same cut the saved projection makes.
        let machine_keys: Vec<&str> = row["machine"]
            .as_object()
            .map(|machine| machine.keys().map(String::as_str).collect())
            .unwrap_or_default();
        assert_eq!(
            machine_keys,
            vec!["states"],
            "the live machine carries only its states:\n{serialized}"
        );
        assert_eq!(
            row["machine"]["states"],
            json!([{"id": "hold"}]),
            "the live machine ships its state ids alone:\n{serialized}"
        );
        // `usage` rides whole through `LIVE_ROW_FIELDS`: the saved
        // projection's six counters plus the live-only `maxChildren`
        // limit, an integer the page never reads, so the absent list
        // cannot name any of them — the machine key-set assert above
        // pins the run block's own copy under `machine.run` out.
        assert_eq!(
            row["usage"],
            live_snapshot_row()["usage"],
            "the usage block rides whole:\n{serialized}"
        );
        for absent in [
            "pauseReason",
            "escalate",
            "activeNodes",
            "lastFired",
            "\"events\"",
            "run_started",
            "milestone",
            "budget",
        ] {
            assert!(
                !serialized.contains(absent),
                "the live row ships {absent}, a field the page never reads:\n{serialized}"
            );
        }
        // A reply without the runs list is malformed — the warning
        // path, never a silent zero.
        assert!(live_rows_from_snapshot(Some(&json!({}))).is_none());
        assert!(live_rows_from_snapshot(None).is_none());
    }

    /// A roster-known passivated owner of a custom session directory
    /// stays in the overview: `worker_idle_passivation` removes registry
    /// residency, but the roster keeps the owner's row with its custom
    /// `sessionFile` and the saved catalog never lists that directory —
    /// the roster root (not residency) is what keeps the owner and its
    /// passive child readable, through that directory's own ledger.
    #[allow(clippy::await_holding_lock)] // the env guard must span the async overview read
    #[tokio::test]
    async fn a_passivated_custom_directory_owner_stays_in_the_overview() {
        let _env = without_session_dir_override();
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let custom = dir.path().join("custom-sessions");
        let owner_log = write_saved_session(&custom, "custom-owner", "custom owner");
        write_run_record(
            &owner_log,
            &json!({
                "run_id": "run-custom", "spec_id": "hold", "state": "paused",
                "machine": {"states": [], "transitions": [], "order": []},
            }),
        );
        // The owner's passive child at the real nested layout, reachable
        // only through the custom directory's ledger edge.
        let child_log = write_saved_session(
            &session_artifact_dir_for_log(&owner_log)
                .expect("owner artifact dir")
                .join("sub-x"),
            "custom-child",
            "custom child",
        );
        write_run_record(
            &child_log,
            &json!({
                "run_id": "run-child", "spec_id": "hold", "state": "running",
                "machine": {"states": [], "transitions": [], "order": []},
            }),
        );
        // The child edge in the DEFAULT sessions dir's ledger — the
        // placement production admission writes (`record_rlm_child_
        // admission` ignores the create's sessionDir), so the roster
        // root's walk must consult the default ledger, not just its own
        // directory's.
        let default_sessions = agent_dir.join("sessions");
        std::fs::create_dir_all(&default_sessions).expect("default sessions dir");
        let ledger =
            crate::rlm_ledger::RlmSpawnLedger::new(&agent_dir, &default_sessions, |_log| {});
        ledger
            .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
                child_id: "custom-child".to_string(),
                parent: owner_log.to_string_lossy().to_string(),
                child: child_log.to_string_lossy().to_string(),
                depth: 1,
                name: "custom child".to_string(),
                factory: None,
                decision_child: false,
            })
            .expect("append ledger spawn");
        drop(ledger);
        let supervisor = Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("daemon.sock"),
                agent_dir: agent_dir.clone(),
            })
            .expect("supervisor"),
        );
        // The roster row a passivated owner keeps: an inactive top-level
        // entry with its custom sessionFile.
        {
            let mut roster = supervisor.roster.lock().unwrap();
            roster.write_seeded(
                json!({
                    "id": "custom-owner",
                    "sessionId": "custom-owner",
                    "runtimeKind": "top-level",
                    "activity": "idle",
                    "isSessionActive": false,
                    "sessionFile": owner_log.to_string_lossy(),
                    "sessionName": "custom owner",
                }),
                false,
            );
        }
        let response = supervisor.factory_overview("c1", "factory_activity").await;
        assert!(response.success, "the overview answered: {response:?}");
        let runs = response
            .data
            .as_ref()
            .and_then(|data| data.get("runs"))
            .and_then(Value::as_array)
            .expect("the overview rows")
            .clone();
        let row = |owner: &str, run: &str| {
            runs.iter()
                .find(|row| row["ownerId"] == owner && row["runId"] == run)
                .cloned()
                .unwrap_or_else(|| panic!("no overview row for {owner}/{run}: {runs:#?}"))
        };
        let owner_row = row("custom-owner", "run-custom");
        assert_eq!(owner_row["saved"], true);
        assert_eq!(owner_row["state"], "paused");
        assert_eq!(owner_row["ownerName"], "custom owner");
        let child_row = row("custom-child", "run-child");
        assert_eq!(child_row["saved"], true);
        assert_eq!(child_row["state"], "running");
        assert_eq!(child_row["ownerName"], "custom child");
    }
}
