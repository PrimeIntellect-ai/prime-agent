//! The built-in Herdr connector e2e: the session-scoped pane reporting
//! proven against the TS boot-context bug class. The harness boots the
//! real supervisor — and so its worker children — inside a HOSTILE
//! Herdr ambient env (`w0:boot`, the pane the daemon itself "runs in"),
//! while the session's pane identity travels on the create payload only.
//! Every report on the fake pane-state socket must carry the payload
//! pane, never the boot pane, across the whole lifecycle: idle at the
//! create (with the session file reference and the resume argv), working
//! at the turn start, idle at the settle, and the release as the kill's
//! last write. The env-less session stays silent (no boot-context bleed
//! — the TS daemon's shared-process failure mode cannot recur here) until
//! its attach adopts the pane identity (adopt-if-absent).
// Pedantic-gate dispositions (fleet-uniform ruling; see create_join_e2e).
#![allow(clippy::large_futures)]
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
#![allow(clippy::too_many_lines)]
#![allow(
    clippy::unnecessary_wraps,
    clippy::zero_sized_map_values,
    clippy::struct_excessive_bools,
    clippy::struct_field_names
)]
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Daemon {
    child: Child,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The kernel Python (the same resolution the MCP product-path e2e
/// uses): an explicit `PA_E2E_KERNEL_PYTHON`, else the machine's live
/// install. Skipped (with a note) on machines without one.
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
        "kernel python {} not found; skipping the herdr pane e2e",
        candidate.display()
    );
    None
}

/// Spawn the real supervisor inside a HOSTILE Herdr ambient env: the
/// daemon (and every worker it spawns) "boots" in pane `w0:boot` — the
/// boot-context bug class setup. The session's own pane identity must
/// come from the create payload, never from here.
fn spawn_supervisor(
    socket: &Path,
    agent_dir: &Path,
    kernel_python: &Path,
    herdr_socket: &Path,
) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let log_file = std::fs::File::create(socket.with_extension("daemon.log")).expect("log file");
    let log_err = log_file.try_clone().expect("clone log file");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env("PRIME_AGENT_KERNEL_PYTHON", kernel_python)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env_remove("PRIME_API_KEY")
        // THE HOSTILE BOOT CONTEXT: a Herdr pane identity in the daemon's
        // own process env. If the reporter ever read the ambient env (the
        // TS bug class), every report would carry `w0:boot`.
        .env("HERDR_ENV", "1")
        .env("HERDR_SOCKET_PATH", herdr_socket)
        .env("HERDR_PANE_ID", "w0:boot")
        // A supervisor killed at teardown must not leak its session workers
        // into later test binaries: the worker's supervisor-lost exit runs
        // on this short window instead of the 5-minute default.
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_err))
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

/// The fake Herdr pane-state socket: one JSON request line per
/// connection (the connector's wire contract — one request, one
/// response byte, close), every request recorded in arrival order.
fn fake_herdr(socket: &Path) -> Arc<Mutex<Vec<Value>>> {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let listener = UnixListener::bind(socket).expect("bind the fake herdr socket");
    let seen = Arc::clone(&requests);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let Ok(reader) = stream.try_clone() else {
                continue;
            };
            let Ok(mut writer) = stream.try_clone() else {
                continue;
            };
            let mut line = String::new();
            if BufReader::new(reader).read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
            if let Ok(request) = serde_json::from_str::<Value>(line.trim()) {
                seen.lock().unwrap().push(request.clone());
                let response = json!({ "id": request.get("id").cloned().unwrap_or(Value::Null), "result": { "type": "ok" } });
                let _ = writer.write_all(format!("{response}\n").as_bytes());
                let _ = writer.flush();
            }
        }
    });
    requests
}

