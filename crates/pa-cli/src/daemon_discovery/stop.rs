//! Stopping the discovered daemons (TS `cli/daemon-ps.ts` reap/shutdown
//! half): the pure action planners, the safe re-probing executors, and the
//! three command drivers (`status`/`doctor`/`shutdown` output).
//!
//! Divergences from TS, deliberate:
//! - TS's `stopHiddenSupervisors` loop kills duplicate daemons it finds
//!   listening on one socket path (a handoff-era artifact); the Rust
//!   supervisor's socket lease makes two owners of one path impossible, so
//!   the loop is not ported.
//! - The supervisor-ownership registry rule of the TS state-root matcher is
//!   not ported (see the module docs).
//!
//! The shutdown admission (`acquireDaemonShutdownAdmission`, TS
//! `daemon-supervisor-ownership.ts` - the bind-choreography audit's D3
//! port) is now live here: `shutdown` holds the 5s/1s stop-window lease
//! for its whole converging pass, aborting any action whose assertion
//! finds the window lost.

use std::path::Path;

use pa_types::daemon::DaemonCommand;
use serde::Serialize;

use super::format::{print_reap_report, print_shutdown_report};
use super::kill::{
    force_kill_daemon, force_stop_tracked_workers, kill_daemon, remove_socket_file,
    terminate_verified_residuals,
};
use super::plan::{
    plan_reap, plan_shutdown_all, plan_shutdown_confirmation, ReapActionKind,
    ShutdownConfirmationPlan,
};
use super::{
    discover_daemons, is_daemon_process_listening, probe_daemon, DaemonInfo, DaemonStateRoot,
};

/// `status` (TS `runPs`): the daemons discovered in the given state root as
/// JSON or as the table.
pub(crate) fn run_ps(json: bool, root: &DaemonStateRoot) {
    let daemons = discover_daemons(root);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&daemons).unwrap_or_default()
        );
        return;
    }
    if daemons.is_empty() {
        println!("No background services found.");
        return;
    }
    println!("{}", super::format_daemon_list_table(&daemons));
}

/// `doctor --fix` (TS `runReap`): clean up clearly-safe daemons. Returns the
/// process exit code (always 0 — failures are reported as kept lines).
pub(crate) fn run_reap(json: bool, root: &DaemonStateRoot) -> i32 {
    let daemons = discover_daemons(root);
    let mut reaped: Vec<(String, String)> = Vec::new();
    let mut skipped: Vec<(String, String)> = Vec::new();
    for action in plan_reap(&daemons, false) {
        let socket_path = action.daemon.socket_path.display().to_string();
        let pid = action.daemon.pid;
        match action.kind {
            ReapActionKind::Skip => skipped.push((socket_path, action.reason.unwrap_or_default())),
            ReapActionKind::RemoveFile => {
                // Re-probe before unlinking: the path may have become a live
                // listener since discovery.
                if probe_daemon(&action.daemon.socket_path).reachable {
                    skipped.push((
                        socket_path,
                        "now reachable; not removing socket file".to_string(),
                    ));
                } else if remove_socket_file(&action.daemon.socket_path) {
                    reaped.push((socket_path, "removed stale socket file".to_string()));
                } else {
                    skipped.push((socket_path, "could not remove socket file".to_string()));
                }
            }
            ReapActionKind::Kill => {
                // Re-probe right before killing: a daemon classified
                // unreachable at discovery may have started answering; never
                // signal one that now responds.
                if probe_daemon(&action.daemon.socket_path).reachable {
                    apply(
                        reap_reachable_daemon(&action.daemon.socket_path, pid),
                        &socket_path,
                        &mut reaped,
                        &mut skipped,
                    );
                } else {
                    kill_daemon(pid.unwrap_or(0));
                    remove_socket_file(&action.daemon.socket_path);
                    reaped.push((
                        socket_path,
                        format!("killed unreachable daemon (pid {})", pid.unwrap_or(0)),
                    ));
                }
            }
            ReapActionKind::Shutdown => {
                apply(
                    reap_reachable_daemon(&action.daemon.socket_path, pid),
                    &socket_path,
                    &mut reaped,
                    &mut skipped,
                );
            }
        }
    }
    if json {
        println!("{}", reap_report_json(&reaped, &skipped));
        return 0;
    }
    print_reap_report(&reaped, &skipped);
    0
}

