//! The client launch-env e2e (contract audit #1 + #9): the environment a
//! client forwards on its `create` reaches ITS session's worker process
//! (and the kernel under it) under the supervisor's internal identity
//! overrides; `RLM_DEPTH` never reaches a worker — not from the daemon's
//! own boot env, not from a client's forward (a daemon or client running
//! inside an agent must not stamp the new root's recursion identity);
//! one session's forwarded env never bleeds into another's worker; the
//! durable artifacts (descriptor, update-restart roster) never carry the
//! client env; and an `rlm.spawn` child inherits the parent worker's env.
// Pedantic-gate dispositions (fleet-uniform ruling; see kernel_dispose_e2e).
#![allow(clippy::large_futures)]
#![allow(clippy::too_many_lines)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Remove one env var at scope end: a test that must run with a var in
/// its own process env (the parent-worker stand-in) restores the
/// process to its pre-test state (the supervisor tests'
/// save-and-restore pattern).
#[cfg(target_os = "linux")]
struct RemoveEnvVarAtDrop(&'static str);

#[cfg(target_os = "linux")]
impl Drop for RemoveEnvVarAtDrop {
    fn drop(&mut self) {
        std::env::remove_var(self.0);
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

/// The kernel Python (the same resolution the other kernel e2es use):
/// an explicit `PA_E2E_KERNEL_PYTHON`, else the machine's live install.
/// Skipped (with a note) on machines without one.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_E2E_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_E2E_KERNEL_PYTHON {} not found",
            explicit.display()
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
    eprintln!(
        "kernel python {} not found; skipping the launch-env kernel e2e",
        candidate.display()
    );
    None
}

/// Boot the real supervisor in the HOSTILE boot env (audit #9): the
/// daemon itself "runs inside an agent" (`RLM_DEPTH=1`) and has NEVER
/// seen the client's marker. `PA_MARKER` is scrubbed so the only path it
/// can ever take into a worker is the create's launch env.
fn spawn_supervisor(socket: &Path, agent_dir: &Path, kernel_python: Option<&Path>) -> Daemon {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let log_file = std::fs::File::create(socket.with_extension("daemon.log")).expect("log file");
    let log_err = log_file.try_clone().expect("clone log file");
    let mut command = Command::new(env!("CARGO_BIN_EXE_pa-daemon"));
    command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env_remove("PRIME_API_KEY")
        .env_remove("PA_MARKER")
        // THE HOSTILE BOOT CONTEXT (audit #9): a supervisor started from
        // inside an agent's shell. Every worker it spawns would inherit
        // the recursion marker without the spawn-time strip.
        .env("RLM_DEPTH", "1")
        // The daemon-base sentinel: a var only the daemon's own env
        // carries. It MUST still reach the workers (the inherited base
        // layer under the client env).
        .env("PA_DAEMON_BASE_SENTINEL", "daemon-boot")
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_err));
    if let Some(kernel_python) = kernel_python {
        command.env("PRIME_AGENT_KERNEL_PYTHON", kernel_python);
    }
    // A supervisor killed at teardown must not leak its session workers
    // into later test binaries: the worker's supervisor-lost exit runs
    // on this short window instead of the 5-minute default.
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    Daemon {
        child: command.spawn().expect("spawn pa-daemon supervisor"),
    }
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
        let writer = UnixStream::connect(socket).expect("connect");
        let reader = BufReader::new(writer.try_clone().expect("clone"));
        let mut client = Self { reader, writer };
        let hello = client.read_line();
        (client, hello)
    }

    fn send_command(&mut self, id: &str, command: &Value) {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("write");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => panic!("daemon closed the socket"),
            Ok(_) => serde_json::from_str(line.trim()).expect("line json"),
            Err(error) => panic!("read failed: {error}"),
        }
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
            assert!(Instant::now() < deadline, "no response for {id}");
        }
    }

    fn request(&mut self, id: &str, command: &Value) -> Value {
        self.send_command(id, command);
        self.read_response(id)
    }
}

