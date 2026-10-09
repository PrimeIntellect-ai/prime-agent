//! The coordinator FSM driver (spec §4): the detached pa-cli process that
//! owns the update from the adopted status (the invoking CLI staged through
//! `Staged`) to a terminal state. Every state is written to the status file
//! before acting (spec §4); `Rollback` is a first-class path, not an error.
//!
//! The activation boundary (spec §7): the coordinator swaps the launcher
//! symlinks, records `.activation-state`, and deletes it on `Complete`. The
//! `Restoring` phase reports the successor's boot restore pass (spec §6,
//! slice 5): the supervisor restores the roster rows (create-or-adopt,
//! bottom-up) and the coordinator polls the `update_restore_status` RPC
//! for the real per-session counts and failure records.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use super::phases::{check_marker_fresh, commit_update, prepare_to_prepared, restore_report};
use anyhow::{Context, Result};
use pa_types::daemon::update_flow::{
    update_prepared_dir, update_roster_path, UpdateId, UpdateProcessIdentity, UpdateState,
    UpdateStatus, UpdateTimeoutBudget,
};
use tokio::sync::Mutex;

use super::status::{StatusHeartbeat, StatusWriter};
use super::successor::{
    capture_spawned_successor, identity_from_hello, spawn_supervisor, validate_replacement_daemon,
    wait_for_exit, wait_for_hello,
};
use super::swap;

/// The staged release directory, passed by the invoking CLI through the
/// coordinator's environment.
pub const UPDATE_CANDIDATE_DIR_ENV: &str = "PRIME_AGENT_UPDATE_CANDIDATE_DIR";

/// The coordinator's own fence-wait budget (TS
/// `UPDATE_RESTART_PREDECESSOR_FENCE_TIMEOUT_MS`: 60 s, ten times the
/// supervisor's own 10 s default).
const UPDATE_RESTART_PREDECESSOR_FENCE_TIMEOUT_MS: u64 = 60_000;

/// One coordinator run's fixed inputs.
pub struct CoordinatorOptions {
    pub agent_dir: PathBuf,
    pub socket_path: PathBuf,
    pub status_path: PathBuf,
    pub budget: UpdateTimeoutBudget,
}

/// Why the driver left the success path. Before the stop the terminal is
/// Where the prepare-time rollback-roster copy lives: beside the update's
/// status record (the one artifact the successor's `boot_sweep` never
/// deletes), so a rollback that must re-adopt a rejected child's workers
/// still has the roster bytes.
#[must_use]
fn rollback_roster_path(status_path: &Path) -> PathBuf {
    let mut name = status_path.file_name().unwrap_or_default().to_os_string();
    name.push(".rollback-roster");
    status_path.with_file_name(name)
}

/// `Aborted` (the daemon never stopped); after the stop it is a first-class
/// `Rollback` attempt (spec §9) - the workers are gone and the previous
/// binary must take over.
struct PhaseFailure {
    message: String,
    after_stop: bool,
    /// The successor this coordinator spawned and then refused (a
    /// validation failure or a silent boot): still running when the
    /// failure lands, so the rollback must stop it before it spawns onto
    /// the socket the rejected daemon still owns.
    rejected: Option<super::successor::SpawnedSuccessor>,
}

impl PhaseFailure {
    fn before_stop<E: std::fmt::Display>(error: E) -> Self {
        Self {
            message: error.to_string(),
            after_stop: false,
            rejected: None,
        }
    }

    fn after_stop<E: std::fmt::Display>(error: E) -> Self {
        Self {
            message: error.to_string(),
            after_stop: true,
            rejected: None,
        }
    }

    /// An after-stop failure that leaves the named child running.
    fn after_stop_rejected<E: std::fmt::Display>(
        error: E,
        rejected: super::successor::SpawnedSuccessor,
    ) -> Self {
        Self {
            message: error.to_string(),
            after_stop: true,
            rejected: Some(rejected),
        }
    }
}