/// Ask a reachable daemon to stop, but only after a fresh probe confirms it
/// is idle (TS `reapReachableDaemon`).
fn reap_reachable_daemon(socket_path: &Path, pid: Option<u32>) -> StopOutcome {
    let probe = probe_daemon(socket_path);
    if !probe.reachable {
        return StopOutcome::Skipped("no longer reachable".to_string());
    }
    if probe.session_count != Some(0) {
        let count = match probe.session_count {
            Some(count) => count.to_string(),
            None => "unknown".to_string(),
        };
        return StopOutcome::Skipped(format!("now has {count} session(s)"));
    }
    if shutdown_daemon(socket_path, false) {
        StopOutcome::Reaped(format!(
            "stopped idle background service{}",
            pid.map(|pid| format!(" (pid {pid})")).unwrap_or_default()
        ))
    } else {
        StopOutcome::Skipped("shutdown request failed".to_string())
    }
}

enum StopOutcome {
    Reaped(String),
    Skipped(String),
}

fn apply(
    outcome: StopOutcome,
    socket_path: &str,
    reaped: &mut Vec<(String, String)>,
    skipped: &mut Vec<(String, String)>,
) {
    match outcome {
        StopOutcome::Reaped(action) => reaped.push((socket_path.to_string(), action)),
        StopOutcome::Skipped(reason) => skipped.push((socket_path.to_string(), reason)),
    }
}

/// `shutdown` (TS `runShutdownAll` + `runShutdownAllConverging`). Returns the
/// process exit code: 1 when anything failed (or the JSON confirmation
/// error), 0 otherwise.
pub(crate) fn run_shutdown_all(json: bool, force: bool, root: &DaemonStateRoot) -> i32 {
    let daemons = discover_daemons(root);
    match plan_shutdown_confirmation(
        daemons.len(),
        json,
        force,
        std::io::IsTerminal::is_terminal(&std::io::stdin()),
    ) {
        ShutdownConfirmationPlan::JsonError => {
            let failed: Vec<(String, String)> = daemons
                .iter()
                .map(|daemon| {
                    (
                        daemon.socket_path.display().to_string(),
                        r#"confirmation required; use "prime-agent shutdown --force --json""#
                            .to_string(),
                    )
                })
                .collect();
            println!("{}", shutdown_report_json(&[], &failed));
            1
        }
        ShutdownConfirmationPlan::TtyError => {
            // TS throws this out of `runShutdownAll` and the public-command
            // wrapper turns the throw into the standard `Error: …` failure
            // (stderr + exit 1); only reachable once there are daemons to
            // stop, so an empty machine shuts down cleanly without a TTY.
            eprintln!(
                "Error: Shutdown requires confirmation in an interactive terminal. Use \"prime-agent shutdown --force\"."
            );
            1
        }
        ShutdownConfirmationPlan::Prompt => {
            if !prompt_yes_no(
                "Stop every agent and background service? Active work will be interrupted.",
            ) {
                println!("\x1b[2mShutdown cancelled.\x1b[22m");
                return 0;
            }
            run_shutdown_with_admission(json, force, root)
        }
        ShutdownConfirmationPlan::None => run_shutdown_with_admission(json, force, root),
    }
}

/// Hold the shutdown-admission lease for the whole converging pass (TS
/// `runShutdownAll`: `acquireDaemonShutdownAdmission` before the pass,
/// released in the finally). While another stop window is active - an
/// update coordinator mid-restart - the acquire waits it out (the 5 s
/// lease, 1 s renewal); a lost lease aborts the pass, which fails the
/// command (TS's throw out of `runShutdownAllConverging`).
fn run_shutdown_with_admission(json: bool, force: bool, root: &DaemonStateRoot) -> i32 {
    let mut admission = match pa_daemon::supervisor_ownership::ShutdownAdmission::acquire() {
        Ok(admission) => admission,
        Err(error) => {
            eprintln!("Error: {error}");
            return 1;
        }
    };
    let assert = || admission.assert_or_renew();
    let outcome = run_shutdown_converging(json, force, root, &assert);
    admission.release();
    match outcome {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error}");
            1
        }
    }
}

