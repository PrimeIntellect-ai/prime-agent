//! The successor supervisor seam (spec §4 `Booting`): spawn the new (or
//! rollback) binary from its release dir, pass the roster through the one
//! env the boot sweep reads, wait for the `daemon_hello` that carries the
//! successor identity, and validate it (TS `validateReplacementDaemon`: a
//! wrong daemon answering the socket fails the update, never passes as
//! the successor).

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
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
        rest: serde_json::Map::default(),
    }
}

/// Validate the successor's `daemon_hello` (TS package-manager-cli.ts
/// `validateReplacementDaemon`): the daemon that answers the socket after
/// the stop-window release must be the activated successor - a surviving
/// predecessor or a stale third-party daemon that won the cold-boot race
/// fails the update instead of being accepted blindly. Returns the
/// validated successor identity.
///
/// Two ported divergences, both forced by the Rust coordinator being the
/// OLD binary (TS's coordinator IS the new one, so it compares against its
/// own `VERSION` and constants): the strict version expectation is the
/// activated release's `expected_app_version` (the candidate the main flow
/// validated by probe, the rollback installation the failure flow
/// spawns), and the protocol version plus schema id are presence-checked
/// rather than pinned - `DaemonClient::connect` already negotiates the
/// shared protocol minimum, and strict-equal against this build's
/// `DAEMON_PROTOCOL_VERSION`/`DAEMON_SCHEMA_ID` would refuse every
/// protocol-advancing successor.
///
/// # Errors
/// Returns an error when the hello fails the version identity, names
/// another socket, carries no supervisor identity fence, or still wears
/// the predecessor's identity.
pub fn validate_replacement_daemon(
    socket_path: &Path,
    hello: &Value,
    expected_app_version: &str,
    predecessor: Option<&UpdateProcessIdentity>,
) -> Result<UpdateProcessIdentity> {
    let app_version = hello.get("appVersion").and_then(Value::as_str);
    let schema_id = hello.get("schemaId").and_then(Value::as_str);
    if app_version != Some(expected_app_version) || schema_id.is_none() {
        let protocol_version = hello
            .get("protocol")
            .and_then(|protocol| protocol.get("version"))
            .and_then(Value::as_u64)
            .map_or_else(|| "unknown".to_string(), |version| version.to_string());
        bail!(
            "Replacement daemon is v{}/proto{}/schema {}, expected v{expected_app_version}",
            app_version.unwrap_or("unknown"),
            protocol_version,
            schema_id.unwrap_or("legacy"),
        );
    }
    // TS requires the hello's own `supervisorSocketPath` (the daemon always
    // emits it; the generic `socketPath` field is not an acceptable
    // stand-in), normalize-compared so an alias of the requested socket
    // still matches.
    let hello_socket_path = hello
        .get("supervisorSocketPath")
        .and_then(Value::as_str)
        .filter(|hello_socket_path| {
            pa_daemon::supervisor_ownership::normalize_socket_path(Path::new(hello_socket_path))
                == pa_daemon::supervisor_ownership::normalize_socket_path(socket_path)
        });
    if hello_socket_path.is_none() {
        bail!(
            "Replacement daemon identity does not match {}",
            socket_path.display()
        );
    }
    let successor = identity_from_hello(hello);
    if successor.supervisor_generation.is_none() || successor.supervisor_owner_token.is_none() {
        bail!(
            "Replacement daemon on {} did not provide an identity fence",
            socket_path.display()
        );
    }
    // TS's exact shape: a predecessor field rejects only when it is set
    // and the successor carries the same one, and the pid axis requires
    // the start id, so a recycled pid can never impersonate the
    // predecessor.
    if let Some(predecessor) = predecessor {
        let same_generation = predecessor
            .supervisor_generation
            .as_ref()
            .is_some_and(|expected| successor.supervisor_generation.as_ref() == Some(expected));
        let same_owner_token = predecessor
            .supervisor_owner_token
            .as_ref()
            .is_some_and(|expected| successor.supervisor_owner_token.as_ref() == Some(expected));
        let same_process = successor.pid == predecessor.pid
            && predecessor
                .process_start_id
                .as_ref()
                .is_some_and(|expected| successor.process_start_id.as_ref() == Some(expected));
        if same_generation || same_owner_token || same_process {
            bail!(
                "Replacement daemon on {} still has the predecessor identity",
                socket_path.display()
            );
        }
    }
    Ok(successor)
}

/// Spawn the successor supervisor detached (the TS launcher deletes the
/// worker role env from the inherited environment; the roster path is the
/// one addition, spec §6).
///
/// # Errors
/// Returns an error when the successor supervisor process cannot be
/// spawned.
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
    #[cfg(unix)]
    pa_core::platform::process::set_new_session(&mut command);
    #[cfg(not(unix))]
    pa_core::platform::process::set_new_process_group(&mut command);
    let child = command
        .spawn()
        .with_context(|| format!("spawn the successor supervisor from {}", exe.display()))?;
    Ok(u64::from(child.id()))
}

