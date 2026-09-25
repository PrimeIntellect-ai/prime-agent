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
use super::successor::{identity_from_hello, spawn_supervisor, wait_for_exit, wait_for_hello};
use super::swap;

/// The staged release directory, passed by the invoking CLI through the
/// coordinator's environment.
pub const UPDATE_CANDIDATE_DIR_ENV: &str = "PRIME_AGENT_UPDATE_CANDIDATE_DIR";

/// One coordinator run's fixed inputs.
pub struct CoordinatorOptions {
    pub agent_dir: PathBuf,
    pub socket_path: PathBuf,
    pub status_path: PathBuf,
    pub budget: UpdateTimeoutBudget,
}

/// Why the driver left the success path. Before the stop the terminal is
/// `Aborted` (the daemon never stopped); after the stop it is a first-class
/// `Rollback` attempt (spec §9) - the workers are gone and the previous
/// binary must take over.
struct PhaseFailure {
    message: String,
    after_stop: bool,
}

impl PhaseFailure {
    fn before_stop<E: std::fmt::Display>(error: E) -> Self {
        Self {
            message: error.to_string(),
            after_stop: false,
        }
    }

    fn after_stop<E: std::fmt::Display>(error: E) -> Self {
        Self {
            message: error.to_string(),
            after_stop: true,
        }
    }
}

/// Run the FSM from the adopted status to a terminal state; the returned
/// status is the terminal record (the caller prints the report).
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
            finish_failure(&writer, options, failure).await?;
        }
    }
    heartbeat.stop();
    // The terminal state owns the lock cleanup; the boot sweep is the last
    // resort (spec §7).
    let _ = super::intent::release(&options.agent_dir, &socket_lossy);
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
        predecessor = Some(identity);
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
        // The roster artifact is the successor's input (consumed from the
        // env at its boot, spec §6 step 2); the coordinator never parses it.
        roster_path = Some(update_roster_path(&prepared_dir));
        writer
            .lock()
            .await
            .set_state(UpdateState::Prepared)
            .map_err(PhaseFailure::before_stop)?;
        // `Stopping`: the only consumption of the prepared artifact (spec
        // §5) - the slice-3 dispatch stops the workers in budget.
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
    // `Booting`: spawn the successor from the candidate release dir, roster
    // via env (spec §6), hello within `T_boot`.
    writer
        .lock()
        .await
        .set_state(UpdateState::Booting)
        .map_err(PhaseFailure::after_stop)?;
    let spawn_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    spawn_supervisor(
        &candidate.executable,
        &options.socket_path,
        roster_path.as_deref(),
        &spawn_cwd,
    )
    .map_err(PhaseFailure::after_stop)?;
    let successor = wait_for_hello(&options.socket_path, budget.boot_ms)
        .await
        .ok_or_else(|| {
            PhaseFailure::after_stop(
                "the successor supervisor did not greet within its boot budget",
            )
        })?;
    writer
        .lock()
        .await
        .set_successor(successor)
        .map_err(PhaseFailure::after_stop)?;
    // `Restoring`: the successor's restore pass reports real counts
    // (the `update_restore_status` poll; spec §9).
    writer
        .lock()
        .await
        .set_state(UpdateState::Restoring)
        .map_err(PhaseFailure::after_stop)?;
    let (counts, failures) = restore_report(&options.socket_path, budget).await;
    writer
        .lock()
        .await
        .set_counts(counts)
        .map_err(PhaseFailure::after_stop)?;
    writer
        .lock()
        .await
        .set_failures(failures)
        .map_err(PhaseFailure::after_stop)?;
    // The coordinator deletes the prepared dir after `Restoring` (spec §7;
    // idempotent with the supervisor's self-expiry and the boot sweep).
    if let Some(prepared_dir) = roster_path.as_ref().map(|roster_path| {
        roster_path
            .parent()
            .expect("the roster lives in the prepared dir")
    }) {
        let _ = std::fs::remove_dir_all(prepared_dir);
    }
    swap::clear_activation_state(&candidate.root).map_err(PhaseFailure::after_stop)?;
    writer
        .lock()
        .await
        .set_state(UpdateState::Complete)
        .map_err(PhaseFailure::after_stop)?;
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
        .map_err(PhaseFailure::after_stop)?;
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
    let spawn_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    if let Err(error) = spawn_supervisor(
        previous.executable(),
        &options.socket_path,
        None,
        &spawn_cwd,
    ) {
        writer.lock().await.set_state(UpdateState::Failed)?;
        writer.lock().await.set_message(Some(format!(
            "The rollback supervisor could not spawn ({error}); the update failed ({reason}). Sessions persist on disk - prime-agent attach recovers them."
        )))?;
        return Ok(());
    }
    if let Some(identity) = wait_for_hello(&options.socket_path, options.budget.boot_ms).await {
        writer.lock().await.set_successor(identity)?;
        writer.lock().await.set_state(UpdateState::Restoring)?;
        let (counts, _failures) = restore_report(&options.socket_path, &options.budget).await;
        writer.lock().await.set_counts(counts)?;
        writer.lock().await.set_state(UpdateState::Complete)?;
        writer.lock().await.set_message(Some(format!(
            "Rolled back to the previous Prime Agent version ({reason})"
        )))?;
        Ok(())
    } else {
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
