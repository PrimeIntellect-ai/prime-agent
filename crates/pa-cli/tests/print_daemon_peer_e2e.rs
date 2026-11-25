// too_many_lines: style gate only.
#![allow(clippy::too_many_lines)]

//! End-to-end verifier for print mode over a running daemon (T-0016): a
//! `-r <id> -p` run drives a daemon session, so the daemon holds the
//! session lease and a peer's `send_message` reaches the session while the
//! print turn is in flight (TS main.ts `useDaemonClient`).
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The print turn's prompt marker: the mock holds a request carrying it
/// until the test releases the gate.
const HOLD_MARKER: &str = "HOLD-ME";

/// The mock answers a request carrying this marker with an empty reply.
const EMPTY_REPLY_MARKER: &str = "EMPTY-REPLY";

struct Daemon {
    child: Child,
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// The release gate for held requests: `true` once released.
type Gate = Arc<(Mutex<bool>, Condvar)>;

/// An OpenAI-completions mock: every request answers `answer` (empty for
/// one carrying [`EMPTY_REPLY_MARKER`]), and one carrying [`HOLD_MARKER`]
/// before the gate opens reports itself on `held` and waits for the release.
fn spawn_mock(answer: &'static str, gate: &Gate, held: mpsc::Sender<()>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
    let url = format!(
        "http://127.0.0.1:{}/v1",
        listener.local_addr().unwrap().port()
    );
    let gate = Arc::clone(gate);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let gate = Arc::clone(&gate);
            let held = held.clone();
            std::thread::spawn(move || {
                let _ = serve(stream, answer, &gate, &held);
            });
        }
    });
    url
}

fn serve(
    mut stream: TcpStream,
    answer: &str,
    gate: &Gate,
    held: &mpsc::Sender<()>,
) -> std::io::Result<()> {
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
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    let body = String::from_utf8_lossy(&body);
    let answer = if body.contains(EMPTY_REPLY_MARKER) {
        ""
    } else {
        answer
    };
    if body.contains(HOLD_MARKER) {
        let (released, wake) = &**gate;
        let mut released = released.lock().unwrap();
        if !*released {
            let _ = held.send(());
            while !*released {
                released = wake.wait(released).unwrap();
            }
        }
    }
    let mut payload = String::new();
    for (delta, finish_reason) in [
        (json!({"role": "assistant", "content": answer}), Value::Null),
        (json!({}), json!("stop")),
    ] {
        let chunk = json!({
            "id": "chatcmpl-print-daemon",
            "object": "chat.completion.chunk",
            "created": 1_750_000_000,
            "model": "mock-1",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        });
        write!(payload, "data: {chunk}\n\n").expect("write to String");
    }
    payload.push_str("data: [DONE]\n\n");
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
        )
        .as_bytes(),
    )
}

// zombie_processes: the returned `Daemon` reaps the child on drop; only the
// readiness panic abandons it, and that fails the test anyway.
#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &Path, home: &Path, agent_dir: &Path) -> Daemon {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(socket)
        .env("HOME", home)
        .env("PRIME_AGENT_CODING_AGENT_DIR", agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for var in [
        pa_daemon::worker::WORKER_ROLE_ENV,
        pa_daemon::worker::WORKER_TOKEN_ENV,
        pa_daemon::worker::WORKER_ACTIVE_SESSION_ID_ENV,
        pa_daemon::worker::WORKER_RECOVERY_JOURNAL_ENV,
        pa_daemon::worker::WORKER_SUPERVISOR_SOCKET_ENV,
        pa_daemon::worker::WORKER_SOCKET_ENV,
        pa_daemon::worker::WORKER_INSTANCE_ID_ENV,
        pa_daemon::worker::WORKER_SCRIPT_ENV,
    ] {
        command.env_remove(var);
    }
    // A supervisor killed at teardown must not leak its session workers into
    // later test binaries.
    command.env(
        pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
        "15000",
    );
    let child = command.spawn().expect("spawn prime-agent --mode daemon");
    // `bind(2)` creates the socket file before the supervisor listens, so
    // readiness is a successful connect, not the file.
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match UnixStream::connect(socket) {
            Ok(_) => break,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => panic!("the daemon never accepted a connection: {error}"),
        }
    }
    Daemon {
        child,
        socket: socket.to_path_buf(),
    }
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Self {
        let stream = UnixStream::connect(socket).expect("connect daemon");
        stream
            .set_read_timeout(Some(Duration::from_secs(90)))
            .expect("read timeout");
        let writer = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
        };
        assert_eq!(client.read_line()["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        loop {
            line.clear();
            assert_ne!(
                self.reader.read_line(&mut line).expect("daemon line"),
                0,
                "the daemon closed the connection"
            );
            if !line.trim().is_empty() {
                return serde_json::from_str(line.trim()).expect("parse daemon line");
            }
        }
    }

    /// Send one command and return its response (other frames skipped).
    fn request(&mut self, id: &str, command: &Value) -> Value {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": {
                "name": "prime-agent.daemon",
                "version": pa_types::daemon::DAEMON_PROTOCOL_VERSION,
            },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        loop {
            let frame = self.read_line();
            if frame["type"] == "response" && frame["id"] == id {
                return frame;
            }
        }
    }

    fn create(&mut self, id: &str, name: &str, config: &Value) -> Value {
        let created = self.request(
            id,
            &json!({ "type": "create", "name": name, "config": config }),
        );
        assert_eq!(created["success"], true, "create {name} failed: {created}");
        created["data"].clone()
    }

    fn prompt(&mut self, id: &str, active_session_id: &str, message: &str) {
        let prompted = self.request(
            id,
            &json!({ "type": "prompt_and_wait", "activeSessionId": active_session_id, "message": message }),
        );
        assert_eq!(prompted["success"], true, "prompt {id} failed: {prompted}");
    }
}

