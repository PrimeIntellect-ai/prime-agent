//! Bind-time socket-identity guard e2e (the bind-choreography parity
//! audit's D1 fix): the three exit cleanups used to pass a cleanup-time
//! `socket_identity(path)` read as their own "expected" guard, comparing a
//! fresh read with itself - the guard never discriminated, so any file
//! REPLACED at the path after the bind was unlinked by the dying owner's
//! exit. TS captures the identity at LISTEN time (daemon-supervisor.ts:879,
//! daemon-mode.ts:718) and compares THAT at exit (daemon-mode.ts:1078-1080),
//! so a replaced file survives the old owner's exit. The fix carries the
//! bind-time capture to the three call sites; these oracles pin the
//! replaced-file direction at each of them:
//!
//! * `supervisor_lost.rs` `exit_orphaned` - the reachable failure: a
//!   force-stopped worker survives its stop verdict, the supervisor
//!   relaunches its replacement on the SAME deterministic path
//!   (supervision.rs reuses `descriptor.socket_path`), and the survivor's
//!   late orphan exit must not unlink the replacement's live socket.
//! * `worker.rs` `exit_after_close` - the same class through the routed
//!   `shutdown` arm.
//! * `supervisor.rs` `run`'s exit cleanup - the external-sweep edge: the
//!   socket file is removed under a serving supervisor, a successor binds
//!   the path, and the original's graceful exit must not unlink the
//!   successor's live socket.
//!
//! The still-ours direction (the unlink DOES run on the same exit paths
//! when the file is the binder's own) is pinned by the in-tree controls
//! `worker_orphan_exit_e2e::orphaned_worker_exits_when_the_supervisor_socket_never_answers`
//! and
//! `supervisor_e2e::shutdown::a_sigterm_exits_the_supervisor_through_the_graceful_drain`,
//! plus the routed-shutdown control below. Each replacement is bound with
//! the original file renamed aside first: a freed inode can be handed
//! straight back to a fresh bind, which the dev+ino gate cannot see, so
//! keeping the original inode allocated guarantees the identities differ
//! and the oracle is never vacuous on inode reuse.
#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The filesystem identity the guard compares: dev + ino of the file
/// currently at the path.
fn socket_identity(path: &Path) -> (u64, u64) {
    let metadata = std::fs::symlink_metadata(path).expect("stat socket file");
    (metadata.dev(), metadata.ino())
}

/// Bind a replacement listener at `socket` while the original file is
/// renamed aside: the original inode stays allocated, so the replacement's
/// identity is guaranteed to differ from `original_identity`. Returns the
/// replacement listener and its identity.
fn bind_replacement_at(socket: &Path, original_identity: (u64, u64)) -> (UnixListener, (u64, u64)) {
    let aside: PathBuf = socket.parent().expect("socket parent").join(format!(
        "{}.replaced-aside",
        socket
            .file_name()
            .expect("socket file name")
            .to_string_lossy()
    ));
    std::fs::rename(socket, &aside).expect("rename the original socket file aside");
    let replacement = UnixListener::bind(socket).expect("bind the replacement socket");
    let identity = socket_identity(socket);
    assert_ne!(
        identity, original_identity,
        "the replacement must be a different file than the one the daemon bound"
    );
    (replacement, identity)
}

