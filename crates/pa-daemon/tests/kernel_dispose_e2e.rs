//! Worker session-end kernel disposal e2e (TS `closeSession` parity):
//! TS disposes a session's kernel at every session end — `closeSession` ->
//! `AgentSessionRuntime.dispose` -> `AgentSession.disposeAsync` ->
//! `IpythonKernelProvisioner.dispose` (final namespace snapshot, then the
//! `python -m rlm.repl` process exits) — and the daemon worker is the host
//! that keeps its engine object alive past the session, so the Rust port
//! must call `AgentSessionEngine::dispose_kernel` explicitly on each end
//! path. Every end path here ends the *worker process* too, and a process
//! exit runs no destructors, so each assertion catches exactly the
//! missing-dispose leak: a kernel that survives would be orphaned forever.
//!
//! 1. `kill` (user delete): the kernel must die with the session.
//! 2. `shutdown` (daemon stop): the workers dispose their kernels before
//!    the process exit.
//! 3. Supervisor SIGKILL (the `exit_orphaned` supervisor-lost exit): the
//!    orphaned worker disposes its kernel before its own exit.
//!
//! The kernel Python is ambient product state (the auto-bootstrapped kernel
//! venv); like the other live-kernel verifiers, these tests skip (with a
//! note) on machines without a live install. The process-table scans
//! diff against a baseline snapshot, so ambient kernels (other agent
//! sessions on the same box) never interfere.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The three tests scan the whole process table (the kernel is a worker
/// child, not a test-process child), so this std lock serializes them.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn test_lock() -> MutexGuard<'static, ()> {
    TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The kernel Python with prime-agent-runtime installed; set
/// PA_E2E_KERNEL_PYTHON to point at an explicit interpreter instead.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_E2E_KERNEL_PYTHON {explicit:?} not found"
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(
        std::env::var("HOME")
            .map(|home| format!("{home}/.prime/agent/kernel-venv/bin/python"))
            .unwrap_or_else(|_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string()),
    );
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live kernel-dispose e2e");
    None
}

/// Every live `python -m rlm.repl` pid on the box (ambient kernels from
/// other sessions are part of the baseline the diffs below remove).
fn kernel_pids() -> Vec<u32> {
    let mut found = Vec::new();
    let entries = std::fs::read_dir("/proc").unwrap_or_else(|e| panic!("read /proc: {e}"));
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(cmdline) = std::fs::read_to_string(format!("/proc/{pid}/cmdline")) else {
            continue;
        };
        // The kernel is spawned as `python -m rlm.repl` (NUL-separated
        // argv): the adjacent `-m rlm.repl` pair avoids matching an
        // unrelated process that merely mentions the module.
        let args: Vec<&str> = cmdline.split('\0').collect();
        if args.windows(2).any(|window| window == ["-m", "rlm.repl"]) {
            found.push(pid);
        }
    }
    found.sort_unstable();
    found
}

/// Poll until at least one kernel pid exists outside `baseline`.
fn await_new_kernel(baseline: &[u32], budget: Duration) -> Vec<u32> {
    let deadline = Instant::now() + budget;
    loop {
        let fresh: Vec<u32> = kernel_pids()
            .into_iter()
            .filter(|pid| !baseline.contains(pid))
            .collect();
        if !fresh.is_empty() {
            return fresh;
        }
        assert!(
            Instant::now() < deadline,
            "no kernel process appeared within the budget (baseline {baseline:?})"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Poll until no kernel pid exists outside `baseline` — the session-end
/// dispose is the teardown being verified, so a kernel that survives the
/// end path past the budget is the leak this test exists to catch.
fn await_kernels_gone(baseline: &[u32], budget: Duration) {
    let deadline = Instant::now() + budget;
    loop {
        let fresh: Vec<u32> = kernel_pids()
            .into_iter()
            .filter(|pid| !baseline.contains(pid))
            .collect();
        if fresh.is_empty() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "kernel processes {fresh:?} outlived the session-end path (missing dispose)"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(
    socket: &Path,
    agent_dir: &Path,
    kernel_python: &Path,
    lost_window_ms: &str,
) -> Daemon {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
        // Hermetic agent dir: the ambient environment may export a real
        // agent dir; point every fallback at the test sandbox instead.
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env_remove("PRIME_API_KEY")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // The supervisor-lost exit window its workers inherit (TS
        // `workerSupervisorLostExitMs`; the env flows to the workers the
        // supervisor spawns).
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            lost_window_ms,
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    Daemon { child }
}

fn wait_socket_ready(socket: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if UnixStream::connect(socket).is_ok() {
            return;
        }
        assert!(Instant::now() < deadline, "supervisor socket never came up");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// JSONL supervisor client (command envelopes, id-matched responses).
struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> (Self, Value) {
        let stream = UnixStream::connect(socket).expect("connect supervisor");
        let writer = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        (client, hello)
    }

    fn send_command(&mut self, id: &str, command: Value) {
        self.write_line(&json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        }));
    }

    fn write_line(&mut self, value: &Value) {
        let mut line = serde_json::to_string(value).expect("serialize line");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => continue,
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse line"),
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(240);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// A faux script whose single turn runs one ipython cell that writes a
/// receipt: the turn proves the session built and its kernel executed
/// real code (the create-time prewarm alone is not enough evidence).
fn write_faux_script(dir: &Path) -> PathBuf {
    let receipts_dir = dir.join("receipts");
    std::fs::create_dir_all(&receipts_dir).expect("receipts dir");
    let receipt = receipts_dir.join("cell.json");
    let cell = format!(
        "open({receipt:?}, \"w\").write(\"kernel alive\")\nprint(\"kernel alive\")",
        receipt = receipt.to_string_lossy(),
    );
    let script = dir.join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython", "arguments": {
                        "code": cell,
                    } },
                ] },
                { "text": "done" },
            ],
        })
        .to_string(),
    )
    .expect("write faux script");
    script
}