/// An isolated daemon over a loopback provider mock that holds the turn
/// carrying [`HOLD_MARKER`] until the test opens `gate`.
struct Fixture {
    home: PathBuf,
    agent_dir: PathBuf,
    sessions: PathBuf,
    work: PathBuf,
    socket: PathBuf,
    gate: Gate,
    held: mpsc::Receiver<()>,
    // Dropped before the temp dir: the daemon stops before its files go.
    _daemon: Daemon,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn start() -> Self {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let home = dir.path().canonicalize().expect("canonical temp dir");
        let agent_dir = home.join("agent");
        let sessions = agent_dir.join("sessions");
        let work = home.join("work");
        std::fs::create_dir_all(&sessions).expect("sessions dir");
        std::fs::create_dir_all(&work).expect("work dir");
        // The direct delivery path keeps the delivered row in the transcript.
        std::fs::write(
            agent_dir.join("settings.json"),
            json!({ "agentInbox": { "enabled": false } }).to_string(),
        )
        .expect("settings");
        let gate: Gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (held_tx, held) = mpsc::channel();
        let url = spawn_mock("mock reply", &gate, held_tx);
        std::fs::write(
            agent_dir.join("models.json"),
            json!({
                "providers": {
                    "prime-inference": {
                        "api": "openai-completions",
                        "baseUrl": url,
                        "apiKey": "sk-print-daemon",
                        "models": [{
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "contextWindow": 128_000,
                            "maxTokens": 4096
                        }]
                    }
                }
            })
            .to_string(),
        )
        .expect("models.json");
        let socket = home.join("daemon.sock");
        let daemon = spawn_daemon(&socket, &home, &agent_dir);
        Fixture {
            home,
            agent_dir,
            sessions,
            work,
            socket,
            gate,
            held,
            _daemon: daemon,
            _dir: dir,
        }
    }

    fn config(&self) -> Value {
        json!({
            "cwd": self.work.to_string_lossy(),
            "sessionDir": self.sessions.to_string_lossy(),
            "provider": "prime-inference",
            "model": "mock-1",
        })
    }

    /// One turn on a daemon session, then stopped, so its file is a saved
    /// session. Returns its session id.
    fn saved_session(&self, client: &mut Client) -> String {
        let target = client.create("c-target", "target", &self.config());
        let target_active = target["activeSessionId"].as_str().expect("active id");
        client.prompt("p-seed", target_active, "seed");
        let killed = client.request(
            "k-target",
            &json!({ "type": "kill", "activeSessionId": target_active }),
        );
        assert_eq!(killed["success"], true, "kill failed: {killed}");
        target["sessionId"]
            .as_str()
            .expect("session id")
            .to_string()
    }
}