/// One scripted session on the supervisor: create with the given extra
/// create fields, then prompt its single turn and wait for idle.
fn create_session(
    client: &mut Client,
    dir: &Path,
    script: &Path,
    id: &str,
    extra: Value,
) -> (String, String) {
    let sessions_dir = dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let mut create = json!({
        "type": "create",
        "name": id,
        "config": {
            "cwd": dir.to_string_lossy(),
            "sessionDir": sessions_dir.to_string_lossy(),
            "script": script.to_string_lossy(),
        },
    });
    if let Value::Object(fields) = extra {
        for (key, value) in fields {
            create[key] = value;
        }
    }
    let created = client.request(&format!("create-{id}"), &create);
    assert_eq!(created["success"], true, "create {id} failed: {created}");
    let data = &created["data"];
    let session_id = data["activeSessionId"]
        .as_str()
        .or_else(|| data["id"].as_str())
        .expect("session id")
        .to_string();
    let session_file = data["sessionFile"]
        .as_str()
        .expect("session file")
        .to_string();
    (session_id, session_file)
}

fn run_one_turn(client: &mut Client, session_id: &str, id: &str) {
    let prompted = client.request(
        &format!("prompt-{id}"),
        &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "run the turn" }),
    );
    assert_eq!(prompted["success"], true, "prompt {id} failed: {prompted}");
}

/// A plain one-text-turn script (no kernel).
fn write_plain_script(dir: &Path) -> PathBuf {
    let script = dir.join("plain-script.json");
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": "turn done", "delayMs": 10 } ] }).to_string(),
    )
    .expect("write script");
    script
}

