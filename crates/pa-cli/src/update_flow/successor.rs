//! The successor supervisor seam (spec §4 `Booting`): spawn the new (or
//! rollback) binary from its release dir, pass the roster through the one
//! env the boot sweep reads, wait for the `daemon_hello` that carries the
//! successor identity, and validate it (TS `validateReplacementDaemon`: a
//! wrong daemon answering the socket fails the update, never passes as
//! the successor). The adopted successor is pinned to the process this
//! coordinator spawned (pid + process start id, [`SpawnedSuccessor`]): a
//! third-party daemon that wins the release-to-spawn bind race is
//! skipped by the hello wait and refused by the validation, so it can
//! never be adopted - the update fails closed into its rollback instead.

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

/// The spawned successor's pinned process identity: the pid
/// `spawn_supervisor` returned plus the process start id captured off the
/// process table right after the spawn - the same pid-reuse identity the
/// successor's own hello reports as `supervisorProcessStartId`, so a
/// hello can be bound to the one process this update spawned. A `None`
/// start id is the honest fallback: the platform exposes no identity, or
/// the child exited before the capture could read it - the pin then
/// matches the pid alone, and a Linux pid cannot recycle within a boot
/// budget (the kernel allocates pids sequentially and must lap the whole
/// pid space to reuse one), while a dead child never greets at all.
pub struct SpawnedSuccessor {
    /// The spawned child's pid.
    pub pid: u64,
    /// The spawned child's process start id, when captured.
    pub process_start_id: Option<String>,
}