/// Run the FSM from the adopted status to a terminal state; the returned
/// status is the terminal record (the caller prints the report).
///
/// # Errors
/// Returns an error when no status record exists at `status_path`, when the
/// recorded state is not `Staged` (only a staged update is adoptable), or
/// when a status-record write fails.
pub async fn run(options: &CoordinatorOptions) -> Result<UpdateStatus> {
    let Some(existing) = super::status::read_status(&options.status_path) else {
        anyhow::bail!(
            "no coordinator status at {} - the coordinator runs behind an invoking update",
            options.status_path.display()
        );
    };
    if existing.state != UpdateState::Staged {
        anyhow::bail!(
            "cannot adopt an update in state {:?} (only Staged is adoptable)",
            existing.state
        );
    }
    let update_id = existing.update_id.clone();
    let socket_lossy = options.socket_path.to_string_lossy().to_string();
    let socket_dir = super::intent::socket_update_directory(&options.agent_dir, &socket_lossy);
    let writer = Arc::new(Mutex::new(StatusWriter::adopt(
        &options.status_path,
        &update_id,
        &socket_lossy,
    )?));
    let heartbeat = StatusHeartbeat::start(Arc::clone(&writer));
    match drive(&writer, options, &update_id, &socket_dir).await {
        Ok(()) => {}
        Err(failure) if !failure.after_stop => {
            // `Aborted -> [*]: daemon never stopped; user retried later`.
            let mut writer = writer.lock().await;
            writer.set_state(UpdateState::Aborted)?;
            writer.set_message(Some(failure.message))?;
        }
        Err(failure) => {
            // The rollback child gets the update's roster artifact (the
            // same one the failed spawn booted with): the rejected
            // successor's crash-oracle kill leaves its adopted workers'
            // recovery journals on disk, and the rollback boot re-adopts
            // them from the roster - a bare rollback spawn would strand
            // those sessions.
            let prepared_dir = update_prepared_dir(&socket_dir, &update_id);
            let roster_path = update_roster_path(&prepared_dir);
            // The successor's boot sweep has usually deleted the
            // original already: the prepare-time copy beside the status
            // record is the surviving artifact.
            let backup = rollback_roster_path(&options.status_path);
            let roster = if backup.is_file() {
                Some(backup)
            } else {
                (roster_path.is_file()).then_some(roster_path)
            };
            finish_failure(&writer, options, failure, roster.as_deref()).await?;
        }
    }
    heartbeat.stop();
    // The terminal state owns the lock cleanup; the boot sweep is the last
    // resort (spec §7).
    let _ = super::intent::release(&options.agent_dir, &socket_lossy);
    // The prepare-time rollback-roster copy served its purpose (or was
    // never needed); the original artifact is the successor's own.
    let _ = std::fs::remove_file(rollback_roster_path(&options.status_path));
    let final_status = writer.lock().await.current().clone();
    Ok(final_status)
}