fn wait_for_requests(requests: &Arc<Mutex<Vec<Value>>>, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if requests.lock().unwrap().len() >= count {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the connector never sent {count} requests: {:?}",
            requests.lock().unwrap()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Every record must carry the payload pane — the boot pane never wins.
fn assert_no_boot_pane(requests: &Arc<Mutex<Vec<Value>>>, expected_pane: &str) {
    let frames = requests.lock().unwrap();
    for frame in frames.iter() {
        assert_eq!(
            frame["params"]["pane_id"], expected_pane,
            "a report leaked the boot context: {frame}"
        );
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

fn write_faux_script(dir: &Path, responses: &Value) -> PathBuf {
    let path = dir.join("script.json");
    std::fs::write(
        &path,
        json!({ "engine": "faux", "responses": responses }).to_string(),
    )
    .expect("write faux script");
    path
}

/// The payload pane identity (what the client sends on the create): the
/// allowlist the connector consumes, the socket under the test's control.
fn pane_env(herdr_socket: &Path, pane_id: &str) -> Value {
    json!({
        "HERDR_ENV": "1",
        "HERDR_SOCKET_PATH": herdr_socket.to_string_lossy(),
        "HERDR_PANE_ID": pane_id,
        "HERDR_TAB_ID": "t1",
        "HERDR_WORKSPACE_ID": "ws1",
    })
}

/// The pane-reporting lifecycle against the TS boot-context bug class:
/// the session created inside the hostile ambient env reports ONLY for
/// the pane its create payload carried — idle with the session file
/// reference at the create, working at the turn start, idle at the
/// settle, and the release as the kill's last write, with silence after.
#[test]
fn the_session_reports_its_payload_pane_across_the_lifecycle() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let herdr_socket = dir.path().join("herdr.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let responses = json!([{ "text": "turn done" }, { "text": "turn done" }]);
    let script = write_faux_script(dir.path(), &responses);
    let requests = fake_herdr(&herdr_socket);
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python, &herdr_socket);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // CREATE: the client that owns the pane sends its identity on the
    // create payload only.
    let created = client.request(
        "create-a",
        &json!({
            "type": "create",
            "name": "pane-a",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
            },
            "env": pane_env(&herdr_socket, "w1:payload"),
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
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

    // The create's idle report: the payload pane (never the boot pane),
    // the session file reference, the resume argv, a live seq.
    wait_for_requests(&requests, 1);
    let report = requests.lock().unwrap()[0].clone();
    assert_eq!(report["method"], "pane.report_agent");
    let params = &report["params"];
    assert_eq!(params["pane_id"], "w1:payload");
    assert_eq!(params["source"], "herdr:pi");
    assert_eq!(params["agent"], "prime-agent");
    assert_eq!(params["state"], "idle");
    assert!(params.get("message").is_none(), "idle carries no message");
    assert_eq!(params["agent_session_path"], session_file);
    assert_eq!(
        params["resume_argv"],
        json!(["prime-agent", "--resume", session_file])
    );
    assert!(params["seq"].as_u64().expect("seq") > 0);
    assert_no_boot_pane(&requests, "w1:payload");

    // A scripted turn: working at the run start, idle at the settle.
    let prompted = client.request(
        "prompt-a",
        &json!({ "type": "prompt", "activeSessionId": session_id, "message": "run the turn" }),
    );
    assert_eq!(prompted["success"], true, "prompt failed: {prompted}");
    wait_for_requests(&requests, 3);
    {
        let frames = requests.lock().unwrap();
        assert_eq!(
            frames[1]["params"]["state"], "working",
            "the turn start never reported working: {}",
            frames[1]
        );
        assert_eq!(
            frames[2]["params"]["state"], "idle",
            "the settle never reported idle: {}",
            frames[2]
        );
        // The seq chain is monotonic.
        let seqs: Vec<u64> = frames
            .iter()
            .map(|frame| frame["params"]["seq"].as_u64().expect("seq"))
            .collect();
        assert!(
            seqs.windows(2).all(|pair| pair[0] < pair[1]),
            "the seq chain is not monotonic: {seqs:?}"
        );
    }
    assert_no_boot_pane(&requests, "w1:payload");

    // THE STOP: the kill's release is the last write on the wire.
    let killed = client.request(
        "kill-a",
        &json!({ "type": "kill", "activeSessionId": session_id }),
    );
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    wait_for_requests(&requests, 4);
    {
        let frames = requests.lock().unwrap();
        let release = frames.last().expect("the release");
        assert_eq!(release["method"], "pane.release_agent");
        assert_eq!(release["params"]["pane_id"], "w1:payload");
        assert_eq!(release["params"]["source"], "herdr:pi");
        let report_seq = frames[frames.len() - 2]["params"]["seq"]
            .as_u64()
            .expect("seq");
        assert!(
            release["params"]["seq"].as_u64().expect("seq") > report_seq,
            "the release seq must stay above the last report's"
        );
    }
    // Silence after the release: nothing may reclaim the pane.
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(
        requests.lock().unwrap().len(),
        4,
        "a late report reclaimed the pane: {:?}",
        requests.lock().unwrap()
    );
}

/// The env-less session (the cron-created case): it stays silent — the
/// hostile ambient env never produces a boot-context report — until the
/// pane that opens it attaches its identity, which the session ADOPTS
/// (adopt-if-absent), reports for, and releases at its stop.
#[test]
fn an_envless_session_stays_silent_until_its_attach_adopts_the_pane() {
    let Some(kernel_python) = kernel_python() else {
        return;
    };
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let herdr_socket = dir.path().join("herdr.sock");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
    let responses = json!([{ "text": "turn done" }, { "text": "turn done" }]);
    let script = write_faux_script(dir.path(), &responses);
    let requests = fake_herdr(&herdr_socket);
    let _daemon = spawn_supervisor(&socket, &agent_dir, &kernel_python, &herdr_socket);
    wait_socket_ready(&socket);
    let (mut client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");

    // CREATE with NO env: the session runs, and nothing reports for the
    // boot pane — the ambient env cannot reach the reporter.
    let created = client.request(
        "create-b",
        &json!({
            "type": "create",
            "name": "pane-b",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": sessions_dir.to_string_lossy(),
                "script": script.to_string_lossy(),
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    let data = &created["data"];
    let session_id = data["activeSessionId"]
        .as_str()
        .or_else(|| data["id"].as_str())
        .expect("session id")
        .to_string();
    std::thread::sleep(Duration::from_millis(400));
    assert!(
        requests.lock().unwrap().is_empty(),
        "the env-less session reported for the boot context: {:?}",
        requests.lock().unwrap()
    );

    // ATTACH carrying the pane identity: the session adopts it
    // (adopt-if-absent — the reporter was disabled, never bound to
    // another pane) and force-publishes its current state.
    let attached = client.request(
        "attach-b",
        &json!({
            "type": "attach",
            "activeSessionId": session_id,
            "env": pane_env(&herdr_socket, "w2:adopted"),
        }),
    );
    assert_eq!(attached["success"], true, "attach failed: {attached}");
    wait_for_requests(&requests, 1);
    let report = requests.lock().unwrap()[0].clone();
    assert_eq!(report["method"], "pane.report_agent");
    assert_eq!(report["params"]["pane_id"], "w2:adopted");
    assert_eq!(report["params"]["state"], "idle");
    assert_no_boot_pane(&requests, "w2:adopted");

    // The stop releases the adopted pane — the last write.
    let killed = client.request(
        "kill-b",
        &json!({ "type": "kill", "activeSessionId": session_id }),
    );
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    wait_for_requests(&requests, 2);
    {
        let frames = requests.lock().unwrap();
        let release = frames.last().expect("the release");
        assert_eq!(release["method"], "pane.release_agent");
        assert_eq!(release["params"]["pane_id"], "w2:adopted");
    }
}
