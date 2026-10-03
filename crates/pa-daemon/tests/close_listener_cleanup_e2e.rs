//! Poisoned-capture exit oracles (the #3291 residual, the registered
//! follow-up this lane closes): the bind-time identity capture sits AFTER
//! the bind it guards - a replacement landing in the MICROSECOND
//! bind->capture window poisons the capture (it stores the successor's
//! file identity as the owner's own), and the poisoned identity gate
//! later unlinks the SUCCESSOR'S live socket at the owner's exit. The
//! replacement-window direction (a replacement landing after the
//! capture) is pinned by `socket_identity_guard_e2e`; these oracles pin
//! the poisoned direction at the two process shapes whose exit paths
//! run the gate:
//!
//! * the worker's routed `shutdown` (`worker.rs` `exit_after_close`), and
//! * the supervisor's SIGTERM graceful drain (`supervisor.rs` `run`'s
//!   tail; the worker's orphan exit shares the same cleanup choreography).
//!
//! The fix's shape is the TS graceful-shutdown precedent: TS awaits
//! `server.close()` FIRST and cleans the socket path after
//! (daemon-mode.ts:8011-8018, and the supervisor's
//! daemon-supervisor.ts:7436-7491 awaits its "daemon server" close step
//! before its "daemon socket" cleanup step). The Rust port ran all three
//! exit cleanups with the owner's listener still live, which is why a
//! cleanup-side liveness probe was ruled out there (it would refuse the
//! still-ours unlink too); once the listener closes first, a LIVE
//! listener at the path can only be a successor's, so the probe-then-gate
//! cleanup never removes a live socket even under a poisoned capture.
//!
//! The poisoning is made deterministic with the bind-capture gap seam
//! (`PA_DAEMON_BIND_CAPTURE_GAP_MS`, the `PA_DAEMON_EVENT_LOG` seam
//! family): the oracle parks the owner between its bind and its capture
//! with the successor bound at the path, so the capture provably stores
//! the successor's identity (the same file the race would poison, no
//! timing luck involved). The owner is then driven through its REAL exit
//! path - the routed `shutdown` reply, the SIGTERM graceful drain - and
//! the successor's live socket must survive.
//!
//! On this tree the oracles fail: the poisoned gate matches the
//! successor's live file and unlinks it. The fix rides the next commit.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The bind-capture gap the oracles set: wide enough that the replacement
/// provably lands inside the window, small enough to keep the oracle fast.
const BIND_CAPTURE_GAP_MS: &str = "2000";

/// The filesystem identity the gate compares: dev + ino of the file
/// currently at the path.
fn socket_identity(path: &Path) -> (u64, u64) {
    let metadata = std::fs::symlink_metadata(path).expect("stat socket file");
    (metadata.dev(), metadata.ino())
}

/// Move the bound socket file aside, returning the aside path: the bound
/// listener keeps serving through the rename (the kernel tracks the inode,
/// not the name), so the oracle can still drive the owner through its
/// real exit path while the successor owns the original path.
fn rename_bound_socket_aside(socket: &Path) -> PathBuf {
    let aside: PathBuf = socket.parent().expect("socket parent").join(format!(
        "{}.poisoned-aside",
        socket
            .file_name()
            .expect("socket file name")
            .to_string_lossy()
    ));
    std::fs::rename(socket, &aside).expect("rename the bound socket file aside");
    aside
}

/// Bind the successor at the owner's original path while the owner's own
/// capture is still pending: the capture then reads THIS file's identity
/// as the owner's own - the poisoned state the microsecond race
/// produces. The original inode stays allocated (renamed aside), so the
/// identities provably differ.
fn bind_poisoning_successor(socket: &Path) -> (UnixListener, (u64, u64)) {
    let successor = UnixListener::bind(socket).expect("bind the poisoning successor");
    let identity = socket_identity(socket);
    (successor, identity)
}