/// TS `runShutdownAllConverging`: run the planned actions, then (with
/// `force`) sweep residuals until the listener set quiets down. Every stop
/// action is preceded by the admission assertion (`assertAdmission` in the
/// TS pass); a lost stop window aborts the whole pass as `Err`.
fn run_shutdown_converging(
    json: bool,
    force: bool,
    root: &DaemonStateRoot,
    assert: &dyn Fn() -> anyhow::Result<()>,
) -> std::result::Result<i32, String> {
    let mut stopped: Vec<(String, String)> = Vec::new();
    let mut failed: Vec<(String, String)> = Vec::new();
    let mut handled_pids: std::collections::HashSet<u32> = std::collections::HashSet::new();

    let daemons: Vec<DaemonInfo> = discover_daemons(root)
        .into_iter()
        .filter(|daemon| !super::is_worker_socket_path(&daemon.socket_path, &root.socket_dir))
        .collect();
    let action_order = |kind: &ReapActionKind| match kind {
        ReapActionKind::Shutdown => 0,
        ReapActionKind::RemoveFile => 1,
        ReapActionKind::Kill => 2,
        ReapActionKind::Skip => 3,
    };
    let mut actions = plan_shutdown_all(&daemons, force);
    actions.sort_by_key(|action| action_order(&action.kind));

    for action in actions {
        let socket_path = action.daemon.socket_path.display().to_string();
        let pid = action.daemon.pid;
        if let Some(pid) = pid {
            if handled_pids.contains(&pid) {
                assert().map_err(|error| error.to_string())?;
                remove_socket_file(&action.daemon.socket_path);
                stopped.push((
                    socket_path.clone(),
                    format!("background service already stopped (pid {pid})"),
                ));
                if force {
                    let reasons = force_stop_tracked_workers(
                        &action.daemon.socket_path,
                        &root.agent_dir,
                        assert,
                    )
                    .map_err(|error| error.to_string())?;
                    for reason in reasons {
                        failed.push((socket_path.clone(), reason));
                    }
                }
                continue;
            }
        }
        match action.kind {
            ReapActionKind::Skip => {
                failed.push((socket_path.clone(), action.reason.unwrap_or_default()));
            }
            ReapActionKind::RemoveFile => {
                if probe_daemon(&action.daemon.socket_path).reachable {
                    apply_stop(
                        stop_background_service(
                            &action.daemon.socket_path,
                            pid,
                            &mut handled_pids,
                            force,
                            assert,
                        )
                        .map_err(|error| error.to_string())?,
                        &socket_path,
                        &mut stopped,
                        &mut failed,
                    );
                } else {
                    assert().map_err(|error| error.to_string())?;
                    if remove_socket_file(&action.daemon.socket_path) {
                        stopped
                            .push((socket_path.clone(), "removed stale socket file".to_string()));
                    } else {
                        failed.push((
                            socket_path.clone(),
                            "could not remove socket file".to_string(),
                        ));
                    }
                }
            }
            ReapActionKind::Kill => {
                if probe_daemon(&action.daemon.socket_path).reachable {
                    apply_stop(
                        stop_background_service(
                            &action.daemon.socket_path,
                            pid,
                            &mut handled_pids,
                            force,
                            assert,
                        )
                        .map_err(|error| error.to_string())?,
                        &socket_path,
                        &mut stopped,
                        &mut failed,
                    );
                } else if let Some(pid) = pid.filter(|pid| {
                    is_daemon_process_listening(*pid, &action.daemon.socket_path, root)
                }) {
                    // TS asserts on both sides of the verified kill.
                    assert().map_err(|error| error.to_string())?;
                    let outcome = verified_force_kill(
                        pid,
                        &action.daemon.socket_path,
                        format!("killed unreachable background service (pid {pid})"),
                        &mut handled_pids,
                    );
                    assert().map_err(|error| error.to_string())?;
                    apply_stop(outcome, &socket_path, &mut stopped, &mut failed);
                } else {
                    assert().map_err(|error| error.to_string())?;
                    remove_socket_file(&action.daemon.socket_path);
                    stopped.push((
                        socket_path.clone(),
                        "background service already stopped".to_string(),
                    ));
                }
            }
            ReapActionKind::Shutdown => {
                apply_stop(
                    stop_background_service(
                        &action.daemon.socket_path,
                        pid,
                        &mut handled_pids,
                        force,
                        assert,
                    )
                    .map_err(|error| error.to_string())?,
                    &socket_path,
                    &mut stopped,
                    &mut failed,
                );
            }
        }
        if force && action.kind != ReapActionKind::Skip {
            let reasons =
                force_stop_tracked_workers(&action.daemon.socket_path, &root.agent_dir, assert)
                    .map_err(|error| error.to_string())?;
            for reason in reasons {
                failed.push((socket_path.clone(), reason));
            }
        }
    }

    if force {
        terminate_verified_residuals(root, &mut stopped, &mut failed, &handled_pids, assert)
            .map_err(|error| error.to_string())?;
    }

    // The exit code follows the failures in both output modes (TS sets
    // process.exitCode = 1 for any failed stop).
    if json {
        println!("{}", shutdown_report_json(&stopped, &failed));
        return Ok(i32::from(!failed.is_empty()));
    }
    print_shutdown_report(&stopped, &failed);
    Ok(i32::from(!failed.is_empty()))
}

