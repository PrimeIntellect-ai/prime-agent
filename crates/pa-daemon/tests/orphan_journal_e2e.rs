//! Orphan-process journal e2e: a kernel (or its worker) dying without a
//! shutdown hook must not leak the `bash()` process groups it journaled
//! — the worker-side kernel-teardown reap and the supervisor-side worker
//! death reap each answer one half of that contract.
// 64-bit-only targets; the narrowing casts sit at bounded OS boundaries.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Fn length is a style gate, not correctness.
#![allow(clippy::too_many_lines)]
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use nix::sys::signal::{kill as signal_pid, Signal};
use nix::unistd::Pid;
use serde_json::{json, Value};

struct Daemon {
    child: Child,
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The kernel Python with prime-agent-runtime installed; `PA_E2E_KERNEL_PYTHON` overrides.
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
        "kernel python {} not found; skipping orphan journal e2e",
        candidate.display()
    );
    None
}

// Ownership transfers to Daemon, whose Drop kills and waits for the child.
#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, agent_dir: &Path, kernel_python: Option<&Path>) -> Daemon {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_pa-daemon"));
    command
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .env_remove("PRIME_API_KEY")
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "20000",
        );
    if let Some(kernel_python) = kernel_python {
        command.env("PRIME_AGENT_KERNEL_PYTHON", kernel_python);
    }
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket.exists() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

/// The orphaning cell: a released `bash("sleep 600")` handle whose process
/// group outlives the turn, plus the ids the test needs to kill and probe.
fn orphaning_cell() -> String {
    // The e2e kernel namespace does not preload `os`, so the cell imports
    // it before printing the ids the test kills and probes by.
    let code = "h = bash(\"sleep 600\")\nimport os\nprint(f'ORPHAN_PGID={h.pid} KERNEL_PID={os.getpid()}')";
    serde_json::to_string(&json!({ "code": code })).expect("serialize cell")
}

