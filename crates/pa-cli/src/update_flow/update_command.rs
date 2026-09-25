//! The `prime-agent update` driver: the invoking CLI's phases (spec §4
//! `Acquire`..`Staged`) plus the spawn of the detached coordinator and the
//! status tail. The terminal status drives the printed report and the exit
//! code.

use std::path::PathBuf;

use anyhow::{Context, Result};
use pa_types::daemon::update_flow::{UpdateState, UpdateStatus, UpdateTimeoutBudget};

use super::intent::{acquire, hand_over, release, status_path_for, AcquireOutcome};
use super::plan::{plan, UpdatePlan};
use super::report::UpdateReport;
use super::status::UPDATE_TELEMETRY_STATE_NAMES;
use super::status::{read_status, StatusWriter};

/// The tail loop budgets (TS `launchDaemonUpdateRestartCoordinator`:
/// 30 minutes of progress, 3 minutes of heartbeat liveness).
const TAIL_PROGRESS_TIMEOUT_MS: u64 = 30 * 60_000;
const TAIL_LIVENESS_TIMEOUT_MS: u64 = 180_000;
/// Grace for a status file deleted by the successor's boot sweep (spec §6):
/// the coordinator's next write recreates it inside a normal boot window.
const TAIL_SWEEP_GRACE_MS: u64 = 60_000;
const TAIL_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// The update command's fixed inputs (parsed by the public command layer).
pub struct UpdateCommandOptions {
    pub force: bool,
    pub rollback: bool,
    pub channel: Option<pa_core::update::version::UpdateChannel>,
    /// The manual/direct install: stage this local payload (a release
    /// archive or a payload directory) instead of resolving the channel.
    /// The release version comes from the payload binary's `--version`
    /// output and the install goes through the same staged, atomic
    /// activation as a channel update — never an in-place copy.
    pub archive: Option<std::path::PathBuf>,
    /// The `http(s)://` origin recorded as the release's install source
    /// (required with `archive`; future updates resolve from it).
    pub source: Option<String>,
}

