//! Worker orphan-exit e2e (TS `exitIfSupervisorOrphanedForTooLong` parity):
//! a session worker whose supervisor socket never answers must exit on the
//! supervisor-lost window, and a worker whose supervisor is reachable must
//! survive the same window.
#![cfg(unix)]

use std::io::Write as _;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct WorkerGuard {
    child: Child,
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The real `pa-daemon worker` under a supervisor socket it must monitor,
/// with the lost-exit window at zero (exit at the first availability check
/// that cannot connect).
fn spawn_worker(dir: &Path, supervisor_socket: &Path) -> WorkerGuard {
    spawn_worker_with_window(dir, supervisor_socket, "0")
}

fn spawn_worker_with_window(
    dir: &Path,
    supervisor_socket: &Path,
    lost_exit_ms: &str,
) -> WorkerGuard {
    std::fs::create_dir_all(dir.join("agent")).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("worker")
        .env(pa_daemon::worker::WORKER_ROLE_ENV, "1")
        .env(
            pa_daemon::worker::WORKER_TOKEN_ENV,
            "orphan-e2e-bootstrap-token",
        )
        .env(
            pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
            "orphan-e2e-session",
        )
        .env(
            pa_daemon::worker::WORKER_SOCKET_ENV,
            dir.join("worker.sock"),
        )
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
            supervisor_socket,
        )
        .env(
            pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
            dir.join("recovery.jsonl"),
        )
        .env("PRIME_AGENT_CODING_AGENT_DIR", dir.join("agent"))
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            lost_exit_ms,
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon worker");
    WorkerGuard { child }
}