/// A live successor's socket must answer connects after the poisoned
/// owner's exit: the file survived AND it still serves.
fn assert_successor_serves(socket: &Path, identity: (u64, u64)) {
    assert!(
        socket.exists(),
        "the successor's live socket survived the poisoned owner's exit"
    );
    assert_eq!(
        socket_identity(socket),
        identity,
        "the file at the path is still the successor's, not a new file"
    );
    let connect = UnixStream::connect(socket).expect("the successor socket still accepts");
    drop(connect);
}

/// Kill a leftover process at scope exit (the oracle children exit on
/// their own; this is the teardown safety net).
struct ProcessGuard {
    child: Child,
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Wait until the child exits on its own within `budget`, asserting a
/// clean exit: the exit paths under test end in `std::process::exit(0)`
/// (or a graceful supervisor return), so a signal death or a nonzero
/// exit means the wrong path ran.
fn wait_clean_exit(child: &mut Child, budget: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(status) = child.try_wait().expect("poll child") {
            assert!(
                status.success(),
                "the exit path must end in a clean exit 0, not {status}"
            );
            return status;
        }
        assert!(Instant::now() < deadline, "the child did not exit");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn wait_socket_file(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !socket.exists() {
        assert!(Instant::now() < deadline, "socket file never appeared");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> ProcessGuard {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        // Hermetic agent dir: the ambient environment may export a real
        // agent dir; point every fallback at the test sandbox instead.
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env_remove("PA_API_KEY")
        .env(pa_daemon::socket::BIND_CAPTURE_GAP_ENV, BIND_CAPTURE_GAP_MS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon supervisor");
    ProcessGuard { child }
}

/// Spawn the real `pa-daemon worker` binary on its own socket, monitoring
/// a supervisor socket that never answers, with the bind-capture gap armed
/// so the oracle can poison the worker's capture.
fn spawn_worker(dir: &Path, socket: &Path, token: &str) -> ProcessGuard {
    std::fs::create_dir_all(dir.join("agent")).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("worker")
        .env(pa_daemon::worker::WORKER_ROLE_ENV, "1")
        .env(pa_daemon::worker::WORKER_TOKEN_ENV, token)
        .env(
            pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
            "poisoned-capture",
        )
        .env(pa_daemon::worker::WORKER_SOCKET_ENV, socket)
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
            dir.join("absent-supervisor.sock"),
        )
        .env(
            pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
            dir.join("recovery.jsonl"),
        )
        .env("PRIME_AGENT_CODING_AGENT_DIR", dir.join("agent"))
        .env(pa_daemon::socket::BIND_CAPTURE_GAP_ENV, BIND_CAPTURE_GAP_MS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon worker");
    ProcessGuard { child }
}

/// Read one JSONL line from the supervisor's aside socket within the
/// deadline: a served hello proves the supervisor's accept loop (and so
/// the capture before it) has completed - the poisoned state is armed.
fn supervisor_hello_line(socket: &Path) -> Value {
    let stream = UnixStream::connect(socket).expect("connect the supervisor aside socket");
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set timeout");
    let mut reader = BufReader::new(stream);
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut line = String::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "the poisoned supervisor never served its hello"
        );
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => {
                line.clear();
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(_) => return serde_json::from_str(&line).expect("hello line"),
        }
    }
}

/// A raw private-frame client for the worker's aside socket (the same
/// wire the supervisor's request pump speaks).
struct WorkerClient {
    stream: UnixStream,
}

impl WorkerClient {
    fn connect(socket: &Path, token: &str) -> Self {
        let stream = UnixStream::connect(socket).expect("connect the worker aside socket");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        let mut client = WorkerClient { stream };
        let (header, _payload) = client.read_frame();
        assert_eq!(header["outboundType"], "daemon_hello", "worker hello");
        // The supervisor role both arms the routed `shutdown` arm and
        // disarms the orphan monitor (claims > 0), so the exit below is
        // `exit_after_close` alone.
        let auth = client.request(
            "worker_auth",
            &json!({
                "token": token,
                "supervisorGeneration": "sup:poisoned-capture",
                "supervisorPid": 1,
                "supervisorSocketPath": "/nonexistent/supervisor.sock",
            }),
        );
        assert_eq!(auth["success"], true, "worker auth failed: {auth}");
        client
    }

    fn send_frame(&mut self, header: &Value, payload: &Value) {
        let frame = pa_daemon::framing::encode_private_frame(
            header,
            &serde_json::to_vec(payload).expect("payload"),
            pa_daemon::framing::DEFAULT_PRIVATE_FRAME_LIMITS,
        )
        .expect("encode frame");
        self.stream.write_all(&frame).expect("write frame");
        self.stream.flush().expect("flush");
    }

    fn request(&mut self, command_type: &str, payload: &Value) -> Value {
        let request_id = format!("req-{command_type}");
        self.send_frame(
            &json!({
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

    fn read_frame(&mut self) -> (Value, Vec<u8>) {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut prefix = [0u8; 8];
        read_exact_timeout(&mut self.stream, &mut prefix, deadline);
        let header_len = u32::from_be_bytes(prefix[0..4].try_into().unwrap()) as usize;
        let payload_len = u32::from_be_bytes(prefix[4..8].try_into().unwrap()) as usize;
        let mut header = vec![0u8; header_len];
        read_exact_timeout(&mut self.stream, &mut header, deadline);
        let mut payload = vec![0u8; payload_len];
        read_exact_timeout(&mut self.stream, &mut payload, deadline);
        let header: Value = serde_json::from_slice(&header).expect("frame header");
        (header, payload)
    }
}

fn read_exact_timeout(stream: &mut UnixStream, buffer: &mut [u8], deadline: Instant) {
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

/// The poisoned worker's routed shutdown: a replacement bound at the path
/// inside the worker's bind->capture window poisons the captured
/// identity, the worker's real exit path runs, and the successor's LIVE
/// socket at the path must survive it.
#[test]
fn a_poisoned_workers_shutdown_exit_spares_the_successors_live_socket() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("worker.sock");
    let mut worker = spawn_worker(dir.path(), &socket, "poisoned-shutdown-token");
    // The socket file exists: the bind succeeded and the worker is
    // parked in the bind-capture gap. Poison the capture with the
    // successor bound at the original path, then drive the worker
    // through its aside path (the bound listener keeps serving the
    // renamed inode).
    wait_socket_file(&socket);
    let aside = rename_bound_socket_aside(&socket);
    let (_successor, successor_identity) = bind_poisoning_successor(&socket);
    // The served hello through the aside path proves the capture has
    // completed on the poisoned file (the accept loop starts after it):
    // the poisoned state is armed, not assumed.
    let mut client = WorkerClient::connect(&aside, "poisoned-shutdown-token");
    let shutdown = client.request("shutdown", &json!({}));
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    wait_clean_exit(&mut worker.child, Duration::from_secs(10));
    assert_successor_serves(&socket, successor_identity);
}

/// The poisoned supervisor's SIGTERM graceful drain: a replacement bound
/// at the path inside the supervisor's bind->capture window poisons the
/// captured identity, the real drain exit runs, and the successor's LIVE
/// socket at the path must survive it.
#[test]
fn a_poisoned_supervisors_drain_spares_the_successors_live_socket() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_file(&socket);
    let aside = rename_bound_socket_aside(&socket);
    let (_successor, successor_identity) = bind_poisoning_successor(&socket);
    // A served hello through the aside path proves the capture has
    // completed on the poisoned file before the drain fires.
    let hello = supervisor_hello_line(&aside);
    assert_eq!(hello["type"], "daemon_hello", "supervisor hello: {hello}");
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(daemon.child.id().to_string())
        .status()
        .expect("SIGTERM the supervisor");
    wait_clean_exit(&mut daemon.child, Duration::from_secs(10));
    assert_successor_serves(&socket, successor_identity);
}