/// `prime-agent update`: plan, stage, spawn the coordinator, and relay its
/// terminal status. Returns the process exit code.
///
/// # Errors
/// Returns an error when this binary is not owned by the installer (no
/// managed install root), when the update lock cannot be acquired, handed
/// over, or released, when a status-record write fails, when planning,
/// downloading, staging, or candidate validation fails (a planning failure
/// records `Aborted` first), or when the detached coordinator cannot be
/// spawned.
pub async fn run_update_command(options: &UpdateCommandOptions) -> Result<i32> {
    let agent_dir = crate::config::get_agent_dir();
    let socket_path = pa_daemon::socket::default_daemon_socket_path();
    let install_root = super::activation_root().map_err(|_| {
        anyhow::anyhow!(
            "This compiled application is not owned by the Prime Agent installer. Update it using its original installer."
        )
    })?;
    let update_id = pa_types::daemon::update_flow::UpdateId::from(uuid::Uuid::now_v7().to_string());
    let status_path = status_path_for(&agent_dir, &socket_path.to_string_lossy());

    match acquire(
        &agent_dir,
        &socket_path.to_string_lossy(),
        &update_id,
        &status_path,
    )? {
        AcquireOutcome::Join { status_path } => {
            // Relay the running update's terminal status (TS
            // `waitForActiveDaemonUpdateRestartCoordinator`). The running
            // coordinator's invoker owns the telemetry emission.
            let status = tail_status(&status_path).await;
            print_terminal(&status);
            return Ok(if status.state == UpdateState::Complete {
                0
            } else {
                1
            });
        }
        AcquireOutcome::Acquired => {}
    }
    let mut writer = StatusWriter::new(&status_path, &update_id, &socket_path.to_string_lossy())?;
    // §11 telemetry: one `update_<phase>` event per status transition; the
    // tail below derives the coordinator-side events from the same file.
    let mut phases = PhaseTelemetry::open();
    writer.set_state(UpdateState::Planning)?;
    let budget = UpdateTimeoutBudget::from_env();
    let download_base = std::env::var("PRIME_AGENT_DOWNLOAD_BASE_URL").ok();
    let planned = if options.archive.is_some() {
        plan_direct(&install_root, options).await
    } else {
        plan(
            &install_root,
            options.force,
            options.rollback,
            options.channel,
            download_base.as_deref(),
        )
        .await
    };
    let (coordinator_exe, candidate_dir) = match planned {
        Ok(UpdatePlan::Update {
            version,
            archive_url,
            archive_sha256,
            base_url,
        }) => {
            // `Downloading`: stream + digest the archive (one wall-clock
            // budget across all attempts, spec §9).
            writer.set_state(UpdateState::Downloading)?;
            phases.phase(writer.current());
            let archive = agent_dir.join(format!("update-{update_id}.tar.gz"));
            pa_core::update::download::download_archive(
                &archive_url,
                &archive_sha256,
                &archive,
                pa_core::update::download::DownloadBudget {
                    total_ms: budget.download_ms,
                    attempts: budget.download_attempts,
                },
                &pa_core::update::release::update_user_agent(version.as_str()),
            )
            .await
            .with_context(|| "the release download failed; the installed version was kept")?;
            // `Staged`: extract, validate, and probe the candidate.
            writer.set_state(UpdateState::Staged)?;
            phases.phase(writer.current());
            let release_dir = pa_core::update::download::stage_archive(
                &archive,
                &archive_sha256,
                &install_root,
                &version,
                base_url.as_str(),
            )?;
            let _ = std::fs::remove_file(&archive);
            super::swap::validate_candidate(&release_dir.join("prime-agent"), &version).await?;
            (release_dir.join("prime-agent"), release_dir)
        }
        Ok(UpdatePlan::Direct {
            version,
            candidate_dir,
        }) => {
            // `Staged` directly: the payload was staged by `plan_direct`
            // (scratch + fsync + atomic rename); the probe below re-checks
            // the binary's `--version` against the version the release
            // name carries.
            writer.set_state(UpdateState::Staged)?;
            phases.phase(writer.current());
            super::swap::validate_candidate(&candidate_dir.join("prime-agent"), &version).await?;
            (candidate_dir.join("prime-agent"), candidate_dir)
        }
        Ok(UpdatePlan::Rollback {
            coordinator_exe,
            candidate_dir,
            ..
        }) => {
            // A rollback stages nothing; the previous release is already
            // validated on disk. The coordinator IS the previous binary.
            writer.set_state(UpdateState::Staged)?;
            (coordinator_exe, candidate_dir)
        }
        Ok(UpdatePlan::Skipped { reason }) => {
            writer.set_state(UpdateState::Skipped)?;
            writer.set_message(Some(reason.clone()))?;
            release(&agent_dir, &socket_path.to_string_lossy())?;
            track_update_completed(writer.current()).await;
            println!("{reason}");
            // TS `setSelfUpdateNoChangeExitCode`: an interactive child
            // reports no-change with the not-attempted code so the client
            // keeps running instead of relaunching an unchanged binary.
            let interactive_child =
                std::env::var(crate::public_command::SELF_UPDATE_INTERACTIVE_CHILD_ENV).as_deref()
                    == Ok("1");
            return Ok(if interactive_child { 75 } else { 0 });
        }
        Err(error) => {
            // A planning failure aborts before any state that could wedge:
            // the daemon never stopped (spec §4 `Aborted`).
            writer.set_state(UpdateState::Aborted)?;
            writer.set_message(Some(error.to_string()))?;
            release(&agent_dir, &socket_path.to_string_lossy())?;
            track_update_completed(writer.current()).await;
            anyhow::bail!("{error:#}");
        }
    };

    // Spawn the detached coordinator (the new - or previous - binary) and
    // hand the lock over (spec §3: the user-facing process exits after
    // spawning it; only the status file couples them).
    let mut command = std::process::Command::new(&coordinator_exe);
    command
        .args([
            "update",
            crate::public_command::DAEMON_UPDATE_RESTART_COORDINATOR_FLAG,
            "--daemon-socket",
        ])
        .arg(&socket_path)
        .arg(crate::public_command::DAEMON_UPDATE_RESTART_STATUS_FLAG)
        .arg(&status_path)
        .env(super::coordinator::UPDATE_CANDIDATE_DIR_ENV, &candidate_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // The coordinator inherits this CLI's environment minus the worker
        // role markers (the TS launcher deletes the same set).
        .env_remove(pa_daemon::worker::WORKER_ROLE_ENV)
        .env_remove(pa_daemon::worker::WORKER_TOKEN_ENV)
        .env_remove(pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV)
        .env_remove(pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV)
        .env_remove(pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV)
        .env_remove(pa_daemon::worker::WORKER_SOCKET_ENV)
        .env_remove(pa_daemon::worker::WORKER_INSTANCE_ID_ENV)
        .env_remove(pa_daemon::worker::WORKER_SCRIPT_ENV);
    // Detached: own process group, reaped by init, survives this CLI.
    pa_core::platform::process::set_new_process_group(&mut command);
    let child = command.spawn().with_context(|| {
        format!(
            "spawn the update coordinator at {}",
            coordinator_exe.display()
        )
    })?;
    hand_over(
        &agent_dir,
        &socket_path.to_string_lossy(),
        &update_id,
        child.id() as u64,
        &status_path,
    )?;
    drop(child);

    let status = tail_status_with(&status_path, &mut |observed, _fresh| {
        phases.phase(observed);
        if let Some(line) = phase_status_line(observed.state) {
            println!("{line}");
        }
    })
    .await;
    phases.finish().await;
    track_update_completed(&status).await;
    print_terminal(&status);
    Ok(if status.state == UpdateState::Complete {
        0
    } else {
        1
    })
}

/// The manual/direct install (`--archive <payload>`): no manifest and no
/// channel decision — the operator names the payload, the version comes
/// from the payload binary's `--version` probe, and the staging is
/// copy-to-scratch + fsync + atomic rename (the in-place `cp` over a
/// running binary that corrupted two installs is structurally impossible
/// here). The current launcher must already name a valid release — the
/// coordinator's rollback boot depends on it — so a broken launcher is
/// refused with a repair hint before any binary is replaced (the flag
/// parser validated `--source`; the staging boundary re-validates it).
async fn plan_direct(
    install_root: &std::path::Path,
    options: &UpdateCommandOptions,
) -> Result<UpdatePlan> {
    let archive = options
        .archive
        .as_deref()
        .context("the direct install needs a release payload")?;
    let source = options.source.as_deref().context(
        "the direct install needs --source <https-url> (recorded as the release's install origin)",
    )?;
    if !archive.exists() {
        anyhow::bail!("the release payload {} does not exist", archive.display());
    }
    // The active launcher must name a valid release before anything is
    // replaced: the coordinator records it as the rollback target.
    if pa_core::update::install::read_installation(
        install_root,
        pa_core::update::install::CURRENT_LAUNCHER,
    )
    .is_err()
    {
        anyhow::bail!(
            "The active launcher does not point at a valid managed release. Repair the installation (reinstall with the published installer) before a direct install."
        );
    }
    let (candidate_dir, version) =
        pa_core::update::download::stage_local_payload(archive, install_root, source).await?;
    Ok(UpdatePlan::Direct {
        version,
        candidate_dir,
    })
}

/// Tail the coordinator's status file to a terminal state (TS
/// `launchDaemonUpdateRestartCoordinator`'s wait loop): progress, liveness,
/// and the holder's process lifetime all bound the wait.
async fn tail_status(status_path: &std::path::Path) -> UpdateStatus {
    tail_status_with(status_path, &mut |_, _| {}).await
}

/// The tail with per-transition observers (§11: the CLI status line and the
/// `update_<phase>` telemetry derive from the same status-file transitions).
async fn tail_status_with(
    status_path: &std::path::Path,
    observe: &mut dyn FnMut(&UpdateStatus, bool),
) -> UpdateStatus {
    let started = std::time::Instant::now();
    let mut last_liveness = std::time::Instant::now();
    let mut last_epoch: Option<u64> = None;
    let mut last_state: Option<UpdateState> = None;
    // The successor's boot sweep (spec §6 step 1) deletes the scratch dir —
    // including this status file — while the coordinator is still driving
    // the successor's `Restoring`/`Complete` writes. A file that was seen
    // and then vanishes is the sweep, not a dead coordinator: grace it
    // within the liveness budget instead of failing the tail mid-update.
    let mut missing_since: Option<std::time::Instant> = None;
    loop {
        if let Some(status) = read_status(status_path) {
            if Some(status.epoch) != last_epoch {
                last_epoch = Some(status.epoch);
                last_liveness = std::time::Instant::now();
            }
            missing_since = None;
            // One observation per NEW state (epoch churn inside a state -
            // heartbeats - does not re-fire the observers).
            if last_state != Some(status.state) {
                let fresh = last_state.is_some();
                last_state = Some(status.state);
                observe(&status, fresh);
            }
            if status.state.is_terminal() {
                return status;
            }
        } else if missing_since.is_none() && last_epoch.is_some() {
            missing_since = Some(std::time::Instant::now());
        }
        let swept = missing_since
            .is_some_and(|seen| (seen.elapsed().as_millis() as u64) < TAIL_SWEEP_GRACE_MS);
        if !swept && last_liveness.elapsed().as_millis() as u64 >= TAIL_LIVENESS_TIMEOUT_MS {
            return unreported(
                status_path,
                "the update coordinator stopped reporting liveness",
            );
        }
        if started.elapsed().as_millis() as u64 >= TAIL_PROGRESS_TIMEOUT_MS {
            return unreported(status_path, "timed out waiting for update progress");
        }
        tokio::time::sleep(TAIL_POLL).await;
    }
}

fn unreported(status_path: &std::path::Path, message: &str) -> UpdateStatus {
    read_status(status_path).unwrap_or_else(|| UpdateStatus {
        version: 1,
        update_id: pa_types::daemon::update_flow::UpdateId::from(String::new()),
        socket_path: String::new(),
        state: UpdateState::Failed,
        epoch: 0,
        coordinator: None,
        predecessor: None,
        successor: None,
        counts: Default::default(),
        failures: Vec::new(),
        message: Some(message.to_string()),
        started_at: String::new(),
        updated_at: String::new(),
        heartbeat_at: None,
        rest: Default::default(),
    })
}

fn print_terminal(status: &UpdateStatus) {
    UpdateReport::build(status).print();
    if let Some(message) = &status.message {
        match status.state {
            UpdateState::Complete | UpdateState::Skipped => println!("{message}"),
            _ => eprintln!("{message}"),
        }
    }
}

/// The §11 CLI status line for one live state (the terminal states print
/// the TS-parity report instead).
fn phase_status_line(state: UpdateState) -> Option<&'static str> {
    match state {
        UpdateState::Preparing => Some("Preparing the daemon for the update…"),
        UpdateState::Prepared => Some("Prepared — stopping sessions"),
        UpdateState::Stopping => Some("Stopping sessions gracefully…"),
        UpdateState::Activating | UpdateState::Booting => Some("Activating → booting"),
        UpdateState::Restoring => Some("Restoring sessions…"),
        UpdateState::Rollback => Some("Rolling back"),
        // `Acquire`/`Join` precede the coordinator's status file; `Stopped`
        // is `Stopping`'s own tail (the successor's spawn follows); the
        // terminal states print the TS-parity report instead.
        // `Downloading`/`Staged` print their own lines in the invoking
        // phase (before the coordinator spawns).
        UpdateState::Acquire
        | UpdateState::Join
        | UpdateState::Downloading
        | UpdateState::Staged
        | UpdateState::Stopped
        | UpdateState::Planning
        | UpdateState::Skipped
        | UpdateState::Complete
        | UpdateState::Aborted
        | UpdateState::Failed => None,
    }
}

