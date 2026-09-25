//! Boot sweep + roster restore + scheduled-work re-arm (spec §6, update
//! flow slice 5).
//!
//! The new supervisor owns the whole boot side of the update (spec §3):
//! the scratch-dir sweep (invariant I2 by construction), the roster-via-env
//! restore (the Rust redesign of the TS coordinator-driven restore — the
//! TS coordinator replays its manifest over the client wire; here the
//! durable truth rehydrates from the workers' recovery journals and the
//! sessions' durable files, and the supervisor creates or adopts each
//! roster row in place), and the scheduled-jobs re-arm with due-run
//! catch-up (spec §8: `scheduled-jobs.json` is the only write path; the
//! update flow never archives it).
//!
//! Restore never fails the boot (spec §9): a row that cannot come up is
//! recorded as a per-session failure and its session stays on disk for
//! manual resume.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use pa_types::daemon::update_flow::DaemonUpdateResume;
use pa_types::daemon::update_flow::{
    legacy_update_restart_status, legacy_update_restarts_dir, socket_update_dir, UpdateRoster,
    UpdateRosterSession, UpdateStatusCounts, UpdateStatusFailure, UPDATE_ROSTER_ENV,
};
use pa_types::daemon::{DaemonCommand, UpdateId};
use serde_json::json;
use tokio::sync::Notify;

use crate::registry::ResidentWorker;
use crate::supervisor::Supervisor;

/// TS `SCHEDULED_WAKE_CLIENT_ID`, verbatim: the client id the supervisor
/// uses when it wakes a saved session for a due scheduled job.
pub(crate) const SCHEDULED_WAKE_CLIENT_ID: &str = "scheduled-wake";

/// The client id the supervisor uses for roster-row creates (the Rust
/// design's counterpart of the TS coordinator's restore client).
pub(crate) const UPDATE_RESTORE_CLIENT_ID: &str = "update-restore";

/// TS `UPDATE_RESTART_CONTINUATION_PROMPT`, verbatim (spec §10.5: the
/// restored session gets the TS-parity continuation treatment).
pub(crate) const UPDATE_RESTART_CONTINUATION_PROMPT: &str = "Prime Agent restarted after an update. Continue the interrupted task from the saved transcript and restored tool/kernel state. Inspect current state before retrying commands when needed.";

/// How long a client attach queues behind an in-flight restore pass
/// (spec §10.4) before it resolves against the settled restore state.
const RESTORE_ATTACH_WAIT_MS: u64 = 120_000;

// ---------------------------------------------------------------------------
// Shared restore state (hello contract, status RPC, queued attaches)
// ---------------------------------------------------------------------------

/// One roster row's settle outcome, for attach queuing (spec §10.4).
#[derive(Debug, Clone)]
struct RestoreTarget {
    active_session_id: String,
    session_file: String,
    /// The row's session name: `SessionRegistry::resolve` accepts name
    /// selectors, so the restore queue must own them too (the waiter
    /// settles by the same row the registry will resolve once it is up).
    name: Option<String>,
    /// The row needs the TS-parity continuation treatment (§10.5):
    /// an early settle (adoption or a live re-registration) must not
    /// wake this row's waiters ahead of the pass routing the
    /// restart-continuation prompt - the pass settles it right before.
    needs_continuation: bool,
    /// Set the moment the pass finishes this row (or the adoption pass
    /// brings the worker up): the per-target waiters wake immediately
    /// instead of queueing behind the rest of the recovery.
    settled: bool,
    failure: Option<String>,
}

/// The supervisor's restore pass state: read by the hello contract
/// (`update_resume`), the `update_restore_status` RPC, and the attach
/// queue. Held under a brief `std` mutex (no awaits inside); waiters park
/// on the notify.
#[derive(Debug, Default)]
pub(crate) struct RestoreProgress {
    update_id: Mutex<Option<UpdateId>>,
    state: Mutex<RestoreInner>,
    notify: Notify,
}

#[derive(Debug, Default)]
struct RestoreInner {
    done: bool,
    /// Bumped on every row settle: the per-row waiters' budget re-arms
    /// while the pass keeps making progress, so a large capped recovery
    /// cannot starve a healthy late row's waiter out of its queue.
    settled_generation: u64,
    targets: BTreeMap<String, RestoreTarget>,
    counts: UpdateStatusCounts,
    failures: Vec<UpdateStatusFailure>,
}

impl RestoreProgress {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Record the boot's update identity (spec §6 step 2) before serving,
    /// so hellos report the resume contract from the first connection,
    /// and register the roster rows: a client that reconnects while the
    /// recovery is still working queues behind its own session's row
    /// (spec §10.4) instead of failing with the plain unknown-session
    /// error, from the first adoption onward.
    pub(crate) fn begin(&self, roster: Option<&UpdateRoster>) {
        *self.update_id.lock().unwrap() = roster.map(|roster| roster.update_id.clone());
        if let Some(roster) = roster {
            self.register_targets(roster);
        }
    }

    pub(crate) fn update_id(&self) -> Option<UpdateId> {
        self.update_id.lock().unwrap().clone()
    }

    /// The hello resume contract (spec §10.3).
    pub(crate) fn hello_resume(&self) -> DaemonUpdateResume {
        let state = self.state.lock().unwrap();
        DaemonUpdateResume {
            update_id: self.update_id(),
            complete: state.done,
        }
    }