/// Pin the freshly spawned successor to its process identity (call right
/// after [`spawn_supervisor`] returns): the start id is read off the
/// process table while the child is still the process this coordinator
/// created, so every hello later adopted is bound to that one child.
#[must_use]
pub fn capture_spawned_successor(pid: u64) -> SpawnedSuccessor {
    SpawnedSuccessor {
        pid,
        process_start_id: pa_types::platform::process::process_start_id(pid as u32),
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
/// A third divergence, hardening in the same spirit as kill.rs's
/// `forceKillDaemon`, hardened verdict: TS's coordinator never spawns the
/// successor itself (`ensureInteractiveDaemonRunning` adopts whatever
/// current-version daemon already answers the socket), so TS's validation
/// can only read the hello's own fields; the Rust port spawns the child,
/// so [`SpawnedSuccessor`] pins the winner to it - the hello's pid (and
/// start id, when captured) must be the spawned child's, never just any
/// daemon with the right version, socket, and fence.
///
/// # Errors
/// Returns an error when the hello fails the version identity, names
/// another socket, carries no supervisor identity fence, still wears the
/// predecessor's identity, or did not come from the update's spawn.
pub fn validate_replacement_daemon(
    socket_path: &Path,
    hello: &Value,
    expected_app_version: &str,
    predecessor: Option<&UpdateProcessIdentity>,
    spawned: &SpawnedSuccessor,
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
    // The spawn pin (the port's hardening divergence, documented above):
    // the answering daemon must be the process this coordinator spawned,
    // so a same-version third-party daemon that won the bind race is
    // refused even when its hello is otherwise indistinguishable from the
    // intended successor's. When the child's start id was captured, the
    // hello's must match it too - a claim on a recycled pid, or a hello
    // stripped of the start id, cannot pass as the child.
    if successor.pid != spawned.pid
        || spawned
            .process_start_id
            .as_ref()
            .is_some_and(|expected| successor.process_start_id.as_ref() != Some(expected))
    {
        bail!(
            "Replacement daemon on {} did not come from the update's spawn",
            socket_path.display()
        );
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
/// (spec §9 `Booting`): the raw `daemon_hello` frame of the spawned child
/// (`spawned`), `None` on budget expiry. The frame is the caller's to
/// validate ([`validate_replacement_daemon`]): whatever answers the
/// socket must prove itself the intended successor before it is adopted.
///
/// The wait is pinned to the spawned child (the same hardening
/// divergence as [`validate_replacement_daemon`]'s spawn pin: TS's
/// `waitForHello` returns whichever daemon answers because TS's
/// coordinator never spawns the successor): a hello whose
/// `supervisorPid` is not the spawned child's is skipped, never adopted -
/// it is a third-party daemon that won the release-to-spawn bind race,
/// and the wait goes on to the budget. A non-matching daemon that holds
/// the socket means OUR child could not bind and will never greet, so the
/// budget expires and the update fails honestly into its rollback path -
/// the intended fail-closed semantics of the release-to-spawn seam.
pub async fn wait_for_hello(
    socket_path: &Path,
    budget_ms: u64,
    spawned: &SpawnedSuccessor,
) -> Option<Value> {
    let deadline = Instant::now() + Duration::from_millis(budget_ms.max(1));
    loop {
        if let Ok((client, _events)) =
            pa_tui::daemon_client::DaemonClient::connect(socket_path).await
        {
            let hello = client.hello().clone();
            client.close();
            // The spawned child's pid decides adoption: a foreign pid is
            // skipped so the wait goes on (the child greets if it won the
            // bind; nothing else ever gets adopted).
            if identity_from_hello(&hello).pid == spawned.pid {
                return Some(hello);
            }
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
        let hello = wait_for_hello(
            &socket,
            (BOOT_POLL * 2).as_millis() as u64,
            &spawned_successor(),
        )
        .await;
        assert!(hello.is_none());
        assert!(started.elapsed() >= BOOT_POLL);
    }

    /// A stub daemon answering every connection with a `daemon_hello`
    /// whose supervisor pid follows the scripted sequence - first the
    /// third-party daemon that won the bind race, then the spawned child -
    /// the handshake shape `DaemonClient::connect` negotiates with the
    /// real supervisor (supervisor/clients.rs `DaemonHello`).
    #[cfg(unix)]
    #[tokio::test]
    async fn hello_wait_skips_a_foreign_daemon_and_returns_the_spawned_child() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        use tokio::io::AsyncWriteExt;
        use tokio::net::UnixListener;

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("stub.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let pids = [80_080u64, 42_42];
        let served = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&served);
        let stub = tokio::spawn(async move {
            let mut served = 0usize;
            while let Ok((mut stream, _)) = listener.accept().await {
                let pid = pids.get(served).copied().unwrap_or(pids[1]);
                let hello = json!({
                    "type": "daemon_hello",
                    "protocol": { "name": "prime-agent.daemon", "version": 7 },
                    "supervisorPid": pid,
                });
                let mut line = serde_json::to_string(&hello).unwrap();
                line.push('\n');
                let _ = stream.write_all(line.as_bytes()).await;
                served += 1;
                counter.store(served, Ordering::SeqCst);
            }
        });
        let hello = wait_for_hello(&socket, 5_000, &spawned_successor())
            .await
            .expect("the spawned child greets within the budget");
        assert_eq!(
            hello.get("supervisorPid").and_then(Value::as_u64),
            Some(42_42)
        );
        // The foreign daemon greeted first and was skipped, never
        // adopted: the matching hello is at least the second one served.
        assert!(served.load(Ordering::SeqCst) >= 2);
        stub.abort();
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

    /// The child the coordinator spawned and pinned right after the spawn:
    /// the fixture hello's own 4242/7 identity, so the accepted-hello
    /// tests pass the spawn pin and the refusal tests mutate it.
    fn spawned_successor() -> SpawnedSuccessor {
        SpawnedSuccessor {
            pid: 4242,
            process_start_id: Some("4242/7".to_string()),
        }
    }

    #[test]
    fn a_candidate_hello_with_a_fresh_identity_is_accepted() {
        let identity = validate_replacement_daemon(
            Path::new("/tmp/prime.sock"),
            &successor_hello(),
            "9.9.9",
            Some(&predecessor_identity()),
            &spawned_successor(),
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
            &spawned_successor(),
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
            &spawned_successor(),
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
            &spawned_successor(),
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
            &spawned_successor(),
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("Replacement daemon is v9.9.8"));
        assert!(message.contains("expected v9.9.9"));
    }

    #[test]
    fn a_hello_from_a_foreign_daemon_is_rejected() {
        // The bind race's winner: right version, right socket, right fence -
        // but a pid that is not the child this coordinator spawned.
        let error = validate_replacement_daemon(
            Path::new("/tmp/prime.sock"),
            &successor_hello(),
            "9.9.9",
            Some(&predecessor_identity()),
            &SpawnedSuccessor {
                pid: 5150,
                process_start_id: Some("5150/3".to_string()),
            },
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("did not come from the update's spawn"));
    }

    #[test]
    fn a_hello_with_the_spawned_pid_but_a_recycled_start_id_is_rejected() {
        // The pid axis alone does not pass the pin once the start id was
        // captured: a recycled pid wears a different start id.
        let mut hello = successor_hello();
        hello["supervisorProcessStartId"] = json!("4242/8");
        let error = validate_replacement_daemon(
            Path::new("/tmp/prime.sock"),
            &hello,
            "9.9.9",
            Some(&predecessor_identity()),
            &spawned_successor(),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("did not come from the update's spawn"));
    }

    #[test]
    fn an_uncaptured_start_id_pins_the_pid_alone() {
        // The child exited before the capture could read its start id (or
        // the platform has none): the pin trusts the pid alone - the
        // disclosed pid-recycling call.
        let identity = validate_replacement_daemon(
            Path::new("/tmp/prime.sock"),
            &successor_hello(),
            "9.9.9",
            Some(&predecessor_identity()),
            &SpawnedSuccessor {
                pid: 4242,
                process_start_id: None,
            },
        )
        .unwrap();
        assert_eq!(identity.pid, 4242);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn the_spawn_capture_pins_a_live_childs_start_id() {
        // The coordinator's own pid is a live process: the capture pins
        // pid plus start id - the exact identity the child's own hello
        // reports (the same platform helper both read).
        let spawned = capture_spawned_successor(u64::from(std::process::id()));
        assert_eq!(spawned.pid, u64::from(std::process::id()));
        assert!(spawned.process_start_id.is_some());
    }

    #[test]
    fn the_spawn_capture_of_an_exited_child_falls_back_to_the_pid() {
        // A pid nothing owns (the dead-identity fixture's 4,000,000): the
        // capture reads no start id and the pin trusts the pid alone.
        let spawned = capture_spawned_successor(4_000_000);
        assert_eq!(spawned.pid, 4_000_000);
        assert!(spawned.process_start_id.is_none());
    }
}
