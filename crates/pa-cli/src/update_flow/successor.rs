//! The successor supervisor seam (spec §4 `Booting`): spawn the new (or
//! rollback) binary from its release dir, pass the roster through the one
//! env the boot sweep reads, and wait for the `daemon_hello` that carries
//! the successor identity.

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use pa_types::daemon::update_flow::{UpdateProcessIdentity, UPDATE_ROSTER_ENV};
use serde_json::Value;

/// How often the boot wait retries the hello handshake.
const BOOT_POLL: Duration = Duration::from_millis(250);

/// The identity a `daemon_hello` frame carries (TS
/// `processIdentityFromDaemonHello`): pid, start id, generation, and owner
/// token.
pub fn identity_from_hello(hello: &Value) -> UpdateProcessIdentity {
    UpdateProcessIdentity {
        pid: hello
            .get("supervisorPid")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        process_start_id: hello
            .get("supervisorProcessStartId")
            .and_then(Value::as_str)
            .map(str::to_string),
        supervisor_generation: hello
            .get("supervisorGeneration")
            .and_then(Value::as_str)
            .map(str::to_string),
        supervisor_owner_token: hello
            .get("supervisorOwnerToken")
            .and_then(Value::as_str)
            .map(str::to_string),
        rest: Default::default(),
    }
}

/// Spawn the successor supervisor detached (the TS launcher deletes the
/// worker role env from the inherited environment; the roster path is the
/// one addition, spec §6).
pub fn spawn_supervisor(
    exe: &Path,
    socket_path: &Path,
    roster_path: Option<&Path>,
    cwd: &Path,
) -> Result<u64> {
    let mut command = std::process::Command::new(exe);
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(socket_path)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env_remove(pa_daemon::worker::WORKER_ROLE_ENV)
        .env_remove(pa_daemon::worker::WORKER_TOKEN_ENV)
        .env_remove(pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV)
        .env_remove(pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV)
        .env_remove(pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV)
        .env_remove(pa_daemon::worker::WORKER_SOCKET_ENV)
        .env_remove(pa_daemon::worker::WORKER_INSTANCE_ID_ENV)
        .env_remove(pa_daemon::worker::WORKER_SCRIPT_ENV);
    if let Some(roster_path) = roster_path {
        command.env(UPDATE_ROSTER_ENV, roster_path);
    }
    pa_core::platform::process::set_new_process_group(&mut command);
    let child = command
        .spawn()
        .with_context(|| format!("spawn the successor supervisor from {}", exe.display()))?;
    Ok(child.id() as u64)
}

/// Connect and complete the `daemon_hello` handshake, bounded by `budget_ms`
/// (spec §9 `Booting`): `true` identity on hello, `false` on budget expiry.
pub async fn wait_for_hello(socket_path: &Path, budget_ms: u64) -> Option<UpdateProcessIdentity> {
    let deadline = Instant::now() + Duration::from_millis(budget_ms.max(1));
    loop {
        if let Ok((client, _events)) =
            pa_tui::daemon_client::DaemonClient::connect(socket_path).await
        {
            let identity = identity_from_hello(client.hello());
            client.close();
            return Some(identity);
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        // The retry poll never steps past the budget: a silent socket is
        // waited out to the deadline (TS `waitForHello` bounds the whole
        // handshake wait, not one retry slice).
        tokio::time::sleep(BOOT_POLL.min(deadline - now)).await;
    }
}

/// Wait for a process identity to leave the process table (spec §9
/// `Stopped`: the fence-free pid + start-id poll).
pub async fn wait_for_exit(identity: &UpdateProcessIdentity, budget_ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(budget_ms.max(1));
    loop {
        let Ok(alive) = pa_daemon::lease::is_process_alive(identity.pid as u32) else {
            return true;
        };
        let start_id_matches = match &identity.process_start_id {
            None => true,
            Some(expected) => {
                matches!(
                    pa_daemon::lease::get_process_start_id(identity.pid as u32),
                    Some(observed) if &observed == expected
                )
            }
        };
        if !alive || !start_id_matches {
            return true;
        }
        if Instant::now() + BOOT_POLL >= deadline {
            return false;
        }
        tokio::time::sleep(BOOT_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use serde_json::json;

    #[test]
    fn identity_maps_the_hello_frame_fields() {
        let identity = identity_from_hello(&json!({
            "supervisorPid": 42,
            "supervisorProcessStartId": "42/7",
            "supervisorGeneration": "sup:42",
            "supervisorOwnerToken": "tok",
        }));
        assert_eq!(identity.pid, 42);
        assert_eq!(identity.process_start_id.as_deref(), Some("42/7"));
        assert_eq!(identity.supervisor_generation.as_deref(), Some("sup:42"));
        assert_eq!(identity.supervisor_owner_token.as_deref(), Some("tok"));
    }

    #[tokio::test]
    async fn waiting_for_a_dead_identity_returns_immediately() {
        let identity = UpdateProcessIdentity {
            pid: 4_000_000,
            process_start_id: None,
            supervisor_generation: None,
            supervisor_owner_token: None,
            rest: Default::default(),
        };
        assert!(wait_for_exit(&identity, 1_000).await);
    }

    #[tokio::test]
    async fn hello_wait_times_out_on_a_silent_socket() {
        let dir = tempfile::tempdir().unwrap();
        let socket: PathBuf = dir.path().join("silent.sock");
        let started = Instant::now();
        // The budget spans at least one poll: the loop gives up when the
        // next poll would overshoot the deadline, so the elapsed time is
        // poll-granular - never shorter than one poll, never past two.
        let identity = wait_for_hello(&socket, (BOOT_POLL * 2).as_millis() as u64).await;
        assert!(identity.is_none());
        assert!(started.elapsed() >= BOOT_POLL);
    }
}
