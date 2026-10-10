//! The shutdown-admission / startup-fence e2e (the bind-choreography parity
//! audit's D3 fix; TS `daemon-supervisor-ownership.ts`): the update-restart
//! stop window must not admit a third-party successor. TS closes the window
//! with two durable registry records under `~/.prime/supervisor-owners`:
//! a startup fence (`startup-fences/<sha256(socket)>.json`, pinning the
//! dying predecessor's pid + process start id, waited out at supervisor
//! start — TS `waitForDaemonStartupFence`, 10s default) and a shutdown
//! admission (`shutdown-admission.json`, 5000ms lease renewed every 1000ms,
//! refusing any ownership acquisition while active — TS
//! `acquireDaemonShutdownAdmission` / `DaemonShutdownAdmissionError`). The
//! rust tree had neither (audit edge E4d: a third-party daemon spawned in
//! the window takes the socket the moment the old listener drops), so these
//! oracles pin the admission contract at the real supervisor boot:
//!
//! * a live fence pin makes a successor WAIT (never bind, never kill) until
//!   the pinned process exits — then the boot proceeds (failing-first: the
//!   current tree binds straight through);
//! * an active shutdown admission makes a successor REFUSE fast and exit
//!   non-zero (failing-first: the current tree boots);
//! * a crashed stop must not deadlock the next boot: a fence whose pinned
//!   process is already dead self-clears at boot (the crash-oracle), and an
//!   admission whose holder died is inert to a reader even before its 5s
//!   lease elapses — the liveness-checked record, not the file's presence,
//!   is the authority (the disclosed durability-vs-availability call);
//! * an inert record never blocks, and the boot's active read reclaims it
//!   (TS `readActiveShutdownAdmission`'s rmSync).
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The registry override both the supervisor boot and this test honor (TS
/// `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR`): an isolated
/// registry per test, so the box's real daemons never mix in.
const REGISTRY_ENV: &str = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

struct Daemon {
    child: Child,
    // The socket field is carried for teardown symmetry with the other
    // e2e harnesses; the kill/wait below addresses the child directly.
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_supervisor(socket: &Path, agent_dir: &Path, registry: &Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A supervisor killed at teardown must not leak session workers
        // into later test binaries.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .env(REGISTRY_ENV, registry)
        .spawn()
        .expect("spawn pa-daemon supervisor");
    Daemon {
        child,
        socket: socket.to_path_buf(),
    }
}

/// Wait until the supervisor socket accepts connections.
fn wait_socket_ready(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if std::os::unix::net::UnixStream::connect(socket).is_ok() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "supervisor socket never came up: {}",
            socket.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Assert the socket accepts NO connection for the whole window: a
/// successor that must be waiting (fence) or bowing out (admission) never
/// binds in the meantime.
fn socket_stays_silent(socket: &Path, window: Duration) {
    let deadline = Instant::now() + window;
    loop {
        assert!(
            std::os::unix::net::UnixStream::connect(socket).is_err(),
            "a third-party successor bound the socket while the stop window was up: {}",
            socket.display()
        );
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The supervisor process must have exited (non-zero) within the window: a
/// refused successor bows out; it never lingers serving.
fn expect_refused_exit(daemon: &mut Daemon, window: Duration) {
    let deadline = Instant::now() + window;
    loop {
        if let Some(status) = daemon.child.try_wait().expect("poll supervisor") {
            assert!(
                !status.success(),
                "a refused third-party successor exited 0: {status}"
            );
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the third-party successor never exited; it booted straight through the stop window"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The TS fence filename: full sha256 hex of the normalized (absolute,
/// lexical) socket path, `.json` (TS `startupFencePath`).
fn fence_path(registry: &Path, socket: &Path) -> PathBuf {
    let digest = {
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(socket.to_string_lossy().as_bytes());
        hasher.finalize()
    };
    let key: String = digest.iter().fold(String::new(), |mut key, byte| {
        use std::fmt::Write;
        write!(key, "{byte:02x}").expect("write to String");
        key
    });
    registry.join("startup-fences").join(format!("{key}.json"))
}

fn admission_path(registry: &Path) -> PathBuf {
    registry.join("shutdown-admission.json")
}

/// A live pinned stand-in for the dying predecessor: a real process with a
/// real `/proc` start identity, exactly what the fence pins.
fn spawn_pinned_process() -> (Child, u32, String) {
    let child = Command::new("sleep")
        .arg("30")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the pinned stand-in");
    let pid = child.id();
    let start_id =
        pa_daemon::lease::get_process_start_id(pid).expect("the pinned process has a start id");
    (child, pid, start_id)
}

/// A process that is already gone: a fence pinning it must self-clear at
/// the next boot (the crash-oracle's dead pin).
fn spawn_dead_process() -> (u32, String) {
    let mut child = Command::new("sleep")
        .arg("0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the short-lived stand-in");
    let pid = child.id();
    let start_id = pa_daemon::lease::get_process_start_id(pid)
        .expect("the short-lived process has a start id");
    let _ = child.wait();
    (pid, start_id)
}

/// Write a record the way the registry writers do (TS `writeJsonAtomically`:
/// pretty JSON + trailing newline, atomic rename, no fsync).
fn write_record(path: &Path, record: &Value) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create the registry dir");
    }
    let body = format!("{}\n", serde_json::to_string_pretty(record).unwrap());
    std::fs::write(path, body).expect("write the registry record");
}

/// A startup fence record in the TS shape (`DaemonStartupFenceRecord`).
fn fence_record(socket: &Path, pid: u32, start_id: &str) -> Value {
    json!({
        "version": 1,
        "token": "fence-token-0001",
        "ownerToken": "owner-token-0001",
        "pid": pid,
        "processStartId": start_id,
        "socketPath": socket.to_string_lossy(),
        "supervisorGeneration": format!("sup:{pid}"),
        "createdAt": pa_daemon::util::now_iso(),
    })
}

/// A shutdown-admission record in the TS shape
/// (`DaemonShutdownAdmissionRecord`), `expires_at_ms` from now.
fn admission_record(pid: u32, start_id: &str, expires_at_ms: u64) -> Value {
    let now = pa_daemon::util::now_ms();
    json!({
        "version": 1,
        "token": "admission-token-0001",
        "pid": pid,
        "processStartId": start_id,
        "createdAt": pa_daemon::util::iso_from_unix_ms(now),
        "updatedAt": pa_daemon::util::iso_from_unix_ms(now),
        "expiresAt": pa_daemon::util::iso_from_unix_ms(now + expires_at_ms),
    })
}

fn this_process_identity() -> (u32, String) {
    let pid = std::process::id();
    let start_id =
        pa_daemon::lease::get_process_start_id(pid).expect("this test process has a start id");
    (pid, start_id)
}

#[test]
fn a_third_party_successor_waits_out_a_live_startup_fence() {
    let root = tempfile::tempdir().expect("test root");
    let registry = root.path().join("registry");
    let agent_dir = root.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = root.path().join("daemon.sock");
    let (mut pinned, pinned_pid, pinned_start) = spawn_pinned_process();
    write_record(
        &fence_path(&registry, &socket),
        &fence_record(&socket, pinned_pid, &pinned_start),
    );

    let mut successor = spawn_supervisor(&socket, &agent_dir, &registry);
    // The fence pins a LIVE process: the successor must not bind for as
    // long as the pin lives. The current tree binds straight through this
    // window (the failing-first oracle).
    socket_stays_silent(&socket, Duration::from_millis(2_500));
    // The pinned predecessor exits: the fence self-clears and the waiting
    // successor proceeds to own the path (the bow-out, never a kill).
    pinned.kill().expect("end the pinned stand-in");
    let _ = pinned.wait();
    wait_socket_ready(&socket);
    let _ = successor.child.kill();
    let _ = successor.child.wait();
}

#[test]
fn an_active_shutdown_admission_refuses_a_successor_boot() {
    let root = tempfile::tempdir().expect("test root");
    let registry = root.path().join("registry");
    let agent_dir = root.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = root.path().join("daemon.sock");
    let (pid, start_id) = this_process_identity();
    let admission = admission_path(&registry);
    // A 60s lease: the refusal must not race the record's own expiry under
    // a loaded machine; the TS active-window shape allows any future
    // expiry (a real coordinator renews at 5s).
    write_record(&admission, &admission_record(pid, &start_id, 60_000));

    let mut successor = spawn_supervisor(&socket, &agent_dir, &registry);
    // An active admission (live holder, unexpired lease) means a stop
    // window is up: the successor refuses outright - it never binds, and
    // it bows out non-zero instead of lingering. The current tree boots
    // straight through the window (the failing-first oracle).
    socket_stays_silent(&socket, Duration::from_millis(1_500));
    expect_refused_exit(&mut successor, Duration::from_secs(5));
    // A refused boot never touches another holder's record: the admission
    // the stop window holds stays exactly as written.
    assert!(
        admission.exists(),
        "the refused successor must leave the active admission record alone"
    );
}

#[test]
fn a_dead_pinned_fence_self_clears_at_boot() {
    let root = tempfile::tempdir().expect("test root");
    let registry = root.path().join("registry");
    let agent_dir = root.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = root.path().join("daemon.sock");
    let (pinned_pid, pinned_start) = spawn_dead_process();
    let fence = fence_path(&registry, &socket);
    write_record(&fence, &fence_record(&socket, pinned_pid, &pinned_start));

    // A crashed stop leaves a fence behind; the pinned process is already
    // gone. The next boot must not deadlock on the dead record: it clears
    // it and proceeds (the crash-oracle).
    let mut successor = spawn_supervisor(&socket, &agent_dir, &registry);
    wait_socket_ready(&socket);
    let _ = successor.child.kill();
    let _ = successor.child.wait();
    assert!(
        !fence.exists(),
        "the boot must clear a fence whose pinned process is dead"
    );
}

#[test]
fn a_crashed_admission_holder_does_not_wedge_the_boot() {
    let root = tempfile::tempdir().expect("test root");
    let registry = root.path().join("registry");
    let agent_dir = root.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = root.path().join("daemon.sock");
    // A coordinator that crashed mid-stop leaves an unexpired admission
    // record behind. The holder is dead, so the record is inert: the
    // liveness check - not the lease clock alone - is the authority (the
    // disclosed availability call; a live holder stalls out in <=5s), and
    // the boot's active read reclaims the inert record (TS
    // readActiveShutdownAdmission).
    let (pinned_pid, pinned_start) = spawn_dead_process();
    let admission = admission_path(&registry);
    write_record(
        &admission,
        &admission_record(pinned_pid, &pinned_start, 60_000),
    );

    let mut successor = spawn_supervisor(&socket, &agent_dir, &registry);
    wait_socket_ready(&socket);
    let _ = successor.child.kill();
    let _ = successor.child.wait();
    assert!(
        !admission.exists(),
        "the boot reclaims the crashed holder's inert record"
    );
}

#[test]
fn an_elapsed_admission_lease_does_not_block_and_reclaims_at_boot() {
    let root = tempfile::tempdir().expect("test root");
    let registry = root.path().join("registry");
    let agent_dir = root.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = root.path().join("daemon.sock");
    // A live holder whose lease merely elapsed (a stalled renewal): the
    // record is not active, so the boot proceeds; the refusal's active
    // read reclaims the abandoned record (TS
    // readActiveShutdownAdmission's rmSync - the read-ONLY probe of the
    // worker-side replacement monitor is the shape that never reclaims,
    // and this tree has no replacement launch to gate).
    let (pid, start_id) = this_process_identity();
    let admission = admission_path(&registry);
    write_record(&admission, &admission_record(pid, &start_id, 0));

    let mut successor = spawn_supervisor(&socket, &agent_dir, &registry);
    wait_socket_ready(&socket);
    let _ = successor.child.kill();
    let _ = successor.child.wait();
    assert!(
        !admission.exists(),
        "the boot's active read reclaims the elapsed record"
    );
}