/// One `update_<phase>` telemetry event per status-file transition (spec
/// §11: every surface derives from the same transitions; the invoker owns
/// the emission - coordinator mode never emits). Primitives only: phase
/// name, observed duration, and the terminal counts. The privacy contract
/// keeps paths, messages, and ids out.
struct PhaseTelemetry {
    client: Option<pa_telemetry::TelemetryClient>,
    last_observed: Option<std::time::Instant>,
    /// States already emitted this invocation: the invoking CLI emits its
    /// own phases directly (Downloading/Staged) and the tail's first
    /// observation must not duplicate them.
    emitted: Vec<UpdateState>,
}

impl PhaseTelemetry {
    fn open() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let agent_dir = crate::config::get_agent_dir();
        let settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
        let client = if crate::mode::telemetry_disabled(&settings) {
            None
        } else {
            Some(pa_core::session_engine::telemetry::build_client(
                &settings, &agent_dir,
            ))
        };
        PhaseTelemetry {
            client,
            last_observed: None,
            emitted: Vec::new(),
        }
    }

    fn phase(&mut self, status: &UpdateStatus) {
        let Some(client) = &self.client else { return };
        if self.emitted.contains(&status.state) {
            return;
        }
        let Some(event) = phase_event_name(status.state) else {
            return;
        };
        self.emitted.push(status.state);
        let now = std::time::Instant::now();
        let duration_ms = self
            .last_observed
            .map_or(0, |last| now.duration_since(last).as_millis() as u64);
        self.last_observed = Some(now);
        let mut properties = pa_telemetry::base_properties("cli");
        properties.set("phase", serde_json::Value::from(event));
        properties.set("duration_ms", serde_json::Value::from(duration_ms));
        if status.state.is_terminal() {
            properties.set(
                "sessions_total",
                serde_json::Value::from(status.counts.total),
            );
            properties.set(
                "sessions_restored",
                serde_json::Value::from(status.counts.restored),
            );
            properties.set(
                "sessions_failed",
                serde_json::Value::from(status.counts.failed),
            );
        }
        client.track(event, properties);
    }

    async fn finish(self) {
        if let Some(client) = self.client {
            let _ = client.shutdown().await;
        }
    }
}