/// Connect and complete the `daemon_hello` handshake, bounded by `budget_ms`
/// (spec §9 `Booting`): the raw `daemon_hello` frame on hello, `None` on
/// budget expiry. The frame is the caller's to validate
/// ([`validate_replacement_daemon`]): whatever answers the socket must
/// prove itself the intended successor before it is adopted.
pub async fn wait_for_hello(socket_path: &Path, budget_ms: u64) -> Option<Value> {
    let deadline = Instant::now() + Duration::from_millis(budget_ms.max(1));
    loop {
        if let Ok((client, _events)) =
            pa_tui::daemon_client::DaemonClient::connect(socket_path).await
        {
            let hello = client.hello().clone();
            client.close();
            return Some(hello);
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
            rest: serde_json::Map::default(),
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
        let hello = wait_for_hello(&socket, (BOOT_POLL * 2).as_millis() as u64).await;
        assert!(hello.is_none());
        assert!(started.elapsed() >= BOOT_POLL);
    }

    /// A successor hello in the daemon's own shape (supervisor/clients.rs
    /// `DaemonHello`); the validation tests mutate the field under test.
    fn successor_hello() -> Value {
        json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "schemaId": "protocol-7-schema-30-8e4b17c2a9f5",
            "appVersion": "9.9.9",
            "supervisorPid": 4242,
            "supervisorProcessStartId": "4242/7",
            "supervisorGeneration": "sup:4242",
            "supervisorOwnerToken": "successor-token",
            "supervisorSocketPath": "/tmp/prime.sock",
        })
    }

    fn predecessor_identity() -> UpdateProcessIdentity {
        UpdateProcessIdentity {
            pid: 1717,
            process_start_id: Some("1717/9".to_string()),
            supervisor_generation: Some("sup:1717".to_string()),
            supervisor_owner_token: Some("predecessor-token".to_string()),
            rest: serde_json::Map::default(),
        }
    }

    #[test]
    fn a_candidate_hello_with_a_fresh_identity_is_accepted() {
        let identity = validate_replacement_daemon(
            Path::new("/tmp/prime.sock"),
            &successor_hello(),
            "9.9.9",
            Some(&predecessor_identity()),
        )
        .unwrap();
        assert_eq!(identity.pid, 4242);
        assert_eq!(identity.process_start_id.as_deref(), Some("4242/7"));
        assert_eq!(identity.supervisor_generation.as_deref(), Some("sup:4242"));
        assert_eq!(
            identity.supervisor_owner_token.as_deref(),
            Some("successor-token")
        );
    }

    #[test]
    fn a_predecessor_identity_hello_is_rejected() {
        // A surviving predecessor answers the socket with the very
        // identity it had at the stop (generation, owner token, and pid +
        // start id alike).
        let mut hello = successor_hello();
        hello["supervisorGeneration"] = json!("sup:1717");
        hello["supervisorOwnerToken"] = json!("predecessor-token");
        hello["supervisorPid"] = json!(1717);
        hello["supervisorProcessStartId"] = json!("1717/9");
        let error = validate_replacement_daemon(
            Path::new("/tmp/prime.sock"),
            &hello,
            "9.9.9",
            Some(&predecessor_identity()),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("still has the predecessor identity"));
    }

    #[test]
    fn a_hello_without_the_identity_fence_is_rejected() {
        let mut hello = successor_hello();
        hello
            .as_object_mut()
            .unwrap()
            .remove("supervisorGeneration");
        hello
            .as_object_mut()
            .unwrap()
            .remove("supervisorOwnerToken");
        let error = validate_replacement_daemon(
            Path::new("/tmp/prime.sock"),
            &hello,
            "9.9.9",
            Some(&predecessor_identity()),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("did not provide an identity fence"));
    }

    #[test]
    fn a_hello_for_another_socket_is_rejected() {
        let mut hello = successor_hello();
        hello["supervisorSocketPath"] = json!("/tmp/another.sock");
        let error = validate_replacement_daemon(
            Path::new("/tmp/prime.sock"),
            &hello,
            "9.9.9",
            Some(&predecessor_identity()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("identity does not match"));
    }

    #[test]
    fn a_hello_with_the_wrong_app_version_is_rejected() {
        let mut hello = successor_hello();
        hello["appVersion"] = json!("9.9.8");
        let error = validate_replacement_daemon(
            Path::new("/tmp/prime.sock"),
            &hello,
            "9.9.9",
            Some(&predecessor_identity()),
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("Replacement daemon is v9.9.8"));
        assert!(message.contains("expected v9.9.9"));
    }
}