/// The pid of a live session worker, read from its on-disk descriptor
/// (written by the create path before the create response returns). A
/// descriptor that is not yet parseable, or whose pid is not a positive
/// number yet (a transitional rewrite), means "not yet": keep polling
/// until the deadline — never panic mid-write.
#[cfg(target_os = "linux")]
fn worker_pid(socket: &Path, agent_dir: &Path, active_session_id: &str) -> u32 {
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(agent_dir, socket);
    let descriptor_path = descriptor_dir.join(format!("{active_session_id}.json"));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let pid = std::fs::read_to_string(&descriptor_path)
            .ok()
            .and_then(|bytes| serde_json::from_str::<Value>(&bytes).ok())
            .and_then(|descriptor| descriptor["pid"].as_u64())
            .filter(|pid| *pid > 0)
            .and_then(|pid| u32::try_from(pid).ok());
        if let Some(pid) = pid {
            return pid;
        }
        assert!(
            Instant::now() < deadline,
            "worker descriptor never appeared within 10s"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The raw NUL-separated environ bytes, one entry per line.
#[cfg(target_os = "linux")]
fn parse_environ(bytes: &[u8]) -> String {
    bytes
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| String::from_utf8_lossy(entry).to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The raw environ of a live process.
#[cfg(target_os = "linux")]
fn proc_environ(pid: u32) -> String {
    parse_environ(&std::fs::read(format!("/proc/{pid}/environ")).expect("worker environ readable"))
}

/// The child descriptor's pid: the one descriptor whose session file
/// lives under the child's session dir. A descriptor that is not yet
/// parseable, or whose pid is missing or zero, means "not yet" — the
/// caller polls.
#[cfg(target_os = "linux")]
fn child_descriptor_pid(descriptor_dir: &Path, child_id: &str) -> Option<u32> {
    for entry in std::fs::read_dir(descriptor_dir).ok()?.flatten() {
        let Ok(bytes) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(descriptor) = serde_json::from_str::<Value>(&bytes) else {
            continue;
        };
        if descriptor["sessionFile"]
            .as_str()
            .is_some_and(|file| file.contains(child_id))
        {
            if let Some(pid) = descriptor["pid"].as_u64().filter(|pid| *pid > 0) {
                return u32::try_from(pid).ok();
            }
        }
    }
    None
}

/// The `rlmDepth` of a session file's header line.
#[cfg(target_os = "linux")]
fn session_header_depth(session_file: &Path) -> u64 {
    let file = std::fs::File::open(session_file).expect("session file open");
    let mut first_line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(file), &mut first_line)
        .expect("header line");
    let header: Value = serde_json::from_str(first_line.trim()).expect("header json");
    header["rlmDepth"].as_u64().unwrap_or(0)
}

/// The client launch env travels only to the session it created: A's
/// worker runs in it, B's never sees it, the daemon's own env still
/// reaches both (the inherited base), `RLM_DEPTH` reaches NEITHER, the
/// workers stamp depth-0 root headers, and the durable descriptor for
/// A carries no trace of the client env.
#[cfg(target_os = "linux")] // /proc/<pid>/environ
#[test]
fn the_client_launch_env_reaches_only_its_own_worker() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let script = write_plain_script(dir.path());
    let marker = format!("a-{}", uuid::Uuid::new_v4());
    let _daemon = spawn_supervisor(&socket, &agent_dir, None);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // CREATE A: the client forwards its whole env (here: just the marker).
    let (session_a, file_a) = create_session(
        &mut client,
        dir.path(),
        &script,
        "a",
        json!({ "launchEnv": { "PA_MARKER": marker } }),
    );
    // CREATE B: no launch env at all.
    let (session_b, file_b) = create_session(&mut client, dir.path(), &script, "b", json!({}));

    let environ_a = proc_environ(worker_pid(&socket, &agent_dir, &session_a));
    let environ_b = proc_environ(worker_pid(&socket, &agent_dir, &session_b));

    // A's worker runs in the client's env (audit #1).
    assert!(
        environ_a.contains(&format!("PA_MARKER={marker}")),
        "session A's worker never received the client's launch env:\n{environ_a}"
    );
    // B's worker does NOT: one session's env never bleeds into another's.
    assert!(
        !environ_b.contains("PA_MARKER="),
        "session B's worker saw session A's client env:\n{environ_b}"
    );
    // The daemon-base var still reaches both (the inherited base layer).
    for (name, environ) in [("A", &environ_a), ("B", &environ_b)] {
        assert!(
            environ.contains("PA_DAEMON_BASE_SENTINEL=daemon-boot"),
            "session {name}'s worker lost the daemon's own env:\n{environ}"
        );
        // `RLM_DEPTH` never reaches a worker (audit #9): not from the
        // daemon's hostile boot env, not from any client forward.
        assert!(
            !environ.contains("RLM_DEPTH="),
            "session {name}'s worker inherited RLM_DEPTH:\n{environ}"
        );
    }

    // The recursion identity follows: a new root session is stamped
    // depth 0 even though the daemon itself "ran inside an agent".
    assert_eq!(
        session_header_depth(Path::new(&file_a)),
        0,
        "session A's header is stamped with the daemon's RLM_DEPTH"
    );
    assert_eq!(
        session_header_depth(Path::new(&file_b)),
        0,
        "session B's header is stamped with the daemon's RLM_DEPTH"
    );

    // The durable descriptor never carries the client env (TS parity:
    // `withoutSupervisorCreateFields` strips launchEnv from the durable
    // create command).
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket);
    let descriptor_bytes =
        std::fs::read_to_string(descriptor_dir.join(format!("{session_a}.json")))
            .expect("descriptor A");
    assert!(
        !descriptor_bytes.contains(&marker),
        "the worker descriptor leaked the client env"
    );
    let descriptor: Value = serde_json::from_str(&descriptor_bytes).expect("descriptor json");
    assert!(
        descriptor["createCommand"].get("launchEnv").is_none()
            && descriptor["createCommand"].get("launch_env").is_none(),
        "the durable create command carries a launch env"
    );
}

