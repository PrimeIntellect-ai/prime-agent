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
    targets: BTreeMap<String, RestoreTarget>,
    counts: UpdateStatusCounts,
    failures: Vec<UpdateStatusFailure>,
}

impl RestoreProgress {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Record the boot's update identity (spec §6 step 2) before serving,
    /// so hellos report the resume contract from the first connection.
    pub(crate) fn begin(&self, update_id: Option<UpdateId>) {
        *self.update_id.lock().unwrap() = update_id;
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

    fn is_in_flight(&self) -> bool {
        !self.state.lock().unwrap().done
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
                    failure: None,
                },
            );
        }
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
                target.failure = by_file
                    .get(target.session_file.as_str())
                    .map(|message| message.to_string());
            }
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

    /// Whether an in-flight pass owns the selector (a roster row: durable
    /// id, transient active id, or session-file stem).
    fn owns_target(&self, selector: &str) -> bool {
        let state = self.state.lock().unwrap();
        !state.done && restore_target(&state.targets, selector).is_some()
    }

    /// Wait for the restore pass to settle if one is in flight (spec §10.4:
    /// attaches queue server-side behind the pass).
    async fn wait_for_settle(&self) {
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_millis(RESTORE_ATTACH_WAIT_MS.max(1));
        loop {
            // Register interest before re-checking: a settle that runs
            // between the check and the registration must still wake us.
            let notified = self.notify.notified();
            if !self.is_in_flight() {
                // Settled (or no pass at all): the caller re-resolves.
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                return;
            }
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }
    }
}

/// The roster row a selector addresses: by durable id, transient active id,
/// or session-file stem (the same selectors `SessionRegistry::resolve`
/// accepts).
fn restore_target<'a>(
    targets: &'a BTreeMap<String, RestoreTarget>,
    selector: &str,
) -> Option<&'a RestoreTarget> {
    let file_stem = |file: &str| {
        Path::new(file)
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    targets
        .values()
        .find(|target| {
            target.active_session_id == selector || {
                let stem = file_stem(&target.session_file);
                !stem.is_empty() && stem == selector
            }
        })
        .or_else(|| targets.get(selector))
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
    supervisor.restore.register_targets(&roster);
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
                continuation_treatment(supervisor, &resident, row, &mut counts).await;
            }
            None => match restore_session(supervisor, row).await {
                Ok(resident) => {
                    counts.restored += 1;
                    continuation_treatment(supervisor, &resident, row, &mut counts).await;
                }
                Err(error) => {
                    // Restore never fails the boot (spec §9): record the
                    // row and leave the session on disk.
                    supervisor.log_line(&format!(
                        "update restore: could not restore {}: {error:#}",
                        row.session_file
                    ));
                    failures.push(UpdateStatusFailure {
                        session_file: row.session_file.clone(),
                        message: format!("{error:#}"),
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
        if supervisor
            .registry
            .find_by_session_file(&job.session_file)
            .await
            .is_some()
        {
            // The session is live: its own scheduler claims the due job.
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
        rest: Default::default(),
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
        self.restore.wait_for_settle().await;
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

    #[test]
    fn hello_resume_reports_progress_before_and_after_settle() {
        let progress = RestoreProgress::new();
        progress.begin(Some(UpdateId::from("u-1".to_string())));
        assert!(!progress.hello_resume().complete);
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
    async fn queued_attach_waits_for_settle_then_unblocks() {
        let progress = std::sync::Arc::new(RestoreProgress::new());
        progress.begin(None);
        let settler = {
            let progress = std::sync::Arc::clone(&progress);
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                progress.settle(UpdateStatusCounts::default(), Vec::new());
            })
        };
        progress.wait_for_settle().await;
        assert!(progress.hello_resume().complete);
        settler.await.unwrap();
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
            in_flight: Default::default(),
            should_resume: false,
            rest: Default::default(),
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