/// The §11 telemetry event for one coordinator state (`None` for states
/// without their own event: `Planning`, `Skipped`, and the phases the
/// invoking CLI emits directly around its own work).
fn phase_event_name(state: UpdateState) -> Option<&'static str> {
    match state {
        UpdateState::Downloading => Some("update_download_started"),
        UpdateState::Staged => Some("update_staged"),
        UpdateState::Preparing => Some("update_prepare_started"),
        UpdateState::Prepared => Some("update_prepared"),
        UpdateState::Stopping => Some("update_stopping"),
        UpdateState::Activating | UpdateState::Booting => Some("update_restarting"),
        UpdateState::Restoring => Some("update_restoring"),
        UpdateState::Complete => Some("update_complete"),
        UpdateState::Rollback => Some("update_rollback"),
        UpdateState::Aborted => Some("update_aborted"),
        UpdateState::Failed => Some("update_failed"),
        UpdateState::Acquire
        | UpdateState::Join
        | UpdateState::Stopped
        | UpdateState::Planning
        | UpdateState::Skipped => None,
    }
}

/// `update completed`: the update flow's adoption event, one per invocation
/// at the terminal status (primitives only; the privacy contract keeps
/// paths, messages, and ids out of telemetry).
async fn track_update_completed(status: &UpdateStatus) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let agent_dir = crate::config::get_agent_dir();
    let settings = pa_core::settings::SettingsManager::create(&cwd, &agent_dir);
    if crate::mode::telemetry_disabled(&settings) {
        return;
    }
    let client = pa_core::session_engine::telemetry::build_client(&settings, &agent_dir);
    let mut properties = pa_telemetry::base_properties("cli");
    properties.set(
        "outcome",
        serde_json::Value::from(
            UPDATE_TELEMETRY_STATE_NAMES
                .iter()
                .find(|(state, _)| *state == status.state)
                .map_or("unknown", |(_, name)| *name),
        ),
    );
    properties.set(
        "sessions_total",
        serde_json::Value::from(status.counts.total),
    );
    properties.set(
        "sessions_restored",
        serde_json::Value::from(status.counts.restored),
    );
    properties.set(
        "sessions_failed",
        serde_json::Value::from(status.counts.failed),
    );
    client.track("update completed", properties);
    let _ = client.shutdown().await;
}