/// A live replacement socket must answer connects after the old owner's
/// exit: the file survived AND it still serves.
fn assert_replacement_serves(socket: &Path, identity: (u64, u64)) {
    assert!(
        socket.exists(),
        "the replacement socket file survived the old owner's exit"
    );
    assert_eq!(
        socket_identity(socket),
        identity,
        "the file at the path is still the replacement's, not a new file"
    );
    let connect = UnixStream::connect(socket).expect("the replacement socket still accepts");
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
/// clean exit: the exit paths under test all end in `std::process::exit(0)`
/// (or a graceful supervisor return), so a signal death or a nonzero exit
/// means the wrong path ran.
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

fn wait_socket_ready(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if UnixStream::connect(socket).is_ok() {
            return;
        }
        assert!(Instant::now() < deadline, "daemon socket never came up");
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
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon supervisor");
    ProcessGuard { child }
}

/// Spawn the real `pa-daemon worker` binary on its own socket, monitoring a
/// supervisor socket that never answers. `lost_window_ms` sets the
/// supervisor-lost exit window (`None` keeps the default five minutes).
fn spawn_worker(
    dir: &Path,
    socket: &Path,
    token: &str,
    lost_window_ms: Option<&str>,
) -> ProcessGuard {
    std::fs::create_dir_all(dir.join("agent")).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_pa-daemon"));
    command
        .arg("worker")
        .env(pa_daemon::worker::WORKER_ROLE_ENV, "1")
        .env(pa_daemon::worker::WORKER_TOKEN_ENV, token)
        .env(
            pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
            "socket-identity-guard",
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
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(window) = lost_window_ms {
        command.env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            window,
        );
    }
    let child = command.spawn().expect("spawn pa-daemon worker");
    ProcessGuard { child }
}

fn wait_worker_socket(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !socket.exists() {
        assert!(Instant::now() < deadline, "worker socket never appeared");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A raw private-frame client for the worker socket (the same wire the
/// supervisor's request pump speaks).
struct WorkerClient {
    stream: UnixStream,
}

impl WorkerClient {
    fn connect(socket: &Path, token: &str) -> Self {
        let stream = UnixStream::connect(socket).expect("connect worker socket");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        let mut client = WorkerClient { stream };
        let (header, _payload) = client.read_frame();
        assert_eq!(header["outboundType"], "daemon_hello", "worker hello");
        let auth = client.request(
            "worker_auth",
            &json!({
                "token": token,
                "supervisorGeneration": "sup:socket-identity-guard",
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

/// The survivor-wakes scenario on the orphan exit (`supervisor_lost.rs`
/// `exit_orphaned`): the supervisor relaunches a stopped worker's
/// replacement on the same deterministic socket path, and the old
/// process's late orphan exit must leave the replacement's live socket
/// alone - a stale-socket unlink there bounces every route to the
/// replacement until the next relaunch cycle.
#[test]
fn orphan_exit_never_unlinks_a_replacement_bound_on_the_worker_path() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("worker.sock");
    // The zero window exits the worker at the first availability check
    // (1.5s after boot); the replacement is bound long before it.
    let mut worker = spawn_worker(dir.path(), &socket, "orphan-guard-token", Some("0"));
    wait_worker_socket(&socket);
    let original = socket_identity(&socket);
    let (_replacement, replacement_identity) = bind_replacement_at(&socket, original);
    // The oracle's served-path precondition: the exit must fire with the
    // replacement in place, or a pass would say nothing about the guard.
    assert!(
        worker.child.try_wait().expect("poll worker").is_none(),
        "the replacement must be bound before the orphan exit fires"
    );
    wait_clean_exit(&mut worker.child, Duration::from_secs(15));
    assert_replacement_serves(&socket, replacement_identity);
}

/// The routed `shutdown` control (the still-ours direction of
/// `exit_after_close`): a worker's graceful exit owns its socket file - it
/// must remove it so a respawn does not wait out the stale-socket path.
/// The still-ours directions of the other two call sites are pinned by the
/// in-tree controls named in the module doc.
#[test]
fn routed_shutdown_removes_the_workers_own_socket_file() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("worker.sock");
    let mut worker = spawn_worker(dir.path(), &socket, "shutdown-guard-token", Some("15000"));
    wait_worker_socket(&socket);
    let mut client = WorkerClient::connect(&socket, "shutdown-guard-token");
    let shutdown = client.request("shutdown", &json!({}));
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    wait_clean_exit(&mut worker.child, Duration::from_secs(10));
    assert!(
        !socket.exists(),
        "the graceful exit removed the worker's own socket file"
    );
}

/// The replaced-socket scenario on the routed `shutdown` arm
/// (`worker.rs` `exit_after_close`): the same survivor class as the
/// orphan exit - a file replaced at the path after the bind is never
/// unlinked by the old owner's exit.
#[test]
fn routed_shutdown_never_unlinks_a_replacement_bound_on_the_worker_path() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("worker.sock");
    let mut worker = spawn_worker(dir.path(), &socket, "shutdown-guard-token", Some("15000"));
    wait_worker_socket(&socket);
    // Authenticate first: the supervisor role both arms the routed
    // `shutdown` arm and disarms the orphan monitor (claims > 0), so the
    // exit below is `exit_after_close` alone.
    let mut client = WorkerClient::connect(&socket, "shutdown-guard-token");
    let original = socket_identity(&socket);
    let (_replacement, replacement_identity) = bind_replacement_at(&socket, original);
    assert!(
        worker.child.try_wait().expect("poll worker").is_none(),
        "the replacement must be bound before the shutdown exit fires"
    );
    let shutdown = client.request("shutdown", &json!({}));
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");
    wait_clean_exit(&mut worker.child, Duration::from_secs(10));
    assert_replacement_serves(&socket, replacement_identity);
}

/// The replaced-socket scenario on the supervisor exit (`supervisor.rs`
/// `run`'s cleanup): the socket file is removed under a serving
/// supervisor (a tmpfiles age sweep; the TS module names the same edge)
/// and a successor binds the path while the original still serves its
/// nameless listener. The original's graceful drain must not unlink the
/// successor's live socket - every new connect would fail ENOENT while
/// the socket looks alive.
#[test]
fn a_drained_supervisor_never_unlinks_a_replaced_socket_file() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let mut daemon = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let original = socket_identity(&socket);
    let (_replacement, replacement_identity) = bind_replacement_at(&socket, original);
    assert!(
        daemon.child.try_wait().expect("poll supervisor").is_none(),
        "the replacement must be bound before the supervisor's exit"
    );
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(daemon.child.id().to_string())
        .status()
        .expect("SIGTERM the supervisor");
    wait_clean_exit(&mut daemon.child, Duration::from_secs(10));
    assert_replacement_serves(&socket, replacement_identity);
}

/// TS daemon-socket.ts:77-102 and daemon-supervisor.ts:852-865: the
/// supervisor owns a renewable socket-path lease from before bind to exit.
/// A killed holder leaves the directory, but a successor reclaims it after
/// the five-second stale window without touching a live successor's socket.
#[test]
fn supervisor_renews_lifetime_socket_lease_and_reclaims_a_dead_holder() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let mut original = spawn_supervisor(&socket, &agent_dir);
    wait_socket_ready(&socket);
    let lock = PathBuf::from(format!("{}.lock", socket.display()));
    assert!(lock.is_dir(), "serving supervisor must hold socket lease");
    let before = std::fs::metadata(&lock).unwrap().modified().unwrap();
    std::thread::sleep(Duration::from_secs(2));
    let after = std::fs::metadata(&lock).unwrap().modified().unwrap();
    assert!(
        after > before,
        "live holder must refresh lock directory mtime"
    );
    let mut second = spawn_supervisor(&socket, &dir.path().join("rival-agent"));
    assert!(
        second.child.try_wait().unwrap().is_none(),
        "live lease must block rival startup"
    );
    drop(second);
    original.child.kill().expect("kill original holder");
    original.child.wait().expect("reap original holder");
    // The old, unaccepted socket path and the abandoned lock both remain.
    assert!(socket.exists());
    assert!(lock.exists());
    let mut successor = spawn_supervisor(&socket, &dir.path().join("successor-agent"));
    let deadline = Instant::now() + Duration::from_secs(18);
    while UnixStream::connect(&socket).is_err()
        || std::fs::metadata(&lock).unwrap().modified().unwrap() <= after
    {
        assert!(
            Instant::now() < deadline,
            "dead holder lease was not reclaimed"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(successor.child.try_wait().unwrap().is_none());
}

/// A live supervisor's lease must keep the socket path exclusive even if a
/// tmpfiles sweep renames its listener away (TS daemon-supervisor.ts:852-865).
/// D1's bind-time identity guard alone protects the eventual exit unlink,
/// but it does not stop another process binding a fresh file meanwhile.
#[test]
fn live_supervisor_lease_prevents_rebind_after_external_socket_rename() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let mut original = spawn_supervisor(&socket, &dir.path().join("original-agent"));
    wait_socket_ready(&socket);
    let aside = dir.path().join("original.sock");
    std::fs::rename(&socket, &aside).expect("keep original inode alive");
    let mut rival = spawn_supervisor(&socket, &dir.path().join("rival-agent"));
    // TS's lifetime lease queues this startup until the 600x25ms retry
    // budget expires. Rust without a lease binds immediately: fail RED.
    std::thread::sleep(Duration::from_secs(2));
    assert!(
        !socket.exists(),
        "successor bound while original supervisor still held its lease"
    );
    assert!(original.child.try_wait().unwrap().is_none());
    // TS's contender test accepts failed rivals (ENG-4600:579-585), not
    // only ones still waiting. A rival may wait or fail, but must not bind.
    if let Some(status) = rival.child.try_wait().unwrap() {
        assert!(
            !status.success(),
            "a rival that exits must have refused the bind"
        );
    }
}

/// After a stopped holder loses its lock, it must fence itself on resume;
/// only then may a new holder reclaim its stale socket and bind.
#[test]
fn resumed_displaced_supervisor_fences_before_successor_binds() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let mut original = spawn_supervisor(&socket, &dir.path().join("original-agent"));
    wait_socket_ready(&socket);
    let lock = PathBuf::from(format!("{}.lock", socket.display()));
    assert!(
        lock.is_dir(),
        "serving supervisor must own the lifetime lease"
    );
    let original_socket = socket_identity(&socket);
    let stop = Command::new("kill")
        .arg("-STOP")
        .arg(original.child.id().to_string())
        .status()
        .expect("SIGSTOP original supervisor");
    assert!(stop.success());
    let displaced_lock = dir.path().join("displaced.lock");
    std::fs::rename(&lock, &displaced_lock).expect("displace stopped holder's lease");
    std::fs::create_dir(&lock).expect("pin successor's independent lock");
    let resume = Command::new("kill")
        .arg("-CONT")
        .arg(original.child.id().to_string())
        .status()
        .expect("SIGCONT original supervisor");
    assert!(resume.success());
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = original
            .child
            .try_wait()
            .expect("poll displaced supervisor")
        {
            assert!(
                status.code().is_some(),
                "displaced supervisor must exit, not crash"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "displaced holder did not fence itself"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        socket_identity(&socket),
        original_socket,
        "compromised holder must not unlink its socket"
    );
    assert!(lock.is_dir(), "old holder must leave successor lock intact");
    // Pin the old socket inode while the successor binds. Removing the old
    // file would let its dev+ino be recycled immediately by the new socket,
    // making an identity comparison incapable of distinguishing holders.
    let old_socket_aside = dir.path().join("old-supervisor.sock");
    std::fs::rename(&socket, &old_socket_aside).expect("pin old socket inode");
    assert_eq!(socket_identity(&old_socket_aside), original_socket);
    std::fs::remove_dir(&lock).expect("release simulated successor lock");
    let mut successor = spawn_supervisor(&socket, &dir.path().join("successor-agent"));
    // TS's replacement connect helper allows 30s (ENG-4600:287-302).
    let deadline = Instant::now() + Duration::from_secs(30);
    while UnixStream::connect(&socket).is_err() || socket_identity(&socket) == original_socket {
        assert!(
            successor.child.try_wait().unwrap().is_none(),
            "successor exited instead of binding after the old holder fenced"
        );
        assert!(
            Instant::now() < deadline,
            "successor did not bind after old holder fenced"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(successor.child.try_wait().unwrap().is_none());
}