/// The sequential mock: one SSE answer per request in order.
fn spawn_mock(next: &'static AtomicUsize) -> PathBuf {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = serve(stream, next);
            });
        }
    });
    PathBuf::from(url)
}

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-orphan",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn serve(mut stream: TcpStream, next: &AtomicUsize) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    // The scripted sequence: request 1 answers the python_repl tool call that
    // starts the orphaning sleep, request 2 settles the turn.
    let request = next.fetch_add(1, Ordering::SeqCst);
    let mut payload = String::new();
    let data = match request {
        0 => [
            chunk(
                &json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "index": 0,
                        "id": "call-orphan-1",
                        "type": "function",
                        "function": {
                            "name": "python_repl",
                            "arguments": orphaning_cell(),
                        }
                    }]
                }),
                None,
            ),
            chunk(&json!({}), Some("tool_calls")),
        ],
        1 => [
            chunk(
                &json!({"role": "assistant", "content": "the orphan sleeps"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
        _ => [
            chunk(
                &json!({"role": "assistant", "content": "nothing to do"}),
                None,
            ),
            chunk(&json!({}), Some("stop")),
        ],
    };
    for data in data {
        write!(payload, "data: {data}\n\n").expect("write to String");
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let stream = UnixStream::connect(socket).expect("connect");
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("timeout");
        loop {
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => line.clear(),
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

    fn request(&mut self, id: &str, command: &Value) -> Value {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize");
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .unwrap_or_else(|error| panic!("write command {id}: {error}"));
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }

    fn messages(&mut self, active_session_id: &str) -> String {
        let response = self.request(
            "gm",
            &json!({ "type": "get_messages", "activeSessionId": active_session_id }),
        );
        assert_eq!(response["success"], true, "get_messages failed: {response}");
        serde_json::to_string(&response["data"]).expect("messages json")
    }
}

fn wait_until<T>(deadline: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + deadline;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition never became true");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn create_session(client: &mut Client, id: &str, dir: &Path, agent_dir: &Path) -> String {
    let sessions = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions dir");
    let created = client.request(
        id,
        &json!({
            "type": "create",
            "name": "orphan-lane",
            "config": {
                "cwd": dir.to_string_lossy(),
                "sessionDir": sessions.to_string_lossy(),
                "provider": "prime-inference",
                "model": "mock-1",
            },
        }),
    );
    assert_eq!(created["success"], true, "create failed: {created}");
    created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["activeSessionId"].as_str())
        .expect("active session id")
        .to_string()
}

/// The session's own ids for the killing and probing: the bash process
/// group and the kernel pid the orphaning cell printed, parsed from the
/// tool result the turn settled with. The cell's code echoes through the
/// tool-call arguments too (`ORPHAN_PGID={h.pid}` there), so the parse
/// scans every marker occurrence for the first one followed by digits —
/// only the executed result prints them.
fn orphan_ids(client: &mut Client, active_session_id: &str) -> (i32, i32) {
    wait_until(Duration::from_secs(30), || {
        let messages = client.messages(active_session_id);
        let pgid = number_after(&messages, "ORPHAN_PGID=")?;
        let kernel_pid = number_after(&messages, "KERNEL_PID=")?;
        Some((pgid, kernel_pid))
    })
}

fn number_after(text: &str, marker: &str) -> Option<i32> {
    text.split(marker).skip(1).find_map(|rest| {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        digits.parse::<i32>().ok().filter(|pid| *pid > 0)
    })
}

/// The persisted worker descriptor's pid for this session: the pid the
/// supervisor reaps by when the worker itself dies.
fn worker_pid(agent_dir: &Path, active_session_id: &str) -> i32 {
    wait_until(Duration::from_secs(30), || {
        let workers_dir = agent_dir.join("daemon-workers");
        let Ok(entries) = std::fs::read_dir(&workers_dir) else {
            return None;
        };
        for dir in entries.flatten() {
            let Ok(files) = std::fs::read_dir(dir.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(content) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(descriptor) = serde_json::from_str::<Value>(&content) else {
                    continue;
                };
                if descriptor["workerId"].as_str() != Some(active_session_id) {
                    continue;
                }
                let pid = descriptor["pid"].as_i64().unwrap_or(0);
                if pid > 0 {
                    return Some(pid as i32);
                }
            }
        }
        None
    })
}

fn group_alive(pgid: i32) -> bool {
    // The whole process group: signaling the negative pgid answers ESRCH
    // only when every process the group named is gone.
    signal_pid(Pid::from_raw(-pgid), None).is_ok()
}

/// Wait out the one liveness signal the feature produces: the group's
/// death. The message names the kill that failed to reap it, so a red
/// run says exactly which half of the contract leaked.
fn expect_group_dead(pgid: i32, cause: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while group_alive(pgid) {
        assert!(
            Instant::now() < deadline,
            "the journaled bash group (pgid {pgid}) survived {cause}: the reap never ran"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// A red run must not leak `sleep 600` past the test: the group dies with
/// the guard whether or not the assertions passed.
struct GroupGuard(i32);

impl Drop for GroupGuard {
    fn drop(&mut self) {
        let _ = signal_pid(Pid::from_raw(-self.0), Signal::SIGKILL);
    }
}

/// The shared opening: a live session whose kernel runs a released
/// `bash("sleep 600")` group, with the daemon, client, and ids in hand.
struct OrphanedSession {
    daemon: Daemon,
    active_session_id: String,
    pgid: i32,
    kernel_pid: i32,
    worker_pid: i32,
}

fn session_with_orphan(
    mock_next: &'static AtomicUsize,
    root: &Path,
    socket_file: &str,
) -> OrphanedSession {
    let Some(kernel_python) = kernel_python() else {
        panic!("the orphan journal e2e requires a live kernel python");
    };
    let agent_dir = root.join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let socket = agent_dir.join(socket_file);
    let url = spawn_mock(mock_next);
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": url.to_string_lossy(),
                    "apiKey": "sk-orphan",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    let daemon = spawn_daemon(&socket, &agent_dir, Some(&kernel_python));
    let mut client = Client::connect(&socket);
    let active_session_id = create_session(&mut client, "c1", root, &agent_dir);
    let started = client.request(
        "p1",
        &json!({
            "type": "prompt_and_wait",
            "activeSessionId": active_session_id,
            "message": "start the orphan and stop",
        }),
    );
    assert_eq!(started["success"], true, "first turn failed: {started}");
    let (pgid, kernel_pid) = orphan_ids(&mut client, &active_session_id);
    let worker_pid = worker_pid(&agent_dir, &active_session_id);
    assert!(
        group_alive(pgid),
        "the orphaning sleep died before the kill: pgid {pgid}"
    );
    OrphanedSession {
        daemon,
        active_session_id,
        pgid,
        kernel_pid,
        worker_pid,
    }
}

/// T1: a kernel killed without its shutdown hook must not leak the
/// `bash()` groups it journaled — the worker's teardown reaps them.
#[test]
fn a_killed_kernel_reaps_its_journaled_bash_groups() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    if kernel_python().is_none() {
        return;
    }
    let root = tempfile::TempDir::new().expect("temp dir");
    let session = session_with_orphan(&NEXT, root.path(), "t1.sock");
    let _guard = GroupGuard(session.pgid);

    signal_pid(Pid::from_raw(session.kernel_pid), Signal::SIGKILL).expect("kill the kernel pid");
    // Event-driven: the reap lands when the worker notices the dead
    // kernel and tears it down — never a sleep-based wait.
    expect_group_dead(session.pgid, "the kernel kill");

    // Teardown: stop the session through the live supervisor so the
    // worker (and its kernel) do not leak past the test.
    let mut client = Client::connect(&session.daemon.socket);
    client.request(
        "k1",
        &json!({ "type": "kill", "activeSessionId": session.active_session_id }),
    );
}

/// T2: the stopped worker cannot run its own teardown reap when the
/// kernel and worker die — only the supervisor can, from the journal the
/// dead worker's kernel wrote.
#[test]
fn a_dead_worker_reaps_its_journaled_bash_groups_from_the_supervisor() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    if kernel_python().is_none() {
        return;
    }
    let root = tempfile::TempDir::new().expect("temp dir");
    let session = session_with_orphan(&NEXT, root.path(), "t2.sock");
    let _guard = GroupGuard(session.pgid);

    // SIGSTOP first: the worker must not run its kernel-teardown reap when
    // the kernel dies. SIGKILL cannot be caught, so the worker dies without
    // ever observing either death.
    signal_pid(Pid::from_raw(session.worker_pid), Signal::SIGSTOP).expect("stop the worker pid");
    signal_pid(Pid::from_raw(session.kernel_pid), Signal::SIGKILL).expect("kill the kernel pid");
    signal_pid(Pid::from_raw(session.worker_pid), Signal::SIGKILL)
        .expect("kill the stopped worker");
    // The supervisor's crash monitor owns the only reap: the group dies
    // when it fires, not on any timeout of ours.
    expect_group_dead(session.pgid, "the worker kill");
}