fn apply_stop(
    outcome: StopOutcome,
    socket_path: &str,
    stopped: &mut Vec<(String, String)>,
    failed: &mut Vec<(String, String)>,
) {
    match outcome {
        StopOutcome::Reaped(action) => stopped.push((socket_path.to_string(), action)),
        StopOutcome::Skipped(reason) => failed.push((socket_path.to_string(), reason)),
    }
}

/// Stop one daemon gracefully, escalating only with `force` (TS
/// `stopBackgroundService`, whose `assertAdmission` runs before any stop
/// action; a lost stop window aborts the pass).
fn stop_background_service(
    socket_path: &Path,
    pid: Option<u32>,
    handled_pids: &mut std::collections::HashSet<u32>,
    force: bool,
    assert: &dyn Fn() -> anyhow::Result<()>,
) -> anyhow::Result<StopOutcome> {
    assert()?;
    if shutdown_daemon(socket_path, force) {
        if let Some(pid) = pid {
            handled_pids.insert(pid);
        }
        return Ok(StopOutcome::Reaped(format!(
            "stopped background service{}",
            pid.map(|pid| format!(" (pid {pid})")).unwrap_or_default()
        )));
    }
    if !probe_daemon(socket_path).reachable {
        // The 5 s graceful wait above can outlast the window: the
        // admission is re-asserted before the socket file is touched (TS
        // stopBackgroundService asserts at every post-wait step).
        assert()?;
        remove_socket_file(socket_path);
        return Ok(StopOutcome::Reaped(
            "background service already stopped".to_string(),
        ));
    }
    let Some(pid) = pid else {
        return Ok(StopOutcome::Skipped(
            "still listening but no pid to kill".to_string(),
        ));
    };
    if !force {
        return Ok(StopOutcome::Skipped(
            "did not stop gracefully; retry with --force".to_string(),
        ));
    }
    // The last action before the kill: the window must still be ours after
    // the wait (TS asserts between the graceful attempt and the force
    // kill, and again before the socket removal rides the kill's
    // confirmed-death path inside the helper).
    assert()?;
    Ok(verified_force_kill(
        pid,
        socket_path,
        format!("force-killed unresponsive background service (pid {pid})"),
        handled_pids,
    ))
}

/// Verified force-kill for one daemon (the supervisor-side contract the
/// worker-side `stop_tracked_process` already implements): the pid joins
/// `handled_pids` and the socket file is removed only on confirmed death —
/// a daemon that survives SIGKILL is reported as failed, with its socket
/// file deliberately kept so the invisible listener stays discoverable
/// for the `--force` residual sweep and the doctor's re-probe.
fn verified_force_kill(
    pid: u32,
    socket_path: &Path,
    success_action: String,
    handled_pids: &mut std::collections::HashSet<u32>,
) -> StopOutcome {
    if !force_kill_daemon(pid) {
        return StopOutcome::Skipped(format!(
            "could not safely stop daemon (pid {pid}); it survived SIGKILL"
        ));
    }
    handled_pids.insert(pid);
    remove_socket_file(socket_path);
    StopOutcome::Reaped(success_action)
}