    /// Register the roster rows the restore pass will settle (attach
    /// queuing matches selectors against these).
    fn register_targets(&self, roster: &UpdateRoster) {
        let mut state = self.state.lock().unwrap();
        for row in &roster.sessions {
            state.targets.insert(
                row.session_id.clone(),
                RestoreTarget {
                    active_session_id: row.active_session_id.clone(),
                    session_file: row.session_file.clone(),
                    name: row.name.clone(),
                    needs_continuation: row.should_resume && row.in_flight.streaming,
                    settled: false,
                    failure: None,
                },
            );
        }
    }

    /// Record one row's settle outcome the moment the recovery finishes
    /// it (the restore pass's per-row outcome, or a descriptor adoption
    /// that brought the worker up): the row's waiters wake immediately
    /// instead of queueing behind the rest of the recovery (spec §10.4:
    /// the attach streams "once the session comes up"). Idempotent; a
    /// no-op for a selector no in-flight pass owns.
    pub(crate) fn settle_target(&self, selector: &str, failure: Option<String>) {
        {
            let mut state = self.state.lock().unwrap();
            let Some(target) = restore_target_mut(&mut state.targets, selector) else {
                return;
            };
            if target.settled {
                return;
            }
            target.settled = true;
            target.failure = failure;
            state.settled_generation += 1;
        }
        self.notify.notify_waiters();
    }

    /// Settle a row an adoption or a live (re-)registration brought up,
    /// not the restore pass itself. A row still pending its TS-parity
    /// continuation treatment (§10.5) stays queued: the pass settles it
    /// right before it routes the restart-continuation prompt, so a woken
    /// client's prompt cannot land ahead of the required continuation.
    /// The skip is still settle progress — the generation bump keeps the
    /// other waiters' quiet budgets re-armed (a healthy adoption of
    /// streaming rows must not look idle) — but the row's own waiters
    /// stay parked until the pass reaches it. Idempotent; a no-op for a
    /// selector no in-flight pass owns.
    pub(crate) fn settle_adopted(&self, selector: &str) {
        {
            let mut state = self.state.lock().unwrap();
            let Some(target) = restore_target_mut(&mut state.targets, selector) else {
                return;
            };
            if target.settled {
                return;
            }
            if target.needs_continuation {
                state.settled_generation += 1;
            } else {
                target.settled = true;
                state.settled_generation += 1;
            }
        }
        self.notify.notify_waiters();
    }

    /// Mark the pass settled: per-row outcomes, counts, and the waiters'
    /// wakeup. Idempotent.
    fn settle(&self, counts: UpdateStatusCounts, failures: Vec<UpdateStatusFailure>) {
        {
            let mut state = self.state.lock().unwrap();
            if state.done {
                return;
            }
            state.done = true;
            state.counts = counts;
            let mut by_file: BTreeMap<&str, &str> = BTreeMap::new();
            for failure in &failures {
                by_file.insert(failure.session_file.as_str(), failure.message.as_str());
            }
            for target in state.targets.values_mut() {
                target.settled = true;
                target.failure = by_file
                    .get(target.session_file.as_str())
                    .map(std::string::ToString::to_string);
            }
            state.settled_generation += 1;
            state.failures = failures;
        }
        self.notify.notify_waiters();
    }

    /// One row's failure message once settled (spec §10.4's typed attach
    /// error), if any.
    fn settled_failure(&self, selector: &str) -> Option<(String, String)> {
        let state = self.state.lock().unwrap();
        let target = restore_target(&state.targets, selector)?;
        target
            .failure
            .as_ref()
            .map(|message| (target.session_file.clone(), message.clone()))
    }

    /// Whether an in-flight pass owns the selector: any roster row the
    /// registry-shaped selector resolves to (durable id, transient active
    /// id, session-file stem or its normalized suffix, session name), so
    /// a command that will resolve once the row is up queues behind that
    /// row instead of failing fast.
    fn owns_target(&self, selector: &str) -> bool {
        let state = self.state.lock().unwrap();
        !state.done && restore_target(&state.targets, selector).is_some()
    }

    /// Wait for one target's settle outcome, not the whole pass (spec
    /// §10.4: the attach queues server-side and streams "once the session
    /// comes up" — a slow recovery of unrelated sessions must not hold
    /// this request). The §10.4 deadline bounds the queue's quiet time:
    /// every settle progress re-arms it, so a large capped adoption holds
    /// its waiters only while rows keep coming up, while a pass wedged
    /// with no progress for the budget cannot hold a client longer.
    async fn wait_for_settle_target(&self, selector: &str) {
        let quiet = std::time::Duration::from_millis(RESTORE_ATTACH_WAIT_MS.max(1));
        let (mut last_generation, mut deadline) = {
            let state = self.state.lock().unwrap();
            (
                state.settled_generation,
                tokio::time::Instant::now() + quiet,
            )
        };
        loop {
            // Register interest before re-checking: a settle that runs
            // between the check and the registration must still wake us.
            let notified = self.notify.notified();
            let (settled, generation) = {
                let state = self.state.lock().unwrap();
                (
                    state.done
                        || restore_target(&state.targets, selector)
                            .is_none_or(|target| target.settled),
                    state.settled_generation,
                )
            };
            if settled {
                // This row settled (or the whole pass did): the caller
                // re-resolves.
                return;
            }
            if generation != last_generation {
                last_generation = generation;
                deadline = tokio::time::Instant::now() + quiet;
            }
            if tokio::time::Instant::now() >= deadline {
                return;
            }
            tokio::select! {
                () = notified => {}
                () = tokio::time::sleep_until(deadline) => {}
            }
        }
    }
}