/// The coordinator mode entry (`update --internal-update-restart-coordinator
/// --daemon-socket <path> --internal-update-restart-status <path>`): the
/// detached process that adopts the staged status and drives the FSM to a
/// terminal state. Returns the process exit code.
///
/// # Errors
/// Returns an error when the coordinator cannot adopt the staged status
/// record or a status write fails. An invalid invocation (a status path
/// outside the agent dir's `update-restarts/`) is reported on stderr and
/// returns `Ok(1)` instead.
pub async fn run_coordinator_mode(socket_path: PathBuf, status_path: PathBuf) -> Result<i32> {
    let agent_dir = crate::config::get_agent_dir();
    // TS parity: the status file belongs under the agent dir's
    // `update-restarts/` - the coordinator never writes status elsewhere.
    let restarts_dir = pa_types::daemon::update_flow::update_restarts_dir(&agent_dir);
    if !status_path.starts_with(&restarts_dir) {
        eprintln!("Invalid daemon update restart coordinator invocation.");
        return Ok(1);
    }
    let options = super::coordinator::CoordinatorOptions {
        agent_dir,
        socket_path,
        status_path,
        budget: UpdateTimeoutBudget::from_env(),
    };
    let status = super::coordinator::run(&options).await?;
    print_terminal(&status);
    Ok(if status.state == UpdateState::Complete {
        0
    } else {
        1
    })
}
