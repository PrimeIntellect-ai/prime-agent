//! Replacement-flow kernel lifecycle e2e (TS parity ruling per flow).
//!
//! TS ground truth (`AgentSessionRuntime`): the whole-runtime replacement
//! flows - `newSession` / `switchSession` / `importFromJsonl` / `fork` -
//! all run `teardownForReplacement` -> `teardownCurrent` ->
//! `session.disposeAsync()`: the old session's kernel disposes (a final
//! namespace snapshot flush, then the `python -m rlm.repl` process exits)
//! and a FRESH runtime builds onto the replacement file, whose kernel
//! starts cold (the prewarm fires again; the namespace is empty unless
//! the moved-to session carries its own snapshot). The tree moves
//! (`navigateTree`) are NOT replacements: TS rebuilds the branch context
//! in place on the live session and the kernel stays warm.
//!
//! Verified per flow against a live kernel process:
//!
//! 1. `new_session`: the old kernel process dies, a new one boots (the
//!    replacement prewarm), and the new session's namespace is COLD (a
//!    variable set before the replacement is gone).
//! 2. `switch_session`: same dispose+cold ruling on a prepared target -
//!    and a MISSING target never tears the live session down (the
//!    prepare precedes the teardown; the kernel survives the failed
//!    switch, exactly like the TS `releaseUncommittedLease` fallthrough).
//! 3. `fork`: same dispose+cold ruling (TS `createBranchedSession` copies
//!    no kernel state; the fork's kernel is a fresh process).
//! 4. `navigate_tree`: the SAME kernel process stays alive and its
//!    namespace is WARM (the variable set before the move is still
//!    there) - the kernel must not be torn down on a tree move.
//! 5. `switch_session` onto a session file with another recorded cwd:
//!    the rebuilt runtime's kernel-resident tools run in the TARGET
//!    session's cwd (TS `createRuntime({ cwd:
//!    sessionManager.getCwd() })`) - the post-switch kernel's
//!    `os.getcwd()` is the switched-to session's directory.
//!
//! The kernel Python is ambient product state (the auto-bootstrapped kernel
//! venv); like the other live-kernel verifiers, these tests skip (with a
//! note) on machines without a live install. The process-table scans diff
//! against a baseline snapshot, so ambient kernels (other agent sessions
//! on the same box) never interfere.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Every test scans the whole process table (the kernel is a worker
/// child, not a test-process child), so this std lock serializes them.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn test_lock() -> MutexGuard<'static, ()> {
    TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!("kernel python {candidate:?} not found; skipping live replacement-kernel e2e");
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

