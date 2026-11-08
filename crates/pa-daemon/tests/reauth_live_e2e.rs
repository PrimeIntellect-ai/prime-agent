//! Live credential pickup e2e: a daemon worker session whose stored OAuth
//! credential is rotated by ANOTHER process (the `/login` flow's writer)
//! must serve the fresh token on the very next provider request — no
//! daemon restart, no `/reload`. This pins the reported symptom class (a
//! re-authenticated credential needs a daemon restart to be picked up):
//! the live session's request auth follows the credential store. The
//! rotation here is an unexpired replacement written to disk; the OAuth
//! expiry-refresh path is pinned separately by the engine battery.
// Fn length is a style gate, not correctness.
#![allow(clippy::too_many_lines)]
#![cfg(unix)]

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Supervisor {
    child: Child,
    socket: PathBuf,
    stderr_path: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A mock OpenAI-completions provider that AUTHORIZES per request: the
/// stored `stale-access` token is rejected with a 401 (the shape a rotated
/// credential produces), any other bearer serves a fixed SSE answer. The
/// served Authorization headers are recorded per request.
struct AuthorizingMock {
    authorizations: Arc<Mutex<Vec<String>>>,
    port: u16,
}

impl AuthorizingMock {
    fn start() -> AuthorizingMock {
        let authorizations = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock");
        let port = listener.local_addr().expect("mock addr").port();
        let recorded = Arc::clone(&authorizations);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let recorded = Arc::clone(&recorded);
                std::thread::spawn(move || {
                    let _ = serve(stream, &recorded);
                });
            }
        });
        AuthorizingMock {
            authorizations,
            port,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/v1", self.port)
    }

    fn served_bearers(&self) -> Vec<String> {
        self.authorizations.lock().expect("mock lock").clone()
    }
}

fn chunk(delta: &Value, finish_reason: Option<&str>) -> String {
    json!({
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "created": 1_750_000_000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    })
    .to_string()
}

fn serve(mut stream: TcpStream, recorded: &Arc<Mutex<Vec<String>>>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        head.push_str(&line);
        if line == "\r\n" {
            break;
        }
    }
    let mut content_length = 0usize;
    let mut authorization = String::new();
    for line in head.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse().unwrap_or_default();
        }
        if let Some(value) = lower.strip_prefix("authorization:") {
            authorization = value.trim().to_string();
        }
    }
    let mut body_bytes = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body_bytes)?;
    }
    recorded
        .lock()
        .expect("mock lock")
        .push(authorization.clone());
    // The stale token is rejected exactly like a rotated credential: a
    // 401 with an authentication_error shape.
    if authorization != "bearer fresh-access" {
        let body = json!({
            "error": {
                "message": "Invalid API key provided",
                "type": "authentication_error",
                "code": 401
            }
        })
        .to_string();
        return stream.write_all(
            format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );
    }
    let mut payload = String::new();
    for data in [
        chunk(
            &json!({"role": "assistant", "content": "fresh credential answer"}),
            None,
        ),
        chunk(&json!({}), Some("stop")),
    ] {
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

#[allow(clippy::zombie_processes)]
fn spawn_supervisor(socket: &Path, agent_dir: &Path) -> Supervisor {
    std::fs::create_dir_all(agent_dir).expect("agent dir");
    let stderr_path = agent_dir.join("supervisor-stderr.log");
    let stderr = std::fs::File::create(&stderr_path).expect("capture supervisor stderr");
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr))
        .env_remove("PRIME_API_KEY")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    Supervisor {
        child,
        socket: socket.to_path_buf(),
        stderr_path,
    }
}

// Socket presence precedes listen readiness; return the connection itself so
// callers do not race a second connect after a successful probe.
fn connect_when_ready(
    socket: &Path,
    mut exit_status: impl FnMut() -> std::io::Result<Option<std::process::ExitStatus>>,
    mut on_pending: impl FnMut(),
) -> std::io::Result<std::os::unix::net::UnixStream> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = exit_status()? {
            return Err(std::io::Error::other(format!(
                "supervisor exited during startup: {status}"
            )));
        }
        match std::os::unix::net::UnixStream::connect(socket) {
            Ok(stream) => return Ok(stream),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::ConnectionRefused
                        | std::io::ErrorKind::InvalidInput
                ) =>
            {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("supervisor readiness timed out: {error}"),
                    ));
                }
                on_pending();
            }
            Err(error) => return Err(error),
        }
    }
}

/// One client connection: request/response plus the session events that stream while a response is
/// outstanding.
struct Client {
    reader: BufReader<std::os::unix::net::UnixStream>,
    writer: std::os::unix::net::UnixStream,
    events: Vec<Value>,
}