/// Whether one target answers the registry-shaped selector (the durable id
/// is the map key, checked first by the key resolver): the transient
/// active id, the session-file stem (both exact or a normalized suffix,
/// `SessionRegistry`'s `selector_matches`), or the session name (exact) —
/// the same shapes `SessionRegistry::resolve` accepts, so a command the
/// registry will resolve once the row is up queues behind that row now.
fn matches_selector(target: &RestoreTarget, selector: &str) -> bool {
    if target.active_session_id == selector {
        return true;
    }
    let stem = Path::new(&target.session_file)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default();
    if crate::registry::selector_matches(&target.active_session_id, selector)
        || (!stem.is_empty() && crate::registry::selector_matches(&stem, selector))
    {
        return true;
    }
    target
        .name
        .as_deref()
        .is_some_and(|name| !name.is_empty() && name == selector)
}

/// The map key a selector addresses: the exact durable id, or the key of
/// the single row the registry-shaped selector matches — an ambiguous
/// suffix or name matches nothing, the same way the registry errors an
/// ambiguous selector instead of picking one row to serve it.
fn restore_target_key(targets: &BTreeMap<String, RestoreTarget>, selector: &str) -> Option<String> {
    if targets.contains_key(selector) {
        return Some(selector.to_string());
    }
    let mut matches = targets
        .iter()
        .filter(|(_, target)| matches_selector(target, selector));
    let (key, _) = matches.next()?;
    matches.next().is_none().then(|| key.clone())
}

/// The roster row a selector addresses: any selector shape the registry
/// accepts, resolved to exactly one row.
fn restore_target<'a>(
    targets: &'a BTreeMap<String, RestoreTarget>,
    selector: &str,
) -> Option<&'a RestoreTarget> {
    restore_target_key(targets, selector).and_then(|key| targets.get(&key))
}

/// The mutable counterpart of [`restore_target`]: resolve the key, then
/// borrow it mutably.
fn restore_target_mut<'a>(
    targets: &'a mut BTreeMap<String, RestoreTarget>,
    selector: &str,
) -> Option<&'a mut RestoreTarget> {
    restore_target_key(targets, selector).and_then(|key| targets.get_mut(&key))
}

// ---------------------------------------------------------------------------
// Spec §6 step 1: the unconditional boot sweep
// ---------------------------------------------------------------------------

/// Delete this socket's update scratch directory plus the legacy TS-era
/// names (spec §6 step 1): no liveness checks, no exceptions — everything
/// there is per-update scratch state. The roster is consumed from the
/// spawn env before this runs, so the sweep can safely delete the file the
/// env pointed at. Failures are logged by the caller's posture: a missing
/// entry is a clean sweep.
pub(crate) fn boot_sweep(agent_dir: &Path, socket_path: &Path) {
    let socket_hash = crate::paths::hash_key(&socket_path.to_string_lossy(), 64);
    let _ = std::fs::remove_dir_all(socket_update_dir(agent_dir, &socket_hash));
    let _ = std::fs::remove_dir_all(legacy_update_restarts_dir(agent_dir));
    let _ = std::fs::remove_file(legacy_update_restart_status(agent_dir));
}

// ---------------------------------------------------------------------------
// Spec §6 step 2: consume the roster from the spawn env
// ---------------------------------------------------------------------------