async fn drive(
    writer: &Arc<Mutex<StatusWriter>>,
    options: &CoordinatorOptions,
    update_id: &UpdateId,
    socket_dir: &Path,
) -> std::result::Result<(), PhaseFailure> {
    let budget = &options.budget;
    // The stop window opens here (TS package-manager-cli.ts
    // `runDaemonUpdateRestartCoordinator`: `acquireDaemonShutdownAdmission`
    // before the probe; 5000 ms lease renewed every 1000 ms). While it is
    // held, a third-party successor refuses its own boot ("Daemon shutdown
    // is in progress"); the handle releases on drop, and a crashed holder
    // stops renewing, so the window self-heals inside the lease.
    let mut admission = pa_daemon::supervisor_ownership::ShutdownAdmission::acquire()
        .map_err(PhaseFailure::before_stop)?;
    // `Preparing`: connect the old supervisor. An unreachable daemon is a
    // daemon-less update: an empty prepare is trivially durable and the
    // successor boots without a roster (the workers are already gone).
    let daemon = match pa_tui::daemon_client::DaemonClient::connect(&options.socket_path).await {
        Ok((client, _events)) => Some(client),
        Err(_) => None,
    };
    let mut predecessor: Option<UpdateProcessIdentity> = None;
    let mut roster_path: Option<PathBuf> = None;
    if let Some(client) = &daemon {
        let identity = identity_from_hello(client.hello());
        writer
            .lock()
            .await
            .set_predecessor(identity.clone())
            .map_err(PhaseFailure::before_stop)?;
        predecessor = Some(identity.clone());
        writer
            .lock()
            .await
            .set_state(UpdateState::Preparing)
            .map_err(PhaseFailure::before_stop)?;
        prepare_to_prepared(client, update_id, budget)
            .await
            .map_err(PhaseFailure::before_stop)?;
        let prepared_dir = update_prepared_dir(socket_dir, update_id);
        check_marker_fresh(&prepared_dir).map_err(PhaseFailure::before_stop)?;
        // Pin the dying predecessor from its verified hello (TS
        // `prepareConnectedDaemonUpdateRestart` ->
        // `persistPreparedRestartFence`): the fence is what a third-party
        // successor bows out against once this listener drops. A hello
        // without a fixed identity leaves the window unfenced, exactly
        // like TS's old-build daemons.
        let hello_socket_path = client
            .hello()
            .get("supervisorSocketPath")
            .and_then(serde_json::Value::as_str);
        if let Some(fence) = pa_daemon::supervisor_ownership::FenceIdentity::from_verified_hello(
            &identity,
            &options.socket_path,
            hello_socket_path,
        ) {
            pa_daemon::supervisor_ownership::persist_startup_fence(&options.socket_path, &fence)
                .map_err(PhaseFailure::before_stop)?;
        }
        // The roster artifact is the successor's input (consumed from the
        // env at its boot, spec §6 step 2); the coordinator never parses it.
        roster_path = Some(update_roster_path(&prepared_dir));
        // The rollback's roster insurance: the
        // successor's `boot_sweep` deletes the socket's WHOLE update
        // directory - the roster included - before it greets, so a
        // rollback that must re-adopt a rejected child's workers would
        // find nothing at the original path. The roster BYTES are copied
        // beside the status record (sweep-safe); the copy is opaque - the
        // coordinator still never parses the roster. Removed at the end
        // of the run.
        if let Some(roster_path) = &roster_path {
            // The backup is published ATOMICALLY (write beside, then
            // rename) and its failure ABORTS the update before the stop:
            // a partial backup could win over the intact original and the
            // rollback would report completion without restoring sessions
            // a session-losing rollback - and an update that cannot
            // secure its own rollback insurance must not stop the daemon.
            let backup = rollback_roster_path(&options.status_path);
            let partial = {
                let mut name = backup.file_name().unwrap_or_default().to_os_string();
                name.push(".partial");
                backup.with_file_name(name)
            };
            let insured = (|| -> Result<()> {
                let bytes = std::fs::read(roster_path)?;
                if let Some(parent) = backup.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&partial, &bytes)?;
                pa_telemetry::rename_onto(&partial, &backup)?;
                Ok(())
            })();
            insured.map_err(|error| {
                PhaseFailure::before_stop(format!(
                    "the rollback's roster insurance could not be written: {error}"
                ))
            })?;
        }
        writer
            .lock()
            .await
            .set_state(UpdateState::Prepared)
            .map_err(PhaseFailure::before_stop)?;
        // `Stopping`: the only consumption of the prepared artifact (spec
        // §5) - the slice-3 dispatch stops the workers in budget. The
        // admission must still be ours at the stop (TS `assertOrRenew`
        // before `shutdownConnectedDaemonAndWait`).
        admission
            .assert_or_renew()
            .map_err(PhaseFailure::before_stop)?;
        writer
            .lock()
            .await
            .set_state(UpdateState::Stopping)
            .map_err(PhaseFailure::before_stop)?;
        commit_update(client, update_id, budget)
            .await
            .map_err(PhaseFailure::after_stop)?;
        client.close();
    } else {
        writer
            .lock()
            .await
            .set_state(UpdateState::Preparing)
            .map_err(PhaseFailure::after_stop)?;
        writer
            .lock()
            .await
            .set_state(UpdateState::Prepared)
            .map_err(PhaseFailure::after_stop)?;
    }
    // `Stopped`: fence-free predecessor exit wait (spec §9).
    if let Some(identity) = &predecessor {
        if !wait_for_exit(identity, budget.predecessor_exit_ms).await {
            return Err(PhaseFailure::after_stop(
                "the predecessor supervisor did not exit within its budget",
            ));
        }
    }
    // Wait the persisted fence out before anything takes the socket again
    // (TS package-manager-cli.ts:1440, `UPDATE_RESTART_PREDECESSOR_FENCE_TIMEOUT_MS`):
    // the record clears only when the pinned predecessor process is gone -
    // either this wait's own dead-pin clear or the predecessor's exit.
    // Bounded like TS (60 s), so a pinned survivor can never wedge the
    // update.
    pa_daemon::supervisor_ownership::wait_for_startup_fence(
        &options.socket_path,
        UPDATE_RESTART_PREDECESSOR_FENCE_TIMEOUT_MS,
    )
    .await
    .map_err(PhaseFailure::after_stop)?;
    writer
        .lock()
        .await
        .set_state(UpdateState::Stopped)
        .map_err(PhaseFailure::after_stop)?;
    // `Activating`: validate the staged candidate BEFORE the swap (a bad
    // candidate never becomes the launcher), then record
    // `.activation-state`, move the old target to `bin/previous`, and
    // atomically repoint `bin/prime-agent` (spec §7).
    writer
        .lock()
        .await
        .set_state(UpdateState::Activating)
        .map_err(PhaseFailure::after_stop)?;
    let candidate = activation_plan().map_err(PhaseFailure::after_stop)?;
    tokio::time::timeout(
        Duration::from_millis(budget.activate_ms.max(1)),
        swap::validate_candidate(&candidate.executable, &candidate.version),
    )
    .await
    .map_err(|_| PhaseFailure::after_stop("the candidate validation probes timed out"))?
    .map_err(PhaseFailure::after_stop)?;
    swap::activate(
        &candidate.root,
        &candidate.current_target,
        &candidate.candidate_target,
        update_id.as_ref(),
    )
    .map_err(PhaseFailure::after_stop)?;
    // Close the stop window right before the successor spawns (TS:
    // `assertOrRenew` + `release` immediately before the spawn): the fence
    // has confirmed the predecessor is gone, and the release must precede
    // the spawn - the successor's own boot refuses while a shutdown
    // admission is active ("Daemon shutdown is in progress"), so holding
    // it through the spawn would refuse the very successor it guards. The
    // residual release-to-hello race is adjudicated by the spawn pin
    // below (the hello wait and the validation bind the answerer to the
    // process this coordinator spawns): a competing daemon that wins the
    // socket is skipped and refused, never adopted, and the update fails
    // closed into the rollback.
    admission
        .assert_or_renew()
        .map_err(PhaseFailure::after_stop)?;
    admission.release();
    // `Booting`: spawn the successor from the candidate release dir, roster
    // via env (spec §6), hello within `T_boot`.
    writer
        .lock()
        .await
        .set_state(UpdateState::Booting)
        .map_err(PhaseFailure::after_stop)?;
    let spawn_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    // Pin the spawned child to its process identity right after the
    // spawn: the hello the coordinator waits for and adopts must come
    // from THIS child, never from a third-party daemon that won the
    // release-to-spawn bind race.
    let spawned = capture_spawned_successor(
        spawn_supervisor(
            &candidate.executable,
            &options.socket_path,
            roster_path.as_deref(),
            &spawn_cwd,
        )
        .map_err(PhaseFailure::after_stop)?,
    );
    let successor_hello = wait_for_hello(&options.socket_path, budget.boot_ms, &spawned)
        .await
        .ok_or_else(|| {
            PhaseFailure::after_stop_rejected(
                "the successor supervisor did not greet within its boot budget",
                spawned.clone(),
            )
        })?;
    // The daemon that answered must be the activated candidate, not
    // whatever else won the release-to-spawn race (TS
    // `validateReplacementDaemon`): version, socket identity, identity
    // fence, not-the-predecessor - and the spawned child's own pid +
    // start id (the spawn pin): a surviving predecessor, a stale
    // third-party daemon, or the bind race's winner fails the update and
    // the rollback takes over.
    let successor = validate_replacement_daemon(
        &options.socket_path,
        &successor_hello,
        &candidate.version,
        predecessor.as_ref(),
        &spawned,
    )
    .map_err(|error| PhaseFailure::after_stop_rejected(error, spawned.clone()))?;
    // From here on the spawned child is live AND adopted: any later
    // after-stop failure carries its identity, so the rollback stops the
    // daemon this coordinator spawned - an adopted successor holds the
    // socket exactly like a rejected one.
    writer
        .lock()
        .await
        .set_successor(successor)
        .map_err(|error| PhaseFailure::after_stop_rejected(error, spawned.clone()))?;
    // `Restoring`: the successor's restore pass reports real counts
    // (the `update_restore_status` poll; spec §9).
    writer
        .lock()
        .await
        .set_state(UpdateState::Restoring)
        .map_err(|error| PhaseFailure::after_stop_rejected(error, spawned.clone()))?;
    let (counts, failures) = restore_report(&options.socket_path, budget).await;
    writer
        .lock()
        .await
        .set_counts(counts)
        .map_err(|error| PhaseFailure::after_stop_rejected(error, spawned.clone()))?;
    writer
        .lock()
        .await
        .set_failures(failures)
        .map_err(|error| PhaseFailure::after_stop_rejected(error, spawned.clone()))?;
    // The coordinator deletes the prepared dir after `Restoring` (spec §7;
    // idempotent with the supervisor's self-expiry and the boot sweep).
    if let Some(prepared_dir) = roster_path.as_ref().map(|roster_path| {
        roster_path
            .parent()
            .expect("the roster lives in the prepared dir")
    }) {
        let _ = std::fs::remove_dir_all(prepared_dir);
    }
    swap::clear_activation_state(&candidate.root)
        .map_err(|error| PhaseFailure::after_stop_rejected(error, spawned.clone()))?;
    writer
        .lock()
        .await
        .set_state(UpdateState::Complete)
        .map_err(|error| PhaseFailure::after_stop_rejected(error, spawned.clone()))?;
    let message = if counts.failed > 0 {
        format!(
            "Restarted the daemon with {} session restore failure{}",
            counts.failed,
            if counts.failed == 1 { "" } else { "s" }
        )
    } else {
        "Restarted the daemon after the update".to_string()
    };
    writer
        .lock()
        .await
        .set_message(Some(message))
        .map_err(|error| PhaseFailure::after_stop_rejected(error, spawned.clone()))?;
    Ok(())
}