/// The kernel under the worker runs in the client's env too (the audit
/// #1 repro: `bash()`/kernel subprocesses see the terminal's PATH, not
/// the daemon's). One scripted cell writes its `os.environ` to a receipt.
#[test]
fn the_kernel_runs_in_the_client_launch_env() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let marker = format!("a-{}", uuid::Uuid::new_v4());
    let receipt = dir.path().join("kernel-receipt.txt");
    // The cell records exactly the two vars the contract cares about.
    let cell = format!(
        "import os\nopen({receipt:?}, \"w\").write((os.environ.get(\"PA_MARKER\") or \"ABSENT\") + \"\\n\" + (os.environ.get(\"RLM_DEPTH\") or \"ABSENT\"))\nprint(\"cell done\")",
        receipt = receipt.to_string_lossy(),
    );
    let script = dir.path().join("kernel-script.json");
    std::fs::write(
        &script,
        json!({
            "engine": "faux",
            "responses": [
                { "content": [
                    { "type": "toolCall", "name": "python_repl", "arguments": {
                        "code": cell,
                    } },
                ] },
                { "text": "done" },
            ],
        })
        .to_string(),
    )
    .expect("write faux script");
    let _daemon = spawn_supervisor(&socket, &agent_dir, Some(&kernel_python));
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    let (session_a, _file_a) = create_session(
        &mut client,
        dir.path(),
        &script,
        "a",
        json!({ "launchEnv": { "PA_MARKER": marker } }),
    );
    run_one_turn(&mut client, &session_a, "a");

    // The receipt proves the kernel executed the cell (a skipped kernel
    // never writes it).
    let deadline = Instant::now() + Duration::from_secs(30);
    let content = loop {
        if let Ok(content) = std::fs::read_to_string(&receipt) {
            break content;
        }
        assert!(
            Instant::now() < deadline,
            "the kernel cell receipt never appeared at {}",
            receipt.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(
        content,
        format!("{marker}\nABSENT"),
        "the kernel env must carry the client's marker and no RLM_DEPTH"
    );
    // The ran-proof (the skip gate must not be a hollow pass): the
    // receipt exists only because the live kernel executed the cell.
    eprintln!(
        "launch-env kernel e2e ran: kernel {} executed the cell, receipt={:?}",
        kernel_python.display(),
        content
    );
}

/// An `rlm.spawn` child is a separate worker process in the Rust port;
/// TS runs it in-process inside the parent worker. Parity: the child
/// create forwards the parent worker's own env (filtered), so the child
/// worker inherits it — while the parent's `RLM_DEPTH` never rides
/// along.
#[cfg(target_os = "linux")] // /proc/<pid>/environ
#[tokio::test]
async fn an_rlm_spawn_child_inherits_the_parent_worker_env() {
    use pa_core::session_engine::rlm_host::{RlmSpawnRequest, RlmSubagentHost};
    use pa_daemon::rlm_children::{ParentIdentity, SupervisorChildSessions};
    use pa_daemon::supervisor_link::SupervisorLink;

    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let script = dir.path().join("child-script.json");
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": "child answer", "delayMs": 30 } ] }).to_string(),
    )
    .expect("write script");
    let marker = format!("parent-worker-{}", uuid::Uuid::new_v4());
    let _daemon = spawn_supervisor(&socket, &agent_dir, None);
    wait_socket_ready(&socket);

    // The test process stands in for the parent worker: its env is what
    // the spawn arm forwards. The daemon itself was scrubbed of the
    // marker at boot, so the ONLY way the child can see it is the
    // spawn arm's forward. The var never leaks past this test: the
    // guard removes it at scope end.
    std::env::set_var("PA_MARKER", &marker);
    let _marker_guard = RemoveEnvVarAtDrop("PA_MARKER");
    let children = SupervisorChildSessions::new(
        std::sync::Arc::new(SupervisorLink::new(socket.clone())),
        agent_dir.clone(),
        "parent-active-id".to_string(),
        std::sync::Arc::new(pa_daemon::model_allowlist::ModelRefusalTelemetry::new(
            agent_dir.clone(),
            /*telemetry_disabled*/ true,
        )),
        // This process stands in for the parent and has no worker token;
        // this fixture reads the child's env, not authenticated roster joins.
        String::new(),
    );
    children.set_identity(ParentIdentity {
        rlm_depth: 0,
        rlm_max_depth: 2,
        model: Some("scripted/faux-1".to_string()),
        cwd: Some(agent_dir.to_string_lossy().to_string()),
        session_id: Some("parent-session-uuid".to_string()),
        session_file: Some(agent_dir.join("parent.jsonl").to_string_lossy().to_string()),
        thinking: None,
        child_script: Some(script.to_string_lossy().to_string()),
    });
    let handle = children
        .spawn(RlmSpawnRequest {
            prompt: "ship the lane".to_string(),
            name: Some("worker-a".to_string()),
            model: None,
            thinking: None,
            cwd: None,
            decision_child: false,
            spawned_by_request_id: None,
            factory: None,
        })
        .await
        .expect("spawn");
    // The child worker's env exists from its first exec: read it while
    // the worker is guaranteed alive — BEFORE the settle pass, after
    // which the child may passivate or exit (its pid can vanish from
    // /proc, and a mid-flight descriptor rewrite can read as pid-less).
    // A descriptor that is not yet parseable or pid-less, or a pid whose
    // /proc read fails, means "not yet": keep polling until the deadline,
    // never panic mid-transition.
    let descriptor_dir = pa_daemon::descriptor::descriptor_dir(&agent_dir, &socket);
    let deadline = Instant::now() + Duration::from_secs(15);
    let environ = loop {
        if let Some(pid) = child_descriptor_pid(&descriptor_dir, &handle.rlm_child_id) {
            if let Ok(bytes) = std::fs::read(format!("/proc/{pid}/environ")) {
                break parse_environ(&bytes);
            }
        }
        assert!(
            Instant::now() < deadline,
            "the child worker's env never became observable"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        environ.contains(&format!("PA_MARKER={marker}")),
        "the spawned child's worker never received the parent worker's env:\n{environ}"
    );
    // The supervisor itself "runs inside an agent" (the hostile boot
    // env): the child must not inherit that stale recursion marker.
    assert!(
        !environ.contains("RLM_DEPTH="),
        "the spawned child inherited the supervisor's RLM_DEPTH:\n{environ}"
    );
    // The registry sits outside a live worker turn here: release the
    // detached task prompt at the boundary the worker would signal (the
    // existing rlm-children e2e's contract), wait for the settle, and
    // clean the child up.
    children.notify_turn_done();
    let _ = children
        .collect(vec![handle.rlm_child_id.clone()], 5_000)
        .await;
    let _ = children.delete_subagent(handle.rlm_child_id.clone()).await;
}

/// The update-restart roster's `launch_env` rows respawn workers with the
/// supervisor's INTERNAL identity only: the client env a session was
/// created with never lands in the durable roster.
#[test]
fn the_update_roster_never_carries_the_client_env() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    let script = write_plain_script(dir.path());
    let marker = format!("roster-{}", uuid::Uuid::new_v4());
    let _daemon = spawn_supervisor(&socket, &agent_dir, None);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    let (session_a, _file_a) = create_session(
        &mut client,
        dir.path(),
        &script,
        "a",
        json!({ "launchEnv": { "PA_MARKER": marker } }),
    );
    run_one_turn(&mut client, &session_a, "a");

    // The prepare transaction snapshots every resident and writes the
    // roster (the same file a new binary revives workers from). The
    // update id stays disjoint from the marker: the marker's absence
    // must be about the env rows, not the id string.
    let prepared = client.request(
        "prepare",
        &json!({ "type": "prepare_update_restart", "updateId": format!("u-{}", uuid::Uuid::new_v4()) }),
    );
    assert_eq!(prepared["success"], true, "prepare failed: {prepared}");

    let restarts = agent_dir.join("update-restarts");
    let mut roster: Option<Value> = None;
    for entry in std::fs::read_dir(&restarts)
        .expect("update-restarts dir")
        .flatten()
    {
        let prepared_dir = entry.path().join("prepared");
        for update in std::fs::read_dir(&prepared_dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
        {
            let bytes =
                std::fs::read_to_string(update.path().join("roster.json")).expect("roster.json");
            assert!(
                !bytes.contains(&marker),
                "the update roster leaked the client env:\n{bytes}"
            );
            roster = Some(serde_json::from_str(&bytes).expect("roster json"));
        }
    }
    let roster = roster.expect("the prepared roster file");
    for worker in roster["workers"].as_array().expect("worker rows") {
        let launch_env = worker["launch_env"].as_object().expect("launch_env row");
        // The row is the supervisor's internal identity only: the
        // client's marker key never lands in it (the raw-bytes check
        // above covers the value).
        assert!(
            !launch_env.contains_key("PA_MARKER"),
            "the roster row's launch env carries a client var: {worker}"
        );
        // And the row IS populated: the respawn env is really there.
        assert!(
            launch_env.contains_key(pa_daemon::worker::WORKER_TOKEN_ENV),
            "the roster row's launch env lost the internal identity: {worker}"
        );
    }
}