/// Read `PRIME_AGENT_UPDATE_ROSTER` (spec §6 step 2): a path the
/// coordinator passed, never a discovered file. Returns `None` on a normal
/// boot. A malformed roster never fails the boot (spec §9): it restores
/// nothing and the sessions stay on disk for manual resume.
pub(crate) fn consume_roster_env() -> Option<UpdateRoster> {
    let path = std::env::var(UPDATE_ROSTER_ENV).ok()?;
    let path = Path::new(&path);
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) => {
            eprintln!(
                "pa-daemon: could not read the update roster at {}: {error}",
                path.display()
            );
            return None;
        }
    };
    match serde_json::from_str(&content) {
        Ok(roster) => Some(roster),
        Err(error) => {
            eprintln!(
                "pa-daemon: malformed update roster at {}: {error}",
                path.display()
            );
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Spec §6 steps 2-3: the restore pass + the re-arm
// ---------------------------------------------------------------------------

/// Order roster rows bottom-up (spec §8): deepest first so parents attach
/// to existing children; subagents before top-level rows of equal depth;
/// stable by session id otherwise.
fn sort_rows_bottom_up(rows: &mut [&UpdateRosterSession]) {
    rows.sort_by(|a, b| {
        b.rlm_depth.cmp(&a.rlm_depth).then_with(|| {
            let subagent = |row: &UpdateRosterSession| {
                row.kind == pa_types::daemon::update_flow::UpdateRosterSessionKind::Subagent
            };
            (subagent(b) as u8).cmp(&(subagent(a) as u8))
        })
    });
}

/// The boot restore driver: run after the descriptor-adoption task settles
/// (kept workers relaunch from their descriptors), then walk the roster
/// session rows bottom-up — deepest first (spec §8: parents attach to
/// existing children) — creating or adopting each row, then re-arm
/// scheduled work. Finally the pass settles the shared state, waking the
/// queued attaches and unblocking the `update_restore_status` poll.
pub(crate) async fn restore_pass(
    supervisor: &std::sync::Arc<Supervisor>,
    adoption: tokio::task::JoinHandle<()>,
    roster: Option<UpdateRoster>,
) {
    let _ = adoption.await;
    let Some(roster) = roster else {
        // Normal boot (spec §6 step 3 still applies): re-arm only.
        let woke = rearm_scheduled_wake(supervisor).await;
        if woke > 0 {
            supervisor.log_line(&format!("scheduled-work re-arm woke {woke} session(s)"));
        }
        supervisor
            .restore
            .settle(UpdateStatusCounts::default(), Vec::new());
        return;
    };
    let mut rows: Vec<&UpdateRosterSession> = roster.sessions.iter().collect();
    sort_rows_bottom_up(&mut rows);
    let mut counts = UpdateStatusCounts::default();
    let mut failures: Vec<UpdateStatusFailure> = Vec::new();
    for row in rows {
        counts.total += 1;
        match supervisor
            .registry
            .find_by_session_file(&row.session_file)
            .await
        {
            // The adoption pass (or a still-alive abandoned worker)
            // already brought the session up.
            Some(resident) => {
                counts.restored += 1;
                // Settle the row before the continuation treatment: the
                // waiters attach to the live worker now, while the
                // continuation prompt is this session's own stream.
                supervisor.restore.settle_target(&row.session_id, None);
                continuation_treatment(supervisor, &resident, row, &mut counts).await;
            }
            None => match restore_session(supervisor, row).await {
                Ok(resident) => {
                    counts.restored += 1;
                    supervisor.restore.settle_target(&row.session_id, None);
                    continuation_treatment(supervisor, &resident, row, &mut counts).await;
                }
                Err(error) => {
                    // Restore never fails the boot (spec §9): record the
                    // row and leave the session on disk. The row's waiters
                    // get the typed failure now, not behind the rest of
                    // the pass.
                    let message = format!("{error:#}");
                    supervisor.log_line(&format!(
                        "update restore: could not restore {}: {message}",
                        row.session_file
                    ));
                    supervisor
                        .restore
                        .settle_target(&row.session_id, Some(message.clone()));
                    failures.push(UpdateStatusFailure {
                        session_file: row.session_file.clone(),
                        message,
                    });
                    counts.failed += 1;
                }
            },
        }
    }
    let woke = rearm_scheduled_wake(supervisor).await;
    if woke > 0 {
        supervisor.log_line(&format!("scheduled-work re-arm woke {woke} session(s)"));
    }
    supervisor.restore.settle(counts, failures);
}

/// Re-create one roster row's session from the durable create command the
/// roster captured (spec §8 `runtime_config`): the supervisor's own create
/// path — the same launch, ledger admission, and roster publication a
/// client create gets — under the restore client id.
async fn restore_session(
    supervisor: &std::sync::Arc<Supervisor>,
    row: &UpdateRosterSession,
) -> Result<std::sync::Arc<ResidentWorker>> {
    let durable = row
        .runtime_config
        .get("create")
        .cloned()
        .context("the roster row carries no create command")?;
    let durable: pa_types::daemon::DurableDaemonCreateCommand =
        serde_json::from_value(durable).context("parse the roster row's create command")?;
    let payload = crate::descriptor::create_command_payload(&durable);
    let command: DaemonCommand =
        serde_json::from_value(payload).context("rebuild the create command")?;
    let summary = supervisor
        .handle_create(&command, UPDATE_RESTORE_CLIENT_ID.to_string())
        .await?;
    let session_id = summary.get("sessionId").and_then(|value| value.as_str());
    if session_id.is_none() {
        anyhow::bail!("the create reply carries no session id");
    }
    supervisor
        .registry
        .find_by_session_file(&row.session_file)
        .await
        .context("the restored session did not register")
}

/// The TS-parity continuation treatment (spec §10.5): a row that was
/// mid-turn when the snapshot was taken gets the TS continuation prompt
/// routed to the restored worker (a queued-work row already resumed via
/// the relaunch/create replay of its recovery journal). A failed prompt is
/// a resume failure, not a restore failure (TS parity: warn, don't fail).
async fn continuation_treatment(
    supervisor: &std::sync::Arc<Supervisor>,
    resident: &std::sync::Arc<ResidentWorker>,
    row: &UpdateRosterSession,
    counts: &mut UpdateStatusCounts,
) {
    if !row.should_resume {
        return;
    }
    if !row.in_flight.streaming {
        // Queued work: the relaunch/create replay restored the lanes.
        counts.resumed += 1;
        return;
    }
    let response = supervisor
        .route_command(
            resident,
            "prompt",
            json!({ "message": UPDATE_RESTART_CONTINUATION_PROMPT }),
            crate::supervisor::LONG_ROUTE_TIMEOUT_MS,
        )
        .await;
    match response {
        Ok(response) if response.success => counts.resumed += 1,
        Ok(response) => supervisor.log_line(&format!(
            "update restore: could not resume {}: {}",
            row.session_file,
            response.error.unwrap_or_default()
        )),
        Err(error) => supervisor.log_line(&format!(
            "update restore: could not resume {}: {error:#}",
            row.session_file
        )),
    }
}

/// Spec §6 step 3: the scheduled-work re-arm. `scheduled-jobs.json` in the
/// session artifacts is the only write path (spec §8); this pass rescans
/// it and wakes the sessions of due active jobs that have no live worker,
/// so a job that came due during the update window (and never ran) fires
/// on the first re-arm pass — `next_run_at` is never advanced to hide a
/// gap. Live sessions need no wake: their in-process scheduler claims due
/// jobs itself. Returns how many sessions were woken.
async fn rearm_scheduled_wake(supervisor: &std::sync::Arc<Supervisor>) -> usize {
    let jobs = crate::update_roster::scan_scheduled_jobs(&supervisor.options.agent_dir);
    let now = crate::util::now_ms();
    // The wake-scan target verification (TS `collectPassiveScheduledJobs`'s
    // scan gates): a due job may only wake a session that still exists —
    // the file present, still the job's session, still carrying the
    // `active` state — and that no live worker covers (a covered tree's
    // scheduler owns the fire itself). A killed (state `archived`) or
    // deleted session is never revived (TS parity; the zombie fix).
    let live = supervisor.live_session_files().await;
    let mut woke = 0usize;
    for job in jobs {
        if job.status != pa_core::cron::JobStatus::Active {
            continue;
        }
        if !pa_core::cron::is_due_job(&job, now) {
            continue;
        }
        if job.session_file.is_empty() {
            continue;
        }
        if !crate::stop_cleanup::due_job_target_alive(&job, &live) {
            continue;
        }
        match wake_saved_session(supervisor, &job.session_file).await {
            Ok(()) => woke += 1,
            Err(error) => supervisor.log_line(&format!(
                "scheduled-work re-arm failed for {}: {error:#}",
                job.session_file
            )),
        }
    }
    woke
}

/// Wake one saved session for its due scheduled jobs (TS
/// `wakeDueScheduledSessions`: a create with just the session path, under
/// the scheduled-wake client id). The wake reuses an existing worker if
/// one already owns the file (the caller checked; this is the second
/// line of defense).
async fn wake_saved_session(
    supervisor: &std::sync::Arc<Supervisor>,
    session_file: &str,
) -> Result<()> {
    if supervisor
        .registry
        .find_by_session_file(session_file)
        .await
        .is_some()
    {
        return Ok(());
    }
    // One owning daemon: the session-lease table is the one cross-daemon
    // ownership record a shared agent dir offers. A live holder — this
    // daemon's own surviving process, or another daemon's worker serving
    // the same file — owns the session and its scheduler; waking a rival
    // would either fail on the lease (the 6-strike storm) or, with leases
    // off, double-serve the file. The wake skips; the owner's own
    // scheduler fires the job.
    if let Some(owner) = crate::lease::live_lease_owner(
        &supervisor.options.agent_dir,
        std::path::Path::new(session_file),
    ) {
        supervisor.log_line(&format!(
            "scheduled-work re-arm skipped {session_file}: a live worker (pid {}) holds its session lease",
            owner.pid
        ));
        return Ok(());
    }
    let command = DaemonCommand::Create {
        id: None,
        session_path: Some(session_file.to_string()),
        continue_recent: None,
        no_session: None,
        name: None,
        config: None,
        telemetry_disabled: None,
        runtime_metadata: None,
        lifecycle: None,
        env: None,
        launch_env: None,
        rest: Map::default(),
    };
    supervisor
        .handle_create(&command, SCHEDULED_WAKE_CLIENT_ID.to_string())
        .await
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// Supervisor integration helpers
// ---------------------------------------------------------------------------

impl Supervisor {
    /// Spec §10.4: a client command addressed a session the registry cannot
    /// resolve. If a restore pass is in flight and the roster owns the
    /// selector, queue behind the pass (server-side; no client-visible
    /// retry), then let the caller re-resolve or fail typed against the
    /// settled outcome.
    pub(crate) async fn await_restore_target(&self, selector: &str) {
        if !self.restore.owns_target(selector) {
            // A pass is not in flight, or the selector is not a roster row:
            // no queuing (a fresh attach to an unrelated dead session must
            // fail immediately, not wait out the restore).
            return;
        }
        // Queue behind this session's own row only, never behind the
        // whole recovery (spec §10.4): an unrelated slow restore must not
        // hold a control-plane request.
        self.restore.wait_for_settle_target(selector).await;
    }

    /// Spec §10.4: the settled per-row failure for one selector, as the
    /// typed attach error with the session file path and the manual-resume
    /// hint.
    pub(crate) fn restore_failure_for(&self, selector: &str) -> Option<String> {
        self.restore
            .settled_failure(selector)
            .map(|(session_file, message)| {
                format!(
                    "Session {selector} failed to restore: {message}. The session file is at \
                     {session_file} — run `prime-agent attach` to resume it manually."
                )
            })
    }

    /// The `update_restore_status` RPC body: the restore pass's live
    /// snapshot for the coordinator's `Restoring` report (spec §9).
    pub(crate) fn restore_status_body(&self) -> serde_json::Value {
        let state = self.restore.state.lock().unwrap();
        json!({
            "updateId": self.restore.update_id().map(|id| id.to_string()),
            "inFlight": !state.done,
            "complete": state.done,
            "counts": {
                "total": state.counts.total,
                "restored": state.counts.restored,
                "resumed": state.counts.resumed,
                "failed": state.counts.failed,
            },
            "failures": state.failures,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::daemon::update_flow::UpdateStatusCounts;

    /// A two-row roster (update `u-1`): row `a-1`, and row `durable-b`
    /// whose session-file stem (`b-2`) differs from its durable id (the
    /// selector shapes the attach queue and the adoption settle both use).
    fn two_row_roster() -> UpdateRoster {
        serde_json::from_value(serde_json::json!({
            "format_version": 1,
            "update_id": "u-1",
            "socket_path": "/tmp/s.sock",
            "created_at": "2026-01-01T00:00:00Z",
            "supervisor": { "pid": 1, "process_start_id": "p", "generation": "g" },
            "binary": { "from_version": "0.1", "to_version": "0.2" },
            "sessions": [
                {
                    "session_id": "a-1",
                    "active_session_id": "active-a",
                    "session_file": "/sessions/a-1.jsonl",
                    "name": "alpha",
                    "kind": "top-level",
                    "rlm_depth": 0,
                    "cwd": "/w",
                    "runtime_config": {},
                    "queue": { "next_turn": [], "actions": {} },
                    "in_flight": {
                        "streaming": false, "compacting": false, "bash_running": false,
                        "rlm_children": false, "retrying": false, "prompt_in_flight": false
                    },
                    "should_resume": false
                },
                {
                    "session_id": "durable-b",
                    "active_session_id": "active-b",
                    "session_file": "/sessions/b-2.jsonl",
                    "kind": "top-level",
                    "rlm_depth": 0,
                    "cwd": "/w",
                    "runtime_config": {},
                    "queue": { "next_turn": [], "actions": {} },
                    "in_flight": {
                        "streaming": false, "compacting": false, "bash_running": false,
                        "rlm_children": false, "retrying": false, "prompt_in_flight": false
                    },
                    "should_resume": false
                }
            ],
        }))
        .unwrap()
    }

    #[test]
    fn hello_resume_reports_progress_before_and_after_settle() {
        let progress = RestoreProgress::new();
        progress.begin(Some(&two_row_roster()));
        assert!(!progress.hello_resume().complete);
        assert_eq!(
            progress.hello_resume().update_id,
            Some(UpdateId::from("u-1".to_string()))
        );
        progress.settle(
            UpdateStatusCounts {
                total: 2,
                restored: 1,
                resumed: 1,
                failed: 1,
            },
            vec![UpdateStatusFailure {
                session_file: "/sessions/b.jsonl".to_string(),
                message: "worker create failed".to_string(),
            }],
        );
        let hello = progress.hello_resume();
        assert!(hello.complete);
        assert_eq!(hello.update_id, Some(UpdateId::from("u-1".to_string())));
        // Idempotent settle: a second settle never overwrites the first.
        progress.settle(UpdateStatusCounts::default(), Vec::new());
        assert!(progress.hello_resume().complete);
    }

    #[tokio::test(start_paused = true)]
    async fn queued_attach_unblocks_when_only_its_target_settles() {
        let progress = std::sync::Arc::new(RestoreProgress::new());
        progress.begin(Some(&two_row_roster()));
        let waiter = |progress: &std::sync::Arc<RestoreProgress>, selector: &str| {
            let progress = std::sync::Arc::clone(progress);
            let selector = selector.to_string();
            tokio::spawn(async move { progress.wait_for_settle_target(&selector).await })
        };
        let mut queued_a = waiter(&progress, "a-1");
        let mut queued_b = waiter(&progress, "durable-b");
        // Neither row settled: both waiters queue behind their own rows
        // (the deadline, not this test's ticks, bounds the queue).
        let tick = std::time::Duration::from_millis(1);
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        assert!(tokio::time::timeout(tick, &mut queued_b).await.is_err());
        // One row settles (an adoption brought `durable-b` up; a client
        // may address it by stem): only that row's waiter wakes, while
        // the other row's keeps queueing behind the rest of the pass.
        progress.settle_target("b-2", None);
        assert!(tokio::time::timeout(tick, queued_b).await.is_ok());
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        // The whole pass settling unblocks the remaining row's waiter.
        progress.settle(UpdateStatusCounts::default(), Vec::new());
        assert!(tokio::time::timeout(tick, queued_a).await.is_ok());
    }

    #[test]
    fn settle_target_failure_answers_the_typed_attach_error_per_row() {
        let progress = RestoreProgress::new();
        progress.begin(Some(&two_row_roster()));
        progress.settle_target("durable-b", Some("worker create failed".to_string()));
        // Every selector shape for the failed row resolves the failure;
        // the still-queued row has none yet (its attach waits, it does
        // not fail early).
        for selector in ["durable-b", "active-b", "b-2"] {
            let (file, message) = progress.settled_failure(selector).unwrap();
            assert_eq!(file, "/sessions/b-2.jsonl");
            assert_eq!(message, "worker create failed");
        }
        assert!(progress.settled_failure("a-1").is_none());
        assert!(progress.settled_failure("unknown-id").is_none());
    }

    #[test]
    fn registry_shaped_selectors_own_their_row_and_ambiguous_ones_own_nothing() {
        let progress = RestoreProgress::new();
        progress.begin(Some(&two_row_roster()));
        // Every selector shape SessionRegistry::resolve accepts owns the
        // row: the durable id (the registry's exact-key lookup), the
        // transient active id, the session-file stem, the session name,
        // and normalized suffixes of the active id and stem (the durable
        // id is exact-key only, exactly like the registry's map lookup).
        for selector in ["a-1", "active-a", "alpha", "ve-a", "IVEA", "b-2", "e-b"] {
            assert!(progress.owns_target(selector), "owns {selector}");
        }
        assert!(!progress.owns_target("unknown"));
        assert!(!progress.owns_target(""));

        // An ambiguous selector owns nothing: like the registry, the
        // queue refuses to pick one of several matching rows.
        let mut roster = two_row_roster();
        roster.sessions[1].active_session_id = "xx-active-a".to_string();
        let ambiguous = RestoreProgress::new();
        ambiguous.begin(Some(&roster));
        assert!(!ambiguous.owns_target("active-a"));
        ambiguous.settle_target("active-a", Some("never lands".to_string()));
        assert!(ambiguous.settled_failure("active-a").is_none());
        // The rows settle by their own selectors all the same.
        ambiguous.settle_target("alpha", None);
        assert!(ambiguous.settled_failure("alpha").is_none());
        assert!(ambiguous.hello_resume().update_id.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn an_adoption_settle_skips_a_row_pending_its_continuation() {
        let mut roster = two_row_roster();
        roster.sessions[0].should_resume = true;
        roster.sessions[0].in_flight.streaming = true;
        let progress = std::sync::Arc::new(RestoreProgress::new());
        progress.begin(Some(&roster));
        let waiter = |progress: &std::sync::Arc<RestoreProgress>, selector: &str| {
            let progress = std::sync::Arc::clone(progress);
            let selector = selector.to_string();
            tokio::spawn(async move { progress.wait_for_settle_target(&selector).await })
        };
        let tick = std::time::Duration::from_millis(1);
        let mut queued_a = waiter(&progress, "a-1");
        let queued_b = waiter(&progress, "durable-b");
        // The adoption settles skip the continuation row but settle the
        // ordinary one: only the ordinary row's waiter wakes.
        progress.settle_adopted("a-1");
        progress.settle_adopted("durable-b");
        assert!(tokio::time::timeout(tick, queued_b).await.is_ok());
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        // The pass's own settle is unconditional: it wakes the
        // continuation row's waiters the moment the pass reaches it,
        // right before it routes the restart-continuation prompt.
        progress.settle_target("a-1", None);
        assert!(tokio::time::timeout(tick, queued_a).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_continuation_skip_is_still_progress_for_the_other_waiters() {
        let mut roster = two_row_roster();
        roster.sessions[0].should_resume = true;
        roster.sessions[0].in_flight.streaming = true;
        roster.sessions[1].should_resume = true;
        roster.sessions[1].in_flight.streaming = true;
        let progress = std::sync::Arc::new(RestoreProgress::new());
        progress.begin(Some(&roster));
        let waiter = |progress: &std::sync::Arc<RestoreProgress>, selector: &str| {
            let progress = std::sync::Arc::clone(progress);
            let selector = selector.to_string();
            tokio::spawn(async move { progress.wait_for_settle_target(&selector).await })
        };
        let mut queued_a = waiter(&progress, "a-1");
        let tick = std::time::Duration::from_millis(1);
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        // Quiet for 110s, then an adoption brings a continuation row up:
        // that row's settle is skipped (its waiters stay parked for the
        // pass's continuation) but still counts as progress, re-arming
        // this waiter's quiet budget.
        tokio::time::advance(std::time::Duration::from_secs(110)).await;
        progress.settle_adopted("durable-b");
        // Past the original absolute deadline: only the re-arm keeps the
        // waiter queued, and its own row is still owned (still pending
        // its continuation prompt).
        tokio::time::advance(std::time::Duration::from_secs(30)).await;
        assert!(
            tokio::time::timeout(tick, &mut queued_a).await.is_err(),
            "the skipped settle did not re-arm the other waiters"
        );
        // The pass settles the row itself: the waiter wakes.
        progress.settle_target("a-1", None);
        assert!(tokio::time::timeout(tick, queued_a).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn settle_progress_rearms_a_waiters_quiet_budget_past_the_first_deadline() {
        let progress = std::sync::Arc::new(RestoreProgress::new());
        progress.begin(Some(&two_row_roster()));
        let waiter = |progress: &std::sync::Arc<RestoreProgress>, selector: &str| {
            let progress = std::sync::Arc::clone(progress);
            let selector = selector.to_string();
            tokio::spawn(async move { progress.wait_for_settle_target(&selector).await })
        };
        let mut queued_a = waiter(&progress, "a-1");
        let tick = std::time::Duration::from_millis(1);
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        // Quiet for 110s (the budget is 120s), then one unrelated settle:
        // the pass is healthy and making progress, so the waiter's budget
        // re-arms instead of expiring on the original absolute deadline.
        tokio::time::advance(std::time::Duration::from_secs(110)).await;
        progress.settle_target("b-2", None);
        // Past the original absolute deadline: only the re-arm keeps the
        // waiter queued.
        tokio::time::advance(std::time::Duration::from_secs(30)).await;
        assert!(
            tokio::time::timeout(tick, &mut queued_a).await.is_err(),
            "the waiter expired on the original deadline instead of the re-armed one"
        );
        // Its own row settles well past that deadline: the waiter wakes.
        tokio::time::advance(std::time::Duration::from_secs(40)).await;
        progress.settle_target("alpha", None);
        assert!(tokio::time::timeout(tick, queued_a).await.is_ok());
    }

    #[test]
    fn settle_target_without_a_registered_pass_is_a_no_op() {
        let progress = RestoreProgress::new();
        // No pass began: the adoption settle on a normal boot (no
        // roster) must be a silent no-op.
        progress.settle_target("a-1", None);
        progress.settle_target("a-1", Some("never happens".to_string()));
        assert!(progress.settled_failure("a-1").is_none());
    }

    #[test]
    fn restore_rows_sort_bottom_up_deepest_first() {
        let row = |id: &str, depth: u32, subagent: bool| UpdateRosterSession {
            session_id: id.to_string(),
            active_session_id: format!("active-{id}"),
            session_file: format!("/sessions/{id}.jsonl"),
            name: None,
            kind: if subagent {
                pa_types::daemon::update_flow::UpdateRosterSessionKind::Subagent
            } else {
                pa_types::daemon::update_flow::UpdateRosterSessionKind::TopLevel
            },
            parent_session_id: None,
            rlm_depth: depth,
            cwd: "/w".to_string(),
            runtime_config: serde_json::json!({}),
            queue: pa_types::daemon::update_flow::UpdateRosterQueue {
                next_turn: Vec::new(),
                actions: serde_json::json!({}),
            },
            in_flight: UpdateRosterInFlight::default(),
            should_resume: false,
            rest: Map::default(),
        };
        let owned = [
            row("top", 0, false),
            row("child", 1, true),
            row("grandchild", 2, true),
        ];
        let mut rows: Vec<&UpdateRosterSession> = owned.iter().collect();
        sort_rows_bottom_up(&mut rows);
        let ids: Vec<&str> = rows.iter().map(|row| row.session_id.as_str()).collect();
        assert_eq!(ids, ["grandchild", "child", "top"]);
    }

    #[test]
    fn settled_failure_matches_durable_active_and_stem_selectors() {
        let progress = RestoreProgress::new();
        let roster: UpdateRoster = serde_json::from_value(serde_json::json!({
            "format_version": 1,
            "update_id": "u-1",
            "socket_path": "/tmp/s.sock",
            "created_at": "2026-01-01T00:00:00Z",
            "supervisor": { "pid": 1, "process_start_id": "p", "generation": "g" },
            "binary": { "from_version": "0.1", "to_version": "0.2" },
            "sessions": [{
                "session_id": "durable-1",
                "active_session_id": "active-1",
                "session_file": "/sessions/durable-1.jsonl",
                "kind": "top-level",
                "rlm_depth": 0,
                "cwd": "/w",
                "runtime_config": {},
                "queue": { "next_turn": [], "actions": {} },
                "in_flight": {
                    "streaming": false, "compacting": false, "bash_running": false,
                    "rlm_children": false, "retrying": false, "prompt_in_flight": false
                },
                "should_resume": false
            }],
        }))
        .unwrap();
        progress.register_targets(&roster);
        progress.settle(
            UpdateStatusCounts {
                total: 1,
                failed: 1,
                ..Default::default()
            },
            vec![UpdateStatusFailure {
                session_file: "/sessions/durable-1.jsonl".to_string(),
                message: "worker create failed".to_string(),
            }],
        );
        for selector in ["durable-1", "active-1"] {
            let (file, message) = progress.settled_failure(selector).unwrap();
            assert_eq!(file, "/sessions/durable-1.jsonl");
            assert_eq!(message, "worker create failed");
        }
        assert!(progress.settled_failure("unknown-id").is_none());
    }

    #[test]
    fn boot_sweep_removes_socket_dir_and_legacy_names() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        let socket = dir.path().join("daemon.sock");
        let socket_hash = crate::paths::hash_key(&socket.to_string_lossy(), 64);
        let scratch = socket_update_dir(&agent_dir, &socket_hash);
        std::fs::create_dir_all(scratch.join("prepared/u-1")).unwrap();
        std::fs::create_dir_all(legacy_update_restarts_dir(&agent_dir)).unwrap();
        std::fs::write(legacy_update_restart_status(&agent_dir), "{}").unwrap();
        boot_sweep(&agent_dir, &socket);
        assert!(!scratch.exists());
        assert!(!legacy_update_restarts_dir(&agent_dir).exists());
        assert!(!legacy_update_restart_status(&agent_dir).exists());
    }

    #[test]
    fn consume_roster_env_none_without_the_env() {
        // NOTE: process env is global; this test documents the None path
        // only when no other test set the var (the env is absent in the
        // test harness).
        if std::env::var(UPDATE_ROSTER_ENV).is_err() {
            assert!(consume_roster_env().is_none());
        }
    }
}