/// The after-stop failure terminal (spec §9): `Rollback` is first-class -
/// the previous binary takes over and still serves the sessions. A rollback
/// boot that also fails is `Failed` (sessions persist on disk; `attach`
/// recovers them).
async fn finish_failure(
    writer: &Arc<Mutex<StatusWriter>>,
    options: &CoordinatorOptions,
    failure: PhaseFailure,
    roster_path: Option<&Path>,
) -> Result<()> {
    let reason = failure.message.trim_end_matches('.');
    writer.lock().await.set_state(UpdateState::Rollback)?;
    // Every rollback-unavailable path records `Failed` - the status must
    // reach a terminal state, and the failure message is the diagnostic
    // channel (the coordinator's stdio is detached).
    let fail_hard = |message: String| async {
        let mut writer = writer.lock().await;
        let _ = writer.set_state(UpdateState::Failed);
        let _ = writer.set_message(Some(message));
    };
    // The rollback runs INSIDE the stop window (TS keeps its
    // `shutdownAdmission` held through every failure unwind, releasing it
    // only in the `finally`): drive's handle dropped at its return, so the
    // window is re-opened here - without it the fence wait and the
    // launcher restore run open, and a third-party daemon can bind the
    // socket out from under the rollback child. A re-acquire failure is
    // another window's socket: the rollback cannot run under it.
    let mut rollback_admission = match pa_daemon::supervisor_ownership::ShutdownAdmission::acquire()
    {
        Ok(admission) => admission,
        Err(error) => {
            fail_hard(format!(
                "The rollback could not hold the stop window ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
            ))
            .await;
            return Ok(());
        }
    };
    // The successor this coordinator spawned - rejected or adopted - still
    // running from the failed spawn and is stopped HERE, FIRST in the
    // rollback (before any later abort return can leave it running beside a
    // restored launcher): an identity-verified DIRECT SIGKILL of the pid
    // this coordinator spawned - never an RPC to the socket, and never a
    // SIGTERM: both the graceful Shutdown and the TERM signal drain
    // persist worker stop tombstones (a durable stop that kills the
    // sessions), while the direct kill is the crash path the protocol
    // already trusts - the adopted workers die with the supervisor, their
    // recovery journals persist, and the roster'd rollback boot below
    // re-adopts them while the socket frees for the rollback. The
    // start-id check means a reused pid is never signaled, and a
    // competing daemon that answered the socket is never touched - a live
    // competitor keeps the rollback's honest Failed.
    if let Some(rejected) = &failure.rejected {
        let confirmed_dead = crate::daemon_discovery::kill::force_kill_identity_crash(
            u32::try_from(rejected.pid).unwrap_or(0),
            rejected.process_start_id.as_deref(),
        );
        if !confirmed_dead {
            // An UNCONFIRMED death never proceeds - not to the launcher
            // restore, not to the spawn: the refused daemon could still
            // own the socket, and a Failed rollback beside a serving new
            // binary is the honest terminal state (the crash kill itself
            // reports the conservative outcome - a liveness probe error
            // counts as alive).
            fail_hard(format!(
                "The successor this update spawned could not be stopped; the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
            ))
            .await;
            return Ok(());
        }
    }
    let root = match super::activation_root() {
        Ok(root) => root,
        Err(error) => {
            fail_hard(format!(
                "The rollback is unavailable ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
            ))
            .await;
            return Ok(());
        }
    };
    let previous = match pa_core::update::install::read_rollback_installation(&root) {
        Ok(previous) => previous,
        Err(error) => {
            fail_hard(format!(
                "No valid previous release to roll back to ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
            ))
            .await;
            return Ok(());
        }
    };
    let previous_target = match swap::launcher_target(
        &root,
        pa_core::update::install::PREVIOUS_LAUNCHER,
    ) {
        Ok(target) => target,
        Err(error) => {
            fail_hard(format!(
                    "The rollback launcher is missing ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
                ))
                .await;
            return Ok(());
        }
    };
    if let Err(error) = swap::restore_previous(&root, &previous_target) {
        fail_hard(format!(
            "The rollback repoint failed ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
        ))
        .await;
        return Ok(());
    }
    writer.lock().await.set_state(UpdateState::Booting)?;
    // The rollback boot must not race the dying predecessor either: wait
    // the prepare-time fence out exactly like the main flow's stopped
    // state. The fence is a deadman record (a dead pin self-clears here;
    // TS `waitForDaemonStartupFence`), so this only blocks while the
    // pinned predecessor is a genuine survivor - and a surviving owner of
    // the socket must surface as an explicit rollback failure, never as a
    // silent boot refusal inside the spawned child.
    if let Err(error) = pa_daemon::supervisor_ownership::wait_for_startup_fence(
        &options.socket_path,
        UPDATE_RESTART_PREDECESSOR_FENCE_TIMEOUT_MS,
    )
    .await
    {
        fail_hard(format!(
            "The rollback could not wait out the predecessor fence ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
        ))
        .await;
        return Ok(());
    }
    // Close the stop window right before the rollback child spawns,
    // exactly like the happy path's release-to-spawn choreography: the
    // child's own boot refuses while an admission is active, and the
    // residual release-to-hello race is adjudicated by the spawn pin
    // below (a competing daemon that wins the socket is refused, never
    // adopted).
    if let Err(error) = rollback_admission.assert_or_renew() {
        fail_hard(format!(
            "The rollback lost the stop window ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
        ))
        .await;
        return Ok(());
    }
    rollback_admission.release();
    let spawn_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    // The rollback spawn is pinned exactly like the main flow's: the
    // adopted hello must come from the rollback child this coordinator
    // spawned, never from a third-party daemon that won the bind race.
    let spawned = match spawn_supervisor(
        previous.executable(),
        &options.socket_path,
        roster_path,
        &spawn_cwd,
    ) {
        Ok(pid) => capture_spawned_successor(pid),
        Err(error) => {
            writer.lock().await.set_state(UpdateState::Failed)?;
            writer.lock().await.set_message(Some(format!(
                "The rollback supervisor could not spawn ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
            )))?;
            return Ok(());
        }
    };
    // The rollback boot greets under the same successor contract as the
    // main flow (TS `validateReplacementDaemon`, applied to the Rust
    // rollback path too - the TS coordinator has no rollback spawn): the
    // expected version is the rollback installation's, the
    // not-the-predecessor check reads the status record's predecessor
    // (`drive` pinned it there from the verified predecessor hello before
    // the stop), and the spawn pin binds the hello to the rollback child.
    let predecessor = writer.lock().await.current().predecessor.clone();
    // A rollback child that fails its boot or validation is killed the
    // same way the main flow's rejected successor is: this coordinator
    // spawned it, and a Failed rollback must not leave it owning the
    // socket or leaking unbound (the crash kill is best-effort here - the
    // terminal Failed state is already recorded, and an unconfirmed death
    // leaves the same honest status as before).
    let retire_rollback_child = |spawned: &super::successor::SpawnedSuccessor| {
        let _ = crate::daemon_discovery::kill::force_kill_identity_crash(
            u32::try_from(spawned.pid).unwrap_or(0),
            spawned.process_start_id.as_deref(),
        );
    };
    if let Some(hello) =
        wait_for_hello(&options.socket_path, options.budget.boot_ms, &spawned).await
    {
        match validate_replacement_daemon(
            &options.socket_path,
            &hello,
            previous.version(),
            predecessor.as_ref(),
            &spawned,
        ) {
            Ok(identity) => {
                writer.lock().await.set_successor(identity)?;
                writer.lock().await.set_state(UpdateState::Restoring)?;
                let (counts, failures) =
                    restore_report(&options.socket_path, &options.budget).await;
                writer.lock().await.set_counts(counts)?;
                // The per-session restore diagnostics ride the report too -
                // the completed rollback must say WHICH sessions failed and
                // why, never silently drop them.
                writer.lock().await.set_failures(failures)?;
                writer.lock().await.set_state(UpdateState::Complete)?;
                writer.lock().await.set_message(Some(format!(
                    "Rolled back to the previous Prime Agent version ({reason})"
                )))?;
                Ok(())
            }
            Err(error) => {
                retire_rollback_child(&spawned);
                writer.lock().await.set_state(UpdateState::Failed)?;
                writer.lock().await.set_message(Some(format!(
                    "The rollback supervisor failed validation ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
                )))?;
                Ok(())
            }
        }
    } else {
        retire_rollback_child(&spawned);
        writer.lock().await.set_state(UpdateState::Failed)?;
        writer.lock().await.set_message(Some(format!(
            "The rollback supervisor did not greet within its boot budget; the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
        )))?;
        Ok(())
    }
}

/// The candidate activation plan: the staged release directory and the
/// launcher targets the swap writes.
struct ActivationPlan {
    root: PathBuf,
    executable: PathBuf,
    version: String,
    current_target: String,
    candidate_target: String,
}

fn activation_plan() -> Result<ActivationPlan> {
    let candidate_dir = std::env::var(UPDATE_CANDIDATE_DIR_ENV)
        .context("the coordinator was spawned without a staged candidate")?;
    let candidate_dir = PathBuf::from(candidate_dir);
    let executable = candidate_dir.join("prime-agent");
    let root = super::activation_root()?;
    let directory_name = candidate_dir
        .file_name()
        .and_then(|name| name.to_str())
        .context("the staged release directory has no name")?
        .to_string();
    let version = pa_core::update::install::release_version_of(&directory_name)
        .context("the staged release directory name does not carry a version")?;
    Ok(ActivationPlan {
        current_target: swap::launcher_target(&root, pa_core::update::install::CURRENT_LAUNCHER)?,
        candidate_target: format!("../releases/{directory_name}/prime-agent"),
        executable,
        version,
        root,
    })
}