/// Create a session on the supervisor and run its one scripted turn
/// (prompt + idle wait). Returns the active session id.
fn create_session_with_kernel(client: &mut Client, dir: &Path, script: &Path, id: &str) -> String {
    let sessions_dir = dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    client.send_command(
        id,
        json!({
            "type": "create",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response(id);
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();
    let prompt_id = format!("{id}-prompt");
    client.send_command(
        &prompt_id,
        json!({ "type": "prompt", "activeSessionId": session_id, "message": "run the cell" }),
    );
    let prompted = client.read_response(&prompt_id);
    assert_eq!(prompted["success"], true, "prompt failed: {prompted}");
    let idle_id = format!("{id}-idle");
    client.send_command(
        &idle_id,
        json!({ "type": "wait_for_idle", "activeSessionId": session_id }),
    );
    let idle = client.read_response(&idle_id);
    assert_eq!(idle["success"], true, "wait_for_idle failed: {idle}");
    session_id
}

/// The cell's receipt proves the kernel executed code for the session.
fn await_receipt(dir: &Path) {
    let receipt = dir.join("receipts").join("cell.json");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(content) = std::fs::read_to_string(&receipt) {
            assert_eq!(content, "kernel alive");
            return;
        }
        assert!(
            Instant::now() < deadline,
            "kernel cell receipt never appeared at {}",
            receipt.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `kill` disposes the session's kernel before the response: a worker
/// holding its kernel past the session end (the #235 leak class) leaves
/// the `python -m rlm.repl` process orphaned when the worker exits, and
/// this test catches it as a kernel pid that never clears the diff.
#[test]
fn kill_disposes_the_session_kernel() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _guard = test_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("supervisor.sock");
    let script = write_faux_script(dir.path());
    let baseline = kernel_pids();

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python, "15000");
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let session_id = create_session_with_kernel(&mut client, dir.path(), &script, "c1");

    // The session's kernel booted and executed the cell.
    let kernels = await_new_kernel(&baseline, Duration::from_secs(120));
    await_receipt(dir.path());

    // User delete: the routed `kill` closes the session (the supervisor
    // stops the worker right after, so the whole path is exercised).
    client.send_command(
        "k1",
        json!({ "type": "kill", "activeSessionId": session_id }),
    );
    let killed = client.read_response("k1");
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    let _ = kernels;

    // The kernel died with the session: process exit never runs the
    // engine-drop teardown, so only the explicit dispose clears this.
    await_kernels_gone(&baseline, Duration::from_secs(90));
}

/// Daemon `shutdown` routes a `shutdown` to every worker: each worker
/// disposes its kernel before its own process exit (no destructors run on
/// `std::process::exit`, so the dispose must happen in the handler).
#[test]
fn shutdown_disposes_session_kernels_before_the_worker_exits() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _guard = test_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("supervisor.sock");
    let script = write_faux_script(dir.path());
    let baseline = kernel_pids();

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python, "15000");
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let _session_id = create_session_with_kernel(&mut client, dir.path(), &script, "c1");
    await_new_kernel(&baseline, Duration::from_secs(120));
    await_receipt(dir.path());

    // Daemon stop: the supervisor routes `shutdown` to the workers and
    // then exits itself.
    client.send_command("sd", json!({ "type": "shutdown" }));
    let shutdown = client.read_response("sd");
    assert_eq!(shutdown["success"], true, "shutdown failed: {shutdown}");

    await_kernels_gone(&baseline, Duration::from_secs(90));
}

/// A SIGKILLed supervisor leaves orphaned workers: the supervisor-lost
/// monitor exits them after the lost window, and the exit path (TS
/// `shutdown(0)`'s session close) disposes the kernel first — the exit
/// itself would orphan it forever.
#[test]
fn orphan_exit_disposes_the_kernel_before_the_worker_exits() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _guard = test_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("supervisor.sock");
    let script = write_faux_script(dir.path());
    let baseline = kernel_pids();

    // A short supervisor-lost window: the orphaned worker exits quickly
    // once its supervisor is gone (the env flows to the spawned workers).
    let mut daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python, "5000");
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let _session_id = create_session_with_kernel(&mut client, dir.path(), &script, "c1");
    await_new_kernel(&baseline, Duration::from_secs(120));
    await_receipt(dir.path());

    // Hard-kill the supervisor: no graceful stop runs, so the worker's
    // supervisor-lost monitor is the only cleanup left.
    daemon.child.kill().expect("SIGKILL supervisor");
    let _ = daemon.child.wait();

    // The orphaned worker exits on the lost window and disposes its
    // kernel on the way out. Budget: the first availability check lands
    // 1.5s after boot and the window is 5s, so 90s covers slow boxes.
    await_kernels_gone(&baseline, Duration::from_secs(90));
}