/// The `-r <id> -p <prompt>` run against the fixture daemon.
fn print_command(fixture: &Fixture, session_id: &str, prompt: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(["--daemon-socket"])
        .arg(&fixture.socket)
        .args(["--provider", "prime-inference", "--model", "mock-1"])
        .args(["-r", session_id, "-p", prompt])
        .current_dir(&fixture.work)
        .env("HOME", &fixture.home)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &fixture.agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// A peer reaches a session driven by `-r <id> -p` while its turn runs:
/// the print run is a daemon session, never a daemonless lease holder the
/// daemon cannot wake.
#[test]
fn a_peer_message_reaches_a_resumed_print_session_mid_turn() {
    let fixture = Fixture::start();
    let mut client = Client::connect(&fixture.socket);
    let session_id = fixture.saved_session(&mut client);
    let peer = client.create("c-peer", "peer", &fixture.config());
    let peer_active = peer["activeSessionId"].as_str().expect("peer active id");

    let mut print = print_command(&fixture, &session_id, &format!("resume {HOLD_MARKER}"))
        .spawn()
        .expect("spawn the print run");
    if fixture.held.recv_timeout(Duration::from_secs(90)).is_err() {
        let _ = print.kill();
        let output = print.wait_with_output().expect("print output");
        panic!(
            "the print turn never reached the provider: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let sent = client.request(
        "s-peer",
        &json!({
            "type": "send_message",
            "targetActiveSessionId": session_id,
            "fromActiveSessionId": peer_active,
            "message": "peer hello",
        }),
    );
    {
        let (released, wake) = &*fixture.gate;
        *released.lock().unwrap() = true;
        wake.notify_all();
    }
    let output = print.wait_with_output().expect("print output");
    assert_eq!(
        sent["success"], true,
        "the peer's send must reach the print-driven session: {sent}"
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let transcript = std::fs::read_to_string(fixture.sessions.join(format!("{session_id}.jsonl")))
        .expect("transcript");
    assert!(
        transcript.contains("peer hello"),
        "the delivery is in the session transcript: {transcript}"
    );
}

/// The live rows that serve `session_file`, from a `list` that includes
/// client-owned sessions.
fn live_rows_for(client: &mut Client, id: &str, session_file: &Path) -> Vec<Value> {
    let listed = client.request(id, &json!({ "type": "list", "includeClientOwned": true }));
    assert_eq!(listed["success"], true, "list failed: {listed}");
    listed["data"]["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .filter(|row| {
            row["sessionFile"].as_str().is_some_and(|file| {
                Path::new(file).canonicalize().ok().as_deref() == Some(session_file)
            })
        })
        .cloned()
        .collect()
}

/// Wait until no live worker serves `session_file`, failing after `within`.
fn wait_until_unhosted(client: &mut Client, session_file: &Path, within: Duration) {
    let deadline = Instant::now() + within;
    while !live_rows_for(client, "l-unhosted", session_file).is_empty() {
        assert!(
            Instant::now() < deadline,
            "a worker still serves the session after {within:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A resident client that opens a saved session before the print run's
/// client-owned `create` keeps it: the daemon refuses the client-owned
/// create atomically, so the file has exactly one live owner, and both
/// clients stay usable.
#[test]
fn a_session_opened_between_list_and_create_keeps_one_owner() {
    let fixture = Fixture::start();
    let mut setup = Client::connect(&fixture.socket);
    let session_id = fixture.saved_session(&mut setup);
    let session_file = fixture
        .sessions
        .join(format!("{session_id}.jsonl"))
        .canonicalize()
        .expect("saved session file");
    let mut runner = Client::connect(&fixture.socket);
    let mut resident = Client::connect(&fixture.socket);
    let open = |lifecycle: Option<&str>| {
        let mut command = json!({
            "type": "create",
            "sessionPath": session_file.to_string_lossy(),
            "config": fixture.config(),
        });
        if let Some(lifecycle) = lifecycle {
            command["lifecycle"] = json!(lifecycle);
        }
        command
    };

    wait_until_unhosted(&mut runner, &session_file, Duration::from_secs(30));
    let opened = resident.request("o-resident", &open(None));
    assert_eq!(opened["success"], true, "resident open failed: {opened}");
    let resident_active = opened["data"]["activeSessionId"]
        .as_str()
        .expect("resident active id")
        .to_string();
    let claimed = runner.request("c-runner", &open(Some("client_owned")));
    assert_eq!(
        claimed["success"], false,
        "the client-owned create took a live session: {claimed}"
    );
    let error = claimed["error"].as_str().unwrap_or_default();
    assert!(
        error.contains(&format!("Session is already active in {resident_active}")),
        "the refusal names the live session: {claimed}"
    );

    let rows = live_rows_for(&mut runner, "l-after", &session_file);
    assert_eq!(rows.len(), 1, "exactly one live owner: {rows:?}");
    assert_eq!(rows[0]["activeSessionId"], resident_active.as_str());
    resident.prompt("p-resident", &resident_active, "still mine");

    // Once the resident lets go, the runner's client-owned create claims it.
    let killed = resident.request(
        "k-resident",
        &json!({ "type": "kill", "activeSessionId": resident_active }),
    );
    assert_eq!(killed["success"], true, "kill failed: {killed}");
    let claimed = runner.request("c-runner-2", &open(Some("client_owned")));
    assert_eq!(
        claimed["success"], true,
        "the free file is claimable: {claimed}"
    );
    let runner_active = claimed["data"]["activeSessionId"]
        .as_str()
        .expect("runner active id")
        .to_string();
    runner.prompt("p-runner", &runner_active, "now mine");
    let rows = live_rows_for(&mut runner, "l-claimed", &session_file);
    assert_eq!(rows.len(), 1, "exactly one live owner: {rows:?}");
    assert_eq!(rows[0]["activeSessionId"], runner_active.as_str());
}

/// Ctrl-C on a daemon-backed print run stops the daemon-side turn: the run
/// exits 130 and the session's worker is gone well inside the daemon's
/// 30 s disconnect grace, while the provider still holds the turn.
#[test]
fn ctrl_c_stops_the_daemon_side_turn() {
    let fixture = Fixture::start();
    let mut client = Client::connect(&fixture.socket);
    let session_id = fixture.saved_session(&mut client);
    let session_file = fixture
        .sessions
        .join(format!("{session_id}.jsonl"))
        .canonicalize()
        .expect("saved session file");
    let print = print_command(&fixture, &session_id, &format!("resume {HOLD_MARKER}"))
        .spawn()
        .expect("spawn the print run");
    fixture
        .held
        .recv_timeout(Duration::from_secs(90))
        .expect("the print turn reached the provider");
    assert_eq!(
        live_rows_for(&mut client, "l-running", &session_file).len(),
        1,
        "the print run's worker serves the session"
    );

    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(print.id()).expect("pid")),
        nix::sys::signal::Signal::SIGINT,
    )
    .expect("send SIGINT");
    let output = print.wait_with_output().expect("print output");
    assert_eq!(
        output.status.code(),
        Some(130),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    wait_until_unhosted(&mut client, &session_file, Duration::from_secs(10));
}

/// A goal the run drives into the no-progress cap fails the text-mode run
/// with the cap reason, like the daemonless run. The saved paused goal
/// already has two no-output turns; the resumed continuation's empty reply
/// is the third.
#[test]
fn a_goal_capped_during_the_run_exits_one_with_the_reason() {
    let fixture = Fixture::start();
    let mut client = Client::connect(&fixture.socket);
    let session_id = fixture.saved_session(&mut client);
    let session_file = fixture.sessions.join(format!("{session_id}.jsonl"));
    wait_until_unhosted(
        &mut client,
        &session_file.canonicalize().expect("saved session file"),
        Duration::from_secs(30),
    );
    let transcript = std::fs::read_to_string(&session_file).expect("transcript");
    let last: Value = serde_json::from_str(transcript.lines().last().expect("an entry"))
        .expect("parse the last entry");
    let earlier = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis(),
    )
    .expect("millis")
        - 60_000;
    let goal = json!({
        "type": "custom",
        "id": "goal-seed",
        "parentId": last["id"],
        "timestamp": last["timestamp"],
        "customType": pa_core::goals::GOAL_STATE_CUSTOM_TYPE,
        "data": {
            "active": false,
            "status": "paused",
            "goalId": "goal-seed",
            "objective": format!("finish the work {EMPTY_REPLY_MARKER}"),
            "tokensUsed": 0,
            "timeUsedSeconds": 0,
            "continuationsUsed": 2,
            "createdAt": earlier,
            "noProgressStreak": 2,
            "noProgressTurnMs": earlier,
            "updatedAt": earlier,
        },
    });
    std::fs::write(&session_file, format!("{transcript}{goal}\n")).expect("seed the goal");

    let output = print_command(&fixture, &session_id, "/goal resume")
        .output()
        .expect("print output");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(
        stderr.contains(pa_core::session_engine::goal_driver::CONTINUATION_NO_PROGRESS_CAP_REASON),
        "stderr: {stderr}"
    );
}