fn wait_worker_socket(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !socket.exists() {
        assert!(Instant::now() < deadline, "worker socket never appeared");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_exit(child: &mut Child, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(status) = child.try_wait().expect("poll worker") {
            assert!(status.success(), "worker exited with {status}");
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn orphaned_worker_exits_when_the_supervisor_socket_never_answers() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    // A supervisor socket nobody ever bound.
    let supervisor_socket = dir.path().join("never-bound-supervisor.sock");
    let mut worker = spawn_worker(dir.path(), &supervisor_socket);
    wait_worker_socket(&dir.path().join("worker.sock"));
    assert!(
        wait_exit(&mut worker.child, Duration::from_secs(15)),
        "the orphaned worker exited on the supervisor-lost window"
    );
    // The TS graceful exit owns its socket file: the orphan exit removes
    // it, so a respawn does not wait out the stale-socket path.
    assert!(
        !dir.path().join("worker.sock").exists(),
        "the exited worker removed its socket file"
    );
}

#[test]
fn worker_with_a_reachable_supervisor_survives_the_lost_window() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let supervisor_socket = dir.path().join("live-supervisor.sock");
    let listener = UnixListener::bind(&supervisor_socket).expect("bind supervisor socket");
    let mut worker = spawn_worker(dir.path(), &supervisor_socket);
    wait_worker_socket(&dir.path().join("worker.sock"));
    // Past the first availability check (1.5s) with margin: the reachable
    // supervisor resets the absence timer every check, so the same zero
    // window that exits the orphan case must leave this worker alive.
    std::thread::sleep(Duration::from_secs(4));
    let exited = worker.child.try_wait().expect("poll worker").is_some();
    assert!(
        !exited,
        "the worker survived the lost window while its supervisor answered"
    );
    drop(listener);
}

struct WorkerClient {
    stream: std::os::unix::net::UnixStream,
}

impl WorkerClient {
    fn connect(socket: &Path, token: &str) -> Self {
        let stream = std::os::unix::net::UnixStream::connect(socket).expect("connect worker");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        let mut client = WorkerClient { stream };
        let (header, _payload) = client.read_frame();
        assert_eq!(header["outboundType"], "daemon_hello", "worker hello");
        let auth = client.request(
            "worker_auth",
            &serde_json::json!({
                "token": token,
                "supervisorGeneration": "sup:orphan-lease-e2e",
                "supervisorPid": 1,
                "supervisorSocketPath": "/nonexistent/supervisor.sock",
            }),
        );
        assert_eq!(auth["success"], true, "worker auth failed: {auth}");
        client
    }

    fn send_frame(&mut self, header: &serde_json::Value, payload: &serde_json::Value) {
        let frame = pa_daemon::framing::encode_private_frame(
            header,
            &serde_json::to_vec(payload).expect("payload"),
            pa_daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .expect("encode frame");
        self.stream.write_all(&frame).expect("write frame");
        self.stream.flush().expect("flush");
    }

    fn request(&mut self, command_type: &str, payload: &serde_json::Value) -> serde_json::Value {
        let request_id = format!("req-{command_type}");
        self.send_frame(
            &serde_json::json!({
                "kind": "command",
                "requestId": request_id,
                "commandType": command_type,
            }),
            payload,
        );
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no response for {command_type}");
            let (header, body) = self.read_frame();
            if header["outboundType"].as_str() == Some("response")
                && header["requestId"].as_str() == Some(&request_id)
            {
                return serde_json::from_slice(&body).expect("response body");
            }
        }
    }

    fn read_frame(&mut self) -> (serde_json::Value, Vec<u8>) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut prefix = [0u8; 8];
        read_exact_timeout(&mut self.stream, &mut prefix, deadline);
        let header_len = u32::from_be_bytes(prefix[0..4].try_into().unwrap()) as usize;
        let payload_len = u32::from_be_bytes(prefix[4..8].try_into().unwrap()) as usize;
        let mut header = vec![0u8; header_len];
        read_exact_timeout(&mut self.stream, &mut header, deadline);
        let mut payload = vec![0u8; payload_len];
        read_exact_timeout(&mut self.stream, &mut payload, deadline);
        let header: serde_json::Value = serde_json::from_slice(&header).expect("frame header");
        (header, payload)
    }
}

fn read_exact_timeout(
    stream: &mut std::os::unix::net::UnixStream,
    buffer: &mut [u8],
    deadline: Instant,
) {
    use std::io::Read as _;
    let mut read = 0usize;
    while read < buffer.len() {
        assert!(Instant::now() < deadline, "worker frame read timed out");
        match stream.read(&mut buffer[read..]) {
            Ok(0) => panic!("worker closed the connection mid-frame"),
            Ok(n) => read += n,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => panic!("worker read: {error}"),
        }
    }
}

#[test]
fn the_orphan_exit_preserves_the_session_and_allows_dead_owner_lease_reclaim() {
    let dir = tempfile::tempdir().expect("temp dir");
    let canonical_dir = std::fs::canonicalize(dir.path()).expect("canonical dir");
    let supervisor_socket = dir.path().join("never-bound-supervisor.sock");
    let mut worker = spawn_worker_with_window(dir.path(), &supervisor_socket, "4000");
    let worker_socket = dir.path().join("worker.sock");
    wait_worker_socket(&worker_socket);
    let session_file = canonical_dir.join("orphan-lease-session.jsonl");
    let mut client = WorkerClient::connect(&worker_socket, "orphan-e2e-bootstrap-token");
    let created = client.request(
        "create",
        &serde_json::json!({"sessionPath": session_file.to_string_lossy()}),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    drop(client);

    let session_leases = dir.path().join("agent").join("session-leases");
    let session_path_key = session_file.to_string_lossy().to_string();
    let held_lease = std::fs::read_dir(&session_leases)
        .expect("session-leases directory")
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            std::fs::read_to_string(path.join("owner.json"))
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .and_then(|owner| owner["sessionPath"].as_str().map(str::to_string))
                == Some(session_path_key.clone())
        })
        .unwrap_or_else(|| panic!("no session lease for {session_path_key}"));

    assert!(
        wait_exit(&mut worker.child, Duration::from_secs(30)),
        "the orphaned worker exited on the supervisor-lost window"
    );
    assert!(
        held_lease.exists(),
        "process exit retains the dead-owner lease for safe reclamation"
    );
    let reopened = pa_daemon::lease::acquire_runtime_session_lease(
        &session_file,
        &dir.path().join("agent"),
    )
    .expect("a new owner can reclaim the lease after the worker exited");
    reopened.release();
    assert!(!held_lease.exists(), "the new owner released its lease");
    assert!(
        session_file.exists(),
        "the session file survives the lease release"
    );
}