/// Poll until the old kernel pids are gone AND a fresh kernel exists: a
/// replacement flow disposed the old session's kernel and its fresh
/// session prewarmed a new one. The new kernel may boot before the old
/// one finishes its final snapshot flush, so any ordering passes - only
/// the end state (old gone, new alive) is the contract.
fn await_kernel_turnover(baseline: &[u32], old: &[u32], budget: Duration) -> Vec<u32> {
    let deadline = Instant::now() + budget;
    loop {
        let fresh: Vec<u32> = kernel_pids()
            .into_iter()
            .filter(|pid| !baseline.contains(pid))
            .collect();
        let old_gone = old.iter().all(|pid| !fresh.contains(pid));
        if old_gone && !fresh.is_empty() {
            return fresh;
        }
        assert!(
            Instant::now() < deadline,
            "kernel turnover never landed (baseline {baseline:?}, old {old:?}, now {fresh:?})"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Poll until the kernel pids outside `baseline` are exactly `expected`
/// (same pids, no additions): a tree move must not turn the kernel over.
fn await_same_kernels(baseline: &[u32], expected: &[u32], budget: Duration) {
    let deadline = Instant::now() + budget;
    loop {
        let fresh: Vec<u32> = kernel_pids()
            .into_iter()
            .filter(|pid| !baseline.contains(pid))
            .collect();
        if fresh == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "kernel set drifted on a warm path (baseline {baseline:?}, expected {expected:?}, now {fresh:?})"
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
fn spawn_supervisor(socket: &Path, agent_dir: &Path, kernel_python: &Path) -> Daemon {
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
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
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
        let deadline = Instant::now() + Duration::from_mins(2);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
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
        let deadline = Instant::now() + Duration::from_mins(4);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

/// One turn's ipython cell: writes `receipt` under the receipts dir with
/// the cell's verdict, after setting (first turn) or probing (second
/// turn) the `marker` variable. The first turn seeds `marker = "warm"`;
/// the probe records `"warm"` when the variable survived into the
/// session's kernel and `"cold"` when the kernel started fresh.
fn receipt_path(dir: &Path, name: &str) -> PathBuf {
    let receipts = dir.join("receipts");
    std::fs::create_dir_all(&receipts).expect("receipts dir");
    receipts.join(format!("{name}.txt"))
}

/// The first turn's cell: set the marker and write the receipt.
fn seed_cell(dir: &Path, name: &str) -> String {
    let receipt = receipt_path(dir, name);
    format!(
        "marker = \"warm\"\nopen({receipt:?}, \"w\").write(\"seeded\")\nprint(\"seeded\")",
        receipt = receipt.to_string_lossy(),
    )
}

/// The probe cell: record whether `marker` survived the session move.
fn probe_cell(dir: &Path, name: &str) -> String {
    let receipt = receipt_path(dir, name);
    format!(
        "try:\n    state = marker\nexcept NameError:\n    state = \"cold\"\nopen({receipt:?}, \"w\").write(state)\nprint(state)",
        receipt = receipt.to_string_lossy(),
    )
}

/// A faux script whose turns run one ipython cell each: turn 1 seeds the
/// marker, turn 2 probes it. The engine's queued responses span the
/// replacement (the worker keeps its engine), so the second turn runs
/// whatever kernel the moved-to session owns.
fn write_faux_script(dir: &Path) -> PathBuf {
    let script = dir.join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython", "arguments": {
                        "code": seed_cell(dir, "seed"),
                    } },
                ] },
                { "text": "done" },
                { "content": [
                    { "type": "toolCall", "name": "ipython", "arguments": {
                        "code": probe_cell(dir, "probe"),
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

/// Create a session on the supervisor and run one scripted turn
/// (prompt + idle wait). Returns the active session id.
fn create_session(client: &mut Client, dir: &Path, script: &Path, id: &str) -> String {
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
    created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string()
}

/// Run one turn (prompt + idle wait) on the session.
fn run_turn(client: &mut Client, session_id: &str, message: &str, id: &str) {
    client.send_command(
        id,
        json!({ "type": "prompt", "activeSessionId": session_id, "message": message }),
    );
    let prompted = client.read_response(id);
    assert_eq!(prompted["success"], true, "prompt failed: {prompted}");
    let idle_id = format!("{id}-idle");
    client.send_command(
        &idle_id,
        json!({ "type": "wait_for_idle", "activeSessionId": session_id }),
    );
    let idle = client.read_response(&idle_id);
    assert_eq!(idle["success"], true, "wait_for_idle failed: {idle}");
}

/// A cell's receipt proves the kernel executed it; the content is the
/// cell's verdict (`seeded` for the seed, `warm`/`cold` for the probe).
fn await_receipt(dir: &Path, name: &str) -> String {
    await_receipt_text(&receipt_path(dir, name))
}

/// Poll for a kernel cell's receipt content (the cwd rebind verifier
/// reads the full path the cell wrote).
fn await_receipt_text(receipt: &Path) -> String {
    let deadline = Instant::now() + Duration::from_mins(1);
    loop {
        if let Ok(content) = std::fs::read_to_string(receipt) {
            return content;
        }
        assert!(
            Instant::now() < deadline,
            "kernel cell receipt never appeared at {}",
            receipt.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The first user message's entry id (a fork/navigation target).
fn first_user_entry_id(client: &mut Client, session_id: &str, id: &str) -> String {
    client.send_command(
        id,
        json!({ "type": "get_user_messages_for_forking", "activeSessionId": session_id }),
    );
    let messages = client.read_response(id);
    assert_eq!(messages["success"], true, "fork points failed: {messages}");
    messages["data"]["messages"][0]["entryId"]
        .as_str()
        .expect("first user entry id")
        .to_string()
}

/// `new_session` (TS `AgentSessionRuntime.newSession` ->
/// `teardownForReplacement`): the old session's kernel process dies with
/// the session, the replacement session's kernel prewarm boots a fresh
/// process, and the fresh kernel's namespace is COLD - a variable set in
/// the old session's kernel does not survive into the new session.
#[test]
fn new_session_disposes_the_kernel_and_starts_cold() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _guard = test_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("supervisor.sock");
    let script = write_faux_script(dir.path());
    let baseline = kernel_pids();

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let session_id = create_session(&mut client, dir.path(), &script, "c1");
    run_turn(&mut client, &session_id, "seed the marker", "t1");
    let first = await_new_kernel(&baseline, Duration::from_mins(2));
    assert_eq!(await_receipt(dir.path(), "seed"), "seeded");

    // The replacement: TS disposes the old runtime first.
    client.send_command(
        "n1",
        json!({ "type": "new_session", "activeSessionId": session_id }),
    );
    let replaced = client.read_response("n1");
    assert_eq!(replaced["success"], true, "new_session failed: {replaced}");
    let _replacement = await_kernel_turnover(&baseline, &first, Duration::from_mins(2));

    // The fresh session's kernel executes the probe on a cold namespace.
    run_turn(&mut client, &session_id, "probe the marker", "t2");
    assert_eq!(
        await_receipt(dir.path(), "probe"),
        "cold",
        "the new session's kernel kept the old session's namespace"
    );
}

/// `switch_session` (TS `AgentSessionRuntime.switchSession` ->
/// `teardownForReplacement`): a prepared target replaces the runtime -
/// the old kernel dies, the fresh one boots cold. A MISSING target is a
/// prepare failure: no teardown runs, so the live session's kernel
/// survives the failed switch untouched.
#[test]
fn switch_session_disposes_the_kernel_and_a_failed_target_keeps_it() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _guard = test_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("supervisor.sock");
    let script = write_faux_script(dir.path());
    let baseline = kernel_pids();

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let session_id = create_session(&mut client, dir.path(), &script, "c1");
    run_turn(&mut client, &session_id, "seed the marker", "t1");
    let first = await_new_kernel(&baseline, Duration::from_mins(2));
    assert_eq!(await_receipt(dir.path(), "seed"), "seeded");

    // A missing switch target fails at the prepare: the live session and
    // its kernel stay untouched (no teardown on a failed prepare).
    client.send_command(
        "s1",
        json!({
            "type": "switch_session",
            "activeSessionId": session_id,
            "sessionPath": "/tmp/definitely-missing-replacement.jsonl",
        }),
    );
    let failed = client.read_response("s1");
    assert_eq!(
        failed["success"], false,
        "missing switch target succeeded: {failed}"
    );
    assert!(
        failed["error"]
            .as_str()
            .unwrap_or_default()
            .contains("/tmp/definitely-missing-replacement.jsonl"),
        "missing switch target error: {failed:?}"
    );
    await_same_kernels(&baseline, &first, Duration::from_secs(30));

    // A prepared target replaces the runtime: kernel turnover + cold
    // namespace on the switched-to session.
    let target = dir.path().join("sessions").join("switch-target.jsonl");
    std::fs::write(
        &target,
        format!(
            "{}\n",
            json!({
                "type": "session",
                "id": "switch-target",
                "timestamp": "2026-09-21T00:00:00.000Z",
                "cwd": dir.path().to_string_lossy(),
            })
        ),
    )
    .expect("write switch target");
    client.send_command(
        "s2",
        json!({
            "type": "switch_session",
            "activeSessionId": session_id,
            "sessionPath": target.to_string_lossy(),
        }),
    );
    let switched = client.read_response("s2");
    assert_eq!(
        switched["success"], true,
        "switch_session failed: {switched}"
    );
    let _replacement = await_kernel_turnover(&baseline, &first, Duration::from_mins(2));
    run_turn(&mut client, &session_id, "probe the marker", "t2");
    assert_eq!(
        await_receipt(dir.path(), "probe"),
        "cold",
        "the switched-to session's kernel kept the old session's namespace"
    );
}

/// `fork` (TS `AgentSessionRuntime.fork` -> `teardownForReplacement`):
/// the forked session is a whole-runtime replacement - the old kernel
/// dies, the fork's kernel boots cold (TS `createBranchedSession` copies
/// no kernel state).
#[test]
fn fork_disposes_the_kernel_and_starts_cold() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _guard = test_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("supervisor.sock");
    let script = write_faux_script(dir.path());
    let baseline = kernel_pids();

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let session_id = create_session(&mut client, dir.path(), &script, "c1");
    run_turn(&mut client, &session_id, "seed the marker", "t1");
    let first = await_new_kernel(&baseline, Duration::from_mins(2));
    assert_eq!(await_receipt(dir.path(), "seed"), "seeded");

    // Fork before the first user message: the fork's branch is empty and
    // the runtime is replaced wholesale.
    let entry_id = first_user_entry_id(&mut client, &session_id, "f0");
    client.send_command(
        "f1",
        json!({
            "type": "fork",
            "activeSessionId": session_id,
            "entryId": entry_id,
            "position": "before",
        }),
    );
    let forked = client.read_response("f1");
    assert_eq!(forked["success"], true, "fork failed: {forked}");
    assert_eq!(
        forked["data"]["cancelled"], false,
        "fork cancelled: {forked}"
    );
    let _replacement = await_kernel_turnover(&baseline, &first, Duration::from_mins(2));

    // The fork's kernel executes the probe on a cold namespace.
    run_turn(&mut client, &session_id, "probe the marker", "t2");
    assert_eq!(
        await_receipt(dir.path(), "probe"),
        "cold",
        "the forked session's kernel kept the source session's namespace"
    );
}

/// The switch cwd rebind (TS `switchSession` -> `createRuntime({ cwd:
/// sessionManager.getCwd() })`): the rebuilt runtime's kernel-resident
/// tools run in the TARGET session's recorded cwd - the post-switch
/// kernel's `os.getcwd()` is the switched-to session's working directory,
/// not the worker's original one.
#[test]
fn switch_session_rebinds_the_kernel_cwd_onto_the_target_session() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _guard = test_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("supervisor.sock");
    let alpha = dir.path().join("alpha");
    let beta = dir.path().join("beta");
    std::fs::create_dir_all(&alpha).expect("alpha dir");
    std::fs::create_dir_all(&beta).expect("beta dir");
    // One scripted turn: an ipython cell writes the kernel's cwd receipt.
    let receipt = dir.path().join("receipts").join("cwd.txt");
    std::fs::create_dir_all(receipt.parent().expect("receipts dir")).expect("receipts dir");
    let script = dir.path().join("faux.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "ipython", "arguments": {
                        "code": format!(
                            "import os\nopen({receipt:?}, \"w\").write(os.getcwd())\nprint(\"cwd\")",
                            receipt = receipt.to_string_lossy(),
                        ),
                    } },
                ] },
                { "text": "done" },
            ],
        })
        .to_string(),
    )
    .expect("write faux script");

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let sessions_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    client.send_command(
        "c1",
        json!({
            "type": "create",
            "config": {
                "cwd": alpha.to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["activeSessionId"]
        .as_str()
        .or_else(|| created["data"]["id"].as_str())
        .expect("active session id")
        .to_string();

    // A target session file recording the OTHER directory as its cwd.
    let target = sessions_dir.join("switch-target.jsonl");
    std::fs::write(
        &target,
        format!(
            "{}\n",
            json!({
                "type": "session",
                "id": "switch-target",
                "timestamp": "2026-09-21T00:00:00.000Z",
                "cwd": beta.to_string_lossy(),
            })
        ),
    )
    .expect("write switch target");
    client.send_command(
        "s1",
        json!({
            "type": "switch_session",
            "activeSessionId": session_id,
            "sessionPath": target.to_string_lossy(),
        }),
    );
    let switched = client.read_response("s1");
    assert_eq!(
        switched["success"], true,
        "switch_session failed: {switched}"
    );

    // The post-switch turn runs the cell on the rebuilt session's kernel:
    // the cwd the tools see is the target session's recorded cwd.
    run_turn(&mut client, &session_id, "print the cwd", "t1");
    let observed = await_receipt_text(&receipt);
    assert_eq!(
        observed,
        beta.to_string_lossy(),
        "the switched-to session's kernel kept the worker's original cwd"
    );
}

/// `navigate_tree` (TS `AgentSession.navigateTree`): a tree move is NOT
/// a runtime replacement - the SAME kernel process stays alive and its
/// namespace is WARM (the marker set before the move survives it).
#[test]
fn navigate_tree_keeps_the_kernel_warm() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let _guard = test_lock();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let socket = dir.path().join("supervisor.sock");
    let script = write_faux_script(dir.path());
    let baseline = kernel_pids();

    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let session_id = create_session(&mut client, dir.path(), &script, "c1");
    run_turn(&mut client, &session_id, "seed the marker", "t1");
    let first = await_new_kernel(&baseline, Duration::from_mins(2));
    assert_eq!(await_receipt(dir.path(), "seed"), "seeded");

    // A branch move to the first user message: in-place context rebuild,
    // same session, same kernel.
    let entry_id = first_user_entry_id(&mut client, &session_id, "m0");
    client.send_command(
        "m1",
        json!({
            "type": "navigate_tree",
            "activeSessionId": session_id,
            "targetId": entry_id,
        }),
    );
    let moved = client.read_response("m1");
    assert_eq!(moved["success"], true, "navigate_tree failed: {moved}");
    assert_eq!(
        moved["data"]["cancelled"], false,
        "navigate_tree cancelled: {moved}"
    );
    await_same_kernels(&baseline, &first, Duration::from_secs(30));

    // The same kernel's namespace survived the move.
    run_turn(&mut client, &session_id, "probe the marker", "t2");
    assert_eq!(
        await_receipt(dir.path(), "probe"),
        "warm",
        "a tree move lost the live kernel's namespace"
    );
    await_same_kernels(&baseline, &first, Duration::from_secs(30));
}