impl Client {
    fn connect(supervisor: &mut Supervisor) -> Client {
        let stream = connect_when_ready(
            &supervisor.socket,
            || supervisor.child.try_wait(),
            || std::thread::sleep(Duration::from_millis(20)),
        )
        .unwrap_or_else(|error| {
            let mut stderr = String::new();
            if let Ok(file) = std::fs::File::open(&supervisor.stderr_path) {
                let _ = file.take(16 * 1024).read_to_string(&mut stderr);
            }
            panic!("supervisor startup: {error}; stderr: {stderr}");
        });
        let writer = stream.try_clone().expect("clone");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer,
            events: Vec::new(),
        };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello");
        client
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(60);
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

    fn send_command(&mut self, id: &str, command: &Value) {
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
    }

    fn request(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            assert!(Instant::now() < deadline, "no response for id {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
            self.collect_event(&line);
        }
    }

    fn collect_event(&mut self, line: &Value) {
        if line.get("type").and_then(Value::as_str) == Some("session_event") {
            self.events.push(line["event"].clone());
        }
    }
}

/// One stored OAuth credential, the shape `/login` writes.
fn write_oauth_credential(agent_dir: &Path, access: &str) {
    let path = agent_dir.join("auth.json");
    let temp = agent_dir.join("auth.json.tmp-login");
    std::fs::write(
        &temp,
        json!({
            "battery": { "type": "oauth", "access": access, "refresh": "r",
                "expires": 4_102_444_800_000i64 }
        })
        .to_string(),
    )
    .expect("write the credential");
    // The product's login writer renames into place: the daemon's stat
    // identity must see the change.
    std::fs::rename(&temp, &path).expect("land the credential");
}

/// The reported seam, end to end: the daemon serves the credential another
/// process wrote, on the live session's next request. The daemon process
/// outlives both prompts; nothing restarts it.
#[test]
fn a_live_daemon_serves_a_reauthenticated_credential_without_restart() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let session_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&session_dir).expect("session dir");
    let mock = AuthorizingMock::start();
    std::fs::write(
        agent_dir.join("models.json"),
        json!({
            "providers": {
                "battery": {
                    "api": "openai-completions",
                    "baseUrl": mock.url(),
                    "apiKey": "sk-config-fallback",
                    "models": [
                        {
                            "id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                            "contextWindow": 128_000, "maxTokens": 4096
                        }
                    ]
                }
            }
        })
        .to_string(),
    )
    .expect("write models.json");
    // Retries stay off: each prompt makes exactly one provider request, so
    // the served bearer per prompt is observable.
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({ "retry": { "enabled": false } }).to_string(),
    )
    .expect("write settings.json");
    // The stored credential the session builds against.
    write_oauth_credential(&agent_dir, "stale-access");
    let socket = dir.path().join("reauth-live.sock");
    let mut supervisor = spawn_supervisor(&socket, &agent_dir);
    let mut client = Client::connect(&mut supervisor);
    client.send_command(
        "c1",
        &json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": session_dir.to_string_lossy(),
                "provider": "battery",
                "model": "mock-1",
            },
        }),
    );
    let created = client.request("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();
    client.send_command(
        "a1",
        &json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.request("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    // Prompt 1: the stale credential is rejected — the kickout the report
    // describes.
    client.send_command(
        "p1",
        &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "hi" }),
    );
    let failed = client.request("p1");
    assert_eq!(
        failed["success"], false,
        "the stale credential fails: {failed}"
    );
    assert_eq!(
        mock.served_bearers(),
        vec!["bearer stale-access".to_string()]
    );

    // The re-authentication: ANOTHER process (the `/login` writer) lands a
    // fresh credential. The daemon keeps running.
    write_oauth_credential(&agent_dir, "fresh-access");
    assert!(
        supervisor
            .child
            .try_wait()
            .expect("supervisor alive")
            .is_none(),
        "the daemon was never restarted"
    );

    // Prompt 2, on the SAME live session: the fresh credential serves.
    client.send_command(
        "p2",
        &json!({ "type": "prompt_and_wait", "activeSessionId": session_id, "message": "again" }),
    );
    let served = client.request("p2");
    assert_eq!(
        served["success"], true,
        "the fresh credential serves the live session: {served}"
    );
    assert_eq!(
        mock.served_bearers(),
        vec![
            "bearer stale-access".to_string(),
            "bearer fresh-access".to_string()
        ],
        "the second prompt carried the re-authenticated token"
    );
}