/// Ask the daemon to stop and confirm it actually stopped listening: the ack
/// alone is not proof, so success is reported only once the socket stops
/// accepting connections (TS `shutdownDaemon`).
fn shutdown_daemon(socket_path: &Path, force: bool) -> bool {
    let Ok(mut client) = crate::daemon_client::DaemonClient::connect_probe(socket_path) else {
        return false;
    };
    let shutdown = DaemonCommand::Shutdown {
        id: None,
        force: Some(force),
        rest: serde_json::Map::default(),
    };
    // The daemon may still stop; the connectivity check below is the source
    // of truth.
    let _ = client.request_with_timeout(shutdown, 1_500);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if !probe_daemon(socket_path).reachable {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    false
}

/// `promptYesNo`: empty or anything-but-yes resolves false (default No).
pub(crate) fn prompt_yes_no(message: &str) -> bool {
    use std::io::Write as _;
    print!("{message} [y/N] ");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    if std::io::stdin().read_line(&mut answer).is_err() {
        return false;
    }
    let normalized = answer.trim().to_ascii_lowercase();
    normalized == "y" || normalized == "yes"
}

/// One acted-on service in the JSON reports (TS prints the socket path
/// first, then the action, or the reason on failure).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionEntry {
    socket_path: String,
    action: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReasonEntry {
    socket_path: String,
    reason: String,
}

/// The reap JSON report (TS prints `{reaped, skipped}` in that order).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReapReport {
    reaped: Vec<ActionEntry>,
    skipped: Vec<ReasonEntry>,
}

/// The shutdown JSON report (TS prints `{stopped, failed}` in that order).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShutdownReport {
    stopped: Vec<ActionEntry>,
    failed: Vec<ReasonEntry>,
}

fn action_entries(rows: &[(String, String)]) -> Vec<ActionEntry> {
    rows.iter()
        .map(|(socket_path, action)| ActionEntry {
            socket_path: socket_path.clone(),
            action: action.clone(),
        })
        .collect()
}

fn reason_entries(rows: &[(String, String)]) -> Vec<ReasonEntry> {
    rows.iter()
        .map(|(socket_path, reason)| ReasonEntry {
            socket_path: socket_path.clone(),
            reason: reason.clone(),
        })
        .collect()
}

fn reap_report_json(reaped: &[(String, String)], skipped: &[(String, String)]) -> String {
    serde_json::to_string_pretty(&ReapReport {
        reaped: action_entries(reaped),
        skipped: reason_entries(skipped),
    })
    .unwrap_or_default()
}

fn shutdown_report_json(stopped: &[(String, String)], failed: &[(String, String)]) -> String {
    serde_json::to_string_pretty(&ShutdownReport {
        stopped: action_entries(stopped),
        failed: reason_entries(failed),
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verified_force_kill_reports_confirmed_death_and_removes_the_socket() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let socket_path = tmp.path().join("daemon.sock");
        std::fs::write(&socket_path, b"").expect("create the socket file");
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a sleep child");
        let pid = child.id();
        let mut handled_pids = std::collections::HashSet::new();

        let outcome = verified_force_kill(
            pid,
            &socket_path,
            "killed unreachable background service".to_string(),
            &mut handled_pids,
        );

        match outcome {
            StopOutcome::Reaped(action) => {
                assert_eq!(action, "killed unreachable background service");
            }
            StopOutcome::Skipped(reason) => panic!("expected a reaped outcome, got {reason}"),
        }
        // Only the confirmed death joins the handled set and unlinks the
        // socket (the contract this helper enforces).
        assert!(handled_pids.contains(&pid));
        assert!(
            !socket_path.exists(),
            "a confirmed death removes the socket file"
        );
        let _ = child.wait();
    }

    #[test]
    fn shutdown_report_json_pins_the_failure_shape() {
        // Every failure path funnels into this report (TS prints
        // `{stopped, failed}`); the shape is the `--json` contract, so a
        // survived SIGKILL must surface as a `failed` reason entry.
        let report = serde_json::from_str::<serde_json::Value>(&shutdown_report_json(
            &[],
            &[(
                "/tmp/r6-shape.sock".to_string(),
                "could not safely stop daemon (pid 4242); it survived SIGKILL".to_string(),
            )],
        ))
        .expect("well-formed JSON");
        assert_eq!(
            report,
            serde_json::json!({
                "stopped": [],
                "failed": [
                    {
                        "socketPath": "/tmp/r6-shape.sock",
                        "reason": "could not safely stop daemon (pid 4242); it survived SIGKILL"
                    }
                ]
            })
        );
    }
}
